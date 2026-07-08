import type { Vec3 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { addMorphDelta, skinVertexToRef } from "./deformation-math.js";

// Scratch reused by computeDeformedPositionToRef to keep it zero-allocation after the first call. The
// shared primitives operate on a Float32Array at an offset, so the single vertex is staged here at
// offset 0 and copied out to the Vec3 result at the end. Allocated lazily so merely importing this
// module (e.g. for tree-shaking analysis) does not allocate anything until the function is called.
let _deformScratch: Float32Array | undefined;

/**
 * Writes the deformed MESH-LOCAL position of a single vertex into `out`, applying the mesh's active
 * morph targets and skeletal skinning for the current frame.
 *
 * Reads the CPU mirrors that the animation tick maintains every frame (`_cpuPositions`,
 * `morphTargets.weights`/`targets`, `skeleton.boneMatrices`), so the result matches what the GPU
 * renders this frame — with no GPU readback and no latency.
 *
 * Mirrors the structure of Babylon.js core's `GetTransformedPosition`: the result is in mesh-local
 * space. A caller computing a hotspot barycentric-blends several deformed vertices and then applies
 * `mesh.worldMatrix` to the single blended point (blending is affine, so blend-then-transform equals
 * transform-then-blend). This is the primitive used to track hotspot/annotation positions on animated
 * meshes.
 *
 * Lives in its own module (rather than alongside the bulk `computeDeformedPositions`) so that the
 * GPU picker's dynamic `import()` of `deformed-geometry.js` does not drag this hotspot-only function
 * into every picking scene's bundle. It reuses the shared morph/skin primitives in
 * `deformation-math.js`, so there is no duplicated math.
 *
 * @param mesh - The mesh to query. Must have CPU position data (`_cpuPositions`).
 * @param vertexIndex - Index of the vertex within the mesh's position buffer.
 * @param out - Destination mesh-local position, written in place (zero-allocation).
 * @returns true on success; false if the mesh has no CPU positions or `vertexIndex` is out of range.
 */
export function computeDeformedPositionToRef(mesh: Mesh, vertexIndex: number, out: Vec3): boolean {
    const base = mesh._cpuPositions;
    if (!base) {
        return false;
    }
    const componentOffset = vertexIndex * 3;
    if (componentOffset < 0 || componentOffset + 2 >= base.length) {
        return false;
    }

    const scratch = (_deformScratch ??= new Float32Array(3));
    scratch[0] = base[componentOffset]!;
    scratch[1] = base[componentOffset + 1]!;
    scratch[2] = base[componentOffset + 2]!;

    // Morph targets — accumulate this vertex's active target offsets (shared with the bulk path). The
    // vertex is staged at scratch offset 0, but its deltas still come from the mesh's componentOffset.
    const morph = mesh.morphTargets;
    if (morph) {
        addMorphDelta(morph, scratch, 0, componentOffset);
    }

    // Skeletal skinning — reuse the same bone-blend math the render path uses. wCoord = 1 (position).
    const skeleton = mesh.skeleton;
    if (skeleton) {
        skinVertexToRef(
            skeleton.boneMatrices,
            skeleton.joints,
            skeleton.weights,
            skeleton.joints1,
            skeleton.weights1,
            vertexIndex,
            scratch[0]!,
            scratch[1]!,
            scratch[2]!,
            1,
            scratch,
            0
        );
    }

    out.x = scratch[0]!;
    out.y = scratch[1]!;
    out.z = scratch[2]!;
    return true;
}
