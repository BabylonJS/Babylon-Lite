import type { BlockEmitter } from "./node-types.js";
import type { ParseNodeMaterialOptions } from "./node-material.js";

/** One explicitly selected, lazily loaded Node Material block implementation. */
export interface NodeMaterialBlock {
    readonly className: string;
    /** @internal */
    readonly _load: () => Promise<BlockEmitter>;
}

/** Create a graph-specific loader without retaining the general block registry.
 * Missing or duplicate block selections are errors; this loader never silently
 * falls back to the general registry. Select the full PBR block when the graph
 * uses advanced PBR inputs or specular anti-aliasing. */
export function createNodeMaterialBlockLoader(blocks: readonly NodeMaterialBlock[]): NonNullable<ParseNodeMaterialOptions["blockLoader"]> {
    const selected = new Map<string, NodeMaterialBlock["_load"]>();
    for (const block of blocks) {
        if (selected.has(block.className)) {
            throw new Error(`NodeMaterial: duplicate block selection "${block.className}"`);
        }
        selected.set(block.className, block._load);
    }
    return async (className) => {
        const load = selected.get(className);
        if (!load) {
            throw new Error(`NodeMaterial: no emitter selected for block "${className}"`);
        }
        return load();
    };
}
