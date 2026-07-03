import { F32 } from "../engine/typed-arrays.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Vec3 } from "../math/types.js";

export function hasCpuDeformation(mesh: Mesh): boolean {
    return !!mesh._cpuPositions && (!!mesh.morphTargets || !!mesh.skeleton);
}

export function computeDeformedPositions(mesh: Mesh): Float32Array | null {
    const base = mesh._cpuPositions;
    if (!base) {
        return null;
    }

    const out = new F32(base);
    applyMorphPositions(mesh, out);
    applySkinPositions(mesh, out);
    return out;
}

export function computeDeformedNormals(mesh: Mesh): Float32Array | null {
    const base = mesh._cpuNormals;
    if (!base) {
        return null;
    }

    const out = new F32(base);
    applyMorphNormals(mesh, out);
    applySkinNormals(mesh, out);
    return out;
}

// Scratch reused by computeDeformedPositionToRef to keep it zero-allocation.
const _deformScratch: [number, number, number] = [0, 0, 0];

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
    const i = vertexIndex * 3;
    if (i < 0 || i + 2 >= base.length) {
        return false;
    }

    let x = base[i]!;
    let y = base[i + 1]!;
    let z = base[i + 2]!;

    // Morph targets — accumulate this vertex's active target offsets (shared with the bulk path).
    const morph = mesh.morphTargets;
    if (morph) {
        morphVec3ToRef(morph, i, x, y, z, _deformScratch);
        x = _deformScratch[0];
        y = _deformScratch[1];
        z = _deformScratch[2];
    }

    // Skeletal skinning — reuse the same bone-blend math the render path uses. wCoord = 1 (position).
    const skeleton = mesh.skeleton;
    if (skeleton) {
        skinVec3ToRef(skeleton.boneMatrices, skeleton.joints, skeleton.weights, skeleton.joints1, skeleton.weights1, vertexIndex, x, y, z, 1, _deformScratch);
        x = _deformScratch[0];
        y = _deformScratch[1];
        z = _deformScratch[2];
    }

    out.x = x;
    out.y = y;
    out.z = z;
    return true;
}

type MorphState = NonNullable<Mesh["morphTargets"]>;

// Scratch reused by the bulk morph pass to keep it allocation-light.
const _morphScratch: [number, number, number] = [0, 0, 0];

/**
 * Accumulates a single vertex's active morph-target position offsets onto (x, y, z) and writes the
 * result into `out`. `componentOffset` is the vertex's base index into the flat position buffer
 * (vertexIndex * 3). Shared by both the single-vertex ({@link computeDeformedPositionToRef}) and
 * bulk ({@link applyMorphPositions}) deformation paths.
 *
 * @param morph - The mesh's morph-target state.
 * @param componentOffset - The vertex's base index into the flat position buffer (vertexIndex * 3).
 * @param x - The vertex's current x component (typically the base or already-morphed position).
 * @param y - The vertex's current y component.
 * @param z - The vertex's current z component.
 * @param out - Destination vec3, written in place (zero-allocation).
 */
function morphVec3ToRef(morph: MorphState, componentOffset: number, x: number, y: number, z: number, out: [number, number, number]): void {
    const targetCount = Math.min(morph.count, morph.targets.length);
    for (let t = 0; t < targetCount; t++) {
        const weight = morph.weights[t] ?? 0;
        if (weight === 0) {
            continue;
        }
        const positions = morph.targets[t]!.positions;
        x += positions[componentOffset]! * weight;
        y += positions[componentOffset + 1]! * weight;
        z += positions[componentOffset + 2]! * weight;
    }
    out[0] = x;
    out[1] = y;
    out[2] = z;
}

function applyMorphPositions(mesh: Mesh, out: Float32Array): void {
    const morph = mesh.morphTargets;
    if (!morph) {
        return;
    }

    const vertexCount = out.length / 3;
    for (let v = 0; v < vertexCount; v++) {
        const i = v * 3;
        morphVec3ToRef(morph, i, out[i]!, out[i + 1]!, out[i + 2]!, _morphScratch);
        out[i] = _morphScratch[0];
        out[i + 1] = _morphScratch[1];
        out[i + 2] = _morphScratch[2];
    }
}

function applyMorphNormals(mesh: Mesh, out: Float32Array): void {
    const morph = mesh.morphTargets;
    if (!morph) {
        return;
    }

    const vertexCount = out.length / 3;
    const targetCount = Math.min(morph.count, morph.targets.length);
    for (let t = 0; t < targetCount; t++) {
        const weight = morph.weights[t] ?? 0;
        const normals = morph.targets[t]!.normals;
        if (weight === 0 || !normals) {
            continue;
        }
        for (let v = 0; v < vertexCount; v++) {
            const i = v * 3;
            out[i] = out[i]! + normals[i]! * weight;
            out[i + 1] = out[i + 1]! + normals[i + 1]! * weight;
            out[i + 2] = out[i + 2]! + normals[i + 2]! * weight;
        }
    }
}

