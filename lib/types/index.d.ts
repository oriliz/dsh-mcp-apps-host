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
import type { Context } from '@deepseek-ai/cordis';
import zz from '@deepseek-ai/schemastery';
import type { JsonValue } from '@deepseek-ai/dsh-tools';
/** Canonical MCP result exposed to programmatic callers with `_meta` intact. */
export type McpAppsResult = {
    content: JsonValue[];
    structuredContent?: JsonValue;
    /** Preserved `_meta` from the MCP `tools/call` result — carries `ui` payload. */
    _meta?: Record<string, unknown>;
};
/** Config for connecting via stdio. */
export interface StdioConfig {
    transport: 'stdio';
    serverName: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    toolCallTimeoutMs: number;
}
/** Config for connecting via Streamable HTTP. */
export interface StreamableHttpConfig {
    transport: 'streamable-http';
    serverName: string;
    url: string;
    headers: Record<string, string>;
    toolCallTimeoutMs: number;
}
export type Config = StdioConfig | StreamableHttpConfig;
export declare const Config: zz<Config>;
/** Cordis plugin name. */
export declare const name = "mcp-apps-host";
/** Services required: tool registry + HTTP server for the iframe bridge. */
export declare const inject: string[];
/**
 * Connect one MCP Apps server, register its tools with `_meta` preservation,
 * and expose the HTTP bridge endpoint for iframe postMessage proxying.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map