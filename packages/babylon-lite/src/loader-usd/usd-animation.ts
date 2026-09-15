import type { AnimationChannel, AnimationClip, AnimationSampler } from "../animation/types.js";
import { INTERP_LINEAR, PATH_POINTER } from "../animation/types.js";
import { decomposeMat4 } from "../math/decompose-mat4.js";
import { multiplyMat4IntoBuffer } from "../math/multiply-mat4-into-buffer.js";
import type { Mat4Storage } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { _markWorldMatrixDirty } from "../scene/world-matrix-state.js";
import type { UsdContext } from "./usd-context.js";
import { UsdOp, usdField, usdFloats } from "./usd-protocol.js";

interface UsdAnimationTarget {
    target: object;
    path: string;
}

function matrixWriter(target: SceneNode): (values: Float32Array, offset: number) => void {
    return (values, offset) => {
        const matrix = target._localMatrix as unknown as Mat4Storage;
        for (let index = 0; index < 16; index++) {
            matrix[index] = values[offset + index]!;
        }
        _markWorldMatrixDirty(target);
    };
}

function vectorWriter(target: SceneNode, property: number): (values: Float32Array, offset: number) => void {
    if (target._localMatrix) {
        const { translation, rotation, scale } = decomposeMat4(target._localMatrix);
        target._localMatrix = undefined;
        target.position.set(translation.x, translation.y, translation.z);
        target.rotationQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        target.scaling.set(scale.x, scale.y, scale.z);
    }
    return (values, offset) => {
        const x = values[offset]!;
        const y = values[offset + 1]!;
        const z = values[offset + 2]!;
        if (property === 0) {
            target.position.set(x, y, z);
        } else if (property === 1) {
            target.rotationQuaternion.set(x, y, z, values[offset + 3]!);
        } else {
            target.scaling.set(x, y, z);
        }
    };
}

function morphWriter(context: UsdContext, targetId: number): ((values: Float32Array, offset: number) => void) | undefined {
    const bindings = context.morphTargets.get(targetId);
    if (!bindings?.length) {
        return undefined;
    }
    return (values, offset) => {
        const influence = values[offset]!;
        for (const binding of bindings) {
            if (binding.data._disposed) {
                continue;
            }
            binding.data.weights[binding.targetIndex] = influence;
            context.engine._device.queue.writeBuffer(
                binding.data.weightsBuffer,
                16 + binding.targetIndex * 4,
                binding.data.weights.buffer,
                binding.data.weights.byteOffset + binding.targetIndex * 4,
                4
            );
        }
    };
}

/** @internal Build stopped Lite groups for node, bone, and morph influence tracks. */
export async function apply(context: UsdContext): Promise<void> {
    const records = context.records.filter((record) => record.op === UsdOp.Animation);
    if (!records.length) {
        return;
    }
    const { createAnimationGroups } = await import("../animation/animation-group.js");
    const groups = new Map<number, { samplers: AnimationSampler[]; channels: AnimationChannel[]; targets: UsdAnimationTarget[] }>();
    for (const record of records) {
        const kind = usdField(record, 0);
        const targetId = usdField(record, 1);
        const property = usdField(record, 2);
        const count = usdField(record, 4);
        const stride = usdField(record, 7);
        const expectedStride = property === 4 ? 1 : property === 0 || property === 2 ? 3 : property === 1 ? 4 : property === 3 ? 16 : 0;
        if (kind > 2 || !count || stride !== expectedStride || (kind === 2) !== (property === 4)) {
            throw new Error("Invalid USD animation target, property, or value stride");
        }
        const target = kind === 0 ? context.nodes.get(targetId) : kind === 1 ? context.bones.get(targetId) : undefined;
        const writer = kind === 2 ? morphWriter(context, targetId) : target ? (property === 3 ? matrixWriter(target) : vectorWriter(target, property)) : undefined;
        if (!writer) {
            continue;
        }
        const input = usdFloats(context.data, usdField(record, 5), count).map((time) => time / context.timeCodesPerSecond);
        const output = usdFloats(context.data, usdField(record, 6), count * stride);
        if (!output.every(Number.isFinite) || input.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= input[index - 1]!))) {
            throw new Error("Invalid USD animation samples");
        }
        const trackIndex = usdField(record, 3);
        let group = groups.get(trackIndex);
        if (!group) {
            group = { samplers: [], channels: [], targets: [] };
            groups.set(trackIndex, group);
        }
        group.channels.push({
            path: PATH_POINTER,
            nodeIdx: -1,
            samplerIdx: group.samplers.length,
            pointerWriter: writer,
            pointerArity: stride,
            pointerQuaternion: property === 1,
        });
        group.samplers.push({ input, output, interpolation: INTERP_LINEAR });
        group.targets.push({
            target: kind === 2 ? context.morphTargets.get(targetId)![0]!.data : target!,
            path: ["position", "rotationQuaternion", "scaling", "matrix", "influence"][property]!,
        });
    }
    const clips: AnimationClip[] = [...groups].map(([trackIndex, group]) => ({
        name: `USD Animation ${trackIndex + 1}`,
        channels: group.channels,
        samplers: group.samplers,
        duration: Math.max(...group.samplers.map((sampler) => sampler.input[sampler.input.length - 1]!)),
        frameRate: context.timeCodesPerSecond,
    }));
    const nativeGroups = createAnimationGroups({
        clips,
        nodes: [],
        skeletons: [],
        morphBindings: [],
        nodeTargets: [],
        excludedNodeIndices: new Set(),
        nodeNames: [],
    });
    const scratch = new Float32Array(16);
    context.container.animationGroups = nativeGroups.map((native, index) => {
        const { _gltfMixer, ...group } = native;
        void _gltfMixer;
        const controller = group._ctrl!;
        const tick = controller.tick;
        controller.tick = (deltaMs, engine) => {
            if (context.container._usdDisposed) {
                return;
            }
            tick(deltaMs, engine);
            for (const rig of context.rigs.values()) {
                for (const skin of rig.skins) {
                    if (skin._disposed) {
                        continue;
                    }
                    for (let joint = 0; joint < rig.joints.length; joint++) {
                        multiplyMat4IntoBuffer(scratch, 0, rig.joints[joint]!.worldMatrix as unknown as Mat4Storage, 0, rig.inverseBindMatrices, joint * 16);
                        skin.boneMatrices.set(scratch, joint * 16);
                    }
                    const width = rig.joints.length * 4;
                    (engine ?? context.engine)._device.queue.writeTexture(
                        { texture: skin.boneTexture },
                        skin.boneMatrices.buffer,
                        { bytesPerRow: width * 16 },
                        { width, height: 1 }
                    );
                }
            }
        };
        return {
            ...group,
            isPlaying: false,
            _stopped: true,
            targetedAnimations: [...groups.values()][index]!.targets,
        };
    });
}
