/** MeshLoD GPU metadata buffer layout tests (Task 5.1).
 *
 *  Proves every packed GPU word has the meaning the selection WGSL relies on: the
 *  immutable node/group/cluster records, the mutable page-state record, and the
 *  128-byte instance record (world matrix, cofactor normal matrix, maximum world
 *  scale, visibility flag, stable ID). Also exercises version-gated instance uploads,
 *  make-before-break capacity growth with retirement, and the device-limit failure. */

import { describe, expect, it } from "vitest";
import {
    CLUSTER_WORDS,
    GROUP_WORDS,
    INSTANCE_BYTES,
    INSTANCE_WORDS,
    NODE_WORDS,
    PAGE_FLAG_PINNED,
    PAGE_FLAG_RESIDENT,
    PAGE_STATE_WORDS,
    buildPageStateData,
    createMeshLoDGpuInstanceState,
    getMeshLoDGpuAssetBuffers,
    packClusters,
    packGroups,
    packHierarchyNodes,
    packInstanceRecord,
    meshLoDDispatchSize,
    runMeshLoDGpuExpansion,
    syncMeshLoDPageState,
    uploadMeshLoDInstances,
    writePageStateRecord,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import { isMeshLoDError } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import { createMeshLoDInstance } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { addMeshLoDInstanceToScene, removeMeshLoDInstanceFromScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { conservativeWorldScale } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-math.js";
import type {
    MeshLoDCluster,
    MeshLoDGroup,
    MeshLoDHierarchyNode,
    MeshLoDPageRecord,
    MeshLoDPageRuntime,
    MeshLoDAssetRuntime,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import { createMockDevice, createMockEngine } from "./fixtures/gpu-mock.js";
import type { MockBuffer } from "./fixtures/gpu-mock.js";

const f32Bits = (v: number): number => {
    const a = new Float32Array([v]);
    return new Uint32Array(a.buffer)[0]!;
};

function makeNode(over: Partial<MeshLoDHierarchyNode> = {}): MeshLoDHierarchyNode {
    return { center: [1, 2, 3], radius: 4, error: 5, groupId: -1, childOffset: 7, childCount: 8, ...over };
}

function makeGroup(over: Partial<MeshLoDGroup> = {}): MeshLoDGroup {
    return {
        center: [1, 2, 3],
        radius: 4,
        simplifiedError: 5,
        depth: 2,
        firstCluster: 6,
        clusterCount: 7,
        firstPageRef: 8,
        pageRefCount: 9,
        terminal: true,
        pinned: true,
        sourceTriangleCount: 10,
        outputTriangleCount: 11,
        ...over,
    };
}

function makeCluster(over: Partial<MeshLoDCluster> = {}): MeshLoDCluster {
    return {
        center: [1, 2, 3],
        radius: 4,
        error: 5,
        groupId: 6,
        refinedGroupId: -1,
        pageId: 7,
        vertexOffset: 8,
        indexOffset: 9,
        vertexCount: 10,
        triangleCount: 11,
        sourceTriangleCount: 12,
        ...over,
    };
}

function makePageRecord(over: Partial<MeshLoDPageRecord> = {}): MeshLoDPageRecord {
    return {
        offset: 0,
        storedBytes: 0,
        meaningfulBytes: 0,
        decodedBytes: 0,
        crc: 0,
        vertexCount: 24,
        localIndexCount: 36,
        vertexByteOffset: 0,
        indexByteOffset: 576,
        firstCluster: 0,
        clusterCount: 1,
        pinned: true,
        coarse: true,
        minDepth: 0,
        maxDepth: 0,
        ...over,
    };
}

function makePageRuntime(over: Partial<MeshLoDPageRuntime> = {}): MeshLoDPageRuntime {
    return { id: 0, state: "gpu-resident", arenaOffset: 131072, arenaBytes: 65536, vertexByteOffset: 0, indices: null, lastUsedFrame: 0, priority: 0, frameRefCount: 0, ...over };
}

describe("MeshLoD GPU metadata layout", () => {
    it("rounds a subnormal operator-norm bound upward rather than losing the rounding increment", () => {
        const s = 2 ** -141;
        const world = [s, 0, 0, 0, s, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
        expect(conservativeWorldScale(world)).toBeGreaterThanOrEqual(Math.sqrt(3) * s);
    });

    it.each([
        [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        [4 * Math.SQRT1_2, Math.SQRT1_2, 0, 0, -4 * Math.SQRT1_2, Math.SQRT1_2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
    ])("packs a conservative shear bound covering transformed sphere geometry", (...world) => {
        const data = new Float32Array(INSTANCE_WORDS);
        packInstanceRecord(data, new Uint32Array(data.buffer), 0, world, true, 0);
        const bound = data[28]!;
        expect(bound).toBe(conservativeWorldScale(world));
        for (let latitude = 0; latitude <= 16; latitude++) {
            for (let longitude = 0; longitude < 32; longitude++) {
                const theta = (latitude * Math.PI) / 16;
                const phi = (longitude * 2 * Math.PI) / 32;
                const v = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
                const transformed = [0, 1, 2].map((row) => world[row]! * v[0]! + world[row + 4]! * v[1]! + world[row + 8]! * v[2]!);
                expect(Math.hypot(...transformed)).toBeLessThanOrEqual(bound);
            }
        }
        expect(data[31]).toBe(0); // cone culling remains disabled for non-similarity transforms
    });

    it.each([65535, 65536])("expands all %i pairs using bounded dispatch dimensions", (count) => {
        const dimensions = meshLoDDispatchSize(count, 65535);
        expect(dimensions.every((value) => value <= 65535)).toBe(true);
        expect(dimensions.reduce((product, value) => product * value, 1)).toBeGreaterThanOrEqual(count);
        const seen = new Uint8Array(count);
        for (let z = 0; z < dimensions[2]; z++) {
            for (let y = 0; y < dimensions[1]; y++) {
                for (let x = 0; x < dimensions[0]; x++) {
                    const pair = x + (y + z * dimensions[1]) * dimensions[0];
                    if (pair < count) {
                        seen[pair]!++;
                    }
                }
            }
        }
        expect(seen.every((visits) => visits === 1)).toBe(true);
        const result = runMeshLoDGpuExpansion({
            selected: Array.from({ length: count }, () => ({ clusterId: 0, instanceId: 0 })),
            clusters: packClusters([makeCluster({ pageId: 0, triangleCount: 1, indexOffset: 0 })]),
            pageState: new Uint32Array(PAGE_STATE_WORDS),
            arena: new Uint32Array(2),
            drawVertexCapacity: count * 3,
        });
        expect(result.vertexCount).toBe(count * 3);
        expect(result.overflow).toBe(false);
    });

    it("handles XYZ padding and zero without exceeding the reported device limit", () => {
        expect(meshLoDDispatchSize(0, 2)).toEqual([0, 1, 1]);
        expect(meshLoDDispatchSize(5, 2)).toEqual([2, 2, 2]);
        expect(() => meshLoDDispatchSize(9, 2)).toThrow(expect.objectContaining({ code: "MLOD_DEVICE_LIMIT" }));
    });

    it("packs hierarchy nodes into 8 words with float bits and i32 groupId", () => {
        const packed = packHierarchyNodes([makeNode({ groupId: -1 }), makeNode({ groupId: 5, center: [9, 8, 7] })]);
        expect(packed.length).toBe(2 * NODE_WORDS);
        expect(packed[0]).toBe(f32Bits(1));
        expect(packed[3]).toBe(f32Bits(4));
        expect(packed[4]).toBe(f32Bits(5));
        expect(packed[5]! | 0).toBe(-1); // internal node sentinel
        expect(packed[6]).toBe(7);
        expect(packed[7]).toBe(8);
        expect(packed[NODE_WORDS + 5]).toBe(5); // second node's leaf group id
        expect(packed[NODE_WORDS]).toBe(f32Bits(9));
    });

    it("packs groups into 16 words with terminal|pinned flags", () => {
        const packed = packGroups([makeGroup({ terminal: true, pinned: false }), makeGroup({ terminal: false, pinned: true })]);
        expect(packed.length).toBe(2 * GROUP_WORDS);
        expect(packed[4]).toBe(f32Bits(5)); // simplifiedError float bits
        expect(packed[5]).toBe(2); // depth
        expect(packed[6]).toBe(6); // firstCluster
        expect(packed[8]).toBe(8); // firstPageRef
        expect(packed[9]).toBe(9); // pageRefCount
        expect(packed[10]).toBe(0x1); // terminal only
        expect(packed[GROUP_WORDS + 10]).toBe(0x2); // pinned only
        expect(packed[11]).toBe(10);
        expect(packed[12]).toBe(11);
    });

    it("packs clusters into 16 words with i32 refinedGroupId", () => {
        const packed = packClusters([makeCluster({ refinedGroupId: -1 }), makeCluster({ refinedGroupId: 3 })]);
        expect(packed.length).toBe(2 * CLUSTER_WORDS);
        expect(packed[5]).toBe(6); // groupId
        expect(packed[6]! | 0).toBe(-1); // finest sentinel
        expect(packed[7]).toBe(7); // pageId
        expect(packed[8]).toBe(8); // vertexOffset
        expect(packed[9]).toBe(9); // indexOffset
        expect(packed[10]).toBe(10); // vertexCount
        expect(packed[11]).toBe(11); // triangleCount
        expect(packed[CLUSTER_WORDS + 6]).toBe(3); // second cluster refined group
    });

    it("packs a resident page-state record with absolute arena offsets", () => {
        const out = new Uint32Array(PAGE_STATE_WORDS);
        writePageStateRecord(
            out,
            0,
            makePageRuntime({ arenaOffset: 131072 }),
            makePageRecord({ vertexByteOffset: 0, indexByteOffset: 576, vertexCount: 24, localIndexCount: 36 }),
            7
        );
        expect(out[0]! & PAGE_FLAG_RESIDENT).toBe(PAGE_FLAG_RESIDENT);
        expect(out[0]! & PAGE_FLAG_PINNED).toBe(PAGE_FLAG_PINNED);
        expect(out[1]).toBe(131072); // arena base
        expect(out[2]).toBe(131072); // absolute vertex byte offset
        expect(out[3]).toBe(131072 + 576); // absolute index byte offset
        expect(out[4]).toBe(24);
        expect(out[5]).toBe(36);
        expect(out[6]).toBe(7); // residency generation
    });

    it("marks an unrequested page non-resident with zero offsets", () => {
        const out = new Uint32Array(PAGE_STATE_WORDS);
        writePageStateRecord(out, 0, makePageRuntime({ state: "unrequested", arenaOffset: -1 }), makePageRecord({ pinned: false }), 3);
        expect(out[0]! & PAGE_FLAG_RESIDENT).toBe(0);
        expect(out[1]).toBe(0);
        expect(out[2]).toBe(0);
        expect(out[6]).toBe(0);
    });

    it("packs the 128-byte instance record: world, cofactor normal, per-instance SSE, max scale, visibility, id", () => {
        const f32 = new Float32Array(INSTANCE_WORDS);
        const u32 = new Uint32Array(f32.buffer);
        // Uniform scale 2, translation (5,6,7), column-major.
        const world = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 6, 7, 1];
        packInstanceRecord(f32, u32, 0, world, true, 42, 0.75);
        expect(INSTANCE_BYTES).toBe(128);
        for (let i = 0; i < 16; i++) {
            expect(f32[i]).toBe(world[i]);
        }
        // Cofactor of 2·I is 4·I: n0 = (4,0,0), n1 = (0,4,0), n2 = (0,0,4).
        expect([f32[16], f32[17], f32[18]]).toEqual([4, 0, 0]);
        expect([f32[20], f32[21], f32[22]]).toEqual([0, 4, 0]);
        expect([f32[24], f32[25], f32[26]]).toEqual([0, 0, 4]);
        expect(f32[19]).toBe(0.75); // unused n0.w carries the per-instance SSE
        expect(f32[28]).toBe(2); // maximum world scale
        expect(u32[29]).toBe(1); // visible
        expect(u32[30]).toBe(42); // stable id
        expect(u32[31]).toBe(1); // uniform positive scale permits the similarity-transform path
    });

    it("writes visibility=0 for a hidden instance", () => {
        const f32 = new Float32Array(INSTANCE_WORDS);
        const u32 = new Uint32Array(f32.buffer);
        packInstanceRecord(f32, u32, 0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], false, 3);
        expect(u32[29]).toBe(0);
        expect(f32[28]).toBe(1);
        expect(f32[19]).toBe(0); // asset-level default
    });

    it.each([
        [-1, 1, 1],
        [-2, 3, 4],
        [2, -3, 4],
        [2, 3, -4],
    ])("matches inverse-transpose lighting and reflection for scale %j", (...scale) => {
        const f32 = new Float32Array(INSTANCE_WORDS);
        const world = [scale[0]!, 0, 0, 0, 0, scale[1]!, 0, 0, 0, 0, scale[2]!, 0, 0, 0, 0, 1];
        packInstanceRecord(f32, new Uint32Array(f32.buffer), 0, world, true, 0);
        const normalize = (v: number[]): number[] => v.map((value) => value / Math.hypot(...v));
        const local = [1, 2, 3];
        const ordinaryNormal = normalize(local.map((value, axis) => value / scale[axis]!));
        const meshLoDNormal = normalize(local.map((value, axis) => value * f32[16 + axis * 5]!));
        for (let axis = 0; axis < 3; axis++) {
            expect(meshLoDNormal[axis]).toBeCloseTo(ordinaryNormal[axis]!, 6);
        }
        const light = normalize([-1, 1, 2]);
        const lambert = (normal: number[]): number =>
            Math.max(
                0,
                normal.reduce((dot, value, axis) => dot + value * light[axis]!, 0)
            );
        expect(lambert(meshLoDNormal)).toBeCloseTo(lambert(ordinaryNormal), 6);
        const reflection = (normal: number[]): number[] => light.map((value, axis) => value - 2 * normal[axis]! * normal.reduce((dot, n, i) => dot + n * light[i]!, 0));
        reflection(meshLoDNormal).forEach((value, axis) => expect(value).toBeCloseTo(reflection(ordinaryNormal)[axis]!, 6));
        expect(f32[23]).toBe(-1);
    });

    it("rejects singular and non-finite transforms explicitly", () => {
        for (const scale of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
            const f32 = new Float32Array(INSTANCE_WORDS);
            expect(() => packInstanceRecord(f32, new Uint32Array(f32.buffer), 0, [scale, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true, 0)).toThrow(
                expect.objectContaining({ code: "MLOD_INVALID_OPTION" })
            );
        }
    });
});

function fakeRuntime(pages: MeshLoDPageRuntime[], records: MeshLoDPageRecord[]): MeshLoDAssetRuntime {
    return {
        hierarchyNodes: [makeNode()],
        groups: [makeGroup()],
        clusters: [makeCluster()],
        groupPageRefs: Uint32Array.from([0]),
        pageRecords: records,
        generation: 1,
        gpuSelection: null,
        gpu: { pages, residentPageCount: pages.filter((p) => p.state === "gpu-resident").length },
    } as unknown as MeshLoDAssetRuntime;
}

describe("MeshLoD GPU asset buffers", () => {
    it("uploads immutable metadata + page state and caches on the runtime", () => {
        const { engine, device } = createMockEngine();
        const records = [makePageRecord()];
        const runtime = fakeRuntime([makePageRuntime()], records);
        const buffers = getMeshLoDGpuAssetBuffers(engine, runtime);
        expect(runtime.gpuSelection).toBe(buffers);
        // Re-request returns the cached buffers (shared assets reuse immutable buffers).
        expect(getMeshLoDGpuAssetBuffers(engine, runtime)).toBe(buffers);
        // One consolidated meta buffer + one page-state buffer created & written.
        const labels = device.buffers.map((b) => b.label);
        expect(labels).toContain("mesh-lod-meta");
        expect(labels).toContain("mesh-lod-page-state");
        // Concatenation order: nodes(8) ++ groups(16) ++ clusters(16) ++ refs(1).
        expect(buffers.nodeWordOffset).toBe(0);
        expect(buffers.groupWordOffset).toBe(NODE_WORDS);
        expect(buffers.clusterWordOffset).toBe(NODE_WORDS + GROUP_WORDS);
        expect(buffers.pageRefWordOffset).toBe(NODE_WORDS + GROUP_WORDS + CLUSTER_WORDS);
    });

    it("re-uploads page state only after residency changes", () => {
        const { engine, device } = createMockEngine();
        const records = [makePageRecord(), makePageRecord({ pinned: false })];
        const pages = [makePageRuntime(), makePageRuntime({ id: 1, state: "unrequested", arenaOffset: -1 })];
        const runtime = fakeRuntime(pages, records);
        const buffers = getMeshLoDGpuAssetBuffers(engine, runtime);
        const pageStateBuffer = device.buffers.find((b) => b.label === "mesh-lod-page-state")!;
        const writesBefore = device.writes.filter((w) => w.buffer === pageStateBuffer).length;
        syncMeshLoDPageState(engine, buffers, runtime); // unchanged epoch → skipped
        expect(device.writes.filter((w) => w.buffer === pageStateBuffer).length).toBe(writesBefore);
        // Second page becomes resident → epoch changes → one upload.
        pages[1]!.state = "gpu-resident";
        pages[1]!.arenaOffset = 196608;
        runtime.gpu.residentPageCount = 2;
        syncMeshLoDPageState(engine, buffers, runtime);
        expect(device.writes.filter((w) => w.buffer === pageStateBuffer).length).toBe(writesBefore + 1);
        expect(buffers.pageStateData[PAGE_STATE_WORDS + 1]).toBe(196608);
    });

    it("throws MLOD_DEVICE_LIMIT when a metadata buffer exceeds the storage limit", () => {
        const { engine } = createMockEngine(createMockDevice(256)); // 256-byte storage cap
        const manyClusters: MeshLoDCluster[] = [];
        for (let i = 0; i < 64; i++) {
            manyClusters.push(makeCluster());
        }
        const runtime = fakeRuntime([makePageRuntime()], [makePageRecord()]);
        (runtime as unknown as { clusters: MeshLoDCluster[] }).clusters = manyClusters; // 64 × 64B = 4096B > 256B cap
        try {
            getMeshLoDGpuAssetBuffers(engine, runtime);
            throw new Error("expected MLOD_DEVICE_LIMIT");
        } catch (error) {
            expect(isMeshLoDError(error) && error.code).toBe("MLOD_DEVICE_LIMIT");
        }
    });
});

describe("MeshLoD GPU instance state", () => {
    const inst = (id: number, version: number, visible = true, tx = 0): { worldMatrix: number[]; worldMatrixVersion: number; visible: boolean; _instanceId: number } => ({
        worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1],
        worldMatrixVersion: version,
        visible,
        _instanceId: id,
    });

    it("version-gates uploads: unchanged instances are not re-written", () => {
        const { engine, device } = createMockEngine();
        const state = createMeshLoDGpuInstanceState(40); // 2 words/instance bitset
        expect(state.wordsPerInstance).toBe(2);
        const a = inst(0, 1);
        const b = inst(1, 1, true, 5);
        uploadMeshLoDInstances(engine, state, [a, b]);
        const instBuffer = state.instanceBuffer! as unknown as MockBuffer;
        const writesAfterFirst = device.writes.filter((w) => w.buffer === instBuffer).length;
        expect(writesAfterFirst).toBeGreaterThan(0);
        // No version change → no new writes.
        uploadMeshLoDInstances(engine, state, [a, b]);
        expect(device.writes.filter((w) => w.buffer === instBuffer).length).toBe(writesAfterFirst);
        // Bump one instance's version → exactly one more write (its coalesced run).
        uploadMeshLoDInstances(engine, state, [a, inst(1, 2, true, 9)]);
        expect(device.writes.filter((w) => w.buffer === instBuffer).length).toBe(writesAfterFirst + 1);
    });

    it("re-uploads a slot when visibility toggles", () => {
        const { engine, device } = createMockEngine();
        const state = createMeshLoDGpuInstanceState(8);
        uploadMeshLoDInstances(engine, state, [inst(0, 1, true)]);
        const instBuffer = state.instanceBuffer! as unknown as MockBuffer;
        const before = device.writes.filter((w) => w.buffer === instBuffer).length;
        uploadMeshLoDInstances(engine, state, [inst(0, 1, false)]);
        expect(device.writes.filter((w) => w.buffer === instBuffer).length).toBe(before + 1);
    });

    it("re-uploads a slot when its per-instance SSE override changes, even with a stable transform version", () => {
        const { engine, device } = createMockEngine();
        const state = createMeshLoDGpuInstanceState(8);
        const original = inst(0, 1);
        uploadMeshLoDInstances(engine, state, [original]);
        const instBuffer = state.instanceBuffer! as unknown as MockBuffer;
        const before = device.writes.filter((w) => w.buffer === instBuffer).length;
        uploadMeshLoDInstances(engine, state, [{ ...original, screenSpaceError: 4 }]);
        expect(device.writes.filter((w) => w.buffer === instBuffer)).toHaveLength(before + 1);
        expect(state.scratchF32[19]).toBe(4);
        uploadMeshLoDInstances(engine, state, [{ ...original, screenSpaceError: 4 }]);
        expect(device.writes.filter((w) => w.buffer === instBuffer)).toHaveLength(before + 1);
    });

    it("does not repeatedly upload non-float32-exact SSE overrides, but uploads changes and removal", () => {
        const { engine, device } = createMockEngine();
        const state = createMeshLoDGpuInstanceState(8);
        const original = inst(0, 1);
        uploadMeshLoDInstances(engine, state, [{ ...original, screenSpaceError: 0.1 }]);
        const instBuffer = state.instanceBuffer! as unknown as MockBuffer;
        const before = device.writes.filter((write) => write.buffer === instBuffer).length;
        expect(state.scratchF32[19]).toBe(Math.fround(0.1));
        for (let frame = 0; frame < 32; frame++) {
            uploadMeshLoDInstances(engine, state, [{ ...original, screenSpaceError: 0.1 }]);
        }
        expect(device.writes.filter((write) => write.buffer === instBuffer)).toHaveLength(before);
        uploadMeshLoDInstances(engine, state, [{ ...original, screenSpaceError: 0.2 }]);
        expect(device.writes.filter((write) => write.buffer === instBuffer)).toHaveLength(before + 1);
        expect(state.scratchF32[19]).toBe(Math.fround(0.2));
        uploadMeshLoDInstances(engine, state, [{ ...original, screenSpaceError: Math.fround(0.2) }]);
        expect(device.writes.filter((write) => write.buffer === instBuffer)).toHaveLength(before + 1);
        uploadMeshLoDInstances(engine, state, [original]);
        expect(device.writes.filter((write) => write.buffer === instBuffer)).toHaveLength(before + 2);
        expect(state.scratchF32[19]).toBe(0);
        uploadMeshLoDInstances(engine, state, [original]);
        expect(device.writes.filter((write) => write.buffer === instBuffer)).toHaveLength(before + 2);
    });

    it("grows make-before-break, copying prior-state bits and retiring old buffers", () => {
        const { engine, encoder } = createMockEngine();
        const state = createMeshLoDGpuInstanceState(40);
        uploadMeshLoDInstances(engine, state, [inst(0, 1)]); // capacity 1
        const firstInstance = state.instanceBuffer as unknown as MockBuffer;
        const firstPrior = state.priorStateBuffer as unknown as MockBuffer;
        expect(state.capacity).toBe(1);
        // Growth to 3 instances → capacity doubles past 1 to 4.
        uploadMeshLoDInstances(engine, state, [inst(0, 2), inst(1, 1), inst(2, 1)]);
        expect(state.capacity).toBeGreaterThanOrEqual(3);
        expect(state.instanceBuffer as unknown as MockBuffer).not.toBe(firstInstance);
        // Retained prior-state bits copied old → new.
        expect(encoder.copies.some((c) => c.src === firstPrior)).toBe(true);
        // Old buffers retired (not destroyed synchronously) for frame safety.
        expect(firstInstance.destroyed).toBe(false);
        const retire = (engine as unknown as { _retirements: (() => void)[] | null })._retirements!;
        expect(retire.length).toBeGreaterThan(0);
        retire.forEach((r) => r());
        expect(firstInstance.destroyed).toBe(true);
        expect(firstPrior.destroyed).toBe(true);
    });

    it("remaps retained IDs and clears reused slots without growing either instance buffer", () => {
        const { engine } = createMockEngine();
        const state = createMeshLoDGpuInstanceState(40);
        const a = inst(0, 1);
        const b = inst(1, 1);
        uploadMeshLoDInstances(engine, state, [a, b]);
        const instanceBuffer = state.instanceBuffer;
        const oldPrior = state.priorStateBuffer! as unknown as MockBuffer;
        oldPrior.data = new Uint8Array(Uint32Array.from([1, 2, 4, 8]).buffer);
        uploadMeshLoDInstances(engine, state, [b, inst(2, 1)]);
        expect(state.instanceBuffer).toBe(instanceBuffer);
        expect(state.capacity).toBe(2);
        const remapped = state.priorStateBuffer! as unknown as MockBuffer;
        expect(Array.from(new Uint32Array(remapped.data.buffer))).toEqual([4, 8]);
        expect(remapped.size).toBe(16); // unpopulated new-ID row is GPU-zero-initialized
        remapped.data = new Uint8Array(Uint32Array.from([4, 8, 16, 32]).buffer);
        uploadMeshLoDInstances(engine, state, [inst(2, 1), b]);
        expect(Array.from(new Uint32Array((state.priorStateBuffer! as unknown as MockBuffer).data.buffer))).toEqual([16, 32, 4, 8]);
        uploadMeshLoDInstances(engine, state, [{ ...b, _selectionVersion: 1 }]);
        expect((state.priorStateBuffer! as unknown as MockBuffer).data).toHaveLength(0); // same ID reinserted starts clean
    });

    it("clears a publicly removed and reinserted instance even without an intervening upload", () => {
        const { engine } = createMockEngine();
        const scene = { _deferredBuilders: [], surface: { engine } } as unknown as SceneContext;
        const asset = { _runtime: { nextInstanceId: 0 } } as unknown as MeshLoDAsset;
        const material = createPbrMaterial();
        const a = createMeshLoDInstance(asset, material);
        const b = createMeshLoDInstance(asset, material);
        addMeshLoDInstanceToScene(scene, a);
        addMeshLoDInstanceToScene(scene, b);
        const instances = scene._meshLoDRegistry!.batches[0]!.instances;
        const state = createMeshLoDGpuInstanceState(40);
        uploadMeshLoDInstances(engine, state, instances);
        const instanceBuffer = state.instanceBuffer;
        const prior = state.priorStateBuffer! as unknown as MockBuffer;
        prior.data = new Uint8Array(Uint32Array.from([1, 2, 4, 8]).buffer);
        removeMeshLoDInstanceFromScene(scene, b);
        removeMeshLoDInstanceFromScene(scene, b);
        expect(b._selectionVersion).toBe(1);
        addMeshLoDInstanceToScene(scene, b);
        expect(instances).toEqual([a, b]);
        uploadMeshLoDInstances(engine, state, instances);
        expect(state.instanceBuffer).toBe(instanceBuffer);
        expect(state.capacity).toBe(2);
        const remapped = state.priorStateBuffer! as unknown as MockBuffer;
        const words = new Uint32Array(remapped.size / 4);
        words.set(new Uint32Array(remapped.data.buffer));
        expect(Array.from(words)).toEqual([1, 2, 0, 0]);
    });

    it("builds one page-state record per page", () => {
        const data = buildPageStateData(
            [makePageRuntime(), makePageRuntime({ id: 1, state: "unrequested", arenaOffset: -1 })],
            [makePageRecord(), makePageRecord({ pinned: false })],
            5
        );
        expect(data.length).toBe(2 * PAGE_STATE_WORDS);
        expect(data[0]! & PAGE_FLAG_RESIDENT).toBe(PAGE_FLAG_RESIDENT);
        expect(data[PAGE_STATE_WORDS]! & PAGE_FLAG_RESIDENT).toBe(0);
    });
});
