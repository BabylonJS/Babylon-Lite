import type { AnimationChannel, AnimationClip, AnimationSampler, NodeRest } from "../animation/types.js";
import { INTERP_LINEAR, PATH_POINTER } from "../animation/types.js";
import type { AnimationGroup, AnimationPropertyMixStrategy, AnimationPropertyRuntimeTrack, TargetedAnimation } from "../animation/animation-group.js";
import { decomposeMat4 } from "../math/decompose-mat4.js";
import { multiplyMat4IntoBuffer } from "../math/multiply-mat4-into-buffer.js";
import type { Mat4Storage } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { _markWorldMatrixDirty } from "../scene/world-matrix-state.js";
import type { MorphTargetData } from "../animation/types.js";
import type { UsdContext, UsdRig } from "./usd-context.js";
import { UsdOp, usdField, usdFloats } from "./usd-protocol.js";

interface UsdAnimationTarget extends TargetedAnimation {
    target: object;
    targetName: string;
}

interface PendingTrack {
    sampler: AnimationSampler;
    writer: (values: Float32Array, offset: number) => void;
    target: object;
    targetName: string;
    path: string;
    stride: number;
    quaternion: boolean;
    targetIndex: number;
    mix?: AnimationPropertyMixStrategy;
}

function matrixMixStrategy(reference: ArrayLike<number>): AnimationPropertyMixStrategy {
    const base = new Float32Array(16);
    base.set(reference);
    return {
        accumulate(output, values, weight) {
            for (let index = 0; index < 16; index++) {
                output[index] = output[index]! + values[index]! * weight;
            }
        },
        finish(output, weight) {
            const remainder = Math.max(0, 1 - weight);
            const normalization = weight > 1 ? 1 / weight : 1;
            for (let index = 0; index < 16; index++) {
                output[index] = (output[index]! + base[index]! * remainder) * normalization;
            }
        },
    };
}

function matrixWriter(target: SceneNode, markRigDirty: () => void): (values: Float32Array, offset: number) => void {
    return (values, offset) => {
        const matrix = target._localMatrix as unknown as Mat4Storage;
        let changed = false;
        // Gf row-major row-vector bytes are Lite column-major column-vector bytes.
        for (let index = 0; index < 16; index++) {
            const value = values[offset + index]!;
            changed ||= matrix[index] !== value;
            matrix[index] = value;
        }
        if (changed) {
            _markWorldMatrixDirty(target);
            markRigDirty();
        }
    };
}

function vectorWriter(target: SceneNode, property: number, markRigDirty: () => void): (values: Float32Array, offset: number) => void {
    if (target._localMatrix) {
        const { translation, rotation, scale } = decomposeMat4(target._localMatrix);
        target._localMatrix = undefined;
        target._localMatrixLocked = undefined;
        target.position.set(translation.x, translation.y, translation.z);
        target.rotationQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        target.scaling.set(scale.x, scale.y, scale.z);
    }
    return (values, offset) => {
        const x = values[offset]!;
        const y = values[offset + 1]!;
        const z = values[offset + 2]!;
        if (property === 0) {
            if (target.position.x !== x || target.position.y !== y || target.position.z !== z) {
                target.position.set(x, y, z);
                markRigDirty();
            }
        } else if (property === 1) {
            const w = values[offset + 3]!;
            if (target.rotationQuaternion.x !== x || target.rotationQuaternion.y !== y || target.rotationQuaternion.z !== z || target.rotationQuaternion.w !== w) {
                target.rotationQuaternion.set(x, y, z, w);
                markRigDirty();
            }
        } else if (target.scaling.x !== x || target.scaling.y !== y || target.scaling.z !== z) {
            target.scaling.set(x, y, z);
            markRigDirty();
        }
    };
}

