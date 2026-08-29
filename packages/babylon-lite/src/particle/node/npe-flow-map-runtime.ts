import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import { cpuTextureSourceBlock } from "./blocks/cpu-texture-source-block.js";
import { updateFlowMapBlock } from "./blocks/update-flow-map-block.js";
import { buildNodeParticleSet, type BuildNodeParticleOptions, type NodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/** @internal Dynamically loaded implementation for the public flow-map builder. */
export async function buildNodeParticleSetWithFlowMapsRuntime(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions
): Promise<NodeParticleSet> {
    return buildNodeParticleSet(engine, scene, graph, {
        ...options,
        _getEvaluator: (block) => (block.className === "UpdateFlowMapBlock" ? updateFlowMapBlock : options._getEvaluator?.(block)),
        _getInputEvaluator: (block, input) =>
            block.className === "UpdateFlowMapBlock" && input.name === "flowMap" ? cpuTextureSourceBlock : options._getInputEvaluator?.(block, input),
    });
}
