/** Renderable — the universal draw contract.
 *
 *  Every visible entity in the scene implements this interface.
 *  The engine iterates renderables in order; no hardcoded pipeline branching.
 *
 *  Renderables are created lazily by scene.build() before the first frame.
 *  Materials own their shaders and pipelines (pillar 4c). */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";

/** Something that draws itself into a render pass. */
export interface Renderable {
    /** Sort key for draw order (lower = drawn first). Default: 100 (opaque), 200 (transparent). */
    readonly order: number;
    /** Whether this renderable is transparent (auto-derived from material). */
    readonly isTransparent: boolean;
    /** Whether this renderable is transmissive (refraction through surface). Opaque write-depth
     *  but rendered AFTER the opaque-scene RTT is built. Defaults to false. */
    readonly isTransmissive?: boolean;
    /** Reference to the source mesh (for distance sort + material-change detection). */
    readonly mesh?: Mesh;
    /** Pipeline reference for state batching (skip redundant setPipeline). */
    readonly _pipeline?: GPURenderPipeline;
    /** Scene bind group reference for state batching (skip redundant setBindGroup). */
    readonly _sceneBG?: GPUBindGroup;
    /** Scratch: squared distance from camera for transparent sorting. */
    _sortDistance?: number;
    /** World-space center for distance sort computation. */
    _worldCenter?: [number, number, number];
    /** Material reference at build time — for detecting material swaps. */
    _lastMaterial?: any;
    /** Update dirty UBOs (world matrices) before draw. Called once per frame. */
    updateUBOs?(): void;
    /** Issue draw commands into the given render pass (or bundle encoder). Returns the number of GPU draw calls issued. */
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, engine: EngineContext): number;
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
    updater: SceneUniformUpdater;
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