function morphWriter(bindings: readonly { data: MorphTargetData; targetIndex: number }[], dirty: Set<MorphTargetData>): (values: Float32Array, offset: number) => void {
    return (values, offset) => {
        const influence = values[offset]!;
        for (const binding of bindings) {
            if (!binding.data._disposed && binding.data.weights[binding.targetIndex] !== influence) {
                binding.data.weights[binding.targetIndex] = influence;
                dirty.add(binding.data);
            }
        }
    };
}

function identityRest(): NodeRest {
    return { parentIdx: -1, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1 };
}

/** @internal Build maskable, weight-aware Lite groups for node, bone, and morph tracks. */
export async function apply(context: UsdContext): Promise<void> {
    const records = context.records.filter((record) => record.op === UsdOp.Animation);
    if (!records.length) {
        return;
    }
    const dirtyMorphs = new Set<MorphTargetData>();
    const dirtyRigs = new Set<UsdRig>();
    const skinScratch = new Float32Array(16);
    const publish = (): void => {
        if (context.container._usdDisposed) {
            return;
        }
        if (dirtyRigs.size) {
            for (const rig of dirtyRigs) {
                for (const skin of rig.skins) {
                    if (skin._disposed) {
                        continue;
                    }
                    for (let joint = 0; joint < rig.joints.length; joint++) {
                        // geomBind-baked vertices and joints are both in the
                        // Skeleton prim's object space; mesh world is applied
                        // later by the vertex shader.
                        multiplyMat4IntoBuffer(skinScratch, 0, rig.joints[joint]!.worldMatrix as unknown as Mat4Storage, 0, rig.inverseBindMatrices, joint * 16);
                        skin.boneMatrices.set(skinScratch, joint * 16);
                    }
                    const width = rig.joints.length * 4;
                    context.engine._device.queue.writeTexture({ texture: skin.boneTexture }, skin.boneMatrices.buffer, { bytesPerRow: width * 16 }, { width, height: 1 });
                }
            }
            dirtyRigs.clear();
        }
        for (const morph of dirtyMorphs) {
            if (!morph._disposed) {
                context.engine._device.queue.writeBuffer(morph.weightsBuffer, 16, morph.weights);
            }
        }
        dirtyMorphs.clear();
    };
    context.publishAnimation = publish;

    const targetKeys = new Map<object, number>();
    const targetNames: string[] = [];
    const rests: NodeRest[] = [];
    const targetIndex = (target: object, name: string): number => {
        const existing = targetKeys.get(target);
        if (existing !== undefined) {
            return existing;
        }
        const index = rests.length;
        targetKeys.set(target, index);
        targetNames.push(name);
        rests.push(identityRest());
        return index;
    };
    const rigsByBone = new Map<SceneNode, UsdRig[]>();
    for (const rig of context.rigs.values()) {
        for (const bone of rig.joints) {
            const rigs = rigsByBone.get(bone) ?? [];
            rigs.push(rig);
            rigsByBone.set(bone, rigs);
        }
    }
    const groups = new Map<number, PendingTrack[]>();
    for (const record of records) {
        const kind = usdField(record, 0);
        const id = usdField(record, 1);
        const property = usdField(record, 2);
        const count = usdField(record, 4);
        const stride = usdField(record, 7);
        const expectedStride = property === 4 ? 1 : property === 0 || property === 2 ? 3 : property === 1 ? 4 : property === 3 ? 16 : 0;
        if (kind > 2 || !count || stride !== expectedStride || (kind === 2) !== (property === 4)) {
            throw new Error("Invalid USD animation target, property, or value stride");
        }
        const sceneTarget = kind === 0 ? context.nodes.get(id) : kind === 1 ? context.bones.get(id) : undefined;
        const morphBindings = kind === 2 ? context.morphTargets.get(id) : undefined;
        const target = sceneTarget ?? morphBindings;
        if (!target) {
            continue;
        }
        const name = sceneTarget?.name ?? morphBindings![0]!.name;
        const markRigDirty = (): void => {
            if (sceneTarget) {
                for (const rig of rigsByBone.get(sceneTarget) ?? []) {
                    dirtyRigs.add(rig);
                }
            }
        };
        const writer =
            kind === 2 ? morphWriter(morphBindings!, dirtyMorphs) : property === 3 ? matrixWriter(sceneTarget!, markRigDirty) : vectorWriter(sceneTarget!, property, markRigDirty);
        const mix = property === 3 ? matrixMixStrategy(sceneTarget!._localMatrix!) : undefined;
        const input = usdFloats(context.data, usdField(record, 5), count).map((time) => time / context.timeCodesPerSecond);
        const output = usdFloats(context.data, usdField(record, 6), count * stride);
        if (!output.every(Number.isFinite) || input.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= input[index - 1]!))) {
            throw new Error("Invalid USD animation samples");
        }
        const trackIndex = usdField(record, 3);
        const tracks = groups.get(trackIndex) ?? [];
        tracks.push({
            sampler: { input, output, interpolation: INTERP_LINEAR },
            writer,
            target,
            targetName: name,
            path: ["position", "rotationQuaternion", "scaling", "matrix", "influence"][property]!,
            stride,
            quaternion: property === 1,
            targetIndex: targetIndex(target, name),
            mix,
        });
        groups.set(trackIndex, tracks);
    }

    const clips: AnimationClip[] = [...groups].map(([trackIndex, tracks]) => {
        const startTime = Math.min(...tracks.map((track) => track.sampler.input[0]!));
        const endTime = Math.max(...tracks.map((track) => track.sampler.input[track.sampler.input.length - 1]!));
        return {
            name: `USD Animation ${trackIndex + 1}`,
            channels: tracks.map((track, samplerIdx): AnimationChannel => ({
                path: PATH_POINTER,
                nodeIdx: track.targetIndex,
                samplerIdx,
                pointerWriter: track.writer,
                pointerArity: track.stride,
                pointerQuaternion: track.quaternion,
            })),
            samplers: tracks.map((track) => track.sampler),
            duration: endTime - startTime,
            _startTime: startTime,
            frameRate: context.timeCodesPerSecond,
        };
    });
    const { createAnimationGroups } = await import("../animation/animation-group.js");
    const [{ _installPropertyMixerHandler }, { _updateWeightedPointerAnimations }] = await Promise.all([
        import("../animation/weighted-gltf-mixer.js"),
        import("../animation/weighted-pointer-mixer.js"),
    ]);
    _installPropertyMixerHandler(_updateWeightedPointerAnimations);
    const nativeGroups = createAnimationGroups({
        clips,
        nodes: rests,
        skeletons: [],
        morphBindings: [],
        nodeTargets: [],
        excludedNodeIndices: new Set(),
        nodeNames: targetNames,
    });
    context.container.animationGroups = nativeGroups.map((native, index) => {
        const tracks = [...groups.values()][index]!;
        const startTime = native._startTime ?? 0;
        const endTime = startTime + native.duration;
        const runtimeTracks: AnimationPropertyRuntimeTrack[] = tracks.map((track) => ({
            sampler: track.sampler,
            stride: track.stride,
            quaternion: track.quaternion,
            writer: track.writer,
            mixTarget: track.target,
            mixProperty: track.path,
            _mix: track.mix,
            _targetName: track.targetName,
            _afterWrite: publish,
        }));
        const group: AnimationGroup = {
            ...native,
            isPlaying: false,
            _stopped: true,
            targetedAnimations: tracks.map((track): UsdAnimationTarget => ({
                target: track.target,
                targetName: track.targetName,
                nodeIndex: track.targetIndex,
                path: track.path,
            })),
            _gltfMixer: undefined,
            _propertyMixer: [runtimeTracks, startTime, endTime, native.duration, startTime],
        };
        const controller = group._ctrl!;
        const tick = controller.tick;
        controller.tick = (deltaMs, engine) => {
            tick(deltaMs, engine);
            if (deltaMs === 0 || group._animationManager) {
                publish();
            }
        };
        return group;
    });
}
