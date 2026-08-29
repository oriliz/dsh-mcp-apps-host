/**
 * MCP Apps Host client plugin: discovers card-capable tools at runtime by
 * watching the current session's transcript, registers a `tool.call.toolview`
 * slot for each tool whose settled result carries an MCP Apps payload, and
 * configures the McpAppCard component with a `sendUserMessage` callback that
 * routes into the DSH conversation service.
 *
 * @module @deepseek-ai/dsh-mcp-apps-host/client
 */
import { McpAppCard, configureMcpAppCard } from "./McpAppCard.js";
// ── Client plugin ─────────────────────────────────────────────────────────
/** Services required: slot registry + sessions (transcript discovery + conversation send). */
export const inject = ['slots', 'sessions'];
/**
 * Mount the MCP Apps card view. No hardcoded server/tool list: the plugin
 * follows the current session's transcript, and the first settled result whose
 * meta carries an MCP Apps payload registers that tool name in the keyed
 * `tool.call.toolview` slot. Store notifications are synchronous while React
 * re-renders after, so even the first card call renders through McpAppCard
 * instead of flashing the generic row; opening a history session works the
 * same way (the restored blocks trigger the registration pass).
 */
export function apply(ctx) {
    // Configure the McpAppCard component with the conversation send callback.
    configureMcpAppCard({
        sendUserMessage: async (sessionId, text) => {
            // Duck-type the sessions service to avoid the SessionStore/ISessions
            // type conflict (server-side SessionStore vs client-side ISessions
            // both merge `sessions` onto Context under different tsconfig programs).
            const sessions = ctx.get('sessions');
            const scoped = sessions?.scope(sessionId);
            if (scoped === undefined) {
                console.error('[mcp-apps-host] no session scope for sessionId:', sessionId);
                return;
            }
            // The conversation service is registered by @deepseek-ai/dsh-client-ui-conversation.
            // Access it via duck typing to avoid a value import across the bundle purity gate.
            const conversation = scoped.get('conversation');
            if (conversation === undefined) {
                console.error('[mcp-apps-host] conversation service unavailable for session:', sessionId);
                return;
            }
            await conversation.send(text);
        },
    });
    // ── Runtime card-tool discovery ─────────────────────────────────────────
    // Registered wire tool names (Set makes the scan idempotent; entries unload
    // with the plugin fiber through the slot registry's effect cascade).
    const registered = new Set();
    /** One transcript node: register its tool result when it carries a card payload. */
    const visit = (node) => {
        if (typeof node !== 'object' || node === null)
            return;
        const n = node;
        if (n.kind === 'tool-result') {
            const name = typeof n.call?.name === 'string' ? n.call.name : '';
            const meta = n.meta;
            if (name !== '' && meta?.mcpApp != null && !registered.has(name)) {
                registered.add(name);
                ctx.slots.register({ name: 'tool.call.toolview', key: name }, McpAppCard);
            }
        }
        for (const child of n.subCalls ?? [])
            visit(child);
        for (const child of n.blocks ?? [])
            visit(child);
    };
    const sessions = ctx.get('sessions');
    // Follow the current session: subscribe to its transcript, scan immediately
    // (history restore), and re-scan on every store notification (live calls —
    // the registration lands before the matching re-render).
    let unsubscribeSession;
    const followCurrent = () => {
        unsubscribeSession?.();
        unsubscribeSession = undefined;
        const current = sessions?.list.getSnapshot().current;
        if (typeof current !== 'string')
            return;
        const session = sessions?.binding(current)?.session;
        if (session === undefined)
            return;
        const scan = () => {
            for (const node of session.getSnapshot().nodes)
                visit(node);
        };
        unsubscribeSession = session.subscribe(scan);
        scan();
    };
    const unsubscribeList = sessions?.list.subscribe(followCurrent);
    followCurrent();
    ctx.effect(() => () => {
        unsubscribeList?.();
        unsubscribeSession?.();
    }, 'mcp-apps-host: card tool discovery');
}
//# sourceMappingURL=index.js.map