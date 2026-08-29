#!/usr/bin/env node
/**
 * MCP Apps demo server — a zero-dependency MCP server (newline-delimited
 * JSON-RPC over stdio) for testing and demonstrating
 * @deepseek-ai/dsh-mcp-apps-host.
 *
 * It exposes two tools that exercise every host capability:
 *
 * - `demo_interactive` (inline form): the tool RESULT carries
 *   `_meta.ui.resource.text` HTML. The card renders data injected from
 *   `structuredContent` (via the `ui/initialize` handshake), refreshes itself
 *   through `tools/call`, and can stage `ui/update-model-context` + send
 *   `ui/message` into the conversation.
 *
 * - `demo_referenced` (referenced form): the tool DEFINITION carries
 *   `_meta.ui.resourceUri`; the result carries no `_meta` at all. The host
 *   fetches `ui://demo/referenced-card` through `resources/read` and inlines
 *   the HTML. The card also demonstrates the `ui://`-only resources/read
 *   security gate (a blocked URI returns a JSON-RPC error).
 *
 * Run standalone (any MCP client) or through DSH:
 *   dsh web --patch demo/mcp-apps-demo.cordis.yml   # from the repo root
 *
 * @module demo/server.mjs
 */

import { createInterface } from 'node:readline'

const SERVER_INFO = { name: 'dsh-mcp-apps-demo', version: '0.1.0' }
const REFERENCED_URI = 'ui://demo/referenced-card'
const HTML_MIME = 'text/html;profile=mcp-app'

// ── Card HTML ───────────────────────────────────────────────────────────────

/**
 * Shared card-side bridge script. Speaks JSON-RPC over postMessage with the
 * DSH host (McpAppCard), logs every message, and exposes `rpc()` to card
 * logic. Inline `render()`-style JS is avoided; this is plain script.
 */
function bridgeScript() {
  return `
<style>
  body{font-family:system-ui,-apple-system,sans-serif;color:#1f2937;font-size:13px}
  h2{font-size:14px;margin:0 0 8px}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
  button{padding:6px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer}
  button:hover{background:#f3f4f6}
  .tag{display:inline-block;padding:2px 8px;border-radius:999px;background:#eef2ff;color:#4338ca;font-size:11px;margin-right:6px}
  .kv{margin:2px 0;color:#374151}
  .kv b{color:#111827}
  pre{background:#0f172a;color:#e2e8f0;border-radius:6px;padding:8px;font-size:11px;max-height:140px;overflow:auto;margin:8px 0 0;white-space:pre-wrap}
  .ok{color:#059669}.err{color:#dc2626}
</style>
<div id="app"></div>
<pre id="log"></pre>
<script>
(function(){
  var pending = new Map(), nextId = 1, logEl = document.getElementById('log')
  function log(line, cls){ logEl.textContent += line + '\\n'; logEl.scrollTop = logEl.scrollHeight }
  window.rpc = function(method, params){
    var id = nextId++
    window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*')
    log('> ' + method + ' #' + id)
    return new Promise(function(resolve){
      pending.set(id, function(msg){
        var ms = msg.error ? 'err' : 'ok'
        log('< #' + id + ' ' + (msg.error ? 'ERROR ' + msg.error.message : 'ok'), ms)
        resolve(msg)
      })
    })
  }
  window.addEventListener('message', function(e){
    var msg = e.data
    if (!msg || msg.jsonrpc !== '2.0' || msg.id === undefined) return
    var settle = pending.get(msg.id)
    if (settle) { pending.delete(msg.id); settle(msg) }
  })
  window.log = log
})()
</script>`
}

