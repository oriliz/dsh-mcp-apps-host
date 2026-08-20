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

import { createHash, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import zz from '@deepseek-ai/schemastery'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition, ToolExecution, JsonSchemaNode, JsonValue } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

// ── Public types ───────────────────────────────────────────────────────────

/** Canonical MCP result exposed to programmatic callers with `_meta` intact. */
export type McpAppsResult = {
  content: JsonValue[]
  structuredContent?: JsonValue
  /** Preserved `_meta` from the MCP `tools/call` result — carries `ui` payload. */
  _meta?: Record<string, unknown>
}

// ── Config ─────────────────────────────────────────────────────────────────

/** Config for connecting via stdio. */
export interface StdioConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  toolCallTimeoutMs: number
}

/** Config for connecting via Streamable HTTP. */
export interface StreamableHttpConfig {
  transport: 'streamable-http'
  serverName: string
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number
}

export type Config = StdioConfig | StreamableHttpConfig

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export const Config = zz.union([
  zz.object({
    transport: zz.const('stdio'),
    serverName: zz.string().required().pattern(SERVER_NAME_PATTERN),
    command: zz.string().required(),
    args: zz.array(String).default([]),
    env: zz.dict(String).default({}),
    cwd: zz.string().default(''),
    toolCallTimeoutMs: zz.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  }),
  zz.object({
    transport: zz.const('streamable-http'),
    serverName: zz.string().required().pattern(SERVER_NAME_PATTERN),
    url: zz.string().required(),
    headers: zz.dict(String).default({}),
    toolCallTimeoutMs: zz.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  }),
]) as unknown as zz<Config>

// ── Plugin ─────────────────────────────────────────────────────────────────

/** Cordis plugin name. */
export const name = 'mcp-apps-host'

/** Services required: tool registry + HTTP server + agent registry for context injection. */
export const inject = ['tools', 'webServer', 'agents']

/** Raw result schema: accept any shape the server returns (no pre-validation). */
const RawResultSchema = z.record(z.string(), z.unknown())

/** DeepSeek function-name contract. */
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/** Derive the model-facing public name for one MCP tool. */
function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Build a scrubbed env for the child process. */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/** Create an MCP transport from the resolved config. */
function createTransport(config: Config) {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: buildChildEnv(config.env),
      cwd: config.cwd,
    })
  }
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    { requestInit: { headers: config.headers } },
  )
}

/** One MCP tool discovered from the server, with `_meta` preserved. */
interface DiscoveredTool {
  name: string
  description: string | undefined
  inputSchema: Record<string, unknown>
  outputSchema: unknown | undefined
  /** Tool-definition `_meta` — carries `ui.resourceUri` for resource-fetch fallback. */
  toolMeta: Record<string, unknown> | undefined
}

/** List tools without the SDK's per-page output-validator cache. */
async function listTools(client: Client): Promise<DiscoveredTool[]> {
  const all: DiscoveredTool[] = []
  let cursor: string | undefined
  do {
    const response = await client.request(
      { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
      ListToolsResultSchema,
    )
    for (const tool of response.tools) {
      const meta = (tool as unknown as { _meta?: Record<string, unknown> })._meta
      all.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        outputSchema: tool.outputSchema,
        toolMeta: meta,
      })
    }
    cursor = response.nextCursor
  } while (cursor)
  return all
}

/** Call a tool without the SDK pre-validating an output schema. */
async function callTool(
  client: Client,
  rawName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return client.request(
    { method: 'tools/call', params: { name: rawName, arguments: args } },
    RawResultSchema,
    { signal, timeout: timeoutMs },
  )
}

