/** Shared helpers for block emitter implementations.
 *
 *  Block modules import from this file rather than directly from `node-types`
 *  to keep the public surface small.
 */

export type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, NodeValueType, NodeTextureBinding } from "../node-types.js";

/** Mint a new SSA-style temporary name. */
export function nextTemp(state: { nextTemp: number }, prefix = "t"): string {
    const id = state.nextTemp++;
    return `_${prefix}${id}`;
}
