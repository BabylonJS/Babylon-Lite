/** Geometry-renderer node-block loader.
 *
 *  The `GeometryTextureOutputBlock` terminal is only used by node-material
 *  geometry-renderer scenes. Keeping it out of the always-loaded base registry
 *  (`node-registry.ts`) means ordinary node-material scenes don't carry its
 *  dispatch entry. Those scenes instead pass this loader as the
 *  {@link ParseNodeMaterialOptions.blockLoader}: it resolves the geometry
 *  terminal and delegates every other block to the standard registry.
 */

import type { BlockEmitter } from "./node-types.js";
import { loadBlockEmitter } from "./node-registry.js";

/**
 * Resolve a node-block emitter, including the geometry-renderer terminal
 * (`GeometryTextureOutputBlock`). Pass as `blockLoader` to
 * `parseNodeMaterialFromSnippet` for node-material geometry-renderer scenes so
 * ordinary node scenes don't bundle the geometry block.
 */
export async function loadNodeBlockEmitterWithGeometry(className: string): Promise<BlockEmitter> {
    if (className === "GeometryTextureOutputBlock") {
        return (await import("./blocks/geometry-texture-output.js")).emitter;
    }
    return loadBlockEmitter(className);
}
