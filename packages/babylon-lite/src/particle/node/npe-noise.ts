import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { BuildNodeParticleOptions, NodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/**
 * Build an NPE set with the optional UpdateNoiseBlock evaluator enabled.
 * Graphs using optional graph plumbing, Phase 4 value blocks, or Int value propagation must first be passed to `normalizeNodeParticleGraph`.
 */
export async function buildNodeParticleSetWithNoiseTextures(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions = {}
): Promise<NodeParticleSet> {
    return (await import("./npe-noise-runtime.js")).buildNodeParticleSetWithNoiseTexturesRuntime(engine, scene, graph, options);
}
