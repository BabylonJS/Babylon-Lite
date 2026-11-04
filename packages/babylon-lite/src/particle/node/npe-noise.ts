import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { BuildNodeParticleOptions, NodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/** Build an NPE set with the optional UpdateNoiseBlock evaluator enabled. */
export async function buildNodeParticleSetWithNoiseTextures(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions = {}
): Promise<NodeParticleSet> {
    return (await import("./npe-noise-runtime.js")).buildNodeParticleSetWithNoiseTexturesRuntime(engine, scene, graph, options);
}
