import { describe, expect, it, vi } from "vitest";

import type { AnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group";
import type { SkeletonBinding, SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose";
import { retain } from "../../../packages/babylon-lite/src/resource/ref-count";
import type { StorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import { attachVat, bakeVatMany, setVatInstanceStorage, setVatTime } from "../../../packages/babylon-lite/src/vat/vat-baker";

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
