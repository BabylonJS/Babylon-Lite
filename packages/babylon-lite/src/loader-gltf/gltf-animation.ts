/**
 *  Lazy-loaded animation/skin parsing for glTF.
 *  Dynamically imported by load-gltf.ts only when a glTF contains animations or skins.
 *
 *  This module is pointer-feature agnostic: KHR_animation_pointer (and the
 *  non-Float32 sampler conversion that CubeVisibility-style assets need) are
 *  installed via the registration seam below, so scenes that don't declare
 *  the extension pay zero bytes for it.
 */
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { GltfAnimationData, AnimationClip, AnimationSampler, AnimationChannel, NodeRest, SkeletonBinding, MorphBinding } from "../animation/types.js";
import { INTERP_LINEAR, INTERP_STEP, INTERP_CUBICSPLINE, PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE, PATH_WEIGHTS } from "../animation/types.js";
import { mat4Identity } from "../math/mat4-identity.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import { resolveAccessor, computeNodeWorldMatrix, findParent } from "./gltf-parser.js";
import type { SceneNode } from "../scene/scene-node.js";

/** Registration seam for KHR_animation_pointer. The pointer feature module
 *  calls `_installPointerHandlers` on side-effect import; if never called,
 *  pointer channels are skipped and non-Float32 samplers fall back to the
 *  aliasing fast path (which throws on misaligned/short accessors). */
export type PointerChannelParser = (ptr: string, channel: any, nodeMap: readonly (SceneNode | undefined)[] | undefined) => AnimationChannel | null;
export type SamplerConverter = (src: ArrayBufferView, length: number, normalized: boolean) => Float32Array;
let _parsePointerChannel: PointerChannelParser | null = null;
let _convertSampler: SamplerConverter | null = null;
export function _installPointerHandlers(parser: PointerChannelParser, converter: SamplerConverter): void {
    _parsePointerChannel = parser;
    _convertSampler = converter;
}

/** Convert sampler input/output to Float32Array. Default: reinterpret existing
 *  Float32 accessor as Float32Array (legacy behaviour; fast but requires
 *  aligned Float32 data). KHR_animation_pointer installs a converter that
 *  additionally handles non-Float32 / normalized accessors. */
function toSamplerFloat32(src: ArrayBufferView, length: number, normalized: boolean): Float32Array {
    if (_convertSampler) {
        return _convertSampler(src, length, normalized);
    }
    return new Float32Array(src.buffer, src.byteOffset, length);
}

/** Parsed skin/skeleton data. */
export interface GltfSkinData {
    /** Node indices of joints in this skin. */
    jointNodes: number[];
    /** Inverse bind matrices — one 4×4 per joint (column-major Float32Array). */
    inverseBindMatrices: Float32Array;
    /** World matrices of each joint at rest pose. */
    jointWorldMatrices: Mat4[];
    /** World matrix of the mesh node that owns this skin. */
    meshWorldMatrix: Mat4;
}

// ─── Skin / Skeleton Extraction ─────────────────────────────────────

/** Resolve a skin's inverse-bind matrices, filling with identities when absent. */
function resolveIBMs(json: any, binChunk: DataView, skin: any): Float32Array {
    const jointCount = skin.joints.length;
    if (skin.inverseBindMatrices !== undefined) {
        const ibmData = resolveAccessor(json, binChunk, skin.inverseBindMatrices);
        return new Float32Array(ibmData._data.buffer, ibmData._data.byteOffset, jointCount * 16);
    }
    const out = new Float32Array(jointCount * 16);
    for (let i = 0; i < jointCount; i++) {
        const o = i * 16;
        out[o] = out[o + 5] = out[o + 10] = out[o + 15] = 1;
    }
    return out;
}

export function extractSkin(
    json: any,
    binChunk: DataView,
    skinIdx: number,
    meshWorldMatrix: Mat4,
    parentMap: Map<number, number>,
    worldMatrixCache: Map<number, Mat4>
): GltfSkinData {
    const skin = json.skins[skinIdx];
    const jointNodes: number[] = skin.joints;
    const inverseBindMatrices = resolveIBMs(json, binChunk, skin);
    const jointWorldMatrices: Mat4[] = jointNodes.map((nodeIdx) => computeNodeWorldMatrix(json, nodeIdx, parentMap, worldMatrixCache));
    return { jointNodes, inverseBindMatrices, jointWorldMatrices, meshWorldMatrix };
}

