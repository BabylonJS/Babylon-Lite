import { F32 } from "../engine/typed-arrays.js";
import type { Mesh } from "../mesh/mesh.js";

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

function applyMorphPositions(mesh: Mesh, out: Float32Array): void {
    const morph = mesh.morphTargets;
    if (!morph) {
        return;
    }

    const vertexCount = out.length / 3;
    const targetCount = Math.min(morph.count, morph.targets.length);
    for (let t = 0; t < targetCount; t++) {
        const weight = morph.weights[t] ?? 0;
        if (weight === 0) {
            continue;
        }
        const positions = morph.targets[t]!.positions;
        for (let v = 0; v < vertexCount; v++) {
            const i = v * 3;
            out[i] = out[i]! + positions[i]! * weight;
            out[i + 1] = out[i + 1]! + positions[i + 1]! * weight;
            out[i + 2] = out[i + 2]! + positions[i + 2]! * weight;
        }
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
        const x = source[i]!;
        const y = source[i + 1]!;
        const z = source[i + 2]!;
        const result = skinVec3(skeleton.boneMatrices, skeleton.joints, skeleton.weights, skeleton.joints1, skeleton.weights1, v, x, y, z, 1);
        out[i] = result[0];
        out[i + 1] = result[1];
        out[i + 2] = result[2];
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
        const x = source[i]!;
        const y = source[i + 1]!;
        const z = source[i + 2]!;
        const result = skinVec3(skeleton.boneMatrices, skeleton.joints, skeleton.weights, skeleton.joints1, skeleton.weights1, v, x, y, z, 0);
        out[i] = result[0];
        out[i + 1] = result[1];
        out[i + 2] = result[2];
    }
}

function skinVec3(
    boneMatrices: Float32Array,
    joints: Uint16Array | Uint8Array,
    weights: Float32Array,
    joints1: Uint16Array | Uint8Array | null,
    weights1: Float32Array | null,
    vertexIndex: number,
    x: number,
    y: number,
    z: number,
    wCoord: 0 | 1
): [number, number, number] {
    let rx = 0;
    let ry = 0;
    let rz = 0;
    const base = vertexIndex * 4;

    for (let i = 0; i < 4; i++) {
        const weight = weights[base + i] ?? 0;
        if (weight !== 0) {
            const joint = joints[base + i] ?? 0;
            const transformed = transformByBone(boneMatrices, joint, x, y, z, wCoord);
            rx += transformed[0] * weight;
            ry += transformed[1] * weight;
            rz += transformed[2] * weight;
        }
    }

    if (joints1 && weights1) {
        for (let i = 0; i < 4; i++) {
            const weight = weights1[base + i] ?? 0;
            if (weight !== 0) {
                const joint = joints1[base + i] ?? 0;
                const transformed = transformByBone(boneMatrices, joint, x, y, z, wCoord);
                rx += transformed[0] * weight;
                ry += transformed[1] * weight;
                rz += transformed[2] * weight;
            }
        }
    }

    return [rx, ry, rz];
}

function transformByBone(boneMatrices: Float32Array, joint: number, x: number, y: number, z: number, wCoord: 0 | 1): [number, number, number] {
    const o = joint * 16;
    return [
        boneMatrices[o]! * x + boneMatrices[o + 4]! * y + boneMatrices[o + 8]! * z + boneMatrices[o + 12]! * wCoord,
        boneMatrices[o + 1]! * x + boneMatrices[o + 5]! * y + boneMatrices[o + 9]! * z + boneMatrices[o + 13]! * wCoord,
        boneMatrices[o + 2]! * x + boneMatrices[o + 6]! * y + boneMatrices[o + 10]! * z + boneMatrices[o + 14]! * wCoord,
    ];
}
