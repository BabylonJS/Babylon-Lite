import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import { addParticleBillboardSystem } from "../particle-billboard-scene.js";
import { buildNodeParticleSet } from "./npe-build.js";
import type { BuildNodeParticleOptions, NodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/** Build an NPE set with optional Multiply and MultiplyAdd rendering enabled. */
export async function buildNodeParticleSetWithBlendModes(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions = {}
): Promise<NodeParticleSet> {
    const set = await buildNodeParticleSet(engine, scene, graph, options);
    for (const system of set.systems) {
        if (system.blendMode === 3 || system.blendMode === 4) {
            system._addBillboardSystem = addParticleBillboardSystem;
        }
    }
    return set;
}
