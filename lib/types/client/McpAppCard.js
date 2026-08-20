import { jsx as _jsx } from "react/jsx-runtime";
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
import { useCallback, useEffect, useRef } from 'react';
// ── Module-level API (set by the client plugin apply) ─────────────────────
/** Sends a user message into the DSH conversation. */
let _sendUserMessage;
/** MCP server name used in the HTTP bridge URL. */
let _serverName = 'utp';
/**
 * Configure the module-level API used by McpAppCard instances.
 * Called once from the client plugin's `apply` function.
 */
export function configureMcpAppCard(opts) {
    _sendUserMessage = opts.sendUserMessage;
    _serverName = opts.serverName;
}
/** Per-card debounce for ui/message (prevents DoS from rapid-fire iframes). */
const MIN_MESSAGE_INTERVAL_MS = 2000;
const _lastMessageTime = new Map();
/** Per-card staged context from ui/update-model-context (prepended to next ui/message). */
const _stagedContext = new Map();
// ── Helpers ────────────────────────────────────────────────────────────────
/** Type guard: is this block a settled tool result? */
function isToolResult(block) {
    return block.kind === 'tool-result';
}
/** Extract the MCP Apps UI payload from the tool result's `meta.mcpApp`. */
function readMcpApp(block) {
    if (!isToolResult(block))
        return null;
    const meta = block.meta;
    if (!meta || typeof meta !== 'object')
        return null;
    return meta.mcpApp ?? null;
}
/** Build a Content-Security-Policy string from the MCP Apps CSP directives. */
function buildCsp(csp) {
    const script = csp?.['script-src']?.join(' ') ?? "'unsafe-inline'";
    const style = csp?.['style-src']?.join(' ') ?? '';
    const img = csp?.['img-src']?.join(' ') ?? '';
    const connect = csp?.['connect-src']?.join(' ') ?? "'none'";
    return [
        "default-src 'none'",
        `script-src ${script}`,
        `style-src 'unsafe-inline'${style ? ' ' + style : ''}`,
        `img-src data: blob: https:${img ? ' ' + img : ''}`,
        'font-src data:',
        `connect-src ${connect}`,
        "base-uri 'none'",
        'form-action *',
    ].join('; ');
}
/** Extract `session_id` from the tool result — prefer structuredContent, fall back to content text. */
function readSessionId(block) {
    // Primary: structuredContent from meta.lastToolResult (set by presentationMeta)
    const meta = block.meta;
    const sc = meta?.lastToolResult?.structuredContent;
    if (sc && typeof sc === 'object') {
        if (typeof sc.session_id === 'string')
            return sc.session_id;
        if (typeof sc.sessionId === 'string')
            return sc.sessionId;
    }
    // Fallback: parse JSON from content text blocks
    for (const content of block.content) {
        if (content.type === 'text') {
            try {
                const json = JSON.parse(content.text);
                if (typeof json === 'object' && json !== null) {
                    const obj = json;
                    if (typeof obj.session_id === 'string')
                        return obj.session_id;
                    if (typeof obj.sessionId === 'string')
                        return obj.sessionId;
                }
            }
            catch {
                // not JSON — skip
            }
        }
    }
    return undefined;
}
/** Extract text from a JSON-RPC params object (handles string | { text } | { content[] }). */
function extractTextContent(params) {
    if (typeof params === 'string')
        return params;
    if (typeof params !== 'object' || params === null)
        return '';
    const p = params;
    if (typeof p.text === 'string')
        return p.text;
    if (Array.isArray(p.content)) {
        return p.content
            .map((c) => (typeof c === 'object' && c !== null && typeof c.text === 'string' ? c.text : ''))
            .filter(Boolean)
            .join('\n');
    }
    return '';
}
// ── Component ──────────────────────────────────────────────────────────────
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
export function McpAppCard(props) {
    const { block, callId, sessionId } = props;
    const iframeRef = useRef(null);
    // Keep the latest block in a ref so the postMessage handler always sees it.
    const blockRef = useRef(block);
    blockRef.current = block;
    const mcpApp = readMcpApp(block);
    const handleMessage = useCallback(async (event) => {
        // Only accept JSON-RPC messages
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0')
            return;
        const { id, method, params } = msg;
        const hasId = id !== undefined;
        const reply = (result) => {
            iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id: id ?? null, result }, '*');
        };
        const replyError = (code, message) => {
            iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, '*');
        };
        try {
            // ── ui/initialize ────────────────────────────────────────────────────
            if (method === 'ui/initialize') {
                const currentBlock = blockRef.current;
                const result = {
                    protocolVersion: '2025-06-18',
                    hostInfo: { name: 'dsh-mcp-apps-host', version: '0.0.1' },
                    hostCapabilities: {
                        updateModelContext: { text: {} },
                        message: { text: {} },
                    },
                };
                if (isToolResult(currentBlock)) {
                    // Prefer structuredContent (passed via presentationMeta as
                    // meta.lastToolResult); fall back to the content text blocks.
                    const meta = currentBlock.meta;
                    result.lastToolResult = meta?.lastToolResult ?? currentBlock.content;
                    result.sessionId = readSessionId(currentBlock);
                }
                reply(result);
                return;
            }
            // ── ui/update-model-context ──────────────────────────────────────────
            // Staged silently; will be prepended to the next user message.
            // For now, acknowledge and log.
            if (method === 'ui/update-model-context') {
                const text = extractTextContent(params);
                if (text) {
                    _stagedContext.set(callId, text);
                }
                if (hasId)
                    reply({});
                return;
            }
            // ── ui/message ───────────────────────────────────────────────────────
            // Sends a user message into the DSH conversation (debounced per card).
            if (method === 'ui/message') {
                const text = extractTextContent(params);
                if (text) {
                    // Per-card debounce
                    const now = Date.now();
                    const last = _lastMessageTime.get(callId) ?? -MIN_MESSAGE_INTERVAL_MS;
                    if (now - last < MIN_MESSAGE_INTERVAL_MS) {
                        if (hasId)
                            reply({});
                        return;
                    }
                    _lastMessageTime.set(callId, now);
                    // Prepend staged context (from ui/update-model-context) if any
                    const staged = _stagedContext.get(callId);
                    const fullText = staged ? `${staged}\n\n${text}` : text;
                    _stagedContext.delete(callId);
                    // Send the user message
                    if (_sendUserMessage !== undefined) {
                        try {
                            await _sendUserMessage(sessionId, fullText);
                        }
                        catch (error) {
                            console.error('[mcp-apps-host] ui/message failed:', error);
                        }
                    }
                }
                if (hasId)
                    reply({});
                return;
            }
            // ── tools/call ──────────────────────────────────────────────────────
            // Forward to the HTTP bridge (with session_id injection if missing).
            if (method === 'tools/call') {
                const p = (params ?? {});
                const args = (p.arguments ?? {});
                // Session ID injection: if the card omits session_id, inject from the last result
                let outgoingMsg = msg;
                if (args.session_id === undefined) {
                    const currentBlock = blockRef.current;
                    if (isToolResult(currentBlock)) {
                        const sid = readSessionId(currentBlock);
                        if (sid) {
                            outgoingMsg = {
                                ...msg,
                                params: { ...p, arguments: { ...args, session_id: sid } },
                            };
                        }
                    }
                }
                const response = await fetch(`/mcp-apps/${_serverName}/bridge`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(outgoingMsg),
                });
                const result = await response.json();
                iframeRef.current?.contentWindow?.postMessage(result, '*');
                return;
            }
            // ── resources/read ──────────────────────────────────────────────────
            // Forward to the HTTP bridge (security gate: ui:// prefix only).
            if (method === 'resources/read') {
                const response = await fetch(`/mcp-apps/${_serverName}/bridge`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(msg),
                });
                const result = await response.json();
                iframeRef.current?.contentWindow?.postMessage(result, '*');
                return;
            }
            replyError(-32601, `method not supported: ${method ?? '(none)'}`);
        }
        catch (error) {
            replyError(-32603, `internal error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, [callId, sessionId]);
    useEffect(() => {
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [handleMessage]);
    // Cleanup debounce + staged context entries on unmount
    useEffect(() => {
        return () => {
            _lastMessageTime.delete(callId);
            _stagedContext.delete(callId);
        };
    }, [callId]);
    // Don't render if no MCP Apps payload (fall back to default tool row)
    if (!mcpApp)
        return null;
    // Inline form: extract HTML from resource.text
    const html = mcpApp.resource?.text;
    if (!html) {
        // Referenced form (resourceUri) not yet implemented — log and fall back
        if (mcpApp.resourceUri) {
            console.debug('[mcp-apps-host] referenced form not yet implemented:', mcpApp.resourceUri);
        }
        return null;
    }
    const csp = buildCsp(mcpApp.csp);
    const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,sans-serif;padding:12px}</style></head><body>${html}</body></html>`;
    return (_jsx("div", { style: { width: '100%', marginTop: '8px' }, children: _jsx("iframe", { ref: iframeRef, sandbox: "allow-scripts allow-forms allow-popups", srcDoc: srcDoc, style: {
                width: '100%',
                height: '400px',
                border: '1px solid #e0e0e0',
                borderRadius: '8px',
            }, title: mcpApp.resource?.uri ?? 'mcp-app' }) }));
}
//# sourceMappingURL=McpAppCard.js.map