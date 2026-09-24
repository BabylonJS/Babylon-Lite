import type { Mat4 } from "../math/types.js";
import { allocateMat4Storage } from "../math/_matrix-allocator.js";
import type { SceneNode } from "../scene/scene-node.js";
import { createSceneNodeFromMatrix } from "../scene/scene-node.js";
import { usdField, usdFloats, usdString, USD_NONE } from "./usd-protocol.js";
import type { UsdRecord } from "./usd-protocol.js";

/** @internal Convert a protocol matrix through Lite's precision-aware allocator.
 * GfMatrix serializes row-vector matrices row-major, while Lite consumes
 * column-vector matrices column-major. The same flat sequence is therefore the
 * required mathematical transpose; reshuffling it would transpose twice. */
export function usdMatrix(values: ArrayLike<number>): Mat4 {
    const storage = allocateMat4Storage();
    storage.set(values);
    // Mat4 is deliberately opaque; all matrix factories brand allocator-owned storage.
    return storage as unknown as Mat4;
}

/** @internal Link a node in both directions of Lite's scene hierarchy. */
export function usdParent(node: SceneNode, parent: SceneNode): void {
    node.parent = parent;
    parent.children.push(node);
}

/** @internal Build and validate the entire parent graph before materializing meshes. */
export function buildUsdNodes(records: readonly UsdRecord[], data: ArrayBuffer, root: SceneNode): Map<number, SceneNode> {
    const nodes = new Map<number, SceneNode>();
    const parents = new Map<number, number>();
    for (const record of records) {
        const id = usdField(record, 0);
        if (nodes.has(id) || id === USD_NONE) {
            throw new Error(`Duplicate or reserved USD node ${id}`);
        }
        const matrix = usdFloats(data, usdField(record, 4), 16);
        if (!matrix.every(Number.isFinite)) {
            throw new Error("Non-finite USD transform");
        }
        nodes.set(id, createSceneNodeFromMatrix(usdString(data, usdField(record, 2), usdField(record, 3)), usdMatrix(matrix)));
        parents.set(id, usdField(record, 1));
    }
    const linked = new Set<number>();
    for (const id of nodes.keys()) {
        const chain = new Set<number>();
        let current = id;
        while (current !== USD_NONE && !linked.has(current)) {
            if (chain.has(current) || !nodes.has(current)) {
                throw new Error("Cyclic or missing USD parent node");
            }
            chain.add(current);
            current = parents.get(current)!;
        }
        for (const child of chain) {
            const parent = parents.get(child)!;
            usdParent(nodes.get(child)!, parent === USD_NONE ? root : nodes.get(parent)!);
            linked.add(child);
        }
    }
    return nodes;
}
