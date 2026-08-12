import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { BuildNodeParticleOptions, NodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/** Build an NPE set with the optional UpdateFlowMapBlock evaluator enabled. */
export async function buildNodeParticleSetWithFlowMaps(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions = {}
): Promise<NodeParticleSet> {
    return (await import("./npe-flow-map-runtime.js")).buildNodeParticleSetWithFlowMapsRuntime(engine, scene, graph, options);
}
