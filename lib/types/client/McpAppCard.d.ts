/**
 * MCP Apps Card Component: renders an interactive HTML card from the MCP Apps
 * `_meta.ui` payload inside a sandboxed iframe, and bridges postMessage
 * between the iframe and the DSH host (ui/initialize, tools/call,
 * resources/read, ui/update-model-context, ui/message).
 *
 * Reference: Hermes `mcp-app-card.tsx` (Layer 5: Card Component).
 *
 * @module
 */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
/**
 * Configure the module-level API used by McpAppCard instances.
 * Called once from the client plugin's `apply` function.
 */
export declare function configureMcpAppCard(opts: {
    sendUserMessage: (sessionId: string, text: string) => Promise<void>;
    serverName: string;
}): void;
/**
 * Renders one MCP Apps interactive HTML card. The card is a sandboxed iframe
 * whose `srcDoc` is the HTML from `_meta.ui.resource.text`. The iframe
 * communicates with the parent via `postMessage` using JSON-RPC messages.
 *
 * Supported postMessage methods:
 * - `ui/initialize` — handshake: returns host capabilities + lastToolResult + sessionId
 * - `tools/call` — forwarded to the HTTP bridge (`/mcp-apps/<serverName>/bridge`)
 * - `resources/read` — forwarded to the HTTP bridge (security: `ui://` prefix only)
 * - `ui/update-model-context` — staged as context for the next user message
 * - `ui/message` — sends a user message into the DSH conversation (debounced)
 */
export declare function McpAppCard(props: ToolCallViewProps): JSX.Element | null;
//# sourceMappingURL=McpAppCard.d.ts.map