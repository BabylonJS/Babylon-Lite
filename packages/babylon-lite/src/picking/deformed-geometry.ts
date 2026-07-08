import { F32 } from "../engine/typed-arrays.js";
import type { Mesh } from "../mesh/mesh.js";
import { addMorphDelta, skinVertexToRef } from "./deformation-math.js";

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
    for (let v = 0; v < vertexCount; v++) {
        const i = v * 3;
        addMorphDelta(morph, out, i, i);
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
        skinVertexToRef(skeleton.boneMatrices, skeleton.joints, skeleton.weights, skeleton.joints1, skeleton.weights1, v, source[i]!, source[i + 1]!, source[i + 2]!, 1, out, i);
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
        skinVertexToRef(skeleton.boneMatrices, skeleton.joints, skeleton.weights, skeleton.joints1, skeleton.weights1, v, source[i]!, source[i + 1]!, source[i + 2]!, 0, out, i);
    }
}
