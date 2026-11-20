import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { BuildNodeParticleOptions, NodeParticleSet } from "./npe-build.js";
import { buildNodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/**
 * Build an NPE set with `UpdateFlowMapBlock` support.
 * @deprecated Flow-map blocks now load from the graph; use {@link buildNodeParticleSet}.
 */
export function buildNodeParticleSetWithFlowMaps(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet> {
    return buildNodeParticleSet(engine, scene, graph, options);
}
