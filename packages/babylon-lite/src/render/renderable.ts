/** Renderable — the universal draw contract.
 *
 *  Every visible entity in the scene implements this interface.
 *  The engine iterates renderables in order; no hardcoded pipeline branching.
 *
 *  Renderables are created lazily by scene.build() before the first frame.
 *  Materials own their shaders and pipelines (pillar 4c). */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Material } from "../material/material.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Camera } from "../camera/camera.js";

/** Dynamic per-pass data available before a binding draws. */
export interface DrawUpdateContext {
    readonly targetWidth: number;
    readonly targetHeight: number;
    /** Active pass camera. Null for camera-less passes. */
    readonly _camera?: Camera | null;
}

/**
 * A per-pass draw binding produced by `Renderable.bind(engine, target)`.
 *
 * Target-specific GPU state (resolved pipeline(s), sceneBG, etc.) is captured in the
 * `draw` closure so the binding itself has no material-specific payload. The same
 * `Renderable` can be bound multiple times (once per pass it participates in) with
 * a separate `DrawBinding` each time.
 */
export interface DrawBinding {
    /** Back-reference for sort/eviction (order, mesh identity). */
    readonly renderable: Renderable;
    /** Pipeline used by this binding. The render pass task owns setPipeline()
     *  and dedups consecutive bindings with the same pipeline. */
    readonly pipeline: GPURenderPipeline;
    /** Issue draw commands for this renderable into `pass`. The render pass task has
     *  already set the scene bind group (group 0) and `pass.setPipeline(pipeline)` if
     *  it changed. The closure handles per-mesh / per-material bind groups,
     *  vertex/index buffers, and drawIndexed. Returns the number of GPU draw calls. */
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, engine: EngineContext): number;
    /** Update dirty per-pass state before draw. Called once per frame per binding.
     *  Per-mesh state (e.g. world matrix) shared across bindings should be
     *  version-guarded to avoid redundant writes. Render task transparent sorting
     *  runs after these updates, so renderables may refresh `_worldCenter` here. */
    update?(context: DrawUpdateContext): void;
    /** Scratch: camera-space depth for transparent sorting (per-pass). */
    _sortDistance?: number;
}

/** Something that draws itself into a render pass. The bind() method returns a
 *  DrawBinding capturing target-specific GPU state and the per-frame draw closure. */
export interface Renderable {
    /** Sort key for draw order (lower = drawn first). Default: 100 (opaque), 200 (transparent). */
    readonly order: number;
    /** Whether this renderable is transparent (auto-derived from material). */
    readonly isTransparent: boolean;
    /** True transmissive/refractive surface. Excluded from opaque-scene RTT; also direct-drawn. */
    readonly _transmissive?: boolean;
    /** Whether this non-transparent renderable must direct-draw after cached opaque bundles. */
    readonly _direct?: boolean;
    /** Reference to the source mesh (for distance sort + material-change detection). */
    readonly mesh?: Mesh;
    /** Scratch: camera-space depth for transparent sorting. */
    _sortDistance?: number;
    /** World-space center for distance sort computation. */
    _worldCenter?: [number, number, number];
    /** Material reference at build time — for detecting material swaps. */
    _lastMaterial?: any;
    /**
     * Resolve target-specific GPU state (pipeline) and return a `DrawBinding` whose
     * `draw` closure captures that state. Called by the render pass task at build/insert
     * time. The scene bind group (group 0) is set once per pass by the task — renderables
     * never see it. Renderables that need to participate in multiple passes with different
     * target formats should pick the appropriate pipeline based on `target`.
     */
    bind(engine: EngineContext, target: RenderTargetSignature): DrawBinding;
}

/** Something that runs before the main render pass (shadow maps, compute, etc.). */
export interface PrePassRenderable {
    /** Execute pre-pass work (e.g., render shadow depth map + blur). Returns the number of GPU draw calls issued. */
    execute(encoder: GPUCommandEncoder, engine: EngineContext): number;
}

/** Updatable scene uniforms — called once per frame before any draw calls.
 *  Multiple renderables may share a scene UBO; only one updater is needed per UBO. */
export interface SceneUniformUpdater {
    /** Write per-frame camera/light/fog data to the scene UBO. */
    update(engine: EngineContext): void;
}

/** Build result from a mesh group builder. */
export interface MeshGroupBuildResult {
    renderables: Renderable[];
    updater?: SceneUniformUpdater;
    /** Closure used to rebuild a single mesh — captures the per-scene context
     *  (composer, BG caches, lights UBO, …) so material swaps and per-pass overrides
     *  reuse the same setup. The group builder stores it on itself as
     *  `_rebuildSingle` after the first run. */
    rebuildSingle: (scene: SceneContext, mesh: Mesh, materialOverride?: Material) => Renderable;
}

/**
 * A function that builds renderables for a group of meshes sharing the same
 * material type. Each material module exports one. The scene calls it at build
 * time — no pipeline-specific logic in scene.ts.
 *
 *  - `_rebuildSingle` is set by the group builder on first run (same compilation
 *    unit as `buildSingleX`). Used for per-mesh material swaps and per-pass
 *    material overrides (`RenderTask.addMesh`).
 *
 * @param scene  - The scene context (for engine, camera, env textures, etc.)
 * @param meshes - All meshes that use this builder's material type.
 */
export type MeshGroupBuilder = ((scene: SceneContext, meshes: Mesh[]) => Promise<MeshGroupBuildResult>) & {
    _rebuildSingle?: (scene: SceneContext, mesh: Mesh, materialOverride?: Material) => Renderable;
    _materialFamily?: "standard" | "pbr" | "node";
};
