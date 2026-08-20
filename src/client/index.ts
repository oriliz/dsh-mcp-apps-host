/**
 * MCP Apps Host client plugin: registers `tool.call.toolview` slots for all
 * known UTP tool names, and configures the McpAppCard component with a
 * `sendUserMessage` callback that routes into the DSH conversation service.
 *
 * @module @deepseek-ai/dsh-mcp-apps-host/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { McpAppCard, configureMcpAppCard } from './McpAppCard.tsx'

// ── Constants ──────────────────────────────────────────────────────────────

/** MCP server name (must match the server-side config in cordis.yml). */
const SERVER_NAME = 'utp'

/**
 * Known UTP tool raw names. The slot keys are the public tool names
 * (`mcp__<serverName>__<rawName>`). If the MCP server adds new tools,
 * their card rendering falls back to the generic tool row — add them
 * here to enable the MCP Apps card view.
 */
const UTP_RAW_TOOL_NAMES: readonly string[] = [
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
]

/** Public tool names: `mcp__<serverName>__<rawName>`. */
const UTP_PUBLIC_TOOL_NAMES: readonly string[] = UTP_RAW_TOOL_NAMES.map(
  name => `mcp__${SERVER_NAME}__${name}`,
)

// ── Client plugin ─────────────────────────────────────────────────────────

/** Services required: slot registry + sessions (for conversation send) + locale. */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Mount the MCP Apps card view: configure the module-level API and register
 * `tool.call.toolview` slots for every known UTP tool name.
 */
export function apply(ctx: ClientContext): void {
  // Configure the McpAppCard component with the conversation send callback.
  configureMcpAppCard({
    serverName: SERVER_NAME,
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

  // Register a tool.call.toolview slot for each UTP tool name.
  // The slot renders the McpAppCard component, which checks block.meta.mcpApp
  // and renders the iframe if present (or falls back to the default tool row).
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const toolName of UTP_PUBLIC_TOOL_NAMES) {
      yield ctx.slots.register({
        name: 'tool.call.toolview',
        key: toolName,
      }, McpAppCard)
    }
  })
}
