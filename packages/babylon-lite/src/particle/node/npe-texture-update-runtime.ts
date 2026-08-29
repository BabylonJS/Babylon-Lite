import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import { embeddedParticleTextureSourceBlock } from "./blocks/embedded-texture-source-block.js";
import { buildNodeParticleSet, type BuildNodeParticleOptions, type NodeParticleSet, type NpeBlockEvaluator } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/** @internal Build an NPE set with opt-in CPU texture update evaluators. */
export function buildNodeParticleSetWithTextureUpdateRuntime(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions,
    featureClassName: string,
    featureTextureInputName: string,
    featureEvaluator: NpeBlockEvaluator,
    featureTextureEvaluator: NpeBlockEvaluator
): Promise<NodeParticleSet>;
export function buildNodeParticleSetWithTextureUpdateRuntime(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions,
    featureClassName: string,
    featureTextureInputName: string,
    featureEvaluator: NpeBlockEvaluator,
    featureTextureEvaluator: NpeBlockEvaluator,
    secondaryFeatureClassName: string,
    secondaryFeatureTextureInputName: string,
    secondaryFeatureEvaluator: NpeBlockEvaluator
): Promise<NodeParticleSet>;
export async function buildNodeParticleSetWithTextureUpdateRuntime(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions,
    featureClassName: string,
    featureTextureInputName: string,
    featureEvaluator: NpeBlockEvaluator,
    featureTextureEvaluator: NpeBlockEvaluator,
    secondaryFeatureClassName?: string,
    secondaryFeatureTextureInputName?: string,
    secondaryFeatureEvaluator?: NpeBlockEvaluator
): Promise<NodeParticleSet> {
    return buildNodeParticleSet(engine, scene, graph, {
        ...options,
        _getEvaluator: (block) => {
            if (block.className === featureClassName) {
                return featureEvaluator;
            }
            if (block.className === secondaryFeatureClassName) {
                return secondaryFeatureEvaluator;
            }
            return block.className === "ParticleTextureSourceBlock" ? embeddedParticleTextureSourceBlock : options._getEvaluator?.(block);
        },
        _getInputEvaluator: (block, input) => {
            const textureInputName =
                block.className === featureClassName ? featureTextureInputName : block.className === secondaryFeatureClassName ? secondaryFeatureTextureInputName : undefined;
            return input.name === textureInputName ? featureTextureEvaluator : options._getInputEvaluator?.(block, input);
        },
    });
}
