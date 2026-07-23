/** PBR material view helper that targets geometry-rendering MRT output.
 *
 *  The geometry renderer task wraps each PBR caster material in a
 *  `PbrGeometryMaterialView`. The view carries the per-task attachment
 *  list, target-texture intent, optional `gp` UBO (shared across the task's
 *  materials), and reverse-culling flag. The view also shadows
 *  {@link Material._buildGroup} with {@link getPbrGeometryGroupBuilder} so that
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
import type { Camera } from "../../camera/camera.js";
import { PBR_HAS_ALPHA_BLEND } from "./pbr-flags.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { getPbrGeometryGroupBuilder } from "./pbr-geometry-renderable.js";
import { _ensurePbrGeometryExt } from "./pbr-geometry-output-shader.js";

const PBR2_GEOMETRY_OUTPUT = 1 << 21;

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
    /** Effective task camera. When the geometry task renders with a `config.camera`
     *  override, the per-mesh world/previous-world packing and floating-origin
     *  invalidation must use THIS camera so they share the same origin as the task's
     *  view-projection. Falls back to `scene.camera` when unset. */
    readonly camera?: Camera | null;
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
    /** @internal Effective task camera (see {@link PbrGeometryViewConfig.camera});
     *  `null` when the task uses the scene's active camera. A plain reference — no
     *  GPU resource, so nothing to dispose. */
    readonly _camera: Camera | null;
    /** @internal Shared per-view resources cache populated lazily by the renderable
     *  factory. Opaque to callers. PBR's cached per-variant resources are composed
     *  WGSL, bind-group layouts, pipeline layouts, shader modules and pipelines — all
     *  GC-reclaimed when the owning geometry task drops this view. There are no
     *  explicitly-destroyable GPU buffers here (the per-mesh mesh/material UBOs are
     *  freed by the renderable's `_geometryDispose`), so — unlike the Standard and Node
     *  views — this view intentionally exposes NO `_disposeGeometryResources`. */
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
 *  - Shadows `_buildGroup` with {@link getPbrGeometryGroupBuilder} so the
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
    Object.defineProperty(view, "_camera", { value: config.camera ?? null, enumerable: false });
    Object.defineProperty(view, "_buildGroup", { value: getPbrGeometryGroupBuilder(), enumerable: false });
    return view;
}
