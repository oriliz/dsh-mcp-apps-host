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

import { useCallback, useEffect, useRef } from 'react'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

// ── Module-level API (set by the client plugin apply) ─────────────────────

/** Sends a user message into the DSH conversation. */
let _sendUserMessage: ((sessionId: string, text: string) => Promise<void>) | undefined
/** MCP server name used in the HTTP bridge URL. */
let _serverName = 'utp'

/**
 * Configure the module-level API used by McpAppCard instances.
 * Called once from the client plugin's `apply` function.
 */
export function configureMcpAppCard(opts: {
  sendUserMessage: (sessionId: string, text: string) => Promise<void>
  serverName: string
}): void {
  _sendUserMessage = opts.sendUserMessage
  _serverName = opts.serverName
}

// ── Types ──────────────────────────────────────────────────────────────────

/** MCP Apps UI payload (the `_meta.ui` object projected by `presentationMeta`). */
interface McpAppPayload {
  /** Inline form: the HTML resource. */
  resource?: { uri?: string; mimeType?: string; text?: string }
  /** Referenced form: a `ui://` URI (not yet implemented — inline only for now). */
  resourceUri?: string
  /** Content Security Policy directives. */
  csp?: Record<string, string[]>
}

/** Per-card debounce for ui/message (prevents DoS from rapid-fire iframes). */
const MIN_MESSAGE_INTERVAL_MS = 2000
const _lastMessageTime = new Map<string, number>()
/** Per-card staged context from ui/update-model-context (prepended to next ui/message). */
const _stagedContext = new Map<string, string>()

// ── Helpers ────────────────────────────────────────────────────────────────

/** Type guard: is this block a settled tool result? */
function isToolResult(block: ToolCallBlock): block is ToolResultNode {
  return (block as ToolResultNode).kind === 'tool-result'
}

/** Extract the MCP Apps UI payload from the tool result's `meta.mcpApp`. */
function readMcpApp(block: ToolCallBlock): McpAppPayload | null {
  if (!isToolResult(block)) return null
  const meta = (block as ToolResultNode).meta as { mcpApp?: McpAppPayload } | undefined | null
  if (!meta || typeof meta !== 'object') return null
  return meta.mcpApp ?? null
}

/** Build a Content-Security-Policy string from the MCP Apps CSP directives. */
function buildCsp(csp: Record<string, string[]> | undefined): string {
  const script = csp?.['script-src']?.join(' ') ?? "'unsafe-inline'"
  const style = csp?.['style-src']?.join(' ') ?? ''
  const img = csp?.['img-src']?.join(' ') ?? ''
  const connect = csp?.['connect-src']?.join(' ') ?? "'none'"
  return [
    "default-src 'none'",
    `script-src ${script}`,
    `style-src 'unsafe-inline'${style ? ' ' + style : ''}`,
    `img-src data: blob: https:${img ? ' ' + img : ''}`,
    'font-src data:',
    `connect-src ${connect}`,
    "base-uri 'none'",
    'form-action *',
  ].join('; ')
}

/** Extract `session_id` from the tool result — prefer structuredContent, fall back to content text. */
function readSessionId(block: ToolResultNode): string | undefined {
  // Primary: structuredContent from meta.lastToolResult (set by presentationMeta)
  const meta = block.meta as { lastToolResult?: { structuredContent?: Record<string, unknown> } } | undefined
  const sc = meta?.lastToolResult?.structuredContent
  if (sc && typeof sc === 'object') {
    if (typeof sc.session_id === 'string') return sc.session_id
    if (typeof sc.sessionId === 'string') return sc.sessionId
  }
  // Fallback: parse JSON from content text blocks
  for (const content of block.content) {
    if (content.type === 'text') {
      try {
        const json = JSON.parse(content.text) as unknown
        if (typeof json === 'object' && json !== null) {
          const obj = json as Record<string, unknown>
          if (typeof obj.session_id === 'string') return obj.session_id
          if (typeof obj.sessionId === 'string') return obj.sessionId
        }
      } catch {
        // not JSON — skip
      }
    }
  }
  return undefined
}

