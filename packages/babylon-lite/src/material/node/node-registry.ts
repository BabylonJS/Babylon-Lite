/** Node-block registry — side-effect-free lazy dispatch.
 *
 *  Each block lives in its own module under `./blocks/`. The base registry keeps
 *  the pre-existing NME surface inline; newer block families are routed through
 *  small extension registries so older scenes don't fetch every new loader.
 */

import type { BlockEmitter } from "./node-types.js";

export type BlockLoader = () => Promise<{ emitter: BlockEmitter }>;

/** Resolve a block emitter by key. Throws if the block is not registered. */
export async function loadBlockEmitter(key: string): Promise<BlockEmitter> {
    const baseLoader = baseBlockLoader(key);
    if (baseLoader) {
        return (await baseLoader()).emitter;
    }
    const extra = await loadExtraBlockEmitter(key);
    if (extra) {
        return extra;
    }
    throw new Error(`NodeMaterial: no emitter registered for block "${key}"`);
}

/** Returns true if a key is registered (used by tests). */
export function hasBlockEmitter(key: string): boolean {
    return !!baseBlockLoader(key) || !!extraRegistryLoader(key);
}

function baseBlockLoader(key: string): BlockLoader | null {
    switch (key) {
        case "InputBlock":
            return () => import("./blocks/input-block.js");
        case "VectorMergerBlock":
            return () => import("./blocks/vector-merger.js");
        case "FragmentOutputBlock":
            return () => import("./blocks/fragment-output.js");
        case "AddBlock":
            return () => import("./blocks/add-block.js");
        case "SubtractBlock":
            return () => import("./blocks/subtract-block.js");
        case "MultiplyBlock":
            return () => import("./blocks/multiply-block.js");
        case "MinBlock":
            return () => import("./blocks/min-block.js");
        case "MaxBlock":
            return () => import("./blocks/max-block.js");
        case "PowBlock":
            return () => import("./blocks/pow-block.js");
        case "StepBlock":
            return () => import("./blocks/step-block.js");
        case "DotBlock":
            return () => import("./blocks/dot-block.js");
        case "ScaleBlock":
            return () => import("./blocks/scale-block.js");
        case "OneMinusBlock":
            return () => import("./blocks/oneminus-block.js");
        case "NegateBlock":
            return () => import("./blocks/negate-block.js");
        case "NormalizeBlock":
            return () => import("./blocks/normalize-block.js");
        case "LerpBlock":
            return () => import("./blocks/lerp-block.js");
        case "ClampBlock":
            return () => import("./blocks/clamp-block.js");
        case "SmoothStepBlock":
            return () => import("./blocks/smoothstep-block.js");
        case "RemapBlock":
            return () => import("./blocks/remap-block.js");
        case "TrigonometryBlock":
            return () => import("./blocks/trigonometry-block.js");
        case "VectorSplitterBlock":
            return () => import("./blocks/vector-splitter.js");
        case "ColorSplitterBlock":
            return () => import("./blocks/color-splitter.js");
        case "TransformBlock":
            return () => import("./blocks/transform-block.js");
        case "VertexOutputBlock":
            return () => import("./blocks/vertex-output.js");
        case "TextureBlock":
            return () => import("./blocks/texture-block.js");
        case "ImageSourceBlock":
            return () => import("./blocks/image-source.js");
        case "FrontFacingBlock":
            return () => import("./blocks/front-facing.js");
        case "ViewDirectionBlock":
            return () => import("./blocks/view-direction.js");
        case "LightBlock":
            return () => import("./blocks/light-block.js");
        case "LightInformationBlock":
            return () => import("./blocks/light-information.js");
        case "FogBlock":
            return () => import("./blocks/fog-block.js");
        case "PerturbNormalBlock":
            return () => import("./blocks/perturb-normal.js");
        case "BonesBlock":
            return () => import("./blocks/bones-block.js");
        case "InstancesBlock":
            return () => import("./blocks/instances-block.js");
        case "MorphTargetsBlock":
            return () => import("./blocks/morph-targets.js");
        case "ShadowMapBlock":
            return () => import("./blocks/shadow-map.js");
        case "DiscardBlock":
            return () => import("./blocks/discard-block.js");
        case "ReflectionTextureBlock":
            return () => import("./blocks/reflection-texture-block.js");
        case "PBRMetallicRoughnessBlock":
            return () => import("./blocks/pbr-metallic-roughness-block.js");
        case "PBRMetallicRoughnessBlock__full":
            return () => import("./blocks/pbr-metallic-roughness-block-full.js");
        case "ReflectionBlock":
            return () => import("./blocks/reflection-block.js");
        case "ClearCoatBlock":
            return () => import("./blocks/clearcoat-block.js");
        case "SheenBlock":
            return () => import("./blocks/sheen-block.js");
        case "AnisotropyBlock":
            return () => import("./blocks/anisotropy-block.js");
        case "SubSurfaceBlock":
            return () => import("./blocks/subsurface-block.js");
        case "RefractionBlock":
            return () => import("./blocks/refraction-block.js");
        default:
            return null;
    }
}

async function loadExtraBlockEmitter(key: string): Promise<BlockEmitter | null> {
    const loader = extraRegistryLoader(key);
    if (!loader) {
        return null;
    }
    return (await loader()).loadExtraEmitter(key);
}

function extraRegistryLoader(key: string): (() => Promise<{ loadExtraEmitter(key: string): Promise<BlockEmitter> }>) | null {
    switch (key) {
        case "DivideBlock":
        case "ModBlock":
        case "ReciprocalBlock":
        case "LengthBlock":
        case "DistanceBlock":
        case "CrossBlock":
        case "ReflectBlock":
        case "RefractBlock":
        case "ArcTan2Block":
        case "FresnelBlock":
        case "OppositeBlock":
        case "NLerpBlock":
        case "ConditionalBlock":
        case "CurveBlock":
        case "WaveBlock":
        case "RandomNumberBlock":
            return () => import("./node-registry-extra-math.js");
        case "ColorMergerBlock":
        case "ColorConverterBlock":
        case "DesaturateBlock":
        case "GradientBlock":
        case "PosterizeBlock":
        case "ReplaceColorBlock":
        case "PannerBlock":
        case "Rotate2dBlock":
        case "TriPlanarBlock":
        case "BiPlanarBlock":
        case "CloudBlock":
        case "SimplexPerlin3DBlock":
        case "VoronoiNoiseBlock":
        case "WorleyNoise3DBlock":
            return () => import("./node-registry-extra-procedural.js");
        case "DerivativeBlock":
        case "HeightToNormalBlock":
        case "TBNBlock":
        case "NormalBlendBlock":
        case "AmbientOcclusionBlock":
        case "FragCoordBlock":
        case "ScreenSizeBlock":
        case "ScreenSpaceBlock":
        case "TwirlBlock":
        case "FragDepthBlock":
        case "MatrixBuilder":
        case "MatrixSplitterBlock":
        case "MatrixTransposeBlock":
        case "MatrixDeterminantBlock":
            return () => import("./node-registry-extra-advanced.js");
        case "ElbowBlock":
        case "NodeMaterialTeleportInBlock":
        case "NodeMaterialTeleportOutBlock":
        case "NodeMaterialDebugBlock":
        case "MeshAttributeExistsBlock":
        case "ClipPlanesBlock":
        case "ReflectionTextureBaseBlock":
        case "ImageProcessingBlock":
        case "IridescenceBlock":
        case "LoopBlock":
        case "StorageReadBlock":
        case "StorageWriteBlock":
            return () => import("./node-registry-extra-compat.js");
        default:
            return null;
    }
}