/** Compute rest-pose bone texture data. Each bone gets 4 vec4 (one 4×4 matrix).
 *  Formula: boneMatrix[i] = inverse(meshWorld) * jointWorld[i] * IBM[i]
 *  At rest pose this simplifies to identity for each bone. */
export function computeBoneTextureData(skin: GltfSkinData): Float32Array {
    const numBones = skin.jointNodes.length;
    const data = new Float32Array(numBones * 16);
    const invMeshWorld = mat4Invert(skin.meshWorldMatrix) ?? mat4Identity();
    const tmp = new Float32Array(16);
    for (let i = 0; i < numBones; i++) {
        mat4MultiplyInto(tmp, 0, invMeshWorld, 0, skin.jointWorldMatrices[i]!, 0);
        mat4MultiplyInto(data, i * 16, tmp, 0, skin.inverseBindMatrices, i * 16);
    }
    return data;
}

// ─── Animation Parsing ──────────────────────────────────────────────

const INTERP_MAP: Record<string, 0 | 1 | 2> = {
    LINEAR: INTERP_LINEAR,
    STEP: INTERP_STEP,
    CUBICSPLINE: INTERP_CUBICSPLINE,
};

const PATH_MAP: Record<string, 0 | 1 | 2 | 3> = {
    translation: PATH_TRANSLATION,
    rotation: PATH_ROTATION,
    scale: PATH_SCALE,
    weights: PATH_WEIGHTS,
};

/**
 * Parse glTF animation data: clips, node hierarchy, and skeleton bindings.
 * Returns null if no animations, or no drivable state at all (no skeletons,
 * no morphs, no pointer channels).
 *
 * `nodeMap` (optional) maps glTF node index → SceneNode. It's required to
 * resolve KHR_animation_pointer targets that write to node properties.
 */
