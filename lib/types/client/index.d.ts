/**
 * MCP Apps Host client plugin: discovers card-capable tools at runtime by
 * watching the current session's transcript, registers a `tool.call.toolview`
 * slot for each tool whose settled result carries an MCP Apps payload, and
 * configures the McpAppCard component with a `sendUserMessage` callback that
 * routes into the DSH conversation service.
 *
 * @module @deepseek-ai/dsh-mcp-apps-host/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Services required: slot registry + sessions (transcript discovery + conversation send). */
export declare const inject: string[];
/**
 * Mount the MCP Apps card view. No hardcoded server/tool list: the plugin
 * follows the current session's transcript, and the first settled result whose
 * meta carries an MCP Apps payload registers that tool name in the keyed
 * `tool.call.toolview` slot. Store notifications are synchronous while React
 * re-renders after, so even the first card call renders through McpAppCard
 * instead of flashing the generic row; opening a history session works the
 * same way (the restored blocks trigger the registration pass).
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map