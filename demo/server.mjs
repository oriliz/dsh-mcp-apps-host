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
 * Shared card shell: app-window styling + the card-side bridge script. Speaks
 * JSON-RPC over postMessage with the DSH host (McpAppCard), mirrors the latest
 * protocol exchange into a one-line status bar, and exposes `rpc()` /
 * `statusLine()` to card logic. Cards set their theme via --brand CSS vars.
 */
function bridgeScript({ icon, title, sub, body }) {
  return `
<style>
  html,body{height:100%}
  body{padding:0 !important;overflow:hidden}
  .app{display:flex;flex-direction:column;height:100%;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(15,23,42,.10),0 10px 28px rgba(15,23,42,.07);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#fff}
  .app header{display:flex;align-items:center;gap:11px;padding:11px 16px;color:#fff;background:linear-gradient(135deg,var(--brand),var(--brand2))}
  .app header .icon{font-size:19px;line-height:1}
  .app header .title{font-size:13.5px;font-weight:650;letter-spacing:.2px}
  .app header .sub{font-size:10.5px;opacity:.82;margin-top:2px}
  .badge{margin-left:auto;flex-shrink:0;font-size:10px;font-weight:600;letter-spacing:.6px;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.20);border:1px solid rgba(255,255,255,.35);text-transform:uppercase}
  .app main{flex:1;display:flex;flex-direction:column;justify-content:center;gap:13px;padding:14px 16px}
  .metrics{display:flex;gap:14px;align-items:stretch}
  .metric{flex:0 0 138px;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:10px;background:var(--tint);border:1px solid var(--tintline);padding:14px 8px}
  .metric .num{font-size:40px;font-weight:750;color:var(--brand);font-variant-numeric:tabular-nums;line-height:1.05}
  .metric .label{font-size:9.5px;font-weight:650;letter-spacing:1.1px;text-transform:uppercase;color:#6b7280;margin-top:6px}
  .side{flex:1;display:flex;flex-direction:column;gap:8px;justify-content:center;min-width:0}
  .note{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:7px 10px;font-size:11.5px;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .note span{color:#94a3b8;font-size:9.5px;letter-spacing:.5px;text-transform:uppercase;font-weight:650;margin-right:6px}
  .kv{display:flex;align-items:center;gap:7px;font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden}
  .kv b{color:#334155;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
  .dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .dot.ok{background:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.15)}
  .dot.err{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.15)}
  .chips{display:flex;gap:6px;flex-wrap:wrap}
  .chip{font-size:10px;font-weight:600;padding:2.5px 9px;border-radius:999px;background:var(--tint);color:var(--brand);border:1px solid var(--tintline);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  button{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 12px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid #d1d5db;background:#fff;color:#374151;cursor:pointer;transition:all .15s;min-width:0}
  button:hover{background:#f8fafc;border-color:#9ca3af}
  button.primary{background:var(--brand);border-color:var(--brand);color:#fff}
  button.primary:hover{background:var(--brand2);border-color:var(--brand2)}
  button.danger{border-color:#fca5a5;color:#dc2626}
  button.danger:hover{background:#fef2f2;border-color:#f87171}
  .statusbar{flex-shrink:0;background:#0f172a;color:#94a3b8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1;padding:10px 14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .statusbar.ok{color:#34d399}
  .statusbar.err{color:#f87171}
</style>
<div class="app">
  <header>
    <span class="icon">${icon}</span>
    <div><div class="title">${title}</div><div class="sub">${sub}</div></div>
    <span class="badge">MCP App</span>
  </header>
  <main>${body}</main>
  <footer class="statusbar" id="status">connecting…</footer>
</div>
<script>
(function(){
  var pending = new Map(), nextId = 1, statusEl = document.getElementById('status')
  function statusLine(line, cls){
    statusEl.textContent = line
    statusEl.className = 'statusbar' + (cls ? ' ' + cls : '')
  }
  window.statusLine = statusLine
  window.rpc = function(method, params){
    var id = nextId++
    window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*')
    statusLine('\\u2192 ' + method + ' #' + id)
    return new Promise(function(resolve){
      pending.set(id, function(msg){
        if (msg.error) statusLine('\\u2190 #' + id + ' error: ' + msg.error.message, 'err')
        else statusLine('\\u2190 #' + id + ' ok', 'ok')
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
})()
</script>`
}

