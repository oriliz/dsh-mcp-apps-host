#!/usr/bin/env node
/**
 * Self-check for the MCP Apps demo server: spawns demo/server.mjs over stdio
 * and asserts every contract the dsh-mcp-apps-host plugin relies on —
 * the ui extension handshake, both card forms, structuredContent shaping,
 * and the ui:// resource table.
 *
 *   node demo/selftest.mjs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url))
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] })

let nextId = 1
const pending = new Map()
const buffer = { text: '' }
child.stdout.on('data', (chunk) => {
  buffer.text += chunk.toString()
  let newline
  while ((newline = buffer.text.indexOf('\n')) !== -1) {
    const line = buffer.text.slice(0, newline)
    buffer.text = buffer.text.slice(newline + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})

/** Send one JSON-RPC request and await the response object. */
async function rpc(method, params) {
  const id = nextId++
  const response = new Promise(resolve => pending.set(id, resolve))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return response
}

try {
  // 1. Handshake — the host declares the ui extension with mimeTypes.
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
    clientInfo: { name: 'selftest', version: '0.0.0' },
  })
  assert.equal(init.result.serverInfo.name, 'dsh-mcp-apps-demo')
  assert.ok(init.result.capabilities.tools)
  assert.ok(init.result.capabilities.resources)

  // 2. Tool discovery — referenced form carries _meta.ui.resourceUri.
  const list = await rpc('tools/list')
  const tools = list.result.tools
  assert.equal(tools.length, 2)
  const interactive = tools.find(t => t.name === 'demo_interactive')
  const referenced = tools.find(t => t.name === 'demo_referenced')
  assert.ok(interactive, 'demo_interactive listed')
  assert.ok(referenced, 'demo_referenced listed')
  assert.equal(referenced._meta?.ui?.resourceUri, 'ui://demo/referenced-card')
  assert.equal(interactive._meta, undefined, 'inline-form tool keeps its definition free of ui meta')

  // 3. Inline-form call — HTML + structuredContent ride the result's _meta.ui.
  const call = await rpc('tools/call', { name: 'demo_interactive', arguments: {} })
  const ui = call.result._meta?.ui
  assert.ok(ui?.resource?.text?.includes('MCP Apps interactive demo'), 'inline HTML present')
  assert.equal(ui.resource.mimeType, 'text/html;profile=mcp-app')
  assert.equal(call.result.structuredContent.session_id, 'demo-session')
  assert.equal(call.result.structuredContent.received_session_id, null, 'no session_id on first call')

  // 4. Bridge-style call — the host injects session_id; the card shows the echo.
  const refresh = await rpc('tools/call', {
    name: 'demo_interactive',
    arguments: { count: 3, note: 'x', session_id: 'demo-session' },
  })
  assert.equal(refresh.result.structuredContent.count, 3)
  assert.equal(refresh.result.structuredContent.received_session_id, 'demo-session')

  // 5. Referenced-form call — the result carries NO _meta; the host resolves the URI.
  const refCall = await rpc('tools/call', { name: 'demo_referenced', arguments: {} })
  assert.equal(refCall.result._meta, undefined, 'referenced-form result has no _meta')

  // 6. resources/read — the ui:// card HTML the host inlines.
  const resource = await rpc('resources/read', { uri: 'ui://demo/referenced-card' })
  assert.ok(resource.result.contents[0].text.includes('MCP Apps referenced-form demo'))

  // 7. Unknown resource — a protocol error, not a crash.
  const missing = await rpc('resources/read', { uri: 'ui://demo/nope' })
  assert.ok(missing.error)

  // 8. Unknown tool — protocol error.
  const unknownTool = await rpc('tools/call', { name: 'nope', arguments: {} })
  assert.ok(unknownTool.error)

  console.log('demo server selftest: all 8 checks passed')
} finally {
  child.kill()
}