/** Extract text from a JSON-RPC params object (handles string | { text } | { content[] }). */
function extractTextContent(params: unknown): string {
  if (typeof params === 'string') return params
  if (typeof params !== 'object' || params === null) return ''
  const p = params as Record<string, unknown>
  if (typeof p.text === 'string') return p.text
  if (Array.isArray(p.content)) {
    return p.content
      .map((c: unknown) => (typeof c === 'object' && c !== null && typeof (c as Record<string, unknown>).text === 'string' ? (c as Record<string, unknown>).text as string : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
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
export function McpAppCard(props: ToolCallViewProps): JSX.Element | null {
  const { block, callId, sessionId } = props
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Keep the latest block in a ref so the postMessage handler always sees it.
  const blockRef = useRef(block)
  blockRef.current = block

  const mcpApp = readMcpApp(block)

  const handleMessage = useCallback(async (event: MessageEvent) => {
    // Only accept JSON-RPC messages
    const msg = event.data
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return

    const { id, method, params } = msg as { jsonrpc: string; id?: string | number; method?: string; params?: unknown }
    const hasId = id !== undefined

    const reply = (result: unknown): void => {
      iframeRef.current?.contentWindow?.postMessage(
        { jsonrpc: '2.0', id: id ?? null, result },
        '*',
      )
    }
    const replyError = (code: number, message: string): void => {
      iframeRef.current?.contentWindow?.postMessage(
        { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
        '*',
      )
    }

    try {
      // ── ui/initialize ────────────────────────────────────────────────────
      if (method === 'ui/initialize') {
        const currentBlock = blockRef.current
        const result: Record<string, unknown> = {
          protocolVersion: '2025-06-18',
          hostInfo: { name: 'dsh-mcp-apps-host', version: '0.0.1' },
          hostCapabilities: {
            updateModelContext: { text: {} },
            message: { text: {} },
          },
        }
        if (isToolResult(currentBlock)) {
          // Prefer structuredContent (passed via presentationMeta as
          // meta.lastToolResult); fall back to the content text blocks.
          const meta = currentBlock.meta as { lastToolResult?: unknown } | undefined
          result.lastToolResult = meta?.lastToolResult ?? currentBlock.content
          result.sessionId = readSessionId(currentBlock)
        }
        reply(result)
        return
      }

      // ── ui/update-model-context ──────────────────────────────────────────
      // Staged silently; will be prepended to the next user message.
      // For now, acknowledge and log.
      if (method === 'ui/update-model-context') {
        const text = extractTextContent(params)
        if (text) {
          _stagedContext.set(callId, text)
        }
        if (hasId) reply({})
        return
      }

      // ── ui/message ───────────────────────────────────────────────────────
      // Sends a user message into the DSH conversation (debounced per card).
      if (method === 'ui/message') {
        const text = extractTextContent(params)
        if (text) {
          // Per-card debounce
          const now = Date.now()
          const last = _lastMessageTime.get(callId) ?? -MIN_MESSAGE_INTERVAL_MS
          if (now - last < MIN_MESSAGE_INTERVAL_MS) {
            if (hasId) reply({})
            return
          }
          _lastMessageTime.set(callId, now)

          // Inject staged context (from ui/update-model-context) invisibly via
          // the bridge before sending the visible user message. The context is
          // plugin-sourced (source: { kind: 'plugin' }) so the UI classifies it
          // as a collapsed context row, not a visible user message bubble.
          const staged = _stagedContext.get(callId)
          _stagedContext.delete(callId)

          if (staged) {
            try {
              await fetch(`/mcp-apps/${_serverName}/bridge`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'ui/inject-context',
                  params: { sessionId, context: staged },
                }),
              })
            } catch (error) {
              console.error('[mcp-apps-host] context injection failed:', error)
            }
          }

          // Send the visible user message (text only, no context prepended)
          if (_sendUserMessage !== undefined) {
            try {
              await _sendUserMessage(sessionId, text)
            } catch (error) {
              console.error('[mcp-apps-host] ui/message failed:', error)
            }
          }
        }
        if (hasId) reply({})
        return
      }

      // ── tools/call ──────────────────────────────────────────────────────
      // Forward to the HTTP bridge (with session_id injection if missing).
      if (method === 'tools/call') {
        const p = (params ?? {}) as Record<string, unknown>
        const args = (p.arguments ?? {}) as Record<string, unknown>

        // Session ID injection: if the card omits session_id, inject from the last result
        let outgoingMsg = msg as Record<string, unknown>
        if (args.session_id === undefined) {
          const currentBlock = blockRef.current
          if (isToolResult(currentBlock)) {
            const sid = readSessionId(currentBlock)
            if (sid) {
              outgoingMsg = {
                ...msg as Record<string, unknown>,
                params: { ...p, arguments: { ...args, session_id: sid } },
              }
            }
          }
        }

        const response = await fetch(`/mcp-apps/${_serverName}/bridge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(outgoingMsg),
        })
        const result = await response.json()
        iframeRef.current?.contentWindow?.postMessage(result, '*')
        return
      }

      // ── resources/read ──────────────────────────────────────────────────
      // Forward to the HTTP bridge (security gate: ui:// prefix only).
      if (method === 'resources/read') {
        const response = await fetch(`/mcp-apps/${_serverName}/bridge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(msg),
        })
        const result = await response.json()
        iframeRef.current?.contentWindow?.postMessage(result, '*')
        return
      }

      replyError(-32601, `method not supported: ${method ?? '(none)'}`)
    } catch (error: unknown) {
      replyError(-32603, `internal error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [callId, sessionId])

  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  // Cleanup debounce + staged context entries on unmount
  useEffect(() => {
    return () => {
      _lastMessageTime.delete(callId)
      _stagedContext.delete(callId)
    }
  }, [callId])

  // Don't render if no MCP Apps payload (fall back to default tool row)
  if (!mcpApp) return null

  // Inline form: extract HTML from resource.text
  const html = mcpApp.resource?.text
  if (!html) {
    // Referenced form (resourceUri) not yet implemented — log and fall back
    if (mcpApp.resourceUri) {
      console.debug('[mcp-apps-host] referenced form not yet implemented:', mcpApp.resourceUri)
    }
    return null
  }

  const csp = buildCsp(mcpApp.csp)
  const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,sans-serif;padding:12px}</style></head><body>${html}</body></html>`

  return (
    <div style={{ width: '100%', marginTop: '8px' }}>
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-forms allow-popups"
        srcDoc={srcDoc}
        style={{
          width: '100%',
          height: '400px',
          border: '1px solid #e0e0e0',
          borderRadius: '8px',
        }}
        title={mcpApp.resource?.uri ?? 'mcp-app'}
      />
    </div>
  )
}
