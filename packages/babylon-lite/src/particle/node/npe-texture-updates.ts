import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { BuildNodeParticleOptions, NodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/**
 * Build an NPE set with both optional flow-map and noise-texture updates enabled.
 * Graphs using optional graph plumbing, Phase 4 value blocks, or Int value propagation must first be passed to `normalizeNodeParticleGraph`.
 */
export async function buildNodeParticleSetWithTextureUpdates(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions = {}
): Promise<NodeParticleSet> {
    return (await import("./npe-texture-updates-runtime.js")).buildNodeParticleSetWithTextureUpdatesRuntime(engine, scene, graph, options);
}
