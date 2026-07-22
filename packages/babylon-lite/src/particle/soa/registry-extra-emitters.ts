import type { SoaBlockEvaluator } from "./npe-build.js";

/** Optional world-space emitter shapes beyond the base box. */
export async function loadEmitterBlockEvaluator(className: string): Promise<SoaBlockEvaluator> {
    switch (className) {
        case "PointShapeBlock":
            return (await import("./blocks/point-shape-block.js")).pointShapeBlock;
        case "SphereShapeBlock":
            return (await import("./blocks/sphere-shape-block.js")).sphereShapeBlock;
        case "ConeShapeBlock":
            return (await import("./blocks/cone-shape-block.js")).coneShapeBlock;
        case "CylinderShapeBlock":
            return (await import("./blocks/cylinder-shape-block.js")).cylinderShapeBlock;
        case "MeshShapeBlock":
            return (await import("./blocks/mesh-shape-block.js")).meshShapeBlock;
        default:
            throw new Error(`SoA NodeParticle: unsupported emitter block "${className}"`);
    }
}
