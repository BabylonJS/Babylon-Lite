import type { NpeBlockTable } from "./npe-manifest.js";

/**
 * Extension node-particle block table — every supported class outside the converter-default base table in
 * `npe-manifest.ts`. New block classes are added here. `loadNpeBlock` imports this table only on a base-table
 * miss, so graphs built from the default classes never fetch it.
 */
// Null prototype: serialized class names such as "constructor" must not resolve to inherited members.
export const NPE_EXTRA_BLOCKS = {
    __proto__: null,
    PointShapeBlock: () => import("./blocks/point-shape-block.js"),
    SphereShapeBlock: () => import("./blocks/sphere-shape-block.js"),
    ConeShapeBlock: () => import("./blocks/cone-shape-block.js"),
    CylinderShapeBlock: () => import("./blocks/cylinder-shape-block.js"),
    MeshShapeBlock: () => import("./blocks/mesh-shape-block.js"),
    UpdateSizeBlock: () => import("./blocks/update-size-block.js"),
    UpdateDirectionBlock: () => import("./blocks/update-direction-block.js"),
    UpdateAngleBlock: () => import("./blocks/update-angle-block.js"),
    UpdateAttractorBlock: () => import("./blocks/update-attractor-block.js"),
    UpdateFlowMapBlock: () => import("./blocks/update-flow-map-block.js"),
    UpdateNoiseBlock: () => import("./blocks/update-noise-block.js"),
    SetupSpriteSheetBlock: () => import("./blocks/setup-sprite-sheet-block.js"),
    BasicSpriteUpdateBlock: () => import("./blocks/basic-sprite-update-block.js"),
    ParticleGradientBlock: () => import("./blocks/particle-gradient-block.js"),
    ParticleGradientValueBlock: () => import("./blocks/particle-gradient-value-block.js"),
    ParticleConditionBlock: () => import("./blocks/particle-condition-block.js"),
    ParticleFloatToIntBlock: () => import("./blocks/particle-float-to-int-block.js"),
    ParticleVectorLengthBlock: () => import("./blocks/particle-vector-length-block.js"),
    ParticleLocalVariableBlock: () => import("./blocks/particle-local-variable-block.js"),
} as unknown as NpeBlockTable;
