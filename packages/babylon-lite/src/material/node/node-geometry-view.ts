/** NodeMaterial view helper that targets geometry-rendering MRT output.
 *
 *  The geometry renderer task wraps each NodeMaterial caster in a
 *  `NodeGeometryMaterialView`. The view carries the per-task attachment list,
 *  optional `gp` UBO (camera near/far, shared across the task's materials), and
 *  reverse-culling flag, and shadows {@link Material._buildGroup} with
 *  {@link getNodeGeometryGroupBuilder} so the geometry renderer task materialises a
 *  {@link Renderable} through the node geometry renderable infrastructure — no
 *  view-aware branching needed in core render-task.
 *
 *  The geometry-output WGSL itself is produced by re-walking the parsed graph
 *  from the `GeometryTextureOutputBlock` terminal in
 *  `./node-geometry-renderable.ts`. Mirrors `material/standard/geometry-view.ts`
 *  and `material/node/esm-shadow-view.ts`. */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import type { GeometryTextureType } from "../../frame-graph/geometry-types.js";
import { NODE_GEOMETRY_OUTPUT } from "./node-flags.js";
import type { NodeMaterial } from "./node-material.js";
import { getNodeGeometryGroupBuilder } from "./node-geometry-renderable.js";

/** Per-task ordered attachment list driving the geometry template. The array
 *  index is the MRT color-attachment slot used in `@location(i)`. */
export type NodeGeometryAttachments = readonly GeometryTextureType[];

/** Per-(task, material) NodeMaterial geometry view configuration. */
export interface NodeGeometryViewConfig {
    /** Ordered MRT attachment list — index = `@location(i)`. */
    readonly attachments: NodeGeometryAttachments;
    /** When true the task additionally wants the real (lit) material color at
     *  `@location(N)`. NodeMaterial geometry views do not implement the extra
     *  color attachment (the realColor impostor is dropped); passing `true`
     *  throws so callers don't silently mismatch the render-pass attachments. */
    readonly emitColor: boolean;
    /** Per-task camera-near-far UBO. Required when {@link attachments} contains
     *  `NORMALIZED_VIEW_DEPTH` (and the input is left unconnected). */
    readonly gpUBO?: GPUBuffer | null;
    /** Flip culling direction. */
    readonly reverseCulling?: boolean;
}

/** NodeMaterial view that emits geometry textures instead of shaded colour. */
export interface NodeGeometryMaterialView extends MaterialView {
    /** @internal Ordered MRT attachment list — index = `@location(i)`. */
    readonly _geometryAttachments: NodeGeometryAttachments;
    /** @internal Optional per-task geometry-params UBO. */
    readonly _gpUBO: GPUBuffer | null;
    /** @internal */
    readonly _reverseCulling: boolean;
    /** @internal Shared per-view resources cache populated lazily by the renderable factory. */
    _geometry?: unknown;
}

/** Wrap a NodeMaterial as a geometry-output view.
 *  - Sets the `NODE_GEOMETRY_OUTPUT` feature bit.
 *  - Shadows `_buildGroup` with {@link getNodeGeometryGroupBuilder} so the natural
 *    `material._buildGroup._rebuildSingle` dispatch builds a geometry-MRT
 *    renderable for this view. */
export function createNodeGeometryMaterialView(source: NodeMaterial, config: NodeGeometryViewConfig): NodeGeometryMaterialView {
    if (config.emitColor) {
        throw new Error("NodeMaterial geometry view: emitColor (real-color target) is not supported — omit targetTexture on the geometry task.");
    }
    const baseFeatures = source._renderFeatures?.features ?? 0;
    const view = createMaterialView(source, { features: baseFeatures | NODE_GEOMETRY_OUTPUT }) as NodeGeometryMaterialView;
    Object.defineProperty(view, "_geometryAttachments", { value: config.attachments, enumerable: false });
    Object.defineProperty(view, "_gpUBO", { value: config.gpUBO ?? null, enumerable: false });
    Object.defineProperty(view, "_reverseCulling", { value: config.reverseCulling ?? false, enumerable: false });
    Object.defineProperty(view, "_buildGroup", { value: getNodeGeometryGroupBuilder(), enumerable: false });
    return view;
}
