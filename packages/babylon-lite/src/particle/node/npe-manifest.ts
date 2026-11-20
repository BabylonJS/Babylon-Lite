import type { NpeBlockEvaluator } from "./npe-build.js";

/** Lazy loader of one block module. Every module listed in the manifest exports its evaluator as `npeBlock`. */
type NpeBlockLoader = () => Promise<{ npeBlock: NpeBlockEvaluator }>;

/**
 * Node-particle block manifest — one lazy entry per supported Babylon.js block class.
 *
 * Each block module owns every serialized property and input form of its class; heavy optional paths are
 * block-local lazy imports, so the builder never routes on block properties. Adding a block adds one entry.
 * Graph-plumbing classes (teleports, elbows, debug) are removed by `normalizeNodeParticleGraph` and are
 * intentionally absent.
 */
// Null prototype: serialized class names such as "constructor" must not resolve to inherited members.
const NPE_BLOCKS = {
    __proto__: null,
    SystemBlock: () => import("./blocks/system-block.js"),
    CreateParticleBlock: () => import("./blocks/create-particle-block.js"),
    BoxShapeBlock: () => import("./blocks/box-shape-block.js"),
    PointShapeBlock: () => import("./blocks/point-shape-block.js"),
    SphereShapeBlock: () => import("./blocks/sphere-shape-block.js"),
    ConeShapeBlock: () => import("./blocks/cone-shape-block.js"),
    CylinderShapeBlock: () => import("./blocks/cylinder-shape-block.js"),
    MeshShapeBlock: () => import("./blocks/mesh-shape-block.js"),
    UpdatePositionBlock: () => import("./blocks/update-position-block.js"),
    UpdateColorBlock: () => import("./blocks/update-color-block.js"),
    UpdateSizeBlock: () => import("./blocks/update-size-block.js"),
    UpdateDirectionBlock: () => import("./blocks/update-direction-block.js"),
    UpdateAngleBlock: () => import("./blocks/update-angle-block.js"),
    UpdateAttractorBlock: () => import("./blocks/update-attractor-block.js"),
    UpdateFlowMapBlock: () => import("./blocks/update-flow-map-block.js"),
    UpdateNoiseBlock: () => import("./blocks/update-noise-block.js"),
    SetupSpriteSheetBlock: () => import("./blocks/setup-sprite-sheet-block.js"),
    BasicSpriteUpdateBlock: () => import("./blocks/basic-sprite-update-block.js"),
    ParticleTextureSourceBlock: () => import("./blocks/texture-source-block.js"),
    ParticleInputBlock: () => import("./blocks/particle-input-block.js"),
    ParticleMathBlock: () => import("./blocks/particle-math-block.js"),
    ParticleLerpBlock: () => import("./blocks/particle-lerp-block.js"),
    ParticleConverterBlock: () => import("./blocks/particle-converter-block.js"),
    ParticleRandomBlock: () => import("./blocks/particle-random-block.js"),
    ParticleGradientBlock: () => import("./blocks/particle-gradient-block.js"),
    ParticleGradientValueBlock: () => import("./blocks/particle-gradient-value-block.js"),
    ParticleConditionBlock: () => import("./blocks/particle-condition-block.js"),
    ParticleFloatToIntBlock: () => import("./blocks/particle-float-to-int-block.js"),
    ParticleVectorLengthBlock: () => import("./blocks/particle-vector-length-block.js"),
    ParticleLocalVariableBlock: () => import("./blocks/particle-local-variable-block.js"),
} as unknown as Readonly<Record<string, NpeBlockLoader | undefined>>;

/** Load the evaluator of one serialized block class. Throws for classes Lite does not implement. */
export async function loadNpeBlock(className: string): Promise<NpeBlockEvaluator> {
    const load = NPE_BLOCKS[className];
    if (!load) {
        throw new Error(`NodeParticle: unsupported block "${className}"`);
    }
    return (await load()).npeBlock;
}
