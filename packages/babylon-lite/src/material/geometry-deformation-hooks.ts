import type { Mesh } from "../mesh/mesh.js";
import type * as Deformation from "./geometry-deformation-velocity.js";
import type { WgslSource } from "../shader/wgsl.js";

let _feature: typeof Deformation | null = null;
/** @internal Optional previous-depth output expression installed by the producer enabler. */
export let geometryVelocityOutput: ((alpha: string) => WgslSource) | null = null;

/** @internal An explicit velocity feature supplies the same implementation as legacy Standard preloading. */
export function installGeometryDeformationVelocity(feature: typeof Deformation, output: NonNullable<typeof geometryVelocityOutput>): void {
    _feature = feature;
    geometryVelocityOutput = output;
}

/** @internal Load previous-pose behavior only for a matching geometry velocity pass. */
export async function preloadGeometryDeformationVelocity(meshes: readonly Mesh[], velocity: boolean): Promise<void> {
    if (velocity && !_feature && meshes.some((mesh) => !mesh.thinInstances && !mesh.vat && (!!mesh.skeleton || !!mesh.morphTargets))) {
        _feature = await import("./geometry-deformation-velocity.js");
    }
}

/** @internal Resolve the preloaded optional feature without creating global state. */
export function getGeometryDeformationVelocity(): typeof Deformation | null {
    return _feature;
}
