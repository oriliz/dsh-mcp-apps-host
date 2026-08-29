window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-mcp-apps-host",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/McpAppCard.tsx
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
		/**
		* Configure the module-level API used by McpAppCard instances.
		* Called once from the client plugin's `apply` function.
		*/
		function configureMcpAppCard(opts) {
			_sendUserMessage = opts.sendUserMessage;
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
		/**
		* Which MCP server's bridge endpoint this card talks to. `presentationMeta`
		* projects the owning server's name beside the payload, so a card result
		* always carries it; '' is the defensive arm for results the plugin never
		* projected (the bridge cannot be routed then).
		*/
		function readMcpServerName(block) {
			if (isToolResult(block)) {
				const meta = block.meta;
				if (meta && typeof meta.mcpServerName === "string" && meta.mcpServerName !== "") return meta.mcpServerName;
			}
			return "";
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
		/** First text line of a settled result, truncated for the plain row. */
		function firstTextLine(content) {
			for (const part of content) if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
				const line = part.text.split("\n", 1)[0] ?? part.text;
				return line.length > 120 ? `${line.slice(0, 117)}…` : line;
			}
			return "";
		}
		/**
		* Plain row for a tool registered in the card slot whose result carries no
		* MCP Apps payload (mixed-return tools, or the call still running). The keyed
		* slot does not fall back once an entry claims the key, so the component owns
		* its own non-card rendering.
		*/
		function PlainToolRow({ toolName, block }) {
			const settled = isToolResult(block);
			const summary = settled ? firstTextLine(block.content) : "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: "10px",
					alignItems: "center",
					padding: "6px 2px",
					fontSize: "13px"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
						flexShrink: 0,
						width: "6px",
						height: "6px",
						borderRadius: "50%",
						background: settled ? "#9aa0a6" : "#4a90d9"
					} }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							flexShrink: 0,
							fontFamily: "ui-monospace, SFMono-Regular, monospace"
						},
						children: toolName
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							color: "#8a8a8a",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap"
						},
						children: settled ? summary === "" ? "done" : summary : "running…"
					})
				]
			});
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
			const { block, callId, sessionId, toolName } = props;
			const iframeRef = (0, react.useRef)(null);
			const blockRef = (0, react.useRef)(block);
			blockRef.current = block;
			const mcpApp = readMcpApp(block);
			const handleMessage = (0, react.useCallback)(async (event) => {
				if (event.source !== iframeRef.current?.contentWindow) return;
				const msg = event.data;
				if (!msg || typeof msg !== "object" || !("jsonrpc" in msg) || msg.jsonrpc !== "2.0") return;
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
				const serverName = readMcpServerName(blockRef.current);
				if (serverName === "") {
					replyError(-32001, "tool result lacks mcpServerName — bridge cannot be routed");
					return;
				}
				const bridgeUrl = `/mcp-apps/${serverName}/bridge`;
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
							_stagedContext.delete(callId);
							if (staged) try {
								await fetch(bridgeUrl, {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({
										jsonrpc: "2.0",
										method: "ui/inject-context",
										params: {
											sessionId,
											context: staged
										}
									})
								});
							} catch (error) {
								console.error("[mcp-apps-host] context injection failed:", error);
							}
							if (_sendUserMessage !== void 0) try {
								await _sendUserMessage(sessionId, text);
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
						const result = await (await fetch(bridgeUrl, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(outgoingMsg)
						})).json();
						iframeRef.current?.contentWindow?.postMessage(result, "*");
						return;
					}
					if (method === "resources/read") {
						const result = await (await fetch(bridgeUrl, {
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
				const listener = (event) => {
					handleMessage(event);
				};
				window.addEventListener("message", listener);
				return () => {
					window.removeEventListener("message", listener);
				};
			}, [handleMessage]);
			(0, react.useEffect)(() => {
				return () => {
					_lastMessageTime.delete(callId);
					_stagedContext.delete(callId);
				};
			}, [callId]);
			if (!mcpApp) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PlainToolRow, {
				toolName,
				block
			});
			const html = mcpApp.resource?.text;
			if (!html) {
				if (mcpApp.resourceUri) console.debug("[mcp-apps-host] referenced form not yet implemented:", mcpApp.resourceUri);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PlainToolRow, {
					toolName,
					block
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					width: "100%",
					marginTop: "8px"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
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
		//#region src/client/index.ts
		/** Services required: slot registry + sessions (transcript discovery + conversation send). */
		const inject = ["slots", "sessions"];
		/**
		* Mount the MCP Apps card view. No hardcoded server/tool list: the plugin
		* follows the current session's transcript, and the first settled result whose
		* meta carries an MCP Apps payload registers that tool name in the keyed
		* `tool.call.toolview` slot. Store notifications are synchronous while React
		* re-renders after, so even the first card call renders through McpAppCard
		* instead of flashing the generic row; opening a history session works the
		* same way (the restored blocks trigger the registration pass).
		*/
		function apply(ctx) {
			configureMcpAppCard({ sendUserMessage: async (sessionId, text) => {
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
			} });
			const registered = /* @__PURE__ */ new Set();
			/** One transcript node: register its tool result when it carries a card payload. */
			const visit = (node) => {
				if (typeof node !== "object" || node === null) return;
				const n = node;
				if (n.kind === "tool-result") {
					const name = typeof n.call?.name === "string" ? n.call.name : "";
					const meta = n.meta;
					if (name !== "" && meta?.mcpApp != null && !registered.has(name)) {
						registered.add(name);
						ctx.slots.register({
							name: "tool.call.toolview",
							key: name
						}, McpAppCard);
					}
				}
				for (const child of n.subCalls ?? []) visit(child);
				for (const child of n.blocks ?? []) visit(child);
			};
			const sessions = ctx.get("sessions");
			let unsubscribeSession;
			const followCurrent = () => {
				unsubscribeSession?.();
				unsubscribeSession = void 0;
				const current = sessions?.list.getSnapshot().current;
				if (typeof current !== "string") return;
				const session = sessions?.binding(current)?.session;
				if (session === void 0) return;
				const scan = () => {
					for (const node of session.getSnapshot().nodes) visit(node);
				};
				unsubscribeSession = session.subscribe(scan);
				scan();
			};
			const unsubscribeList = sessions?.list.subscribe(followCurrent);
			followCurrent();
			ctx.effect(() => () => {
				unsubscribeList?.();
				unsubscribeSession?.();
			}, "mcp-apps-host: card tool discovery");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map