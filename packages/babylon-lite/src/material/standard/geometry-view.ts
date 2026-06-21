/** Standard material view helper that targets geometry-rendering MRT output.
 *
 *  The geometry renderer task wraps each Standard caster material in a
 *  `StandardGeometryMaterialView`. The view carries the per-task attachment
 *  list, target-texture intent, optional `gp` UBO (shared across the task's
 *  materials), and reverse-culling flag. The view also shadows
 *  {@link Material._buildGroup} with {@link getStandardGeometryGroupBuilder} so
 *  that `RenderTask.addMesh` (and the geometry renderer task) materialize a
 *  {@link Renderable} through the shared standard geometry renderable
 *  infrastructure — no view-aware branching required in core render-task.
 *
 *  The geometry-output WGSL itself is produced by post-processing the regular
 *  composed standard shader in `./standard-geometry-output-shader.ts`. */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import type { GeometryTextureType } from "../../frame-graph/geometry-types.js";
import { GEOMETRY_OUTPUT, MATERIAL_ALPHA_BLEND } from "./standard-flags.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { getStandardGeometryGroupBuilder } from "./standard-geometry-renderable.js";

/** Per-task ordered attachment list driving the geometry template. The array
 *  index is the MRT color-attachment slot used in `@location(i)`. */
export type StandardGeometryAttachments = readonly GeometryTextureType[];

/** Per-(task, material) geometry view configuration. All fields are owned by
 *  the geometry renderer task; the view captures them so per-mesh renderables
 *  pick up the same pipeline state and bindings. */
export interface StandardGeometryViewConfig {
    /** Ordered MRT attachment list — index = `@location(i)`. */
    readonly attachments: StandardGeometryAttachments;
    /** When true, the composed fragment emits the real (lit) material color
     *  at `@location(N)` (N = attachments.length). The target texture is
     *  added to the pipeline color-target list at the same slot. */
    readonly emitColor: boolean;
    /** Per-task previous-VP + camera-near-far UBO. Required when
     *  {@link attachments} contains `NORMALIZED_VIEW_DEPTH` or
     *  `LINEAR_VELOCITY`; ignored otherwise. */
    readonly gpUBO?: GPUBuffer | null;
    /** Flip culling direction. */
    readonly reverseCulling?: boolean;
}

/** Standard material view that emits geometry textures instead of shaded colour. */
export interface StandardGeometryMaterialView extends MaterialView {
    /** @internal Ordered MRT attachment list — index = `@location(i)`. */
    readonly _geometryAttachments: StandardGeometryAttachments;
    /** @internal Geometry pipeline carries an extra `@location(N)` color attachment. */
    readonly _emitColor: boolean;
    /** @internal Optional per-task geometry-params UBO shared with the composer's
     *  `geometryParams` fragment. */
    readonly _gpUBO: GPUBuffer | null;
    /** @internal */
    readonly _reverseCulling: boolean;
    /** @internal Shared per-view resources cache populated lazily by the renderable
     *  factory. Opaque to callers. */
    _geometry?: unknown;
}

/** Wrap a Standard material as a geometry-output view.
 *  - Sets the `GEOMETRY_OUTPUT` feature bit.
 *  - Clears `MATERIAL_ALPHA_BLEND`: the geometry pipeline drives blending per
 *    attachment via the pipeline color-target state, not via the standard
 *    fragment's source-over color output.
 *  - Shadows `_buildGroup` with {@link getStandardGeometryGroupBuilder} so the
 *    natural `material._buildGroup._rebuildSingle` dispatch in
 *    `resolvePendingMeshes` builds a geometry-MRT renderable for this view. */
export function createStandardGeometryMaterialView(source: StandardMaterialProps, config: StandardGeometryViewConfig): StandardGeometryMaterialView {
    const baseFeatures = source._renderFeatures?.features ?? 0;
    const view = createMaterialView(source, { features: (baseFeatures & ~MATERIAL_ALPHA_BLEND) | GEOMETRY_OUTPUT }) as StandardGeometryMaterialView;
    Object.defineProperty(view, "_geometryAttachments", { value: config.attachments, enumerable: false });
    Object.defineProperty(view, "_emitColor", { value: config.emitColor, enumerable: false });
    Object.defineProperty(view, "_gpUBO", { value: config.gpUBO ?? null, enumerable: false });
    Object.defineProperty(view, "_reverseCulling", { value: config.reverseCulling ?? false, enumerable: false });
    Object.defineProperty(view, "_buildGroup", { value: getStandardGeometryGroupBuilder(), enumerable: false });
    return view;
}
