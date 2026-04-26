/** Renderable — the universal draw contract.
 *
 *  Every visible entity in the scene implements this interface.
 *  The engine iterates renderables in order; no hardcoded pipeline branching.
 *
 *  Renderables are created lazily by scene.build() before the first frame.
 *  Materials own their shaders and pipelines (pillar 4c). */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";

/** Signature of a render target's attachment set — enough to key a GPURenderPipeline. */
export interface RenderTargetSignature {
    readonly colorFormat: GPUTextureFormat;
    readonly depthStencilFormat?: GPUTextureFormat;
    readonly sampleCount: number;
    /** When true, the projection matrix's Y is flipped (offscreen RTT — see writePassSceneUBO).
     *  Pipelines must invert frontFace to keep back-face culling correct. */
    readonly flipY?: boolean;
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
    /** Pipeline used by this binding. Exposed so the caller (drawList) can dedup setPipeline calls. */
    readonly pipeline: GPURenderPipeline;
    /** Optional shadow bind group (group 2). Exposed so drawList can dedup setBindGroup(2) calls
     *  — usually identical across all draws using the same shadowBGL. */
    readonly shadowBG?: GPUBindGroup;
    /** Issue draw commands for this renderable into `pass`. The caller has already set the
     *  pipeline (if changed) and the shadow bind group (if changed). The closure handles
     *  group(1) [material/mesh BG], vertex/index buffers, and drawIndexed.
     *  Returns the number of GPU draw calls. */
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, engine: EngineContext): number;
    /** Update dirty UBOs (world matrix, material UBO) before draw. Called once per frame
     *  per binding. Per-mesh state (e.g. world matrix) shared across bindings should be
     *  version-guarded to avoid redundant writes. */
    updateUBOs?(): void;
    /** Scratch: squared distance from camera for transparent sorting (per-pass). */
    _sortDistance?: number;
}

/** Something that draws itself into a render pass. One renderable == one logical draw unit
 *  (typically one mesh). Resource sharing (scene UBOs, light UBOs, sceneBG) is handled at
 *  scene-level, not by grouping multiple meshes into one Renderable. */
export interface Renderable {
    /** Sort key for draw order (lower = drawn first). Default: 100 (opaque), 140 (transmissive), 150/200 (transparent). */
    readonly order: number;
    /** Whether this renderable is transparent (alpha-blend). */
    readonly isTransparent: boolean;
    /** Whether this renderable is transmissive (refraction through surface). Opaque write-depth
     *  but rendered AFTER the opaque-scene RTT is built. Defaults to false. */
    readonly isTransmissive?: boolean;
    /** Source mesh — used by `removeMeshFromTask` to evict this renderable when the mesh is
     *  removed or its material is swapped. Scene-level renderables (skyboxes, backgrounds)
     *  that live for the full scene lifetime omit it. */
    readonly mesh?: Mesh;
    /**
     * Resolve target-specific GPU state (pipeline, sceneBG) and return a `DrawBinding`
     * whose `draw` closure captures that state. Called by the render pass task at
     * build/insert time.
     */
    bind(engine: EngineContext, target: RenderTargetSignature): DrawBinding;
}

/** Something that runs before the main render pass (shadow maps, compute, etc.). */
export interface PrePassRenderable {
    /** Execute pre-pass work (e.g., render shadow depth map + blur). Returns the number of GPU draw calls issued. */
    execute(encoder: GPUCommandEncoder, engine: EngineContext): number;
}

/** Build result from a mesh group builder. */
export interface MeshGroupBuildResult {
    renderables: Renderable[];
    /** Per-frame callback for refreshing shared GPU buffers (e.g. multi-light UBOs)
     *  that aren't owned by an individual renderable. Called once per frame, before
     *  any draw calls. May be a no-op. */
    update: () => void;
}

/**
 * A function that builds renderables for a group of meshes sharing the same
 * material type. Each material module exports one. The scene calls it at build
 * time — no pipeline-specific logic in scene.ts.
 *
 * @param scene  - The scene context (for engine, camera, env textures, etc.)
 * @param meshes - All meshes that use this builder's material type.
 */
export type MeshGroupBuilder = (scene: any, meshes: any[]) => Promise<MeshGroupBuildResult>;
