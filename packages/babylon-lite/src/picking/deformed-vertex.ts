import type { Vec3 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { addMorphDelta, skinVertexToRef } from "./deformation-math.js";

/**
 * An immutable copy of the animation state that drives a mesh's deformation.
 *
 * A GPU pick records its draw against the pose of frame N, but the depth readback only resolves a
 * frame or two later, by which point the animation tick has advanced `skeleton.boneMatrices` and
 * `morphTargets.weights` in place. Resolving the hit triangle against those live mirrors would derive
 * the face normal from a different pose than the one that produced the hit. Capturing is O(bones +
 * targets) — independent of vertex count — so the picker can hold the drawn pose without the O(V)
 * geometry snapshot this path replaced.
 */
export interface DeformPose {
    readonly boneMatrices: Float32Array | null;
    readonly morphWeights: Float32Array | null;
}

/** Copy `mesh`'s current deformation pose, or null when the mesh does not deform. */
export function captureDeformPose(mesh: Mesh): DeformPose | null {
    const skeleton = mesh.skeleton;
    const morph = mesh.morphTargets;
    if (!skeleton && !morph) {
        return null;
    }
    return {
        boneMatrices: skeleton ? new Float32Array(skeleton.boneMatrices) : null,
        morphWeights: morph ? Float32Array.from(morph.weights) : null,
    };
}

/** Capture the drawn pose of every deformable pick candidate. Lives here rather than in the picker so
 *  scenes that never deform pay nothing for it: the picker reaches this module through one
 *  optional-chained call on a lazily imported namespace. */
export function captureDeformPoses(candidates: readonly { readonly mesh: Mesh }[]): Map<Mesh, DeformPose> {
    const poses = new Map<Mesh, DeformPose>();
    for (const { mesh } of candidates) {
        const pose = captureDeformPose(mesh);
        if (pose) {
            poses.set(mesh, pose);
        }
    }
    return poses;
}

/** Bind `mesh`'s captured pose into the triangle deformer the detailed picker calls, or null when the
 *  mesh did not deform and its rest triangle is already correct. */
export function deformerFor(poses: Map<Mesh, DeformPose> | null, mesh: Mesh): ((mesh: Mesh, i0: number, i1: number, i2: number, out: Float32Array) => boolean) | null {
    const pose = poses?.get(mesh) ?? null;
    return pose ? (m, i0, i1, i2, out) => deformTriangleToRef(m, i0, i1, i2, out, pose) : null;
}

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
 * Lives in its own module (rather than in the picker's main chunk) so that a scene using hotspots
 * does not drag the GPU picker in, and a picking scene does not drag this in. It reuses the shared
 * morph/skin primitives in `deformation-math.js`, so there is no duplicated math.
 *
 * @param mesh - The mesh to query. Must have CPU position data (`_cpuPositions`).
 * @param vertexIndex - Index of the vertex within the mesh's position buffer.
 * @param out - Destination mesh-local position, written in place (zero-allocation).
 * @returns true on success; false if the mesh has no CPU positions or `vertexIndex` is out of range.
 */
export function computeDeformedPositionToRef(mesh: Mesh, vertexIndex: number, out: Vec3): boolean {
    return deformVertexToRef(mesh, vertexIndex, out, null);
}

/** Shared implementation. `pose` overrides the live animation mirrors when a caller must reproduce a
 *  pose it captured earlier; null reads whatever the animation tick holds right now. */
function deformVertexToRef(mesh: Mesh, vertexIndex: number, out: Vec3, pose: DeformPose | null): boolean {
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
        addMorphDelta(morph, scratch, 0, componentOffset, pose?.morphWeights);
    }

    // Skeletal skinning — reuse the same bone-blend math the render path uses. wCoord = 1 (position).
    const skeleton = mesh.skeleton;
    if (skeleton) {
        skinVertexToRef(
            pose?.boneMatrices ?? skeleton.boneMatrices,
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

// Scratch vertex reused by deformTriangleToRef, allocated lazily for the same reason as _deformScratch.
let _triangleVertex: Vec3 | undefined;

function writeDeformedVertex(mesh: Mesh, vertexIndex: number, out: Float32Array, offset: number, pose: DeformPose | null): boolean {
    const vertex = (_triangleVertex ??= { x: 0, y: 0, z: 0 });
    if (!deformVertexToRef(mesh, vertexIndex, vertex, pose)) {
        return false;
    }
    out[offset] = vertex.x;
    out[offset + 1] = vertex.y;
    out[offset + 2] = vertex.z;
    return true;
}

/**
 * Writes the deformed MESH-LOCAL positions of one triangle's three vertices into `out` as nine floats
 * (vertex `i0` at offset 0, `i1` at 3, `i2` at 6).
 *
 * This is the detailed picker's replacement for deforming the whole position buffer: only the single
 * triangle the GPU reported as hit needs genuine deformed coordinates (to derive its face normal), so
 * the cost is O(1) in vertex count rather than O(V).
 *
 * @param mesh - The mesh to query. Must have CPU position data (`_cpuPositions`).
 * @param i0 - First vertex index of the triangle.
 * @param i1 - Second vertex index of the triangle.
 * @param i2 - Third vertex index of the triangle.
 * @param out - Destination for nine mesh-local floats, written in place (zero-allocation).
 * @param pose - Deformation pose captured when the pick was recorded, so the triangle resolves against
 *   the drawn frame rather than one the animation has advanced to. Null reads the live pose.
 * @returns true on success; false if any vertex could not be resolved.
 */
export function deformTriangleToRef(mesh: Mesh, i0: number, i1: number, i2: number, out: Float32Array, pose: DeformPose | null = null): boolean {
    return writeDeformedVertex(mesh, i0, out, 0, pose) && writeDeformedVertex(mesh, i1, out, 3, pose) && writeDeformedVertex(mesh, i2, out, 6, pose);
}
