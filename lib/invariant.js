//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-mcp-apps-host`.
* @module @deepseek-ai/dsh-mcp-apps-host/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-mcp-apps-host";
/** Cordis companion plugin name. */
const name = "mcp-apps-host-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** No runtime invariant: MCP Apps generations contribute through the tool registry. */
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
