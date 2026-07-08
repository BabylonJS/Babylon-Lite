import type { ParticleBlockEvaluator } from "./npe-types.js";

/**
 * Lazily load the evaluator for a node-particle block class.
 *
 * Each arm is a dynamic `import(...)` so a scene's bundle includes only the block classes its graph
 * actually references — unused blocks tree-shake to zero bytes (the same discipline as the node-material
 * registry). Add new block classes here as scenes need them.
 */
export async function loadParticleBlockEvaluator(className: string): Promise<ParticleBlockEvaluator> {
    switch (className) {
        case "SystemBlock":
            return (await import("./blocks/system-block.js")).systemBlock;
        case "CreateParticleBlock":
            return (await import("./blocks/create-particle-block.js")).createParticleBlock;
        case "BoxShapeBlock":
            return (await import("./blocks/box-shape-block.js")).boxShapeBlock;
        case "SphereShapeBlock":
            return (await import("./blocks/sphere-shape-block.js")).sphereShapeBlock;
        case "PointShapeBlock":
            return (await import("./blocks/point-shape-block.js")).pointShapeBlock;
        case "ConeShapeBlock":
            return (await import("./blocks/cone-shape-block.js")).coneShapeBlock;
        case "CylinderShapeBlock":
            return (await import("./blocks/cylinder-shape-block.js")).cylinderShapeBlock;
        case "MeshShapeBlock":
            return (await import("./blocks/mesh-shape-block.js")).meshShapeBlock;
        case "ParticleInputBlock":
            return (await import("./blocks/particle-input-block.js")).particleInputBlock;
        case "ParticleTextureSourceBlock":
            return (await import("./blocks/texture-source-block.js")).textureSourceBlock;
        case "ParticleRandomBlock":
            return (await import("./blocks/particle-random-block.js")).particleRandomBlock;
        case "ParticleLerpBlock":
            return (await import("./blocks/particle-lerp-block.js")).particleLerpBlock;
        case "ParticleConverterBlock":
            return (await import("./blocks/particle-converter-block.js")).particleConverterBlock;
        case "ParticleMathBlock":
            return (await import("./blocks/particle-math-block.js")).particleMathBlock;
        case "UpdatePositionBlock":
            return (await import("./blocks/update-position-block.js")).updatePositionBlock;
        case "UpdateColorBlock":
            return (await import("./blocks/update-color-block.js")).updateColorBlock;
        case "UpdateAngleBlock":
            return (await import("./blocks/update-angle-block.js")).updateAngleBlock;
        case "UpdateDirectionBlock":
            return (await import("./blocks/update-direction-block.js")).updateDirectionBlock;
        default:
            throw new Error(`NodeParticle: unsupported block class "${className}"`);
    }
}