function applySkinPositions(mesh: Mesh, out: Float32Array): void {
    const skeleton = mesh.skeleton;
    if (!skeleton) {
        return;
    }

    const source = new F32(out);
    const vertexCount = out.length / 3;
    for (let v = 0; v < vertexCount; v++) {
        const i = v * 3;
        skinVec3ToRef(
            skeleton.boneMatrices,
            skeleton.joints,
            skeleton.weights,
            skeleton.joints1,
            skeleton.weights1,
            v,
            source[i]!,
            source[i + 1]!,
            source[i + 2]!,
            1,
            _skinScratch
        );
        out[i] = _skinScratch[0];
        out[i + 1] = _skinScratch[1];
        out[i + 2] = _skinScratch[2];
    }
}

function applySkinNormals(mesh: Mesh, out: Float32Array): void {
    const skeleton = mesh.skeleton;
    if (!skeleton) {
        return;
    }

    const source = new F32(out);
    const vertexCount = out.length / 3;
    for (let v = 0; v < vertexCount; v++) {
        const i = v * 3;
        skinVec3ToRef(
            skeleton.boneMatrices,
            skeleton.joints,
            skeleton.weights,
            skeleton.joints1,
            skeleton.weights1,
            v,
            source[i]!,
            source[i + 1]!,
            source[i + 2]!,
            0,
            _skinScratch
        );
        out[i] = _skinScratch[0];
        out[i + 1] = _skinScratch[1];
        out[i + 2] = _skinScratch[2];
    }
}

// Scratch reused by the bulk skin passes (applySkinPositions/applySkinNormals).
const _skinScratch: [number, number, number] = [0, 0, 0];

/** Applies bone-blended skinning to a single vertex, writing the skinned vec3 into `out` (zero-allocation). */
function skinVec3ToRef(
    boneMatrices: Float32Array,
    joints: Uint16Array | Uint8Array,
    weights: Float32Array,
    joints1: Uint16Array | Uint8Array | null,
    weights1: Float32Array | null,
    vertexIndex: number,
    x: number,
    y: number,
    z: number,
    wCoord: 0 | 1,
    out: [number, number, number]
): void {
    let rx = 0;
    let ry = 0;
    let rz = 0;
    const base = vertexIndex * 4;

    for (let i = 0; i < 4; i++) {
        const weight = weights[base + i] ?? 0;
        if (weight !== 0) {
            transformByBoneToRef(boneMatrices, joints[base + i] ?? 0, x, y, z, wCoord, _boneTransformScratch);
            rx += _boneTransformScratch[0] * weight;
            ry += _boneTransformScratch[1] * weight;
            rz += _boneTransformScratch[2] * weight;
        }
    }

    if (joints1 && weights1) {
        for (let i = 0; i < 4; i++) {
            const weight = weights1[base + i] ?? 0;
            if (weight !== 0) {
                transformByBoneToRef(boneMatrices, joints1[base + i] ?? 0, x, y, z, wCoord, _boneTransformScratch);
                rx += _boneTransformScratch[0] * weight;
                ry += _boneTransformScratch[1] * weight;
                rz += _boneTransformScratch[2] * weight;
            }
        }
    }

    out[0] = rx;
    out[1] = ry;
    out[2] = rz;
}

// Scratch reused by skinVec3ToRef for each bone transform to keep it zero-allocation.
const _boneTransformScratch: [number, number, number] = [0, 0, 0];

/** Zero-allocation bone transform: writes `boneMatrix * [x, y, z, wCoord]` (xyz) into `out`. */
function transformByBoneToRef(boneMatrices: Float32Array, joint: number, x: number, y: number, z: number, wCoord: 0 | 1, out: [number, number, number]): void {
    const o = joint * 16;
    out[0] = boneMatrices[o]! * x + boneMatrices[o + 4]! * y + boneMatrices[o + 8]! * z + boneMatrices[o + 12]! * wCoord;
    out[1] = boneMatrices[o + 1]! * x + boneMatrices[o + 5]! * y + boneMatrices[o + 9]! * z + boneMatrices[o + 13]! * wCoord;
    out[2] = boneMatrices[o + 2]! * x + boneMatrices[o + 6]! * y + boneMatrices[o + 10]! * z + boneMatrices[o + 14]! * wCoord;
}
