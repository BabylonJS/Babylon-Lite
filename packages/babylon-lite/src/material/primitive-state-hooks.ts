import type { Mesh } from "../mesh/mesh.js";

/** @internal Mesh encoder, PBR primitive resolver, and geometry winding resolver. */
export let _primitiveState: readonly [(mesh: Mesh) => number, (meshFeatures: number, hasDoubleSided: boolean) => GPUPrimitiveState, (meshFeatures: number) => GPUFrontFace] | undefined;

/** @internal Install all primitive-state hooks together. */
export function _installPrimitiveStateHooks(
    encode: (mesh: Mesh) => number,
    resolve: (meshFeatures: number, hasDoubleSided: boolean) => GPUPrimitiveState,
    winding: (meshFeatures: number) => GPUFrontFace
): void {
    _primitiveState = [encode, resolve, winding];
}
