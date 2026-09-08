/**
 * MCP Apps Host client plugin: discovers card-capable tools at runtime by
 * watching the current session's transcript, registers a `tool.call.toolview`
 * slot for each tool whose settled result carries an MCP Apps payload, and
 * configures the McpAppCard component with a `sendUserMessage` callback that
 * routes into the DSH conversation service.
 *
 * @module @deepseek-ai/dsh-mcp-apps-host/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { McpAppCard, configureMcpAppCard } from './McpAppCard.tsx'

// ── Client plugin ─────────────────────────────────────────────────────────

/** Services required: slot registry + sessions + conversation assembly (transcript discovery + conversation send). */
export const inject = ['slots', 'sessions', 'uiConversation']

/**
 * Mount the MCP Apps card view. No hardcoded server/tool list: the plugin
 * follows the current session's transcript, and the first settled result whose
 * meta carries an MCP Apps payload registers that tool name in the keyed
 * `tool.call.toolview` slot. Store notifications are synchronous while React
 * re-renders after, so even the first card call renders through McpAppCard
 * instead of flashing the generic row; opening a history session works the
 * same way (the restored blocks trigger the registration pass).
 */
export function apply(ctx: ClientContext): void {
  // Configure the McpAppCard component with the conversation send callback.
  configureMcpAppCard({
    sendUserMessage: async (sessionId: string, text: string): Promise<void> => {
      // Duck-type the sessions service to avoid the SessionStore/ISessions
      // type conflict (server-side SessionStore vs client-side ISessions
      // both merge `sessions` onto Context under different tsconfig programs).
      const sessions = ctx.get('sessions') as unknown as
        | { scope(id: string): { get(name: string): unknown } | undefined }
        | undefined
      const scoped = sessions?.scope(sessionId)
      if (scoped === undefined) {
        console.error('[mcp-apps-host] no session scope for sessionId:', sessionId)
        return
      }
      // The conversation service is registered by @deepseek-ai/dsh-client-ui-conversation.
      // Access it via duck typing to avoid a value import across the bundle purity gate.
      const conversation = scoped.get('conversation') as
        | { send(text: string): Promise<void> }
        | undefined
      if (conversation === undefined) {
        console.error('[mcp-apps-host] conversation service unavailable for session:', sessionId)
        return
      }
      await conversation.send(text)
    },
  })

  // ── Runtime card-tool discovery ─────────────────────────────────────────
  // Registered wire tool names (Set makes the scan idempotent; entries unload
  // with the plugin fiber through the slot registry's effect cascade).
  const registered = new Set<string>()

  /** One transcript node: register its tool result when it carries a card payload. */
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const n = node as {
      kind?: unknown
      call?: { name?: unknown } | null
      meta?: unknown
      subCalls?: readonly unknown[]
      blocks?: readonly unknown[]
    }
    if (n.kind === 'tool-result') {
      const name = typeof n.call?.name === 'string' ? n.call.name : ''
      const meta = n.meta as { mcpApp?: unknown } | null | undefined
      if (name !== '' && meta?.mcpApp != null && !registered.has(name)) {
        registered.add(name)
        ctx.slots.register({ name: 'tool.call.toolview', key: name }, McpAppCard)
      }
    }
    for (const child of n.subCalls ?? []) visit(child)
    for (const child of n.blocks ?? []) visit(child)
  }

  // Duck-typed read of the current session's chat transcript. The flat node
  // array lives on the ChatSnapshot that ui-conversation assembles per session:
  // `uiConversation.binding(binding).target('chat')` is the same source the
  // chat view subscribes to (new master keeps the flat array in `legacy.nodes`;
  // the top-level `nodes` is a keyed store — the fallback covers old master).
  type ChatSnapshotSource = {
    getSnapshot(): { nodes?: readonly unknown[]; legacy?: { nodes?: readonly unknown[] } }
    subscribe(fn: () => void): () => void
  }
  type SessionsFace = {
    list: { getSnapshot(): { current?: unknown }; subscribe(fn: () => void): () => void }
    binding(id: string): unknown
  }
  type UiConversationFace = {
    binding(source: unknown): { target(name: string): ChatSnapshotSource }
  }
  const sessions = ctx.get('sessions') as unknown as SessionsFace | undefined
  const uiConversation = ctx.get('uiConversation') as unknown as UiConversationFace | undefined

  // Follow the current session: subscribe to its transcript, scan immediately
  // (history restore), and re-scan on every store notification (live calls —
  // the registration lands before the matching re-render).
  let unsubscribeSession: (() => void) | undefined
  const followCurrent = (): void => {
    unsubscribeSession?.()
    unsubscribeSession = undefined
    const current = sessions?.list.getSnapshot().current
    if (typeof current !== 'string') return
    const binding = sessions?.binding(current)
    if (binding === undefined || uiConversation === undefined) return
    const chat = uiConversation.binding(binding).target('chat')
    const scan = (): void => {
      const snapshot = chat.getSnapshot()
      const nodes = snapshot.legacy?.nodes ?? snapshot.nodes
      if (nodes !== undefined) for (const node of nodes) visit(node)
    }
    unsubscribeSession = chat.subscribe(scan)
    scan()
  }

  const unsubscribeList = sessions?.list.subscribe(followCurrent)
  followCurrent()

  ctx.effect(() => () => {
    unsubscribeList?.()
    unsubscribeSession?.()
  }, 'mcp-apps-host: card tool discovery')
}
