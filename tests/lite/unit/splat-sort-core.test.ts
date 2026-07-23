import { describe, expect, it } from "vitest";
import { createSplatSortScratch, sortSplatsBackToFront, splatSortBucketBits } from "../../../packages/babylon-lite/src/loader-splat/splat-sort-core";
import { postSplatSortIfDirty, uploadPendingSplatOrder, type GaussianSplattingMesh } from "../../../packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-mesh";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Reference view depth of splat `j`: cameraForward · (world · localPos − cameraPos). */
function refDepth(positions: Float32Array, j: number, m: Float32Array, cf: Float32Array, cp: Float32Array): number {
    const x = positions[3 * j]!;
    const y = positions[3 * j + 1]!;
    const z = positions[3 * j + 2]!;
    const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    return cf[0]! * (wx - cp[0]!) + cf[1]! * (wy - cp[1]!) + cf[2]! * (wz - cp[2]!);
}

/** Reference back-to-front order: full-precision sort, descending depth, stable by index. */
function refOrder(positions: Float32Array, n: number, m: Float32Array, cf: Float32Array, cp: Float32Array): number[] {
    const idx = Array.from({ length: n }, (_, j) => j);
    const depths = idx.map((j) => refDepth(positions, j, m, cf, cp));
    return idx.sort((p, q) => depths[q]! - depths[p]! || p - q);
}

function sort(positions: Float32Array, n: number, m: Float32Array, cf: Float32Array, cp: Float32Array): Uint32Array {
    const order = new Uint32Array(n);
    sortSplatsBackToFront(positions, n, m, cf, cp, order, createSplatSortScratch(n));
    return order;
}

function expectPermutation(order: Uint32Array, n: number): void {
    const seen = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
        seen[order[j]!] = 1;
    }
    expect(seen.every((s) => s === 1)).toBe(true);
}

describe("splatSortBucketBits", () => {
    it("clamps tiny clouds to 10 bits", () => {
        expect(splatSortBucketBits(0)).toBe(10);
        expect(splatSortBucketBits(1)).toBe(10);
        expect(splatSortBucketBits(1024)).toBe(10);
    });

    it("scales with splat count", () => {
        expect(splatSortBucketBits(4 * 2 ** 12)).toBe(12);
        expect(splatSortBucketBits(4 * 2 ** 16)).toBe(16);
    });

    it("clamps huge clouds to 20 bits", () => {
        expect(splatSortBucketBits(4 * 2 ** 20)).toBe(20);
        expect(splatSortBucketBits(1e9)).toBe(20);
    });
});

describe("sortSplatsBackToFront", () => {
    const CF = new Float32Array([0, 0, 1]);
    const CP = new Float32Array([0, 0, 0]);

    it("matches a full-precision reference sort on well-separated depths", () => {
        // Uniformly spread distinct depths: the quantized keys stay distinct
        // (bucket width ≪ spacing), so the counting sort must match the
        // reference exactly, not just up to ties.
        const n = 200;
        const positions = new Float32Array(n * 3);
        const shuffled = Array.from({ length: n }, (_, j) => j);
        let seed = 42;
        const rand = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        for (let j = n - 1; j > 0; j--) {
            const k = (rand() * (j + 1)) | 0;
            [shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!];
        }
        for (let j = 0; j < n; j++) {
            positions[3 * j] = rand() * 10 - 5;
            positions[3 * j + 1] = rand() * 10 - 5;
            positions[3 * j + 2] = shuffled[j]!;
        }
        const order = sort(positions, n, IDENTITY, CF, CP);
        expect(Array.from(order)).toEqual(refOrder(positions, n, IDENTITY, CF, CP));
    });

    it("orders random clouds back-to-front within quantization tolerance", () => {
        const n = 5000;
        const positions = new Float32Array(n * 3);
        let seed = 7;
        const rand = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        for (let i = 0; i < n * 3; i++) {
            positions[i] = rand() * 40 - 20;
        }
        const cf = new Float32Array([0.267261, 0.534522, 0.801784]); // normalized (1,2,3)
        const cp = new Float32Array([1, -2, 3]);
        const order = sort(positions, n, IDENTITY, cf, cp);
        expectPermutation(order, n);

        const depths = Array.from({ length: n }, (_, j) => refDepth(positions, j, IDENTITY, cf, cp));
        let minD = Infinity;
        let maxD = -Infinity;
        for (const dj of depths) {
            minD = Math.min(minD, dj);
            maxD = Math.max(maxD, dj);
        }
        // Widest possible bucket: a coarse bin granted a single key spans
        // range/32. Depths along the output may only increase by less than that.
        const tolerance = (maxD - minD) / 32 + 1e-6;
        for (let j = 1; j < n; j++) {
            expect(depths[order[j]!]!).toBeLessThan(depths[order[j - 1]!]! + tolerance);
        }
    });

    it("honors a non-identity world matrix", () => {
        // 90° rotation about Y (column-major) + translation: local +X maps to
        // world −Z, so the sort along world +Z must invert the local X ranks.
        const world = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 0, 2, 1]);
        const positions = new Float32Array([1, 0, 0, 2, 0, 0, 3, 0, 0]);
        const order = sort(positions, 3, world, CF, CP);
        expect(Array.from(order)).toEqual(refOrder(positions, 3, world, CF, CP));
    });

    it("returns identity order for all-equal depths", () => {
        const n = 64;
        const positions = new Float32Array(n * 3);
        for (let j = 0; j < n; j++) {
            positions[3 * j] = j; // varies orthogonally to the view axis
            positions[3 * j + 2] = 7; // constant depth
        }
        const order = sort(positions, n, IDENTITY, CF, CP);
        expect(Array.from(order)).toEqual(Array.from({ length: n }, (_, j) => j));
    });

    it("handles empty and single-splat clouds", () => {
        expect(() => sort(new Float32Array(0), 0, IDENTITY, CF, CP)).not.toThrow();
        expect(Array.from(sort(new Float32Array([1, 2, 3]), 1, IDENTITY, CF, CP))).toEqual([0]);
    });

    it("sorts NaN centers to the back and keeps the rest ordered", () => {
        const positions = new Float32Array([
            0, 0, 1, // near
            NaN, 0, 2, // corrupt
            0, 0, 9, // far
            0, 0, 5, // mid
        ]);
        const order = sort(positions, 4, IDENTITY, CF, CP);
        expectPermutation(order, 4);
        // Corrupt splat draws first (behind everything)…
        expect(order[0]).toBe(1);
        // …and the finite splats stay back-to-front.
        expect(Array.from(order).slice(1)).toEqual([2, 3, 0]);
    });

    it("survives a fully non-finite cloud", () => {
        const positions = new Float32Array([NaN, NaN, NaN, Infinity, 0, -Infinity]);
        const order = sort(positions, 2, IDENTITY, CF, CP);
        expect(Array.from(order)).toEqual([0, 1]);
    });
});

