/** Builds the `GPUPrimitiveState` partial for glTF's non-triangle primitive modes.
 *
 *  Its own module, dynamically imported by the glTF primitive feature, so the four topology names,
 *  the two index formats and their branches are fetched ONLY by a scene that actually draws points,
 *  lines or strips. Two other groups of scenes must not pay for it:
 *    - every PBR scene, if it lived on the shared pipeline path (~144 bytes each, which is what
 *      pushed eleven scenes past their ceilings);
 *    - a scene that loads the primitive feature only for a MIRRORED node (a negative-determinant
 *      transform) and is otherwise an ordinary triangle list — the common reason that feature loads
 *      at all. Those meshes need the winding bit and nothing here. */

/** Build the exotic primitive partial for a topology index (1=points, 2=lines, 3=line-strip,
 *  4=triangle-strip). Never called for a triangle list.
 *
 *  Deliberately NOT underscore-prefixed: this is reached through a dynamic `import()` and read as a
 *  property off the module namespace, which the scene bundler's Terser pass mangles for names
 *  matching `/^_[a-z]/` (scripts/bundle-scenes-core.ts) — an `_buildPrimitiveState` here becomes
 *  "i is not a function" at runtime in bundled builds. Same reason as `installMirroredMeshSupport`.
 *  @internal */
export function buildPrimitiveState(topo: number, indexU32: boolean): GPUPrimitiveState {
    const prim: GPUPrimitiveState = {
        topology: topo === 1 ? "point-list" : topo === 2 ? "line-list" : topo === 3 ? "line-strip" : "triangle-strip",
    };
    if (topo < 4) {
        // Points and lines have no faces to cull; a triangle strip still obeys its material.
        prim.cullMode = "none";
    }
    if (topo > 2) {
        // BOTH strips index-draw, so this is not the `else` of the above: line-strip needs the
        // index format AND the cull exemption.
        prim.stripIndexFormat = indexU32 ? "uint32" : "uint16";
    }
    return prim;
}