/** Interactive card: lastToolResult rendering + tools/call + ui/* channels. */
function interactiveCardHtml() {
  return `<!-- MCP Apps inline-form card: HTML lives in the tool RESULT's _meta.ui.resource.text -->
<style>
  :root{--brand:#4f46e5;--brand2:#7c3aed;--tint:#eef2ff;--tintline:#e0e7ff}
</style>
${bridgeScript({
  icon: '🎛️',
  title: 'MCP Apps interactive demo',
  sub: "inline form — HTML rides the tool result's _meta.ui.resource.text",
  body: `
  <div class="metrics">
    <div class="metric"><div class="num" id="count">–</div><div class="label">counter</div></div>
    <div class="side">
      <div class="note"><span>note</span><b id="note"></b></div>
      <div class="kv"><span class="dot ok"></span>host session <b id="sid">–</b></div>
      <div class="kv"><span class="dot" id="injdot"></span>session_id auto-injected <b id="inj">–</b></div>
    </div>
  </div>
  <div class="chips"><span class="chip">ui/initialize</span><span class="chip">tools/call</span><span class="chip">ui/message</span></div>
  <div class="row">
    <button class="primary" id="b1">↻ Refresh via tools/call</button>
    <button id="b2">✉ Message the model</button>
  </div>`,
})}
<script>
(function(){
  var state = { count: 0, note: '', sessionId: null, received: false }
  var els = {
    count: document.getElementById('count'),
    note: document.getElementById('note'),
    sid: document.getElementById('sid'),
    inj: document.getElementById('inj'),
    injdot: document.getElementById('injdot'),
  }
  function render(){
    els.count.textContent = String(state.count)
    els.note.textContent = state.note || '(none)'
    els.sid.textContent = state.sessionId || '(none)'
    els.inj.textContent = state.received ? 'yes' : 'no'
    els.injdot.className = 'dot ' + (state.received ? 'ok' : 'err')
  }
  render()
  rpc('ui/initialize').then(function(msg){
    var r = msg.result || {}
    state.sessionId = r.sessionId || null
    var sc = (r.lastToolResult && r.lastToolResult.structuredContent) || {}
    state.count = typeof sc.count === 'number' ? sc.count : 0
    state.note = typeof sc.note === 'string' ? sc.note : ''
    state.received = !!sc.received_session_id
    render()
    statusLine('ui/initialize \\u2713 structuredContent injected (count=' + state.count + ')', 'ok')
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
<style>
  :root{--brand:#0d9488;--brand2:#0284c7;--tint:#f0fdfa;--tintline:#ccfbf1}
  .resline{display:flex;align-items:center;gap:9px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:9px 12px}
  .resline .resicon{font-size:13px}
  .resline code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:600;color:var(--brand);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .explain{font-size:12px;line-height:1.6;color:#475569}
  .explain b{color:#0f172a}
  .explain code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;background:#f1f5f9;padding:1px 5px;border-radius:4px;color:#334155}
</style>
${bridgeScript({
  icon: '📦',
  title: 'MCP Apps referenced-form demo',
  sub: "referenced form — HTML fetched from the tool definition's _meta.ui.resourceUri",
  body: `
  <div class="resline"><span class="resicon">🔗</span><code id="src">${REFERENCED_URI}</code></div>
  <p class="explain">This card's HTML was <b>not</b> in the tool result. The host fetched the <code>ui://</code> resource above via <code>resources/read</code> and inlined it into this sandboxed iframe.</p>
  <div class="chips"><span class="chip">resources/read</span><span class="chip">ui:// gate</span></div>
  <div class="row">
    <button class="primary" id="b1">⬇ Read ui:// resource</button>
    <button class="danger" id="b2">🛡 Try blocked URI</button>
  </div>`,
})}
<script>
(function(){
  rpc('ui/initialize').then(function(msg){
    var sc = (msg.result && msg.result.lastToolResult && msg.result.lastToolResult.structuredContent) || {}
    document.getElementById('src').textContent = sc.source || '${REFERENCED_URI}'
    statusLine('ui/initialize \\u2713 rendered from referenced resource', 'ok')
  })
  document.getElementById('b1').onclick = function(){
    rpc('resources/read', { uri: '${REFERENCED_URI}' }).then(function(msg){
      if (!msg.error) statusLine('allowed \\u2713 ' + msg.result.contents[0].text.length + ' bytes of HTML served', 'ok')
    })
  }
  document.getElementById('b2').onclick = function(){
    rpc('resources/read', { uri: 'file:///etc/passwd' }).then(function(msg){
      if (msg.error) statusLine('blocked \\u2717 ui://-only security gate \\u2014 ' + msg.error.message, 'err')
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
