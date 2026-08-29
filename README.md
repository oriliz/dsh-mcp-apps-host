# DSH MCP Apps Host

MCP Apps Host plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Connects to an MCP server that declares the `io.modelcontextprotocol/ui` extension, preserves `_meta.ui` in tool results, renders interactive HTML cards in sandboxed iframes, and bridges `postMessage` between cards and the MCP server.

## Features

- **Tool discovery with `_meta` preservation** — MCP tools registered with full `_meta.ui` payloads intact
- **Interactive HTML cards** — sandboxed iframe rendering with per-card CSP
- **postMessage bridge** — `ui/initialize`, `tools/call`, `resources/read`, `ui/update-model-context`, `ui/message`
- **Session ID injection** — automatically injects `session_id` into card-initiated `tools/call`
- **Invisible context injection** — `ui/update-model-context` context injected as a plugin-sourced message via `agent.inject()`, classified as a collapsed context row (not a visible user message bubble)
- **HTTP bridge endpoint** — `/mcp-apps/<serverName>/bridge` for secure iframe-to-MCP-server proxying
- **Multi-instance safe** — each plugin instance registers its own per-server bridge route, so several MCP Apps servers can coexist in one DSH profile
- **stdio + streamable-http** — supports both MCP transport types

## Demo

What a tool result carrying an embedded card looks like in the conversation:

![MCP Apps demo cards](demo/demo-cards.png)

The screenshot shows both cards of the bundled demo server ([`demo/server.mjs`](demo/server.mjs) — zero dependencies, Node stdio only):

- `demo_interactive` (**inline form**): the tool *result* carries `_meta.ui.resource.text`, so the card HTML rides the result. Its buttons exercise the full bridge round trip: a `tools/call` that refreshes the card (the host auto-injects `session_id`), and `ui/update-model-context` + `ui/message` talking back to the model.
- `demo_referenced` (**referenced form**): the tool *definition* carries `_meta.ui.resourceUri` (`ui://demo/referenced-card`); the host resolves the HTML once via `resources/read` and inlines it. The card also demonstrates the bridge's `ui://` security gate — a `file:///etc/passwd` read is refused.

Try it:

```bash
# Protocol-level self-check: spawns the demo server over stdio and asserts
# the handshake, both card forms, session_id echo, and the ui:// resource
# table (8 checks, no DSH needed).
node demo/selftest.mjs

# Full E2E: launch dsh web with the demo overlay, then ask the model to call
# demo_interactive and demo_referenced. Run from the PARENT directory of this
# repo (the overlay's server path is cwd-relative); or adjust the !!js path in
# the overlay to your layout.
dsh web --patch dsh-mcp-apps-host/demo/mcp-apps-demo.cordis.yml
```

## Install

Not on npm yet — install from GitHub. The DSH host provides all `@deepseek-ai/dsh-*` peer packages at runtime, so no peer install is needed:

```bash
npm install github:oriliz/dsh-mcp-apps-host
```

### From source

All dsh peer packages resolve inside the [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) pnpm workspace, so build there (this also matches the layout the bundled `lib/` was built in):

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git clone https://github.com/oriliz/dsh-mcp-apps-host.git packages/mcp/mcp-apps-host
pnpm install
npx tsc -b packages/mcp/mcp-apps-host
pnpm --filter @deepseek-ai/dsh-mcp-apps-host bundle
```

## Usage

### 1. Configure in DSH profile

Add to your `cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-apps-host-utp
      name: '@deepseek-ai/dsh-mcp-apps-host'
      config:
        transport: stdio
        serverName: utp
        command: utp
        args: ['mcp', 'serve']
        env: {}
        cwd: ''
        toolCallTimeoutMs: 60000
```

### 2. Start DSH

```bash
dsh --profile web --patch ./examples/mcp-apps-utp.patch.yml
```

### 3. Verify

Ask the agent to search for a product. The MCP tool result renders as an interactive card inside the conversation — product list, images, prices, and all card interactions (add to cart, checkout) work within the iframe.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  DSH Agent Loop                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Tool Registry (ctx.tools)                        │  │
│  │  mcp__utp__catalog_search  →  ToolDefinition      │  │
│  │  mcp__utp__cart_add         →  ToolDefinition      │  │
│  └──────────────┬──────────────────────────────────┘  │
│                 │ execute() → MCP tools/call          │
│                 │ presentationMeta() → meta.mcpApp     │
│  ┌──────────────▼──────────────────────────────────┐  │
│  │  MCP Client (stdio/HTTP)                        │  │
│  │  capabilities: { extensions: { 'io.../ui': {} } } │  │
│  └─────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────┐  │
│  │  HTTP Bridge: /mcp-apps/utp/bridge              │  │
│  │  tools/call (whitelist) · resources/read (ui://) │  │
│  └─────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────┐  │
│  │  Client Plugin (React)                          │  │
│  │  McpAppCard → sandboxed iframe + postMessage    │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Files

| File | Role |
|------|------|
| `src/index.ts` | Server-side: MCP connection, tool registration, HTTP bridge |
| `src/client/McpAppCard.tsx` | Card component: iframe, postMessage handling |
| `src/client/index.ts` | Client plugin: slot registration, sendUserMessage |
| `src/invariant.ts` | Cordis companion (no runtime invariant) |

## Development

```bash
# Build
npx tsc -b packages/mcp/mcp-apps-host/tsconfig.json
pnpm --filter @deepseek-ai/dsh-mcp-apps-host bundle

# Run DSH with the plugin
dsh --profile web --patch ./examples/mcp-apps-utp.patch.yml --port 8089
```

## Pitfalls Fixed

| # | Issue | Fix |
|---|-------|-----|
| P0 | Server strips `_meta.ui` | Declare `mimeTypes` in client capabilities |
| P1 | Card shows empty form, no product data | `presentationMeta()` wraps result as `CallToolResult`-shaped object |
| P2 | `session_id` injection fails | `readSessionId()` prefers `meta.lastToolResult.structuredContent` |
| P3 | External images blocked by CSP | `buildCsp()` adds `https:` to default `img-src` |
| P4 | `ui/update-model-context` was TODO | `_stagedContext` Map stores and prepends context |
| P5 | Context visible as user message text | `ui/inject-context` bridge injects via `agent.inject()` as plugin-sourced message |

See [FINDINGS.md](./FINDINGS.md) for detailed root cause analysis.

## For UTP Skill Authors

If your UTP skill produces interactive HTML cards (via `_meta.ui` in tool results), you **must** load this plugin in DSH — otherwise DSH will call the MCP tools but render only plain text results, with no iframe/card UI.

Quick start:

```bash
# 1. Install the plugin in your DSH profile
dsh plugin add oriliz/dsh-mcp-apps-host

# 2. Configure the MCP server connection (see Usage above)
# 3. Start DSH with your skill and the patch
dsh --profile web --patch ./your-cordis.patch.yml
```

Without this plugin, card-initiated interactions (`tools/call`, `ui/message`, `ui/update-model-context`) have no bridge to reach the MCP server from the iframe.

## License

MIT