export function parseAnimationData(
    json: any,
    binChunk: DataView,
    meshes: Mesh[],
    parentMap: Map<number, number>,
    worldMatrixCache: Map<number, Mat4>,
    nodeMap?: readonly (SceneNode | undefined)[]
): GltfAnimationData | null {
    if (!json.animations || json.animations.length === 0) {
        return null;
    }

    let pointerChannelCount = 0;

    // Parse animation clips
    const clips: AnimationClip[] = [];
    for (const anim of json.animations) {
        const samplers: AnimationSampler[] = [];
        for (const s of anim.samplers) {
            const inputAcc = resolveAccessor(json, binChunk, s.input);
            const outputAcc = resolveAccessor(json, binChunk, s.output);
            const inNorm = json.accessors[s.input]?.normalized === true;
            const outNorm = json.accessors[s.output]?.normalized === true;
            samplers.push({
                input: toSamplerFloat32(inputAcc._data, inputAcc._count, inNorm),
                output: toSamplerFloat32(outputAcc._data, outputAcc._count * outputAcc._componentCount, outNorm),
                interpolation: INTERP_MAP[s.interpolation ?? "LINEAR"] ?? INTERP_LINEAR,
            });
        }

        const channels: AnimationChannel[] = [];
        for (const c of anim.channels) {
            // KHR_animation_pointer: delegated to the registered pointer parser
            // (installed by gltf-feature-animation-pointer on side-effect import).
            const ptr = c.target?.extensions?.KHR_animation_pointer?.pointer;
            if (ptr) {
                if (!_parsePointerChannel) {
                    continue;
                }
                const ch = _parsePointerChannel(ptr, c, nodeMap);
                if (ch) {
                    channels.push(ch);
                    pointerChannelCount++;
                }
                continue;
            }
            if (c.target.node === undefined) {
                continue;
            }
            const path = PATH_MAP[c.target.path];
            if (path === undefined) {
                continue;
            }
            channels.push({ samplerIdx: c.sampler, nodeIdx: c.target.node, path });
        }

        let duration = 0;
        for (const s of samplers) {
            if (s.input.length > 0) {
                const last = s.input[s.input.length - 1]!;
                if (last > duration) {
                    duration = last;
                }
            }
        }

        clips.push({ name: anim.name ?? "", channels, samplers, duration });
    }

    // Build node hierarchy (rest-pose TRS + parent indices)
    const nodeCount = json.nodes?.length ?? 0;
    const nodes: NodeRest[] = [];
    for (let i = 0; i < nodeCount; i++) {
        const n = json.nodes[i];
        const t = n.translation ?? [0, 0, 0];
        const r = n.rotation ?? [0, 0, 0, 1];
        const s = n.scale ?? [1, 1, 1];
        nodes.push({
            parentIdx: findParent(parentMap, i),
            tx: t[0],
            ty: t[1],
            tz: t[2],
            rx: r[0],
            ry: r[1],
            rz: r[2],
            rw: r[3],
            sx: s[0],
            sy: s[1],
            sz: s[2],
        });
    }

    // Build skeleton bindings (connect skin data to GPU bone textures)
    // First, build node→gpuMesh mapping by replaying extraction order
    const nodeToMeshIndices = new Map<number, number[]>();
    let gpuIdx = 0;
    for (let ni = 0; ni < nodeCount; ni++) {
        const node = json.nodes[ni];
        if (node.mesh === undefined) {
            continue;
        }
        const mesh = json.meshes[node.mesh];
        const indices: number[] = [];
        for (let p = 0; p < mesh.primitives.length; p++) {
            indices.push(gpuIdx++);
        }
        nodeToMeshIndices.set(ni, indices);
    }

    const skeletons: SkeletonBinding[] = [];
    for (let nodeIdx = 0; nodeIdx < nodeCount; nodeIdx++) {
        const node = json.nodes[nodeIdx];
        if (node.skin === undefined || !json.skins) {
            continue;
        }

        const meshIndices = nodeToMeshIndices.get(nodeIdx);
        if (!meshIndices) {
            continue;
        }

        const skin = json.skins[node.skin];
        const jointNodes: number[] = skin.joints;
        const inverseBindMatrices = resolveIBMs(json, binChunk, skin);

        const meshWorldMatrix = computeNodeWorldMatrix(json, nodeIdx, parentMap, worldMatrixCache);
        const invMeshWorld = mat4Invert(meshWorldMatrix) ?? mat4Identity();

        // Create a binding for EACH mesh primitive of this skinned node
        for (const mi of meshIndices) {
            const mesh = meshes[mi];
            const skeleton = mesh?.skeleton;
            if (!skeleton) {
                continue;
            }
            skeletons.push({
                jointNodes,
                inverseBindMatrices,
                invMeshWorld,
                boneTexture: skeleton.boneTexture,
                boneCount: jointNodes.length,
                boneMatrices: skeleton.boneMatrices,
                runtimeSkeleton: skeleton,
            });
        }
    }

    // Build morph bindings (connect morph-target meshes to GPU weight buffers)
    const morphBindings: MorphBinding[] = [];
    for (let nodeIdx = 0; nodeIdx < nodeCount; nodeIdx++) {
        const node = json.nodes[nodeIdx];
        if (node.mesh === undefined) {
            continue;
        }
        const gltfMesh = json.meshes[node.mesh];
        if (!gltfMesh.primitives?.[0]?.targets?.length) {
            continue;
        }

        const meshIndices = nodeToMeshIndices.get(nodeIdx);
        if (!meshIndices) {
            continue;
        }

        for (const mi of meshIndices) {
            const mesh = meshes[mi];
            const morphTargets = mesh?.morphTargets;
            if (!morphTargets) {
                continue;
            }
            morphBindings.push({
                nodeIdx,
                weightsBuffer: morphTargets.weightsBuffer,
                weights: morphTargets.weights,
                targetCount: morphTargets.count,
                runtimeMorphTargets: morphTargets,
            });
        }
    }

    if (clips.length === 0 || (skeletons.length === 0 && morphBindings.length === 0 && pointerChannelCount === 0)) {
        return null;
    }
    return { clips, nodes, skeletons, morphBindings };
}
