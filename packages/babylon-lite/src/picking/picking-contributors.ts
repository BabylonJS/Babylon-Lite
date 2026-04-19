/**
 * Generic GPU-pick contributor pattern.
 *
 * The 1×1 ID-pass picker (`gpu-picker.ts`) is split into two halves:
 *   1. A shared "pick pass" that owns the 1×1 render targets, scene UBO, and
 *      readback dance — defined in `gpu-picker.ts`.
 *   2. A list of `PickContributor`s, each of which knows how to (a) draw its
 *      own entities into the shared pick pass with unique pick IDs, and (b)
 *      resolve a returned pick ID + world-space hit point into a domain
 *      `PickingInfo` (or null if it doesn't own that ID).
 *
 * Mesh picking lives in `gpu-picker.ts` itself — it is always paid-for in
 * scenes that use the picker, so keeping it in the main file matches the
 * pre-refactor tree-shake footprint exactly. Sprite (billboard) picking is
 * registered lazily by the billboard renderable through this interface, so
 * mesh-only scenes never load any sprite-picking code.
 */

import type { SceneContext, SceneContextInternal } from "../scene/scene.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { PickingInfo } from "./picking-info.js";

/** Per-pick context shared by every contributor's draw step. */
export interface PickPassContext {
    /** Encoder for the pick command buffer (shared across all contributors). */
    encoder: GPUCommandEncoder;
    /** Active 1×1 render pass. */
    pass: GPURenderPassEncoder;
    /** Scene bind group (group 0) — viewProjection UBO; safe to re-bind. */
    sceneBG: GPUBindGroup;
    /** Engine handle for buffer + pipeline creation. */
    engine: EngineContextInternal;
    /** Scratch list of GPU buffers to destroy after this pick. */
    tempBuffers: GPUBuffer[];
    /** Pick-zoomed VP for the 1×1 target. */
    pickVP: Float32Array;
    /** Original full-resolution VP (for reconstructing world hit point). */
    fullVP: Float32Array;
    /** Pick coordinates (clamped). */
    pickXPx: number;
    pickYPx: number;
    canvasWidth: number;
    canvasHeight: number;
    camera: NonNullable<SceneContext["camera"]>;
}

/** A pick-pass participant. Each contributor owns one or more draw steps and
 *  the pick-ID range it consumed. The picker invokes `draw()` once per pick,
 *  then `resolve()` once per contributor with the returned pick ID. */
export interface PickContributor {
    /** Issue draw commands into the shared pick pass. Returns the next free pick ID. */
    draw(ctx: PickPassContext, nextPickId: number): number;
    /** Try to resolve a pick ID returned by the GPU. Returns the domain-specific
     *  `PickingInfo` if this contributor owns the ID, or null otherwise.
     *  `worldPoint` is the reconstructed world-space hit point (best-effort). */
    resolve(pickId: number, worldPoint: [number, number, number] | null, depth: number): PickingInfo | null;
}

/** Per-scene contributor registry. Created lazily — mesh-only scenes pay
 *  zero bytes for this list because nothing accesses it until a non-mesh
 *  contributor (e.g. a billboard system) registers itself. */
export function getOrCreatePickContributors(scene: SceneContext): PickContributor[] {
    const ctx = scene as SceneContextInternal & { _pickContributors?: PickContributor[] };
    if (!ctx._pickContributors) {
        ctx._pickContributors = [];
    }
    return ctx._pickContributors;
}

/** Read-only view of the registry — null when no contributor has registered. */
export function getPickContributors(scene: SceneContext): readonly PickContributor[] | null {
    const ctx = scene as SceneContextInternal & { _pickContributors?: PickContributor[] };
    return ctx._pickContributors ?? null;
}