/** Interactive card: lastToolResult rendering + tools/call + ui/* channels. */
function interactiveCardHtml() {
  return `<!-- MCP Apps inline-form card: HTML lives in the tool RESULT's _meta.ui.resource.text -->
<div>
  <h2>🎛 MCP Apps interactive demo</h2>
  <span class="tag">inline form</span><span class="tag">tools/call</span><span class="tag">ui/message</span>
  <div id="state"></div>
  <div class="row">
    <button id="b1">Call demo_interactive via bridge (tools/call)</button>
    <button id="b2">Stage context + message the model</button>
  </div>
</div>
${bridgeScript()}
<script>
(function(){
  var state = { count: 0, note: '', sessionId: null }
  function render(){
    document.getElementById('state').innerHTML =
      '<p class="kv">count: <b>' + state.count + '</b> · note: <b>' + (state.note || '(none)') + '</b></p>' +
      '<p class="kv">host sessionId: <b>' + (state.sessionId || '(none)') + '</b> · session_id auto-injected on bridge calls: <b class="' + (state.received ? 'ok">yes' : 'err">no') + '</b></p>'
  }
  rpc('ui/initialize').then(function(msg){
    var r = msg.result || {}
    state.sessionId = r.sessionId || null
    var sc = (r.lastToolResult && r.lastToolResult.structuredContent) || {}
    state.count = typeof sc.count === 'number' ? sc.count : 0
    state.note = typeof sc.note === 'string' ? sc.note : ''
    state.received = !!sc.received_session_id
    render()
    log('ui/initialize ok — lastToolResult.structuredContent injected', 'ok')
  })
  document.getElementById('b1').onclick = function(){
    rpc('tools/call', { name: 'demo_interactive', arguments: { count: state.count + 1, note: state.note || 'refreshed from card' } })
      .then(function(msg){
        if (msg.error) return
        var sc = (msg.result && msg.result.structuredContent) || {}
        state.count = typeof sc.count === 'number' ? sc.count : state.count
        state.note = sc.note || state.note
        state.received = !!sc.received_session_id
        render()
      })
  }
  document.getElementById('b2').onclick = function(){
    rpc('ui/update-model-context', { text: 'Demo card state: count=' + state.count + ', note=' + (state.note || 'none') })
      .then(function(){
        return rpc('ui/message', { text: 'Hello from the MCP Apps demo card — the counter is at ' + state.count + '. Please acknowledge this card message.' })
      })
  }
})()
</script>`
}

/** Referenced card: HTML served from a ui:// resource; also demos the security gate. */
function referencedCardHtml() {
  return `<!-- MCP Apps referenced-form card: HTML fetched by the host from ${REFERENCED_URI} -->
<div>
  <h2>📦 MCP Apps referenced-form demo</h2>
  <span class="tag">resourceUri</span><span class="tag">resources/read</span><span class="tag">ui:// gate</span>
  <div id="state"></div>
  <div class="row">
    <button id="b1">Read ${REFERENCED_URI}</button>
    <button id="b2">Try blocked URI (file:///etc/passwd)</button>
  </div>
</div>
${bridgeScript()}
<script>
(function(){
  rpc('ui/initialize').then(function(msg){
    var sc = (msg.result && msg.result.lastToolResult && msg.result.lastToolResult.structuredContent) || {}
    document.getElementById('state').innerHTML =
      '<p class="kv">This card&apos;s HTML was NOT in the tool result. The host fetched <b>' + (sc.source || REFERENCED_URI) + '</b> via resources/read and inlined it.</p>'
    log('ui/initialize ok — rendered from referenced resource', 'ok')
  })
  document.getElementById('b1').onclick = function(){
    rpc('resources/read', { uri: '${REFERENCED_URI}' }).then(function(msg){
      if (!msg.error) log('allowed: ' + (msg.result.contents[0].text.length) + ' bytes of HTML served', 'ok')
    })
  }
  document.getElementById('b2').onclick = function(){
    rpc('resources/read', { uri: 'file:///etc/passwd' }).then(function(msg){
      if (msg.error) log('blocked by host security gate: ' + msg.error.message, 'err')
    })
  }
})()
</script>`
}

