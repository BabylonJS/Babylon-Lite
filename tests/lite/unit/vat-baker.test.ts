import { describe, expect, it, vi } from "vitest";

import type { AnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group";
import { goToFrame, stopAnimation } from "../../../packages/babylon-lite/src/animation/animation-group";
import { INTERP_LINEAR, PATH_ROTATION, PATH_TRANSLATION } from "../../../packages/babylon-lite/src/animation/types";
import type { AnimationClip, NodeRest, SkeletonBinding, SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import { createAnimationController } from "../../../packages/babylon-lite/src/skeleton/skeleton-updater";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose";
import { retain } from "../../../packages/babylon-lite/src/resource/ref-count";
import type { StorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import {
    attachVat,
    bakeVatMany,
    createVatBakeResult,
    createVatBakeResults,
    prepareVat,
    prepareVatMany,
    setVatInstanceStorage,
    setVatTime,
} from "../../../packages/babylon-lite/src/vat/vat-baker";
import type { PreparedVatBakeResult } from "../../../packages/babylon-lite/src/vat/vat-baker";

function fakeBuffer(): GPUBuffer {
    return { destroy: vi.fn() } as unknown as GPUBuffer;
}

function fakeTexture(): GPUTexture {
    return { destroy: vi.fn(), createView: vi.fn() } as unknown as GPUTexture;
}

function makeSkeleton(): SkeletonData {
    const jointsBuffer = fakeBuffer();
    const weightsBuffer = fakeBuffer();
    return {
        boneTexture: fakeTexture(),
        boneCount: 1,
        jointsBuffer,
        weightsBuffer,
        joints: new Uint8Array(4),
        weights: new Float32Array(4),
        boneMatrices: new Float32Array(16),
        joints1Buffer: null,
        weights1Buffer: null,
        joints1: null,
        weights1: null,
        _skinBuffers: { jointsBuffer, weightsBuffer, joints1Buffer: null, weights1Buffer: null },
    };
}

function makeMesh(name: string, skeleton: SkeletonData): Mesh {
    const gpu: MeshGPU = {
        positionBuffer: fakeBuffer(),
        normalBuffer: fakeBuffer(),
        uvBuffer: fakeBuffer(),
        indexBuffer: fakeBuffer(),
        indexCount: 3,
        indexFormat: "uint16",
    };
    return { name, skeleton, _gpu: gpu } as unknown as Mesh;
}

function makeEngine() {
    const textures: GPUTexture[] = [];
    const buffers: GPUBuffer[] = [];
    const queue = {
        writeTexture: vi.fn(),
        writeBuffer: vi.fn(),
    };
    const device = {
        queue,
        createTexture: vi.fn(() => {
            const texture = fakeTexture();
            textures.push(texture);
            return texture;
        }),
        createBuffer: vi.fn(() => {
            const buffer = fakeBuffer();
            buffers.push(buffer);
            return buffer;
        }),
    };
    return { engine: { _device: device } as unknown as EngineContext, device, queue, textures, buffers };
}

function makeGroup(bindings: readonly SkeletonBinding[], differ: boolean): { group: AnimationGroup; cpuTicks: ReturnType<typeof vi.fn> } {
    const cpuTicks = vi.fn();
    const ctrl = {
        time: 0,
        playing: false,
        speedRatio: 1,
        loop: true,
        tick: vi.fn(() => {
            throw new Error("VAT baking must not use the GPU animation tick");
        }),
        _tickCpu: vi.fn(() => {
            cpuTicks();
            const frame = Math.round(ctrl.time * 2);
            bindings[0]!.boneMatrices.fill(frame + 1);
            bindings[1]!.boneMatrices.fill(frame + (differ ? 2 : 1));
        }),
    };
    const group = {
        name: "walk",
        duration: 1,
        frameRate: 2,
        isPlaying: false,
        currentTime: 0,
        targetedAnimations: [],
        speedRatio: 1,
        loopAnimation: false,
        weight: 1,
        _stopped: false,
        _ctrl: ctrl,
        _gltfMixer: [{ name: "walk", channels: [], samplers: [], duration: 1, frameRate: 2 }, [], bindings],
    } as unknown as AnimationGroup;
    return { group, cpuTicks };
}

function binding(skeleton: SkeletonData): SkeletonBinding {
    return {
        jointNodes: [0],
        inverseBindMatrices: new Float32Array(16),
        invMeshWorld: new Float32Array(16) as unknown as Mat4,
        boneTexture: skeleton.boneTexture,
        boneCount: 1,
        boneMatrices: skeleton.boneMatrices,
        runtimeSkeleton: skeleton,
    };
}

/** A rig with `boneCount` real bones — enough for a capture request to address more than bone 0. */
function makeRigSkeleton(boneCount: number): SkeletonData {
    const jointsBuffer = fakeBuffer();
    const weightsBuffer = fakeBuffer();
    return {
        boneTexture: fakeTexture(),
        boneCount,
        jointsBuffer,
        weightsBuffer,
        joints: new Uint8Array(4 * boneCount),
        weights: new Float32Array(4 * boneCount),
        boneMatrices: new Float32Array(16 * boneCount),
        joints1Buffer: null,
        weights1Buffer: null,
        joints1: null,
        weights1: null,
        _skinBuffers: { jointsBuffer, weightsBuffer, joints1Buffer: null, weights1Buffer: null },
    };
}

/** A three-joint chain driven by a REAL AnimationController, so both the bake pass and a `goToFrame`
 *  seek run the production evaluation/composition math rather than a stub. */
function makeChainRig(): { group: AnimationGroup; skeleton: SkeletonData; binding: SkeletonBinding } {
    const skeleton = makeRigSkeleton(3);
    const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const inverseBindMatrices = new Float32Array(48);
    for (let bone = 0; bone < 3; bone++) {
        inverseBindMatrices.set(identity(), bone * 16);
        inverseBindMatrices[bone * 16 + 13] = -bone; // distinct IBM per bone so the three rows cannot coincide
    }
    const binding: SkeletonBinding = {
        jointNodes: [0, 1, 2],
        inverseBindMatrices,
        invMeshWorld: identity() as unknown as Mat4,
        boneTexture: skeleton.boneTexture,
        boneCount: 3,
        boneMatrices: skeleton.boneMatrices,
        runtimeSkeleton: skeleton,
    };
    const nodes: NodeRest[] = [0, 1, 2].map((i) => ({
        parentIdx: i - 1,
        tx: 0,
        ty: i,
        tz: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        rw: 1,
        sx: 1,
        sy: 1,
        sz: 1,
    }));
    const halfRoot = Math.SQRT1_2;
    const clip: AnimationClip = {
        name: "walk",
        duration: 1,
        frameRate: 4,
        channels: [
            { samplerIdx: 0, nodeIdx: 1, path: PATH_TRANSLATION },
            { samplerIdx: 1, nodeIdx: 2, path: PATH_ROTATION },
        ],
        samplers: [
            { input: new Float32Array([0, 1]), output: new Float32Array([0, 0, 0, 0.7, 1.3, -0.4]), interpolation: INTERP_LINEAR },
            { input: new Float32Array([0, 1]), output: new Float32Array([0, 0, 0, 1, 0, halfRoot, 0, halfRoot]), interpolation: INTERP_LINEAR },
        ],
    };
    const ctrl = createAnimationController(clip, nodes, [binding], []);
    const group = {
        name: "walk",
        duration: 1,
        frameRate: 4,
        isPlaying: false,
        currentTime: 0,
        targetedAnimations: [],
        speedRatio: 1,
        loopAnimation: false,
        weight: 1,
        _stopped: false,
        _ctrl: ctrl,
        _gltfMixer: [clip, nodes, [binding]],
    } as unknown as AnimationGroup;
    return { group, skeleton, binding };
}

/** Exact float comparison by bit pattern — `toEqual` on Float32Arrays would also accept a NaN mismatch. */
function sameBits(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const au = new Uint32Array(a.buffer, a.byteOffset, a.length);
    const bu = new Uint32Array(b.buffer, b.byteOffset, b.length);
    for (let i = 0; i < au.length; i++) {
        if (au[i] !== bu[i]) {
            return false;
        }
    }
    return true;
}

describe("VAT bone-matrix capture", () => {
    it("captures the same bits a per-frame goToFrame seek would read from the live skeleton", () => {
        const captured = makeChainRig();
        const mesh = makeMesh("rig", captured.skeleton);
        const { engine } = makeEngine();

        const baked = bakeVatMany(engine, [{ mesh, captureBoneMatrices: [0, 2] }], [captured.group])[0]!;

        expect(baked.frameCount).toBe(5);
        expect(Object.keys(baked.boneMatrices ?? {})).toEqual(["0", "2"]);

        // The path this replaced: re-seek the same public group at every integer frame with an engine (which
        // is what forced the per-frame bone-texture upload) and keep the requested rows.
        const reference = makeChainRig();
        const expected = new Map<number, Float32Array>([
            [0, new Float32Array(baked.frameCount * 16)],
            [2, new Float32Array(baked.frameCount * 16)],
        ]);
        for (let frame = 0; frame < baked.frameCount; frame++) {
            goToFrame(reference.group, frame, engine);
            for (const [bone, track] of expected) {
                track.set(reference.binding.boneMatrices.subarray(bone * 16, bone * 16 + 16), frame * 16);
            }
        }
        stopAnimation(reference.group);

        for (const [bone, track] of expected) {
            expect(
                track.some((v) => v !== 0),
                `bone ${bone} reference is not all zeros`
            ).toBe(true);
            expect(sameBits(baked.boneMatrices![bone]!, track), `bone ${bone} bit-identical`).toBe(true);
        }
        expect(sameBits(baked.boneMatrices![0]!, baked.boneMatrices![2]!)).toBe(false);
    });

    it("captures exactly the rows uploaded into the baked texture", () => {
        const { group, skeleton } = makeChainRig();
        const mesh = makeMesh("rig", skeleton);
        const { engine, queue } = makeEngine();

        const baked = bakeVatMany(engine, [{ mesh, captureBoneMatrices: [1] }], [group])[0]!;

        const uploaded = new Float32Array(queue.writeTexture.mock.calls[0]![1] as ArrayBuffer);
        const track = baked.boneMatrices![1]!;
        for (let row = 0; row < baked.frameCount; row++) {
            expect(sameBits(track.subarray(row * 16, row * 16 + 16), uploaded.subarray(row * 48 + 16, row * 48 + 32)), `row ${row}`).toBe(true);
        }
    });

    it("uploads a texture payload the capture request cannot change", () => {
        const bakeAndReadTexture = (captureBoneMatrices?: readonly number[]): Float32Array => {
            const { group, skeleton } = makeChainRig();
            const mesh = makeMesh("rig", skeleton);
            const { engine, queue } = makeEngine();
            const target = captureBoneMatrices ? { mesh, captureBoneMatrices } : { mesh };
            const baked = bakeVatMany(engine, [target], [group])[0]!;
            expect(queue.writeTexture).toHaveBeenCalledTimes(1);
            const call = queue.writeTexture.mock.calls[0]!;
            expect(call[2]).toEqual({ offset: 0, bytesPerRow: 12 * 16, rowsPerImage: baked.frameCount });
            return new Float32Array(call[1] as ArrayBuffer);
        };

        // The un-requested bake is exactly the pre-capture behaviour, so this is the pre/post byte comparison.
        expect(sameBits(bakeAndReadTexture([0, 1, 2]), bakeAndReadTexture())).toBe(true);
    });

    it("omits bones outside the skeleton and captures nothing when not requested", () => {
        const { group, skeleton } = makeChainRig();
        const mesh = makeMesh("rig", skeleton);
        const { engine } = makeEngine();

        expect(bakeVatMany(engine, [{ mesh }], [group])[0]!.boneMatrices).toBeUndefined();
        expect(Object.keys(bakeVatMany(engine, [{ mesh, captureBoneMatrices: [1, 7, -1] }], [group])[0]!.boneMatrices ?? {})).toEqual(["1"]);
        expect(Object.keys(bakeVatMany(engine, [{ mesh, captureBoneOrigins: [1, 7, -1] }], [group])[0]!.boneOrigins ?? {})).toEqual(["1"]);
    });
});

describe("VAT prepared payloads", () => {
    it("round-trips CPU-prepared data and captures without allocating a texture until upload", () => {
        const { group, skeleton } = makeChainRig();
        const mesh = makeMesh("rig", skeleton);
        const { engine, device, queue } = makeEngine();

        const prepared = prepareVat(mesh, [group], { captureBoneOrigins: [0, 2, 7, -1], captureBoneMatrices: [0, 2, 7, -1] });

        expect(device.createTexture).not.toHaveBeenCalled();
        expect(queue.writeTexture).not.toHaveBeenCalled();
        expect(Object.keys(prepared.boneOrigins ?? {})).toEqual(["0", "2"]);
        expect(Object.keys(prepared.boneMatrices ?? {})).toEqual(["0", "2"]);

        const baked = createVatBakeResult(engine, prepared);

        expect(device.createTexture).toHaveBeenCalledTimes(1);
        expect(queue.writeTexture).toHaveBeenCalledTimes(1);
        expect(baked.boneCount).toBe(prepared.boneCount);
        expect(baked.frameCount).toBe(prepared.frameCount);
        expect(baked.clips).toEqual(prepared.clips);
        expect(baked.boneOrigins).toEqual(prepared.boneOrigins);
        expect(baked.boneMatrices).toEqual(prepared.boneMatrices);
        expect("data" in baked).toBe(false);
        expect(sameBits(new Float32Array(queue.writeTexture.mock.calls[0]![1] as ArrayBuffer), prepared.data)).toBe(true);
    });

    it("preserves a prepared view's non-zero byte offset during upload", () => {
        const { engine, queue } = makeEngine();
        const backing = new Float32Array(20);
        const data = backing.subarray(4);
        data.fill(3);
        const prepared: PreparedVatBakeResult = {
            boneCount: 1,
            frameCount: 1,
            data,
            clips: { idle: { fromRow: 0, frameCount: 1, fps: 30 } },
        };

        createVatBakeResult(engine, prepared);

        expect(queue.writeTexture).toHaveBeenCalledWith(expect.anything(), backing.buffer, { offset: data.byteOffset, bytesPerRow: 64, rowsPerImage: 1 }, { width: 4, height: 1 });
    });

    it("rejects malformed prepared payloads before allocating GPU resources", () => {
        const { engine, device } = makeEngine();
        const valid: PreparedVatBakeResult = {
            boneCount: 1,
            frameCount: 1,
            data: new Float32Array(16),
            clips: { idle: { fromRow: 0, frameCount: 1, fps: 30 } },
        };

        expect(() => createVatBakeResult(engine, { ...valid, boneCount: 0 })).toThrow("boneCount must be a positive integer");
        expect(() => createVatBakeResult(engine, { ...valid, data: new Float32Array(15) })).toThrow("data length");
        expect(() =>
            createVatBakeResult(engine, {
                ...valid,
                clips: { idle: { fromRow: 1, frameCount: 1, fps: 30 } },
            })
        ).toThrow('clip "idle" is invalid');
        expect(() =>
            createVatBakeResult(engine, {
                ...valid,
                boneOrigins: { 0: [0, 0, 0] as unknown as Float32Array },
            })
        ).toThrow("boneOrigins[0] has an invalid length");
        expect(() =>
            createVatBakeResult(engine, {
                ...valid,
                boneMatrices: { 1: new Float32Array(16) },
            })
        ).toThrow('boneMatrices contains invalid bone index "1"');
        expect(device.createTexture).not.toHaveBeenCalled();
    });

    it("shares equal prepared payloads and releases their texture after the last attached mesh", () => {
        const a = makeSkeleton();
        const b = makeSkeleton();
        const ma = makeMesh("a", a);
        const mb = makeMesh("b", b);
        const { group } = makeGroup([binding(a), binding(b)], false);
        const { engine, device, queue } = makeEngine();
        const prepared = prepareVatMany([{ mesh: ma }, { mesh: mb }], [group]);

        const baked = createVatBakeResults(engine, prepared);

        expect(device.createTexture).toHaveBeenCalledTimes(1);
        expect(queue.writeTexture).toHaveBeenCalledTimes(1);
        expect(baked[0]!.texture).toBe(baked[1]!.texture);

        attachVat(engine, ma, baked[0]!);
        attachVat(engine, mb, baked[1]!);
        disposeMeshGpu(ma);
        expect(baked[0]!.texture.destroy).not.toHaveBeenCalled();
        disposeMeshGpu(mb);
        expect(baked[0]!.texture.destroy).toHaveBeenCalledTimes(1);
    });

    it("keeps byte-distinct prepared payloads in separate textures", () => {
        const { engine, device, queue } = makeEngine();
        const first: PreparedVatBakeResult = {
            boneCount: 1,
            frameCount: 1,
            data: new Float32Array(16),
            clips: {},
        };
        const second: PreparedVatBakeResult = { ...first, data: new Float32Array(first.data).fill(1) };

        const baked = createVatBakeResults(engine, [first, second]);

        expect(device.createTexture).toHaveBeenCalledTimes(2);
        expect(queue.writeTexture).toHaveBeenCalledTimes(2);
        expect(baked[0]!.texture).not.toBe(baked[1]!.texture);
    });

    it("destroys every allocated texture when a later prepared upload fails", () => {
        const { engine, queue, textures } = makeEngine();
        const first: PreparedVatBakeResult = {
            boneCount: 1,
            frameCount: 1,
            data: new Float32Array(16),
            clips: {},
        };
        const second: PreparedVatBakeResult = { ...first, data: new Float32Array(first.data).fill(1) };
        queue.writeTexture
            .mockImplementationOnce(() => undefined)
            .mockImplementationOnce(() => {
                throw new Error("upload failed");
            });

        expect(() => createVatBakeResults(engine, [first, second])).toThrow("upload failed");
        expect(textures).toHaveLength(2);
        expect(textures[0]!.destroy).toHaveBeenCalledTimes(1);
        expect(textures[1]!.destroy).toHaveBeenCalledTimes(1);
    });
});

describe("VAT batching", () => {
    it("evaluates each frame once and shares exactly equal sibling payloads", () => {
        const a = makeSkeleton();
        const b = makeSkeleton();
        const ma = makeMesh("a", a);
        const mb = makeMesh("b", b);
        const { group, cpuTicks } = makeGroup([binding(a), binding(b)], false);
        const { engine, device, queue } = makeEngine();

        const baked = bakeVatMany(engine, [{ mesh: ma }, { mesh: mb }], [group]);

        expect(cpuTicks).toHaveBeenCalledTimes(3);
        expect(device.createTexture).toHaveBeenCalledTimes(1);
        expect(queue.writeTexture).toHaveBeenCalledTimes(1);
        expect(baked[0]!.texture).toBe(baked[1]!.texture);
    });

    it("keeps byte-distinct sibling payloads in separate textures", () => {
        const a = makeSkeleton();
        const b = makeSkeleton();
        const ma = makeMesh("a", a);
        const mb = makeMesh("b", b);
        const { group } = makeGroup([binding(a), binding(b)], true);
        const { engine, device, queue } = makeEngine();

        const baked = bakeVatMany(engine, [{ mesh: ma }, { mesh: mb }], [group]);

        expect(device.createTexture).toHaveBeenCalledTimes(2);
        expect(queue.writeTexture).toHaveBeenCalledTimes(2);
        expect(baked[0]!.texture).not.toBe(baked[1]!.texture);
    });

    it("destroys a shared baked texture only after every attached mesh releases it", () => {
        const a = makeSkeleton();
        const b = makeSkeleton();
        const ma = makeMesh("a", a);
        const mb = makeMesh("b", b);
        const { group } = makeGroup([binding(a), binding(b)], false);
        const { engine } = makeEngine();
        const baked = bakeVatMany(engine, [{ mesh: ma }, { mesh: mb }], [group]);
        const sharedTexture = baked[0]!.texture;

        attachVat(engine, ma, baked[0]!);
        attachVat(engine, mb, baked[1]!);
        disposeMeshGpu(ma);
        expect(sharedTexture.destroy).not.toHaveBeenCalled();
        disposeMeshGpu(mb);
        expect(sharedTexture.destroy).toHaveBeenCalledTimes(1);
    });

    it("keeps skin buffers alive until both the live skeleton and VAT release them", () => {
        const skeleton = makeSkeleton();
        const vatMesh = makeMesh("vat", skeleton);
        const liveMesh = makeMesh("live", skeleton);
        retain(skeleton);
        const { group } = makeGroup([binding(skeleton), binding(skeleton)], false);
        const { engine } = makeEngine();
        const baked = bakeVatMany(engine, [{ mesh: vatMesh }, { mesh: liveMesh }], [group]);

        attachVat(engine, vatMesh, baked[0]!);
        disposeMeshGpu(liveMesh);

        expect(skeleton.boneTexture.destroy).toHaveBeenCalledTimes(1);
        expect(skeleton.jointsBuffer.destroy).not.toHaveBeenCalled();
        expect(skeleton.weightsBuffer.destroy).not.toHaveBeenCalled();

        disposeMeshGpu(vatMesh);
        expect(skeleton.jointsBuffer.destroy).toHaveBeenCalledTimes(1);
        expect(skeleton.weightsBuffer.destroy).toHaveBeenCalledTimes(1);
    });

    it("publishes authoritative instance storage and absolute time for derived VAT passes", () => {
        const skeleton = makeSkeleton();
        const mesh = makeMesh("vat", skeleton);
        const { group } = makeGroup([binding(skeleton), binding(skeleton)], false);
        const { engine, queue } = makeEngine();
        const baked = bakeVatMany(engine, [{ mesh }], [group])[0]!;
        attachVat(engine, mesh, baked);
        const storage = {
            byteLength: 32,
            _buffer: fakeBuffer(),
            _destroyed: false,
            _data: new Uint8Array(32),
            _engine: engine,
        } as unknown as StorageBuffer;
        engine._storageBuffers = new Set([storage]);

        setVatInstanceStorage(engine, mesh, storage);
        setVatTime(engine, mesh, 2.5);

        expect(mesh.vat?._instanceStorage).toBe(storage);
        expect(queue.writeBuffer).toHaveBeenLastCalledWith(mesh.vat!.settingsBuffer, 16, expect.any(Float32Array));
        const time = queue.writeBuffer.mock.calls.at(-1)?.[2] as Float32Array;
        expect(time[0]).toBe(2.5);

        setVatTime(engine, mesh, 4);
        const reusedTime = queue.writeBuffer.mock.calls.at(-1)?.[2] as Float32Array;
        expect(reusedTime).toBe(time);
        expect(reusedTime[0]).toBe(4);
    });
});