/** Read a `ui://` resource and return its text content (for resource-fetch fallback). */
async function readUiResource(
  client: Client,
  uri: string,
): Promise<{ uri: string; mimeType: string | undefined; text: string } | undefined> {
  try {
    const response = await client.request(
      { method: 'resources/read', params: { uri } },
      RawResultSchema,
    ) as { contents?: unknown[] }
    const contents = Array.isArray(response.contents) ? response.contents : []
    for (const entry of contents) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      if (typeof e.text === 'string') {
        return { uri, mimeType: typeof e.mimeType === 'string' ? e.mimeType : undefined, text: e.text }
      }
    }
  } catch {
    // Resource not available — the card will not render, but the tool result still reaches the model
  }
  return undefined
}

/** Keep a supported advertised schema; unsupported vocabulary falls back. */
function supportedOutputSchema(candidate: unknown): JsonSchemaNode | undefined {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

/** Extract text from MCP content blocks for the model-facing text projection. */
function extractText(content: unknown, toolName: string): string {
  if (!Array.isArray(content)) return `(${toolName} returned no model-visible content)`
  const lines: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      lines.push(b.text)
    } else if (b.type === 'resource_link' && typeof b.name === 'string') {
      lines.push(`Resource link: ${b.name} (${b.uri ?? 'unknown'})`)
    } else {
      lines.push(`[unsupported MCP content type: ${String(b.type)}]`)
    }
  }
  return lines.length > 0 ? lines.join('\n') : `(${toolName} returned no model-visible content)`
}

// ── Tool definition factory ───────────────────────────────────────────────

/**
 * Build a ToolDefinition for one MCP tool. The executor preserves `_meta`
 * (including the `ui` payload), and `presentationMeta` projects `_meta.ui`
 * into `result.meta.mcpApp` so it reaches the client-side slot component.
 */
function createDefinition(
  client: Client,
  publicName: string,
  rawName: string,
  description: string,
  parameters: Record<string, unknown>,
  structuredSchema: JsonSchemaNode | undefined,
  toolCallTimeoutMs: number,
  /** Tool-definition `_meta` — carries `ui.resourceUri` for resource-fetch fallback. */
  toolMeta: Record<string, unknown> | undefined,
): ToolDefinition {
  return {
    name: publicName,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: structuredSchema ?? {},
          _meta: { type: 'object' },
        },
        required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
        additionalProperties: false,
      },
      render(_args: unknown, value: JsonValue) {
        const result = value as unknown as McpAppsResult
        return [{ type: 'text', text: extractText(result.content, rawName) }]
      },
      presentationMeta(_args: unknown, value: JsonValue): JsonValue {
        const v = value as unknown as { _meta?: { ui?: unknown }; structuredContent?: unknown; content?: unknown }
        const ui = v._meta?.ui
        if (!ui || typeof ui !== 'object') return null
        // Pass the tool result through meta so McpAppCard can inject it as
        // lastToolResult in the ui/initialize handshake. Cards expect a
        // CallToolResult-shaped object: they read .structuredContent (which
        // may itself have .body.products), falling back to .content.
        const sc = v.structuredContent
        return {
          mcpApp: ui as JsonValue,
          lastToolResult: {
            content: (v.content ?? []) as JsonValue,
            ...(sc !== undefined ? { structuredContent: sc as JsonValue } : {}),
          } as JsonValue,
        }
      },
    },
    async execute(args: unknown, exec: ToolExecution) {
      const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const result = await callTool(client, rawName, argsObj, exec.signal, toolCallTimeoutMs)

      // Normalize content to array
      const content = Array.isArray(result.content) ? result.content as JsonValue[] : [{ type: 'text' as const, text: typeof result.toolResult === 'string' ? result.toolResult : '(no output)' }]

      // MCP isError → throw so ToolRuntime produces an isError result
      if (result.isError === true) {
        throw new Error(extractText(content, rawName))
      }

      // Preserve _meta — this is the whole point of this plugin
      const value: McpAppsResult = {
        content,
        ...result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent as JsonValue }
          : {},
      }
      if (result._meta !== undefined && typeof result._meta === 'object') {
        value._meta = result._meta as Record<string, unknown>
      } else if (toolMeta !== undefined) {
        // Fallback: the tool result didn't carry _meta.ui, but the tool
        // definition does. Fetch the resource via resources/read to get
        // the inline HTML, then construct _meta.ui inline.
        const uiDef = (toolMeta as { ui?: Record<string, unknown> }).ui
        if (uiDef !== undefined) {
          const resourceUri = typeof uiDef.resourceUri === 'string' ? uiDef.resourceUri : undefined
          if (resourceUri !== undefined) {
            const resource = await readUiResource(client, resourceUri)
            if (resource !== undefined) {
              value._meta = {
                ui: {
                  resource: {
                    uri: resource.uri,
                    ...resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {},
                    text: resource.text,
                  },
                  ...uiDef.csp !== undefined ? { csp: uiDef.csp } : {},
                },
              }
            }
          }
        }
      }
      return value
    },
  }
}

