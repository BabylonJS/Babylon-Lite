import type { SoaBlockEvaluator } from "./npe-build.js";

/** Shape table loaded only by emitter-local systems. */
export async function loadLocalShapeEvaluator(className: string): Promise<SoaBlockEvaluator> {
    switch (className) {
        case "BoxShapeBlock":
            return (await import("./blocks/box-shape-local-block.js")).boxShapeLocalBlock;
        case "PointShapeBlock":
            return (await import("./blocks/point-shape-local-block.js")).pointShapeLocalBlock;
        case "SphereShapeBlock":
            return (await import("./blocks/sphere-shape-local-block.js")).sphereShapeLocalBlock;
        case "ConeShapeBlock":
            return (await import("./blocks/cone-shape-local-block.js")).coneShapeLocalBlock;
        case "CylinderShapeBlock":
            return (await import("./blocks/cylinder-shape-local-block.js")).cylinderShapeLocalBlock;
        case "MeshShapeBlock":
            return (await import("./blocks/mesh-shape-local-block.js")).meshShapeLocalBlock;
        default:
            throw new Error(`SoA NodeParticle: unsupported local shape "${className}"`);
    }
}
