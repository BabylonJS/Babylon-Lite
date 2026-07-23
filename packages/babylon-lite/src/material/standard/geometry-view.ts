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
import type { Mesh } from "../../mesh/mesh.js";
import type { Camera } from "../../camera/camera.js";
import { GEOMETRY_OUTPUT, MATERIAL_ALPHA_BLEND } from "./standard-flags.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { getStandardGeometryGroupBuilder, disposeStandardGeometryViewResources } from "./standard-geometry-renderable.js";
import { _getStandardGeometrySkeletonVelocityLoader } from "./standard-geometry-feature-hooks.js";
import type { createStandardGeometrySkeletonVelocity } from "./standard-geometry-skeleton-velocity.js";
import type { createThinInstanceFragment } from "../../shader/fragments/thin-instance-fragment.js";
import type { syncThinInstanceBuffers, syncThinInstanceForDraw } from "../../mesh/thin-instance-gpu.js";

let _skeletonVelocityFactory: typeof createStandardGeometrySkeletonVelocity | null = null;

/** Thin-instance helpers, dynamically injected only when a geometry-pass mesh
 *  actually carries thin instances. Keeping them out of the static import graph of
 *  `standard-geometry-renderable.ts` means a representative non-thin geometry scene
 *  (e.g. scene145 HillValley through the geometry renderer) pays ZERO bytes for
 *  thin-instance-fragment + thin-instance-gpu (~6.6 KB). Mirrors the forward
 *  Standard path, which injects the same helpers via its group builder. */
export interface StandardGeometryThinInstanceHelpers {
    /** @internal */
    readonly _fragment: typeof createThinInstanceFragment;
    /** @internal */
    readonly _syncBuffers: typeof syncThinInstanceBuffers;
    /** @internal */
    readonly _syncForDraw: typeof syncThinInstanceForDraw;
}
let _thinInstanceHelpers: StandardGeometryThinInstanceHelpers | null = null;

/** @internal Load skeletal velocity (opt-in) + thin-instance helpers only when the
 *  matching meshes are present in this geometry pass, so unused optional features
 *  contribute zero bytes to non-matching scenes. */
export async function preloadStandardGeometryFeatures(meshes: readonly Mesh[], needsVelocity: boolean): Promise<void> {
    const loads: Promise<void>[] = [];
    const loader = _getStandardGeometrySkeletonVelocityLoader();
    if (needsVelocity && loader && meshes.some((mesh) => !!mesh.skeleton)) {
        loads.push(
            loader().then((mod) => {
                _skeletonVelocityFactory = mod.createStandardGeometrySkeletonVelocity;
            })
        );
    }
    if (meshes.some((mesh) => !!mesh.thinInstances)) {
        loads.push(
            Promise.all([import("../../shader/fragments/thin-instance-fragment.js"), import("../../mesh/thin-instance-gpu.js")]).then(([fragMod, gpuMod]) => {
                _thinInstanceHelpers = {
                    _fragment: fragMod.createThinInstanceFragment,
                    _syncBuffers: gpuMod.syncThinInstanceBuffers,
                    _syncForDraw: gpuMod.syncThinInstanceForDraw,
                };
            })
        );
    }
    if (loads.length > 0) {
        await Promise.all(loads);
    }
}

/** @internal Return the preloaded skeletal velocity factory. */
export function _getStandardGeometrySkeletonVelocityFactory(): typeof createStandardGeometrySkeletonVelocity | null {
    return _skeletonVelocityFactory;
}

/** @internal Return the preloaded thin-instance helpers, or null if no geometry-pass
 *  mesh carried thin instances (so the modules were never imported). */
export function _getStandardGeometryThinInstanceHelpers(): StandardGeometryThinInstanceHelpers | null {
    return _thinInstanceHelpers;
}

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
    /** Meshes whose velocity output is disabled by the owning task. */
    readonly velocityExclusions?: ReadonlySet<Mesh>;
    /** Effective task camera. When the geometry task renders with a `config.camera`
     *  override (distinct from `scene.camera`), the per-mesh world/previous-world
     *  matrices and the floating-origin offset + invalidation must all use THIS
     *  camera so they share the same origin as the task's view-projection. Falls
     *  back to `scene.camera` when unset. */
    readonly camera?: Camera | null;
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
    /** @internal */
    readonly _velocityExclusions: ReadonlySet<Mesh> | null;
    /** @internal Effective task camera (see {@link StandardGeometryViewConfig.camera});
     *  `null` when the task uses the scene's active camera. */
    readonly _camera: Camera | null;
    /** @internal Shared per-view resources cache populated lazily by the renderable
     *  factory. Opaque to callers. */
    _geometry?: unknown;
    /** @internal Retire the view's shared GPU resources (material + UV UBOs). Set
     *  by {@link createStandardGeometryMaterialView}; called by the owning geometry
     *  task when it discards this view on re-record/dispose. Idempotent. */
    _disposeGeometryResources?: () => void;
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
    Object.defineProperty(view, "_velocityExclusions", { value: config.velocityExclusions ?? null, enumerable: false });
    Object.defineProperty(view, "_camera", { value: config.camera ?? null, enumerable: false });
    Object.defineProperty(view, "_buildGroup", { value: getStandardGeometryGroupBuilder(), enumerable: false });
    Object.defineProperty(view, "_disposeGeometryResources", { value: () => disposeStandardGeometryViewResources(view), enumerable: false });
    return view;
}
