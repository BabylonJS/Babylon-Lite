import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `Mesh.MergeMeshes` forwards to the compat-local `mergeMeshGeometry`
 * (which bakes each source's world-transformed CPU geometry into one new mesh). The
 * real merge uploads to the GPU, so these tests mock the Lite factory to a plain
 * handle and verify the compat surface GPU-free: argument forwarding, the
 * `disposeSource` default, the 16-bit-index vertex ceiling, and that every
 * unsupported Babylon.js semantic is rejected rather than silently dropped.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        createMeshFromData: vi.fn((_engine: unknown, name: string) => ({
            name,
            _cpuPositions: new Float32Array(9),
            _cpuNormals: new Float32Array(9),
            _cpuIndices: new Uint32Array([0, 1, 2]),
            children: [],
        })),
        addToScene: vi.fn(),
        removeFromScene: vi.fn(),
    };
});

vi.mock("../src/meshes/merge-mesh-geometry.js", () => ({
    mergeMeshGeometry: vi.fn((_engine: unknown, name: string) => ({ name, _tag: "merged" })),
}));

import { addToScene } from "babylon-lite";
import { LiteCompatError } from "../src/error";
import { mergeMeshGeometry } from "../src/meshes/merge-mesh-geometry.js";

// Imported after the mocks so `Mesh` picks up the stubbed geometry merge.
const { Mesh } = await import("../src/meshes/meshes");

const mergeMock = vi.mocked(mergeMeshGeometry);

interface FakeMeshOptions {
    name?: string;
    vertices?: number;
    colors?: boolean;
    tangents?: boolean;
    uv2?: boolean;
}

function fakeScene(): {
    getEngine(): { _lite: object };
    defaultMaterial: undefined;
    pendingAdds: Array<() => void>;
    _deferAdd(fn: () => void): void;
    flushPendingAdds(): void;
    _unregisterNode(node: unknown): void;
    _lite: object;
} {
    const pendingAdds: Array<() => void> = [];
    return {
        getEngine: () => ({ _lite: { _tag: "engine" } }),
        defaultMaterial: undefined,
        pendingAdds,
        _deferAdd: (fn) => pendingAdds.push(fn),
        flushPendingAdds: () => {
            for (const add of pendingAdds.splice(0)) {
                add();
            }
        },
        _unregisterNode: vi.fn(),
        _lite: { _tag: "scene" },
    };
}

const scene = fakeScene();
const addToSceneMock = vi.mocked(addToScene);

function fakeMesh(opts: FakeMeshOptions = {}): InstanceType<typeof Mesh> {
    const lite: Record<string, unknown> = { name: opts.name ?? "m" };
    if (opts.colors) {
        lite._cpuColors = new Float32Array(4);
    }
    if (opts.tangents) {
        lite._cpuTangents = new Float32Array(4);
    }
    if (opts.uv2) {
        lite._cpuUv2s = new Float32Array(2);
    }
    return {
        name: opts.name ?? "m",
        _lite: lite,
        material: null,
        getScene: () => scene,
        getTotalVertices: () => opts.vertices ?? 3,
        dispose: vi.fn(),
    } as unknown as InstanceType<typeof Mesh>;
}

describe("Mesh.MergeMeshes", () => {
    beforeEach(() => {
        scene.pendingAdds.length = 0;
        addToSceneMock.mockClear();
        mergeMock.mockClear();
    });

    it("forwards engine, the first mesh's name, and each source's Lite handle", () => {
        mergeMock.mockClear();
        const a = fakeMesh({ name: "alpha" });
        const b = fakeMesh({ name: "beta" });
        const merged = Mesh.MergeMeshes([a, b]);
        expect(mergeMock).toHaveBeenCalledTimes(1);
        const [engine, name, liteArray] = mergeMock.mock.calls[0]!;
        expect(engine).toEqual({ _tag: "engine" });
        expect(name).toBe("alpha");
        expect(liteArray).toEqual([a._lite, b._lite]);
        expect(merged).toBeInstanceOf(Mesh);
    });

    it("filters null/undefined entries and returns null when none remain", () => {
        mergeMock.mockClear();
        expect(Mesh.MergeMeshes([null, undefined])).toBeNull();
        expect(mergeMock).not.toHaveBeenCalled();
    });

    it("disposes the source meshes by default, and keeps them when disposeSource is false", () => {
        const a = fakeMesh();
        const b = fakeMesh();
        Mesh.MergeMeshes([a, b]);
        expect(a.dispose).toHaveBeenCalledTimes(1);
        expect(b.dispose).toHaveBeenCalledTimes(1);

        const c = fakeMesh();
        Mesh.MergeMeshes([c], false);
        expect(c.dispose).not.toHaveBeenCalled();
    });

    it("does not re-add a source disposed by a pre-start merge", () => {
        const source = new Mesh("source", scene as never);

        Mesh.MergeMeshes([source]);
        scene.flushPendingAdds();

        expect(source.isDisposed()).toBe(true);
        expect(addToSceneMock).toHaveBeenCalledTimes(1);
        expect(addToSceneMock).not.toHaveBeenCalledWith(scene._lite, source._lite);
    });

    it("returns null when a 16-bit-index merge would exceed 65535 vertices (Babylon.js parity)", () => {
        mergeMock.mockClear();
        const big = fakeMesh({ vertices: 40000 });
        const big2 = fakeMesh({ vertices: 40000 });
        expect(Mesh.MergeMeshes([big, big2])).toBeNull();
        expect(mergeMock).not.toHaveBeenCalled();
    });

    it("allows the same large merge when allow32BitsIndices is true", () => {
        mergeMock.mockClear();
        const big = fakeMesh({ vertices: 40000 });
        const big2 = fakeMesh({ vertices: 40000 });
        expect(Mesh.MergeMeshes([big, big2], true, true)).toBeInstanceOf(Mesh);
        expect(mergeMock).toHaveBeenCalledTimes(1);
    });

    it("rejects submesh / multi-material merges", () => {
        expect(() => Mesh.MergeMeshes([fakeMesh()], true, true, undefined, true)).toThrow(LiteCompatError);
        expect(() => Mesh.MergeMeshes([fakeMesh()], true, true, undefined, false, true)).toThrow(LiteCompatError);
    });

    it("rejects a meshSubclass target", () => {
        expect(() => Mesh.MergeMeshes([fakeMesh()], true, true, fakeMesh())).toThrow(LiteCompatError);
    });

    it("rejects sources carrying vertex colours, tangents, or a second UV set", () => {
        expect(() => Mesh.MergeMeshes([fakeMesh({ colors: true })])).toThrow(LiteCompatError);
        expect(() => Mesh.MergeMeshes([fakeMesh({ tangents: true })])).toThrow(LiteCompatError);
        expect(() => Mesh.MergeMeshes([fakeMesh({ uv2: true })])).toThrow(LiteCompatError);
    });
});
