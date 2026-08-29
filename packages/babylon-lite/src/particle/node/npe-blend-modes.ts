import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import { addFacingBillboardSystemWithParticleBlend } from "../particle-billboard-scene.js";
import { buildNodeParticleSet } from "./npe-build.js";
import type { BuildNodeParticleOptions, NodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/** Enable exact Babylon.js particle blend rendering on any built NPE set. */
export function enableNodeParticleBlendModes(set: NodeParticleSet): NodeParticleSet {
    for (const system of set.systems) {
        system._registerBillboard = (scene, billboard) => addFacingBillboardSystemWithParticleBlend(scene, billboard, system.blendMode);
    }
    return set;
}

/**
 * Build an NPE set with exact Babylon.js particle blend rendering enabled.
 * Graphs using optional graph plumbing, Phase 4 value blocks, or Int value propagation must first be passed to `normalizeNodeParticleGraph`.
 */
export async function buildNodeParticleSetWithBlendModes(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions = {}
): Promise<NodeParticleSet> {
    return enableNodeParticleBlendModes(await buildNodeParticleSet(engine, scene, graph, options));
}
