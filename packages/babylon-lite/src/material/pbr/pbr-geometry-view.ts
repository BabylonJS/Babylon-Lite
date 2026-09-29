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
import type { Mesh } from "../../mesh/mesh.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { Renderable } from "../../render/renderable.js";
import type { MaterialView } from "../material.js";
import type { GeometryTextureType } from "../../frame-graph/geometry-types.js";
import type { Camera } from "../../camera/camera.js";
import { PBR_HAS_ALPHA_BLEND, PBR2_ESM_SHADOW_OUTPUT, PBR2_NO_COLOR_OUTPUT } from "./pbr-flags.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { _pbrMeshRequest, getPbrGeometryGroupBuilder } from "./pbr-geometry-renderable.js";
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
     *  GC-reclaimed when the owning geometry tasks drop this view. Per-mesh
     *  mesh/material UBOs are retained directly by each task-owned renderable. */
    _geometry?: unknown;
}

// Snapshot of the currently-building view's attachments so the registered
// PBR geometry extension can read them from `frag(ctx)`. The extension is
// invoked synchronously during composePbr inside `buildPbrGeometryRenderable`;
// the snapshot is set right before that call and cleared after.
/** @internal Attachment scope of the active synchronous geometry composition. */
export let _activePbrGeometryAttachments: readonly GeometryTextureType[] | undefined;

/** @internal Used by the geometry renderable to scope attachment access for
 *  the PBR ext during a composePbr call. Returns the previous value so the
 *  caller can restore it (avoids global leakage in nested scenarios). */
export function _setActivePbrGeometryAttachments(att: readonly GeometryTextureType[] | undefined): readonly GeometryTextureType[] | undefined {
    const prev = _activePbrGeometryAttachments;
    _activePbrGeometryAttachments = att;
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
/**
 * @internal Whether `forward` — the renderable the scene's PBR group currently tracks for `mesh` — was built
 * for the mesh's CURRENT generation: the same PBR context the geometry pass is about to compose against, the
 * same material render-feature object, and the same request of that context — mesh feature bits
 * (receive-shadows included), light mode and single-light type.
 *
 * A PBR geometry renderable reuses the forward PBR context, and a context only carries what the forward build
 * that produced it asked for: the single-light block of each light type it saw, the multi-light path only if
 * some mesh needed it, shadow / thin-instance / morph helpers likewise. Forward rebuilds are asynchronous and
 * make-before-break, so while one is pending (or has not been requested yet) the group still tracks the OLD
 * renderable and the scene still publishes the OLD context. Binding the mesh then pairs its new state with
 * that context: `receiveShadows` enabled on a single-light mesh, or a second light added, asks a single-light
 * composer for the multi-light path — WGSL with undeclared light symbols; first thin instances draw without
 * the instance-matrix buffer. So the geometry pass may only ask of a context what the forward build of that
 * same mesh asked of it. `rebuildMaterial` drops `_renderFeatures` at request time, so a pending material
 * rebuild shows up as a changed object; the rest is `_pbrMeshRequest`, the derivation the geometry renderable
 * itself builds from, evaluated under the forward shadow rule (shadow-output materials never receive).
 */
export function isPbrForwardBuildCurrent(scene: SceneContext, forward: Renderable | undefined, mesh: Mesh): boolean {
    const gen = forward?._gen;
    const renderFeatures = (mesh.material as PbrMaterialProps | null)?._renderFeatures;
    return (
        !!gen &&
        gen[4] === renderFeatures &&
        _pbrMeshRequest(scene, mesh, (renderFeatures?.features2 ?? 0) & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT)).every((value, index) => value === gen[index])
    );
}

export function createPbrGeometryMaterialView(source: PbrMaterialProps, config: PbrGeometryViewConfig): PbrGeometryMaterialView {
    _ensurePbrGeometryExt(() => _activePbrGeometryAttachments);
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
