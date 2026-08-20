/**
 * MCP Apps Host client plugin: registers `tool.call.toolview` slots for all
 * known UTP tool names, and configures the McpAppCard component with a
 * `sendUserMessage` callback that routes into the DSH conversation service.
 *
 * @module @deepseek-ai/dsh-mcp-apps-host/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Services required: slot registry + sessions (for conversation send) + locale. */
export declare const inject: string[];
/**
 * Mount the MCP Apps card view: configure the module-level API and register
 * `tool.call.toolview` slots for every known UTP tool name.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map