describe("postSplatSortIfDirty / uploadPendingSplatOrder", () => {
    interface PostedJob {
        m: Float32Array;
        f: Float32Array;
        c: Float32Array;
        o: Uint32Array;
    }

    function makeMesh(vertexCount: number): { mesh: GaussianSplattingMesh; posted: PostedJob[] } {
        const posted: PostedJob[] = [];
        const mesh = {
            vertexCount,
            _orderPool: [new Uint32Array(vertexCount), new Uint32Array(vertexCount)],
            _pendingOrder: null,
            _sortWorldMatrix: new Float32Array(16),
            _sortCameraForward: new Float32Array(3),
            _sortCameraPosition: new Float32Array(3),
            _worker: {
                postMessage(data: PostedJob) {
                    posted.push(data);
                },
            },
            _gs: {
                _splatIndexCpu: new Float32Array(vertexCount),
                _splatIndexBuffer: {},
            },
        } as unknown as GaussianSplattingMesh;
        return { mesh, posted };
    }

    const queueStub = (writes: number[]): GPUQueue =>
        ({
            writeBuffer() {
                writes.push(1);
            },
        }) as unknown as GPUQueue;

    it("posts when the camera moved past the epsilon and snapshots the state", () => {
        const { mesh, posted } = makeMesh(4);
        postSplatSortIfDirty(mesh, IDENTITY, 0, 0, 1, 0, 0, 0);
        expect(posted.length).toBe(1);
        expect(mesh._orderPool.length).toBe(1);
        expect(Array.from(mesh._sortCameraForward)).toEqual([0, 0, 1]);
    });

    it("skips a re-sort for sub-epsilon drift", () => {
        const { mesh, posted } = makeMesh(4);
        postSplatSortIfDirty(mesh, IDENTITY, 0, 0, 1, 0, 0, 0);
        // 5e-5 < SORT_EPS (1e-4) on every component: no new job.
        postSplatSortIfDirty(mesh, IDENTITY, 0, 0, 1 + 5e-5, 5e-5, 0, 0);
        expect(posted.length).toBe(1);
        // Past the epsilon: re-sort.
        postSplatSortIfDirty(mesh, IDENTITY, 0, 0, 1, 0.001, 0, 0);
        expect(posted.length).toBe(2);
    });

    it("re-sorts when only the world matrix changes", () => {
        const { mesh, posted } = makeMesh(4);
        postSplatSortIfDirty(mesh, IDENTITY, 0, 0, 1, 0, 0, 0);
        const moved = new Float32Array(IDENTITY);
        moved[12] = 2;
        postSplatSortIfDirty(mesh, moved, 0, 0, 1, 0, 0, 0);
        expect(posted.length).toBe(2);
    });

    it("caps in-flight jobs at the pool size", () => {
        const { mesh, posted } = makeMesh(4);
        postSplatSortIfDirty(mesh, IDENTITY, 0, 0, 1, 0, 0, 0);
        postSplatSortIfDirty(mesh, IDENTITY, 0, 0, 1, 1, 0, 0);
        expect(posted.length).toBe(2);
        expect(mesh._orderPool.length).toBe(0);
        // Pool exhausted: a further move must not post (and must not consume
        // the snapshot, so the job isn't lost — it stays dirty).
        postSplatSortIfDirty(mesh, IDENTITY, 0, 0, 1, 2, 0, 0);
        expect(posted.length).toBe(2);
        // A buffer returns: the still-dirty state posts on the next call.
        mesh._orderPool.push(new Uint32Array(4));
        postSplatSortIfDirty(mesh, IDENTITY, 0, 0, 1, 2, 0, 0);
        expect(posted.length).toBe(3);
    });

    it("uploads the pending order once and recycles the buffer", () => {
        const { mesh } = makeMesh(3);
        const writes: number[] = [];
        const queue = queueStub(writes);
        mesh._pendingOrder = Uint32Array.from([2, 0, 1]);
        uploadPendingSplatOrder(queue, mesh);
        expect(writes.length).toBe(1);
        expect(Array.from(mesh._gs._splatIndexCpu)).toEqual([2, 0, 1]);
        expect(mesh._orderPool.length).toBe(3);
        expect(mesh._pendingOrder).toBeNull();
        // Nothing pending: no second upload.
        uploadPendingSplatOrder(queue, mesh);
        expect(writes.length).toBe(1);
    });
});