// ── Tool table ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'demo_interactive',
    description:
      'MCP Apps demo (inline form): returns an interactive HTML card via _meta.ui.resource.text. '
      + 'The card reads structuredContent through ui/initialize, refreshes itself via tools/call, '
      + 'and can send ui/message into the conversation. Call this with no arguments for the default demo.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Free-form note shown on the card.' },
        count: { type: 'number', description: 'Counter value to display (card increments it on refresh).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'demo_referenced',
    description:
      'MCP Apps demo (referenced form): the tool definition carries _meta.ui.resourceUri and the result '
      + 'carries NO _meta — the host fetches the card HTML from the ui:// resource via resources/read. '
      + 'The card demonstrates the ui://-only resources/read security gate. Call with no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { ui: { resourceUri: REFERENCED_URI } },
  },
]

const RESOURCES = [
  { uri: REFERENCED_URI, name: 'referenced-card', mimeType: HTML_MIME, text: referencedCardHtml() },
]

// ── Tool handlers ───────────────────────────────────────────────────────────

const TOOL_HANDLERS = {
  /** Inline-form card: HTML rides the tool result's _meta.ui. */
  demo_interactive(args) {
    const count = typeof args.count === 'number' && args.count >= 0 ? Math.floor(args.count) : 0
    const note = typeof args.note === 'string' ? args.note : 'hello from the model-side call'
    return {
      content: [{ type: 'text', text: `Interactive demo card rendered (count=${count}, note="${note}").` }],
      structuredContent: {
        count,
        note,
        // The host reads session_id from structuredContent and injects it into
        // every bridge tools/call the card makes (when the card omits it).
        session_id: 'demo-session',
        // Echoes whether this call arrived WITH a session_id (bridge calls do).
        received_session_id: typeof args.session_id === 'string' ? args.session_id : null,
      },
      _meta: {
        ui: {
          resource: {
            uri: 'ui://demo/interactive-card',
            mimeType: HTML_MIME,
            text: interactiveCardHtml(),
          },
        },
      },
    }
  },
  /** Referenced-form card: no _meta on the result; the host resolves resourceUri. */
  demo_referenced() {
    return {
      content: [{ type: 'text', text: 'Referenced-form demo card rendered.' }],
      structuredContent: { source: REFERENCED_URI },
    }
  },
}

// ── JSON-RPC plumbing (newline-delimited over stdio) ────────────────────────

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

const METHODS = {
  initialize(params) {
    return {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      serverInfo: SERVER_INFO,
    }
  },
  ping() {
    return {}
  },
  'tools/list'() {
    return { tools: TOOLS }
  },
  'tools/call'(params) {
    const handler = TOOL_HANDLERS[params?.name]
    if (handler === undefined) {
      throw Object.assign(new Error(`unknown tool: ${params?.name}`), { code: -32602 })
    }
    return handler(params?.arguments ?? {})
  },
  'resources/list'() {
    return { resources: RESOURCES.map(({ uri, name, mimeType }) => ({ uri, name, mimeType })) }
  },
  'resources/read'(params) {
    const resource = RESOURCES.find(r => r.uri === params?.uri)
    if (resource === undefined) {
      throw Object.assign(new Error(`unknown resource: ${params?.uri}`), { code: -32602 })
    }
    return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }] }
  },
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  if (message === null || typeof message !== 'object' || typeof message.method !== 'string') return
  // Notifications (no id) are acknowledged by silence.
  if (message.id === undefined) return
  const handler = METHODS[message.method]
  if (handler === undefined) {
    replyError(message.id, -32601, `method not found: ${message.method}`)
    return
  }
  try {
    reply(message.id, handler(message.params))
  } catch (error) {
    replyError(message.id, error?.code ?? -32603, String(error?.message ?? error))
  }
})

process.on('SIGTERM', () => process.exit(0))
console.error(`[${SERVER_INFO.name}] MCP Apps demo server on stdio (2 tools, ${RESOURCES.length} ui:// resource)`)
