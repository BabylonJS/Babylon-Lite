import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import { cpuTextureSourceBlock } from "./blocks/cpu-texture-source-block.js";
import { updateFlowMapBlock } from "./blocks/update-flow-map-block.js";
import type { BuildNodeParticleOptions, NodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";
import { buildNodeParticleSetWithTextureUpdateRuntime } from "./npe-texture-update-runtime.js";

/** @internal Dynamically loaded implementation for the public flow-map builder. */
export async function buildNodeParticleSetWithFlowMapsRuntime(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions
): Promise<NodeParticleSet> {
    return buildNodeParticleSetWithTextureUpdateRuntime(
        engine,
        scene,
        graph,
        options,
        (className) => (className === "UpdateFlowMapBlock" ? [updateFlowMapBlock, "flowMap"] : undefined),
        cpuTextureSourceBlock
    );
}
