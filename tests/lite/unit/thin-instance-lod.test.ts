import { describe, expect, it } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose";
import { _detachThinInstanceLodMesh, clearThinInstanceLodPartner, setThinInstanceLodPartner, type ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";

function makeThinInstances(withColors = false): ThinInstanceData {
    return {
        matrices: new Float32Array(16),
        count: 1,
        _capacity: 1,
        _version: 1,
        _gpuBuffer: null,
        _gpuBufferStorage: false,
        _gpuVersion: 0,
        _dirtyMin: 0,
        _dirtyMax: 1,
        colors: withColors ? new Float32Array([1, 1, 1, 1]) : null,
        _colorVersion: 0,
        _colorDirtyMin: 0,
        _colorDirtyMax: 0,
        _colorGpuBuffer: null,
        _colorGpuBufferStorage: false,
        _colorGpuVersion: 0,
        _gpuCullingEnabled: false,
    };
}

function makeMesh(withColors = false): Mesh {
    return { thinInstances: makeThinInstances(withColors) } as unknown as Mesh;
}

function addDisposableGpu(mesh: Mesh): void {
    const buffer = () => ({ destroy() {} }) as unknown as GPUBuffer;
    mesh._gpu = {
        positionBuffer: buffer(),
        normalBuffer: buffer(),
        uvBuffer: buffer(),
        indexBuffer: buffer(),
        indexCount: 3,
        indexFormat: "uint16",
    };
}

describe("thin-instance LOD pairing", () => {
    it("pairs, updates, and clears a partner while restoring auto-enabled culling", () => {
        const full = makeMesh(true);
        const lod = makeMesh(true);

        setThinInstanceLodPartner(full, lod, { distance: 20, band: 4 });

        expect(full.thinInstances!._lodPartner).toBe(lod);
        expect(full.thinInstances!._lodDistance).toBe(20);
        expect(full.thinInstances!._lodBand).toBe(4);
        expect(lod.thinInstances!._lodSource).toBe(full);
        expect(lod.thinInstances!._lodBuckets).toBe(full.thinInstances!._lodBuckets);
        expect(full._clone).toContain("LOD-paired");
        expect(lod._clone).toBe(full._clone);
        expect(lod.thinInstances!._lodAutoCull).toBe(true);
        expect(lod.thinInstances!._gpuCullingEnabled).toBe(true);

        setThinInstanceLodPartner(full, lod, { distance: 30 });
        expect(full.thinInstances!._lodDistance).toBe(30);
        expect(full.thinInstances!._lodBand).toBe(0);

        clearThinInstanceLodPartner(full);

        expect(full.thinInstances!._lodPartner).toBeNull();
        expect(full.thinInstances!._lodDistance).toBeUndefined();
        expect(full.thinInstances!._lodBand).toBeUndefined();
        expect(lod.thinInstances!._lodSource).toBeNull();
        expect(full._clone).toBeUndefined();
        expect(lod._clone).toBeUndefined();
        expect(lod.thinInstances!._lodAutoCull).toBe(false);
        expect(lod.thinInstances!._gpuCullingEnabled).toBe(false);
    });

    it("cleans the previous partner when the source is re-paired", () => {
        const full = makeMesh();
        const first = makeMesh();
        const second = makeMesh();

        setThinInstanceLodPartner(full, first, { distance: 10 });
        setThinInstanceLodPartner(full, second, { distance: 20 });

        expect(first.thinInstances!._lodSource).toBeNull();
        expect(first._clone).toBeUndefined();
        expect(first.thinInstances!._gpuCullingEnabled).toBe(false);
        expect(full.thinInstances!._lodPartner).toBe(second);
        expect(second.thinInstances!._lodSource).toBe(full);
    });

    it("rejects invalid options, role conflicts, reused partners, and missing source colors", () => {
        const full = makeMesh();
        const lod = makeMesh();

        expect(() => setThinInstanceLodPartner(full, lod, { distance: -1 })).toThrow(RangeError);
        expect(() => setThinInstanceLodPartner(full, lod, { distance: Number.NaN })).toThrow(RangeError);
        expect(() => setThinInstanceLodPartner(full, lod, { distance: 1, band: -1 })).toThrow(RangeError);
        expect(() => setThinInstanceLodPartner(full, full, { distance: 1 })).toThrow("two distinct meshes");
        expect(() => setThinInstanceLodPartner(full, makeMesh(true), { distance: 1 })).toThrow("source instance colors");
        full.thinInstances!._refCount = 2;
        expect(() => setThinInstanceLodPartner(full, lod, { distance: 1 })).toThrow("shared by mesh clones");
        full.thinInstances!._refCount = 1;

        setThinInstanceLodPartner(full, lod, { distance: 1 });
        expect(() => setThinInstanceLodPartner(makeMesh(), lod, { distance: 1 })).toThrow("already paired");
        expect(() => setThinInstanceLodPartner(lod, makeMesh(), { distance: 1 })).toThrow("cannot already be an LOD partner");

        const lodOwner = makeMesh();
        const chained = makeMesh();
        setThinInstanceLodPartner(lodOwner, chained, { distance: 1 });
        expect(() => setThinInstanceLodPartner(makeMesh(), lodOwner, { distance: 1 })).toThrow("cannot also own an LOD partner");
    });

    it("detaches both sides when either mesh is disposed", () => {
        const full = makeMesh();
        const lod = makeMesh();
        setThinInstanceLodPartner(full, lod, { distance: 10 });

        _detachThinInstanceLodMesh(lod);
        expect(full.thinInstances!._lodPartner).toBeNull();
        expect(lod.thinInstances!._lodSource).toBeNull();
        expect(full._clone).toBeUndefined();
        expect(lod._clone).toBeUndefined();

        setThinInstanceLodPartner(full, lod, { distance: 10 });
        _detachThinInstanceLodMesh(full);
        expect(full.thinInstances!._lodPartner).toBeNull();
        expect(lod.thinInstances!._lodSource).toBeNull();
        expect(full._clone).toBeUndefined();
        expect(lod._clone).toBeUndefined();
        expect(lod.thinInstances!._gpuCullingEnabled).toBe(false);
    });

    it("detaches the pairing when the last thin-instance owner is disposed", () => {
        const full = makeMesh();
        const lod = makeMesh();
        addDisposableGpu(full);
        setThinInstanceLodPartner(full, lod, { distance: 10 });

        disposeMeshGpu(full);

        expect(full.thinInstances!._lodPartner).toBeNull();
        expect(lod.thinInstances!._lodSource).toBeNull();
        expect(lod.thinInstances!._gpuCullingEnabled).toBe(false);
    });
});
