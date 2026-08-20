window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-mcp-apps-host",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region lib/types/client/McpAppCard.js
		/**
		* MCP Apps Card Component: renders an interactive HTML card from the MCP Apps
		* `_meta.ui` payload inside a sandboxed iframe, and bridges postMessage
		* between the iframe and the DSH host (ui/initialize, tools/call,
		* resources/read, ui/update-model-context, ui/message).
		*
		* Reference: Hermes `mcp-app-card.tsx` (Layer 5: Card Component).
		*
		* @module
		*/
		/** Sends a user message into the DSH conversation. */
		let _sendUserMessage;
		/** MCP server name used in the HTTP bridge URL. */
		let _serverName = "utp";
		/**
		* Configure the module-level API used by McpAppCard instances.
		* Called once from the client plugin's `apply` function.
		*/
		function configureMcpAppCard(opts) {
			_sendUserMessage = opts.sendUserMessage;
			_serverName = opts.serverName;
		}
		/** Per-card debounce for ui/message (prevents DoS from rapid-fire iframes). */
		const MIN_MESSAGE_INTERVAL_MS = 2e3;
		const _lastMessageTime = /* @__PURE__ */ new Map();
		/** Per-card staged context from ui/update-model-context (prepended to next ui/message). */
		const _stagedContext = /* @__PURE__ */ new Map();
		/** Type guard: is this block a settled tool result? */
		function isToolResult(block) {
			return block.kind === "tool-result";
		}
		/** Extract the MCP Apps UI payload from the tool result's `meta.mcpApp`. */
		function readMcpApp(block) {
			if (!isToolResult(block)) return null;
			const meta = block.meta;
			if (!meta || typeof meta !== "object") return null;
			return meta.mcpApp ?? null;
		}
		/** Build a Content-Security-Policy string from the MCP Apps CSP directives. */
		function buildCsp(csp) {
			const script = csp?.["script-src"]?.join(" ") ?? "'unsafe-inline'";
			const style = csp?.["style-src"]?.join(" ") ?? "";
			const img = csp?.["img-src"]?.join(" ") ?? "";
			const connect = csp?.["connect-src"]?.join(" ") ?? "'none'";
			return [
				"default-src 'none'",
				`script-src ${script}`,
				`style-src 'unsafe-inline'${style ? " " + style : ""}`,
				`img-src data: blob: https:${img ? " " + img : ""}`,
				"font-src data:",
				`connect-src ${connect}`,
				"base-uri 'none'",
				"form-action *"
			].join("; ");
		}
		/** Extract `session_id` from the tool result — prefer structuredContent, fall back to content text. */
		function readSessionId(block) {
			const sc = block.meta?.lastToolResult?.structuredContent;
			if (sc && typeof sc === "object") {
				if (typeof sc.session_id === "string") return sc.session_id;
				if (typeof sc.sessionId === "string") return sc.sessionId;
			}
			for (const content of block.content) if (content.type === "text") try {
				const json = JSON.parse(content.text);
				if (typeof json === "object" && json !== null) {
					const obj = json;
					if (typeof obj.session_id === "string") return obj.session_id;
					if (typeof obj.sessionId === "string") return obj.sessionId;
				}
			} catch {}
		}
		/** Extract text from a JSON-RPC params object (handles string | { text } | { content[] }). */
		function extractTextContent(params) {
			if (typeof params === "string") return params;
			if (typeof params !== "object" || params === null) return "";
			const p = params;
			if (typeof p.text === "string") return p.text;
			if (Array.isArray(p.content)) return p.content.map((c) => typeof c === "object" && c !== null && typeof c.text === "string" ? c.text : "").filter(Boolean).join("\n");
			return "";
		}
		/**
		* Renders one MCP Apps interactive HTML card. The card is a sandboxed iframe
		* whose `srcDoc` is the HTML from `_meta.ui.resource.text`. The iframe
		* communicates with the parent via `postMessage` using JSON-RPC messages.
		*
		* Supported postMessage methods:
		* - `ui/initialize` — handshake: returns host capabilities + lastToolResult + sessionId
		* - `tools/call` — forwarded to the HTTP bridge (`/mcp-apps/<serverName>/bridge`)
		* - `resources/read` — forwarded to the HTTP bridge (security: `ui://` prefix only)
		* - `ui/update-model-context` — staged as context for the next user message
		* - `ui/message` — sends a user message into the DSH conversation (debounced)
		*/
		function McpAppCard(props) {
			const { block, callId, sessionId } = props;
			const iframeRef = (0, react.useRef)(null);
			const blockRef = (0, react.useRef)(block);
			blockRef.current = block;
			const mcpApp = readMcpApp(block);
			const handleMessage = (0, react.useCallback)(async (event) => {
				const msg = event.data;
				if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
				const { id, method, params } = msg;
				const hasId = id !== void 0;
				const reply = (result) => {
					iframeRef.current?.contentWindow?.postMessage({
						jsonrpc: "2.0",
						id: id ?? null,
						result
					}, "*");
				};
				const replyError = (code, message) => {
					iframeRef.current?.contentWindow?.postMessage({
						jsonrpc: "2.0",
						id: id ?? null,
						error: {
							code,
							message
						}
					}, "*");
				};
				try {
					if (method === "ui/initialize") {
						const currentBlock = blockRef.current;
						const result = {
							protocolVersion: "2025-06-18",
							hostInfo: {
								name: "dsh-mcp-apps-host",
								version: "0.0.1"
							},
							hostCapabilities: {
								updateModelContext: { text: {} },
								message: { text: {} }
							}
						};
						if (isToolResult(currentBlock)) {
							result.lastToolResult = currentBlock.meta?.lastToolResult ?? currentBlock.content;
							result.sessionId = readSessionId(currentBlock);
						}
						reply(result);
						return;
					}
					if (method === "ui/update-model-context") {
						const text = extractTextContent(params);
						if (text) _stagedContext.set(callId, text);
						if (hasId) reply({});
						return;
					}
					if (method === "ui/message") {
						const text = extractTextContent(params);
						if (text) {
							const now = Date.now();
							if (now - (_lastMessageTime.get(callId) ?? -2e3) < MIN_MESSAGE_INTERVAL_MS) {
								if (hasId) reply({});
								return;
							}
							_lastMessageTime.set(callId, now);
							const staged = _stagedContext.get(callId);
							const fullText = staged ? `${staged}\n\n${text}` : text;
							_stagedContext.delete(callId);
							if (_sendUserMessage !== void 0) try {
								await _sendUserMessage(sessionId, fullText);
							} catch (error) {
								console.error("[mcp-apps-host] ui/message failed:", error);
							}
						}
						if (hasId) reply({});
						return;
					}
					if (method === "tools/call") {
						const p = params ?? {};
						const args = p.arguments ?? {};
						let outgoingMsg = msg;
						if (args.session_id === void 0) {
							const currentBlock = blockRef.current;
							if (isToolResult(currentBlock)) {
								const sid = readSessionId(currentBlock);
								if (sid) outgoingMsg = {
									...msg,
									params: {
										...p,
										arguments: {
											...args,
											session_id: sid
										}
									}
								};
							}
						}
						const result = await (await fetch(`/mcp-apps/${_serverName}/bridge`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(outgoingMsg)
						})).json();
						iframeRef.current?.contentWindow?.postMessage(result, "*");
						return;
					}
					if (method === "resources/read") {
						const result = await (await fetch(`/mcp-apps/${_serverName}/bridge`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(msg)
						})).json();
						iframeRef.current?.contentWindow?.postMessage(result, "*");
						return;
					}
					replyError(-32601, `method not supported: ${method ?? "(none)"}`);
				} catch (error) {
					replyError(-32603, `internal error: ${error instanceof Error ? error.message : String(error)}`);
				}
			}, [callId, sessionId]);
			(0, react.useEffect)(() => {
				window.addEventListener("message", handleMessage);
				return () => window.removeEventListener("message", handleMessage);
			}, [handleMessage]);
			(0, react.useEffect)(() => {
				return () => {
					_lastMessageTime.delete(callId);
					_stagedContext.delete(callId);
				};
			}, [callId]);
			if (!mcpApp) return null;
			const html = mcpApp.resource?.text;
			if (!html) {
				if (mcpApp.resourceUri) console.debug("[mcp-apps-host] referenced form not yet implemented:", mcpApp.resourceUri);
				return null;
			}
			return (0, react_jsx_runtime.jsx)("div", {
				style: {
					width: "100%",
					marginTop: "8px"
				},
				children: (0, react_jsx_runtime.jsx)("iframe", {
					ref: iframeRef,
					sandbox: "allow-scripts allow-forms allow-popups",
					srcDoc: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${buildCsp(mcpApp.csp)}"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,sans-serif;padding:12px}</style></head><body>${html}</body></html>`,
					style: {
						width: "100%",
						height: "400px",
						border: "1px solid #e0e0e0",
						borderRadius: "8px"
					},
					title: mcpApp.resource?.uri ?? "mcp-app"
				})
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/**
		* MCP Apps Host client plugin: registers `tool.call.toolview` slots for all
		* known UTP tool names, and configures the McpAppCard component with a
		* `sendUserMessage` callback that routes into the DSH conversation service.
		*
		* @module @deepseek-ai/dsh-mcp-apps-host/client
		*/
		/** MCP server name (must match the server-side config in cordis.yml). */
		const SERVER_NAME = "utp";
		/** Public tool names: `mcp__<serverName>__<rawName>`. */
		const UTP_PUBLIC_TOOL_NAMES = [
			"utp_discover",
			"utp_login",
			"utp_link",
			"utp_device_authorization",
			"utp_catalog_search",
			"utp_catalog_product",
			"utp_cart_list",
			"utp_cart_add",
			"utp_cart_update",
			"utp_cart_remove",
			"utp_checkout_create",
			"utp_checkout_get",
			"utp_checkout_poll",
			"utp_checkout_complete",
			"utp_checkout_cancel",
			"utp_checkout_set_address",
			"utp_checkout_set_discount",
			"utp_address_form",
			"utp_address_create",
			"utp_address_children",
			"utp_address_parse",
			"utp_order_list",
			"utp_profile_register",
			"utp_profile_get"
		].map((name) => `mcp__${SERVER_NAME}__${name}`);
		/** Services required: slot registry + sessions (for conversation send) + locale. */
		const inject = [
			"slots",
			"sessions",
			"locale"
		];
		/**
		* Mount the MCP Apps card view: configure the module-level API and register
		* `tool.call.toolview` slots for every known UTP tool name.
		*/
		function apply(ctx) {
			configureMcpAppCard({
				serverName: SERVER_NAME,
				sendUserMessage: async (sessionId, text) => {
					const scoped = ctx.get("sessions")?.scope(sessionId);
					if (scoped === void 0) {
						console.error("[mcp-apps-host] no session scope for sessionId:", sessionId);
						return;
					}
					const conversation = scoped.get("conversation");
					if (conversation === void 0) {
						console.error("[mcp-apps-host] conversation service unavailable for session:", sessionId);
						return;
					}
					await conversation.send(text);
				}
			});
			ctx.slots.inject("tool.call.toolview", function* () {
				for (const toolName of UTP_PUBLIC_TOOL_NAMES) yield ctx.slots.register({
					name: "tool.call.toolview",
					key: toolName
				}, McpAppCard);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map