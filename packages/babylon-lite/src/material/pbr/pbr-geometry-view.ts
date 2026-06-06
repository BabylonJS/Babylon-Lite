/** PBR material view helper that targets geometry-rendering MRT output.
 *
 *  The geometry renderer task wraps each PBR caster material in a
 *  `PbrGeometryMaterialView`. The view carries the per-task attachment
 *  list, target-texture intent, optional `gp` UBO (shared across the task's
 *  materials), and reverse-culling flag. The view also shadows
 *  {@link Material._buildGroup} with {@link pbrGeometryGroupBuilder} so that
 *  the geometry renderer task materialises a {@link Renderable} through the
 *  PBR geometry renderable infrastructure — no view-aware branching needed
 *  in core render-task.
 *
 *  The geometry-output WGSL itself is produced by post-processing the regular
 *  per-scene composed PBR shader (reused via the `_pbrGeomContext` stash) in
 *  `./pbr-geometry-output-shader.ts`. */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import type { GeometryTextureType } from "../../frame-graph/geometry-types.js";
import { PBR_HAS_ALPHA_BLEND, PBR2_GEOMETRY_OUTPUT } from "./pbr-flags.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { pbrGeometryGroupBuilder } from "./pbr-geometry-renderable.js";
import { _ensurePbrGeometryExt } from "./pbr-geometry-output-shader.js";

/** Per-task ordered attachment list driving the geometry template. The array
 *  index is the MRT color-attachment slot used in `@location(i)`. */
export type PbrGeometryAttachments = readonly GeometryTextureType[];

/** Per-(task, material) PBR geometry view configuration. All fields are owned
 *  by the geometry renderer task; the view captures them so per-mesh renderables
 *  pick up the same pipeline state and bindings. */
export interface PbrGeometryViewConfig {
    /** Ordered MRT attachment list — index = `@location(i)`. */
    readonly attachments: PbrGeometryAttachments;
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

/** PBR material view that emits geometry textures instead of shaded colour. */
export interface PbrGeometryMaterialView extends MaterialView {
    /** @internal Ordered MRT attachment list — index = `@location(i)`. */
    readonly _geometryAttachments: PbrGeometryAttachments;
    /** @internal Geometry pipeline carries an extra `@location(N)` color attachment. */
    readonly _emitColor: boolean;
    /** @internal Optional per-task geometry-params UBO shared with the composer's
     *  `geometry-params` fragment. */
    readonly _gpUBO: GPUBuffer | null;
    /** @internal */
    readonly _reverseCulling: boolean;
    /** @internal Shared per-view resources cache populated lazily by the renderable
     *  factory. Opaque to callers. */
    _geometry?: unknown;
}

// Snapshot of the currently-building view's attachments so the registered
// PBR geometry extension can read them from `frag(ctx)`. The extension is
// invoked synchronously during composePbr inside `buildPbrGeometryRenderable`;
// the snapshot is set right before that call and cleared after.
let _activeAttachments: readonly GeometryTextureType[] | undefined;

/** @internal Used by the geometry renderable to scope attachment access for
 *  the PBR ext during a composePbr call. Returns the previous value so the
 *  caller can restore it (avoids global leakage in nested scenarios). */
export function _setActivePbrGeometryAttachments(att: readonly GeometryTextureType[] | undefined): readonly GeometryTextureType[] | undefined {
    const prev = _activeAttachments;
    _activeAttachments = att;
    return prev;
}

/** Wrap a PBR material as a geometry-output view.
 *  - Sets the `PBR2_GEOMETRY_OUTPUT` features2 bit.
 *  - Clears `PBR_HAS_ALPHA_BLEND`: the geometry pipeline drives blending per
 *    attachment via the pipeline color-target state, not via the PBR
 *    fragment's source-over color output.
 *  - Shadows `_buildGroup` with {@link pbrGeometryGroupBuilder} so the
 *    natural `material._buildGroup._rebuildSingle` dispatch in
 *    `resolvePendingMeshes` builds a geometry-MRT renderable for this view.
 *  - Registers the PBR geometry extension (idempotent) so subsequent
 *    composePbr calls pick up the `gp` UBO + geometry varyings when
 *    `PBR2_GEOMETRY_OUTPUT` is set. */
export function createPbrGeometryMaterialView(source: PbrMaterialProps, config: PbrGeometryViewConfig): PbrGeometryMaterialView {
    _ensurePbrGeometryExt(() => _activeAttachments);
    const baseFeatures = source._renderFeatures?.features ?? 0;
    const baseFeatures2 = source._renderFeatures?.features2 ?? 0;
    const view = createMaterialView(source, {
        features: baseFeatures & ~PBR_HAS_ALPHA_BLEND,
        features2: baseFeatures2 | PBR2_GEOMETRY_OUTPUT,
    }) as PbrGeometryMaterialView;
    Object.defineProperty(view, "_geometryAttachments", { value: config.attachments, enumerable: false });
    Object.defineProperty(view, "_emitColor", { value: config.emitColor, enumerable: false });
    Object.defineProperty(view, "_gpUBO", { value: config.gpUBO ?? null, enumerable: false });
    Object.defineProperty(view, "_reverseCulling", { value: config.reverseCulling ?? false, enumerable: false });
    Object.defineProperty(view, "_buildGroup", { value: pbrGeometryGroupBuilder, enumerable: false });
    return view;
}
