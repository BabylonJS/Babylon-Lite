import type { SoaBlockEvaluator } from "./npe-build.js";

/**
 * SoA node-particle block registry — side-effect-free lazy dispatch.
 *
 * Base blocks are routed here. Optional feature families are routed through small extra registries so
 * adding feature blocks does not add their loader stubs to every particle scene. This mirrors NME's
 * `node-registry.ts` pattern; callers only provide a class name and never assemble a registry themselves.
 */
export async function loadSoaBlockEvaluator(className: string): Promise<SoaBlockEvaluator> {
    switch (className) {
        case "SystemBlock":
            return (await import("./blocks/system-block.js")).systemBlock;
        case "CreateParticleBlock":
            return (await import("./blocks/create-particle-block.js")).createParticleBlock;
        case "BoxShapeBlock":
            return (await import("./blocks/box-shape-block.js")).boxShapeBlock;
        case "UpdatePositionBlock":
            return (await import("./blocks/update-position-block.js")).updatePositionBlock;
        case "UpdateColorBlock":
            return (await import("./blocks/update-color-block.js")).updateColorBlock;
        case "ParticleTextureSourceBlock":
            return (await import("./blocks/texture-source-block.js")).particleTextureSourceBlock;
        case "ParticleInputBlock":
            return (await import("./blocks/particle-input-block.js")).particleInputBlock;
        case "ParticleMathBlock":
            return (await import("./blocks/particle-math-compact-block.js")).particleMathCompactBlock;
        case "ParticleLerpBlock":
            return (await import("./blocks/particle-lerp-block.js")).particleLerpBlock;
        case "ParticleConverterBlock":
            return (await import("./blocks/particle-converter-block.js")).particleConverterBlock;
        case "ParticleRandomBlock":
            return (await import("./blocks/particle-random-block.js")).particleRandomBlock;
        default:
            return className.endsWith("ShapeBlock")
                ? (await import("./registry-extra-emitters.js")).loadEmitterBlockEvaluator(className)
                : (await import("./registry-extra.js")).loadExtraBlockEvaluator(className);
    }
}
