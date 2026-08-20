import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import zz from "@deepseek-ai/schemastery";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
//#region lib/types/index.js
/**
* MCP Apps Host plugin: connects to an MCP server that declares the
* `io.modelcontextprotocol/ui` extension, registers its tools on `ctx.tools`
* with full `_meta` preservation (so interactive HTML cards survive the
* pipeline), and exposes an HTTP bridge endpoint that sandboxed iframe cards
* call back into the MCP server for `tools/call` and `resources/read`.
*
* One plugin instance connects to one MCP server; load multiple instances in
* `cordis.yml` for multiple servers. The public tool-name pattern matches
* `dsh-mcp-client` (`mcp__<serverName>__<rawName>`) so the two are
* interchangeable for non-Apps servers.
*
* @module @deepseek-ai/dsh-mcp-apps-host
*/
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 6e4;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const Config = zz.union([zz.object({
	transport: zz.const("stdio"),
	serverName: zz.string().required().pattern(SERVER_NAME_PATTERN),
	command: zz.string().required(),
	args: zz.array(String).default([]),
	env: zz.dict(String).default({}),
	cwd: zz.string().default(""),
	toolCallTimeoutMs: zz.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS)
}), zz.object({
	transport: zz.const("streamable-http"),
	serverName: zz.string().required().pattern(SERVER_NAME_PATTERN),
	url: zz.string().required(),
	headers: zz.dict(String).default({}),
	toolCallTimeoutMs: zz.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS)
})]);
/** Cordis plugin name. */
const name = "mcp-apps-host";
/** Services required: tool registry + HTTP server for the iframe bridge. */
const inject = ["tools", "webServer"];
/** Raw result schema: accept any shape the server returns (no pre-validation). */
const RawResultSchema = z.record(z.string(), z.unknown());
/** DeepSeek function-name contract. */
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;
/** Derive the model-facing public name for one MCP tool. */
function publicToolName(serverName, rawName) {
	const joined = `mcp__${serverName}__${rawName}`;
	const normalized = joined.replace(INVALID_NAME_CHARS, "_");
	if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
	const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
	return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
/** Build a scrubbed env for the child process. */
function buildChildEnv(extra) {
	return {
		...scrubbedParentEnv(),
		...extra
	};
}
/** Create an MCP transport from the resolved config. */
function createTransport(config) {
	if (config.transport === "stdio") return new StdioClientTransport({
		command: config.command,
		args: config.args,
		env: buildChildEnv(config.env),
		cwd: config.cwd
	});
	return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
}
/** List tools without the SDK's per-page output-validator cache. */
async function listTools(client) {
	const all = [];
	let cursor;
	do {
		const response = await client.request({
			method: "tools/list",
			...cursor === void 0 ? {} : { params: { cursor } }
		}, ListToolsResultSchema);
		for (const tool of response.tools) {
			const meta = tool._meta;
			all.push({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				outputSchema: tool.outputSchema,
				toolMeta: meta
			});
		}
		cursor = response.nextCursor;
	} while (cursor);
	return all;
}
/** Call a tool without the SDK pre-validating an output schema. */
async function callTool(client, rawName, args, signal, timeoutMs) {
	return client.request({
		method: "tools/call",
		params: {
			name: rawName,
			arguments: args
		}
	}, RawResultSchema, {
		signal,
		timeout: timeoutMs
	});
}
/** Read a `ui://` resource and return its text content (for resource-fetch fallback). */
async function readUiResource(client, uri) {
	try {
		const response = await client.request({
			method: "resources/read",
			params: { uri }
		}, RawResultSchema);
		const contents = Array.isArray(response.contents) ? response.contents : [];
		for (const entry of contents) {
			if (typeof entry !== "object" || entry === null) continue;
			const e = entry;
			if (typeof e.text === "string") return {
				uri,
				mimeType: typeof e.mimeType === "string" ? e.mimeType : void 0,
				text: e.text
			};
		}
	} catch {}
}
/** Keep a supported advertised schema; unsupported vocabulary falls back. */
function supportedOutputSchema(candidate) {
	if (candidate === void 0) return void 0;
	try {
		assertSupportedJsonSchema(candidate);
		return candidate;
	} catch {
		return;
	}
}
/** Extract text from MCP content blocks for the model-facing text projection. */
function extractText(content, toolName) {
	if (!Array.isArray(content)) return `(${toolName} returned no model-visible content)`;
	const lines = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block;
		if (b.type === "text" && typeof b.text === "string") lines.push(b.text);
		else if (b.type === "resource_link" && typeof b.name === "string") lines.push(`Resource link: ${b.name} (${b.uri ?? "unknown"})`);
		else lines.push(`[unsupported MCP content type: ${String(b.type)}]`);
	}
	return lines.length > 0 ? lines.join("\n") : `(${toolName} returned no model-visible content)`;
}
/**
* Build a ToolDefinition for one MCP tool. The executor preserves `_meta`
* (including the `ui` payload), and `presentationMeta` projects `_meta.ui`
* into `result.meta.mcpApp` so it reaches the client-side slot component.
*/
function createDefinition(client, publicName, rawName, description, parameters, structuredSchema, toolCallTimeoutMs, toolMeta) {
	return {
		name: publicName,
		description,
		parameters,
		output: {
			schema: {
				type: "object",
				properties: {
					content: {
						type: "array",
						items: {}
					},
					structuredContent: structuredSchema ?? {},
					_meta: { type: "object" }
				},
				required: structuredSchema === void 0 ? ["content"] : ["content", "structuredContent"],
				additionalProperties: false
			},
			render(_args, value) {
				return [{
					type: "text",
					text: extractText(value.content, rawName)
				}];
			},
			presentationMeta(_args, value) {
				const v = value;
				const ui = v._meta?.ui;
				if (!ui || typeof ui !== "object") return null;
				const sc = v.structuredContent;
				return {
					mcpApp: ui,
					lastToolResult: {
						content: v.content ?? [],
						...sc !== void 0 ? { structuredContent: sc } : {}
					}
				};
			}
		},
		async execute(args, exec) {
			const result = await callTool(client, rawName, typeof args === "object" && args !== null ? args : {}, exec.signal, toolCallTimeoutMs);
			const content = Array.isArray(result.content) ? result.content : [{
				type: "text",
				text: typeof result.toolResult === "string" ? result.toolResult : "(no output)"
			}];
			if (result.isError === true) throw new Error(extractText(content, rawName));
			const value = {
				content,
				...result.structuredContent !== void 0 ? { structuredContent: result.structuredContent } : {}
			};
			if (result._meta !== void 0 && typeof result._meta === "object") value._meta = result._meta;
			else if (toolMeta !== void 0) {
				const uiDef = toolMeta.ui;
				if (uiDef !== void 0) {
					const resourceUri = typeof uiDef.resourceUri === "string" ? uiDef.resourceUri : void 0;
					if (resourceUri !== void 0) {
						const resource = await readUiResource(client, resourceUri);
						if (resource !== void 0) value._meta = { ui: {
							resource: {
								uri: resource.uri,
								...resource.mimeType !== void 0 ? { mimeType: resource.mimeType } : {},
								text: resource.text
							},
							...uiDef.csp !== void 0 ? { csp: uiDef.csp } : {}
						} };
					}
				}
			}
			return value;
		}
	};
}
/**
* Create the HTTP bridge handler for iframe postMessage proxy. The iframe
* sends JSON-RPC messages (`tools/call`, `resources/read`) via postMessage;
* the parent React component forwards them to this endpoint.
*
* Security gate:
* - `tools/call`: the tool name must be in the `registeredToolNames` whitelist
* - `resources/read`: the URI must start with `ui://`
*/
function createBridgeHandler(connections) {
	return async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: {
				code: -32601,
				message: "method not allowed"
			} }));
			return;
		}
		const segments = new URL(req.url ?? "", "http://localhost").pathname.split("/").filter(Boolean);
		if (segments.length < 3 || segments[0] !== "mcp-apps" || segments[2] !== "bridge") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: {
				code: -32601,
				message: "unknown endpoint"
			} }));
			return;
		}
		const serverName = segments[1] ?? "";
		const conn = connections.get(serverName);
		if (conn === void 0) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: {
				code: -32601,
				message: `unknown server: ${serverName}`
			} }));
			return;
		}
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString();
		});
		await new Promise((resolve) => req.on("end", resolve));
		let message;
		try {
			message = JSON.parse(body);
		} catch {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32700,
					message: "parse error"
				}
			}));
			return;
		}
		const { id, method, params } = message;
		const reply = (result) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				id: id ?? null,
				result
			}));
		};
		const replyError = (code, msg) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				id: id ?? null,
				error: {
					code,
					message: msg
				}
			}));
		};
		try {
			if (method === "tools/call") {
				const p = params ?? {};
				const name = p.name;
				if (typeof name !== "string") {
					replyError(-32602, "missing or invalid tool name");
					return;
				}
				if (!conn.registeredToolNames.has(name)) {
					replyError(-32601, `tool '${name}' is not registered on server '${serverName}'`);
					return;
				}
				const arguments_ = p.arguments ?? {};
				reply(await callTool(conn.client, name, arguments_, new AbortController().signal, conn.toolCallTimeoutMs));
				return;
			}
			if (method === "resources/read") {
				const uri = (params ?? {}).uri;
				if (typeof uri !== "string") {
					replyError(-32602, "missing or invalid resource uri");
					return;
				}
				if (!uri.startsWith("ui://")) {
					replyError(-32601, `resource not accessible from a card: ${uri}`);
					return;
				}
				reply(await conn.client.request({
					method: "resources/read",
					params: { uri }
				}, RawResultSchema));
				return;
			}
			replyError(-32601, `method not supported: ${method ?? "(none)"}`);
		} catch (error) {
			replyError(-32603, `internal error: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
}
/**
* Connect one MCP Apps server, register its tools with `_meta` preservation,
* and expose the HTTP bridge endpoint for iframe postMessage proxying.
*/
async function apply(ctx, config) {
	const { client, registeredToolNames } = await connectAndRegister(ctx, config);
	const connections = ctx.__mcpAppsConnections ?? /* @__PURE__ */ new Map();
	ctx.__mcpAppsConnections = connections;
	const conn = {
		client,
		serverName: config.serverName,
		registeredToolNames,
		toolCallTimeoutMs: config.toolCallTimeoutMs
	};
	connections.set(config.serverName, conn);
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "prefix",
			path: "/mcp-apps",
			handler: createBridgeHandler(connections)
		});
		return () => {
			dispose();
			connections.delete(config.serverName);
		};
	}, "mcp-apps-host: HTTP bridge");
	ctx.effect(() => {
		return () => {
			connections.delete(config.serverName);
			try {
				client.close();
			} catch {}
		};
	}, "mcp-apps-host: connection cleanup");
}
/**
* Create the MCP client, connect, list tools, and register them on `ctx.tools`.
* Returns the client and the set of raw tool names for the security whitelist.
*/
async function connectAndRegister(ctx, config) {
	const client = new Client({
		name: "dsh-mcp-apps-host",
		version: "0.0.1"
	}, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
	await client.connect(createTransport(config));
	const tools = await listTools(client);
	const registeredToolNames = /* @__PURE__ */ new Set();
	const disposers = [];
	for (const tool of tools) {
		const publicName = publicToolName(config.serverName, tool.name);
		if (registeredToolNames.has(tool.name)) throw new Error(`mcp-apps-host(${config.serverName}): server listed tool "${tool.name}" more than once`);
		registeredToolNames.add(tool.name);
		const def = createDefinition(client, publicName, tool.name, tool.description ?? "", tool.inputSchema, supportedOutputSchema(tool.outputSchema), config.toolCallTimeoutMs, tool.toolMeta);
		try {
			disposers.push(ctx.tools.register(def));
		} catch (error) {
			ctx.logger.error(`mcp-apps-host(${config.serverName}): tool registration failed for "${publicName}": ${String(error)}`);
		}
	}
	ctx.logger.info(`mcp-apps-host(${config.serverName}): connected, ${registeredToolNames.size} tools registered`);
	ctx.effect(() => {
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "mcp-apps-host: tool registrations");
	return {
		client,
		registeredToolNames
	};
}
//#endregion
export { Config, apply, inject, name };