// ── HTTP Bridge Handler ────────────────────────────────────────────────────

/** One live MCP Apps connection: client + whitelist of raw tool names. */
interface AppsConnection {
  client: Client
  serverName: string
  /** Raw MCP tool names registered by this server (security whitelist). */
  registeredToolNames: Set<string>
  toolCallTimeoutMs: number
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
function createBridgeHandler(connections: Map<string, AppsConnection>, ctx: Context) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Only accept POST
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: -32601, message: 'method not allowed' } }))
      return
    }

    // Parse the URL: /mcp-apps/:serverName/bridge
    const url = new URL(req.url ?? '', 'http://localhost')
    const segments = url.pathname.split('/').filter(Boolean)
    // Expected: ['mcp-apps', '<serverName>', 'bridge']
    if (segments.length < 3 || segments[0] !== 'mcp-apps' || segments[2] !== 'bridge') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: -32601, message: 'unknown endpoint' } }))
      return
    }

    const serverName = segments[1] ?? ''
    const conn = connections.get(serverName)
    if (conn === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: -32601, message: `unknown server: ${serverName}` } }))
      return
    }

    // Read and parse the request body as JSON-RPC
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    await new Promise<void>(resolve => req.on('end', resolve))

    let message: { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> }
    try {
      message = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
      return
    }

    const { id, method, params } = message
    const reply = (result: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }))
    }
    const replyError = (code: number, msg: string): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg } }))
    }

    try {
      if (method === 'tools/call') {
        const p = params ?? {}
        const name = p.name
        if (typeof name !== 'string') {
          replyError(-32602, 'missing or invalid tool name')
          return
        }
        // Security gate: tool must be in the whitelist
        if (!conn.registeredToolNames.has(name)) {
          replyError(-32601, `tool '${name}' is not registered on server '${serverName}'`)
          return
        }
        const arguments_ = (p.arguments ?? {}) as Record<string, unknown>
        const result = await callTool(conn.client, name, arguments_, new AbortController().signal, conn.toolCallTimeoutMs)
        reply(result)
        return
      }

      if (method === 'resources/read') {
        const p = params ?? {}
        const uri = p.uri
        if (typeof uri !== 'string') {
          replyError(-32602, 'missing or invalid resource uri')
          return
        }
        // Security gate: URI must start with ui://
        if (!uri.startsWith('ui://')) {
          replyError(-32601, `resource not accessible from a card: ${uri}`)
          return
        }
        const result = await conn.client.request(
          { method: 'resources/read', params: { uri } },
          RawResultSchema,
        )
        reply(result)
        return
      }

      // ui/inject-context: inject a plugin-sourced (invisible) context message
      // into the agent's next-step inbox. The context is claimed before the next
      // user message in the same step, so the model sees it as a prefix.
      if (method === 'ui/inject-context') {
        const p = params ?? {}
        const sessionId = p.sessionId
        const context = p.context
        if (typeof sessionId !== 'string' || typeof context !== 'string') {
          replyError(-32602, 'missing sessionId or context')
          return
        }
        const agent = ctx.agents.get(sessionId as never)
        if (agent === undefined) {
          replyError(-32601, `agent not found for session: ${sessionId}`)
          return
        }
        // ponytail: inline UserMessage construction instead of importing createUserMessage
        // from @deepseek-ai/dsh-llm — avoids adding a profile dependency the profile doesn't install.
        // The inbox only checks message.id for duplicates; the full UserMessage shape is not validated at runtime.
        const message = {
          id: randomUUID(),
          role: 'user' as const,
          content: [{ type: 'text' as const, text: context }],
          source: { kind: 'plugin' as const, plugin: 'mcp-apps-host' },
        } as never
        agent.inject(message)
        reply({})
        return
      }

      replyError(-32601, `method not supported: ${method ?? '(none)'}`)
    } catch (error: unknown) {
      replyError(-32603, `internal error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// ── Apply ──────────────────────────────────────────────────────────────────

/**
 * Connect one MCP Apps server, register its tools with `_meta` preservation,
 * and expose the HTTP bridge endpoint for iframe postMessage proxying.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { client, registeredToolNames } = await connectAndRegister(ctx, config)

  // Store connection for the HTTP bridge handler
  const connections = (ctx as unknown as { __mcpAppsConnections?: Map<string, AppsConnection> }).__mcpAppsConnections
    ?? new Map<string, AppsConnection>()
  ;(ctx as unknown as { __mcpAppsConnections?: Map<string, AppsConnection> }).__mcpAppsConnections = connections
  const conn: AppsConnection = {
    client,
    serverName: config.serverName,
    registeredToolNames,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
  }
  connections.set(config.serverName, conn)

  // Register HTTP bridge endpoint (idempotent — one route for all servers)
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/mcp-apps',
      handler: createBridgeHandler(connections, ctx),
    })
    return () => {
      dispose()
      connections.delete(config.serverName)
    }
  }, 'mcp-apps-host: HTTP bridge')

  // Cleanup: close the MCP client on disposal
  ctx.effect(() => {
    return () => {
      connections.delete(config.serverName)
      try { void client.close() } catch { /* transport already gone */ }
    }
  }, 'mcp-apps-host: connection cleanup')
}

/**
 * Create the MCP client, connect, list tools, and register them on `ctx.tools`.
 * Returns the client and the set of raw tool names for the security whitelist.
 */
async function connectAndRegister(
  ctx: Context,
  config: Config,
): Promise<{ client: Client; registeredToolNames: Set<string> }> {
  // Declare the io.modelcontextprotocol/ui extension so the MCP server
  // includes `_meta.ui` on tool definitions (the server strips it when the
  // client doesn't declare the extension capability).
  const client = new Client(
    { name: 'dsh-mcp-apps-host', version: '0.0.1' },
    { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } },
  )

  await client.connect(createTransport(config) as Transport)

  const tools = await listTools(client)
  const registeredToolNames = new Set<string>()
  const disposers: (() => void)[] = []

  for (const tool of tools) {
    const publicName = publicToolName(config.serverName, tool.name)
    if (registeredToolNames.has(tool.name)) {
      throw new Error(`mcp-apps-host(${config.serverName}): server listed tool "${tool.name}" more than once`)
    }
    registeredToolNames.add(tool.name)
    const def = createDefinition(
      client,
      publicName,
      tool.name,
      tool.description ?? '',
      tool.inputSchema,
      supportedOutputSchema(tool.outputSchema),
      config.toolCallTimeoutMs,
      tool.toolMeta,
    )
    try {
      disposers.push(ctx.tools.register(def))
    } catch (error) {
      ctx.logger.error(`mcp-apps-host(${config.serverName}): tool registration failed for "${publicName}": ${String(error)}`)
    }
  }

  ctx.logger.info(`mcp-apps-host(${config.serverName}): connected, ${registeredToolNames.size} tools registered`)

  // Cleanup: unregister all tools on disposal
  ctx.effect(() => {
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'mcp-apps-host: tool registrations')

  return { client, registeredToolNames }
}
