/**
 * MCP Apps Host client plugin: registers `tool.call.toolview` slots for the
 * known card-capable MCP server tool names, and configures the McpAppCard
 * component with a `sendUserMessage` callback that routes into the DSH
 * conversation service.
 *
 * @module @deepseek-ai/dsh-mcp-apps-host/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { McpAppCard, configureMcpAppCard } from './McpAppCard.tsx'

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Servers whose tool results render MCP Apps cards, with their raw tool names.
 * The slot keys are the public tool names (`mcp__<serverName>__<rawName>`).
 * The toolview slot is exact-key keyed, so a server not listed here renders
 * its tools through the generic tool row even when `_meta.ui` survives — add
 * its row here to enable the card view.
 */
const CARD_SERVERS: readonly { serverName: string; rawToolNames: readonly string[] }[] = [
  {
    serverName: 'utp',
    rawToolNames: [
      'utp_discover',
      'utp_login',
      'utp_link',
      'utp_device_authorization',
      'utp_catalog_search',
      'utp_catalog_product',
      'utp_cart_list',
      'utp_cart_add',
      'utp_cart_update',
      'utp_cart_remove',
      'utp_checkout_create',
      'utp_checkout_get',
      'utp_checkout_poll',
      'utp_checkout_complete',
      'utp_checkout_cancel',
      'utp_checkout_set_address',
      'utp_checkout_set_discount',
      'utp_address_form',
      'utp_address_create',
      'utp_address_children',
      'utp_address_parse',
      'utp_order_list',
      'utp_profile_register',
      'utp_profile_get',
    ],
  },
  {
    serverName: 'demo',
    rawToolNames: ['demo_interactive', 'demo_referenced'],
  },
]

// ── Client plugin ─────────────────────────────────────────────────────────

/** Services required: slot registry + sessions (for conversation send) + locale. */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Mount the MCP Apps card view: configure the module-level API and register
 * `tool.call.toolview` slots for every known UTP tool name.
 */
export function apply(ctx: ClientContext): void {
  // Configure the McpAppCard component with the conversation send callback.
  // The server name is the bridge-routing fallback; each card's own
  // meta.mcpServerName (projected by presentationMeta) wins when present.
  configureMcpAppCard({
    serverName: CARD_SERVERS[0]?.serverName ?? 'utp',
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

  // Register a tool.call.toolview slot for each known card-capable tool name.
  // The slot renders the McpAppCard component, which checks block.meta.mcpApp
  // and renders the iframe if present (or falls back to the default tool row).
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const server of CARD_SERVERS) {
      for (const rawName of server.rawToolNames) {
        yield ctx.slots.register({
          name: 'tool.call.toolview',
          key: `mcp__${server.serverName}__${rawName}`,
        }, McpAppCard)
      }
    }
  })
}
