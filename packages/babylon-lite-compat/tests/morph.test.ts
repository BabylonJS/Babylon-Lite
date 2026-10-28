import { describe, expect, it, vi } from "vitest";
import { disposeMeshGpu } from "babylon-lite";
import type { Mesh as LiteMesh, MorphTargetData } from "babylon-lite";

import { NullEngine } from "../src/engine/engine";
import { AssetContainer } from "../src/loading/scene-loader";
import { MorphTarget, MorphTargetManager } from "../src/morph/morph";
import { Mesh } from "../src/meshes/meshes";
import { Scene } from "../src/scene/scene";

describe("MorphTarget / MorphTargetManager (compat over native createMorphTargets)", () => {
    function morphData(name: string): MorphTargetData {
        return {
            count: 1,
            names: [name],
            weights: new Float32Array([0]),
            weightsBuffer: { destroy: vi.fn() },
            deltasBuffer: { destroy: vi.fn() },
            targets: [{ positions: new Float32Array(), normals: null }],
        } as unknown as MorphTargetData;
    }

    function liteMesh(name: string, morphTargets: MorphTargetData | null): LiteMesh {
        const buffer = (): object => ({ destroy: vi.fn() });
        return {
            name,
            children: [],
            morphTargets,
            _gpu: {
                positionBuffer: buffer(),
                normalBuffer: buffer(),
                uvBuffer: buffer(),
                indexBuffer: buffer(),
            },
        } as unknown as LiteMesh;
    }

    it("stores absolute positions/normals and influence", () => {
        const t = new MorphTarget("a", 0.25);
        expect(t.name).toBe("a");
        expect(t.influence).toBe(0.25);

        t.setPositions([0, 1, 0, 0, 1, 0]);
        expect(t.getPositions()).toBeInstanceOf(Float32Array);
        expect(Array.from(t.getPositions()!)).toEqual([0, 1, 0, 0, 1, 0]);

        t.setNormals(new Float32Array([0, 0, 1]));
        expect(Array.from(t.getNormals()!)).toEqual([0, 0, 1]);
    });

    it("tracks targets and exposes count", () => {
        const mgr = new MorphTargetManager();
        expect(mgr.numTargets).toBe(0);
        const a = new MorphTarget("a", 0);
        const b = new MorphTarget("b", 1);
        mgr.addTarget(a);
        mgr.addTarget(b);
        expect(mgr.numTargets).toBe(2);
        expect(mgr.getTarget(0)).toBe(a);
        expect(mgr.getTarget(1)).toBe(b);
    });

    it("wires the target back to its manager on addTarget", () => {
        const mgr = new MorphTargetManager();
        const t = new MorphTarget("a", 0);
        mgr.addTarget(t);
        // Changing influence before a build is a no-op (no Lite morph yet) but must not throw.
        expect(() => {
            t.influence = 0.5;
        }).not.toThrow();
        expect(t.influence).toBe(0.5);
    });

    it("wraps loader-produced names and forwards influence updates", () => {
        const writeBuffer = vi.fn();
        const lite = {
            count: 2,
            names: ["Smile", "Blink"],
            weights: new Float32Array([0.25, 0.75]),
            weightsBuffer: {},
            deltasBuffer: {},
            targets: [
                { positions: new Float32Array(), normals: null },
                { positions: new Float32Array(), normals: null },
            ],
        } as unknown as MorphTargetData;
        const manager = MorphTargetManager._fromLite(lite, { _device: { queue: { writeBuffer } } } as never);

        expect(manager.numTargets).toBe(2);
        expect(manager.getTarget(0).name).toBe("Smile");
        expect(manager.getTarget(1).influence).toBe(0.75);

        manager.getTarget(0).influence = 0.5;
        expect(Array.from(lite.weights)).toEqual([0.5, 0.75]);
        expect(writeBuffer).toHaveBeenCalled();
    });

    it("retains loader-produced influence edits made before scene adoption", () => {
        const lite = {
            count: 1,
            names: ["Smile"],
            weights: new Float32Array([0.25]),
            weightsBuffer: {},
            deltasBuffer: {},
            targets: [{ positions: new Float32Array(), normals: null }],
        } as unknown as MorphTargetData;
        const manager = MorphTargetManager._fromLite(lite);

        manager.getTarget(0).influence = 0.5;

        expect(manager.getTarget(0).influence).toBe(0.5);
        expect(lite.weights[0]).toBe(0.5);
    });

    it("reassigns a discovered manager without rebuilding or truncating loaded morph data", () => {
        const targets = Array.from({ length: 5 }, () => ({ positions: new Float32Array([1, 2, 3]), normals: null }));
        const liteMorphs = {
            count: targets.length,
            names: ["a", "b", "c", "d", "e"],
            weights: new Float32Array([0, 0.25, 0.5, 0.75, 1]),
            weightsBuffer: {},
            deltasBuffer: {},
            targets,
        } as unknown as MorphTargetData;
        const liteMesh = { name: "morphed", children: [], _gpu: {}, morphTargets: liteMorphs };
        const pendingMorphBuilds: unknown[] = [];
        const engine = { _device: { queue: { writeBuffer: vi.fn() } } };
        const scene = {
            _registerMesh: vi.fn(),
            _getLiteEngine: () => engine,
            _registerMorphTargetManager: (...args: unknown[]) => pendingMorphBuilds.push(args),
        } as unknown as Scene;
        const mesh = Mesh._fromLite(liteMesh as never, undefined, scene);
        const manager = mesh.morphTargetManager!;

        mesh.morphTargetManager = manager;

        expect(manager.numTargets).toBe(5);
        expect(liteMesh.morphTargets).toBe(liteMorphs);
        expect(liteMesh.morphTargets.targets).toBe(targets);
        expect(pendingMorphBuilds).toEqual([]);
    });

    it("retains shared morph resources and releases replacement, clearing, and disposal claims", () => {
        const first = morphData("first");
        const second = morphData("second");
        const source = liteMesh("source", first);
        const secondSource = liteMesh("second-source", second);
        const target = liteMesh("target", null);
        const sourceMesh = Mesh._fromLite(source);
        const secondSourceMesh = Mesh._fromLite(secondSource);
        const targetMesh = Mesh._fromLite(target);
        const firstManager = sourceMesh.morphTargetManager!;
        const secondManager = secondSourceMesh.morphTargetManager!;

        targetMesh.morphTargetManager = firstManager;
        expect(first._refCount).toBe(3);

        targetMesh.morphTargetManager = firstManager;
        expect(first._refCount).toBe(3);

        targetMesh.morphTargetManager = secondManager;
        expect(first._refCount).toBe(2);
        expect(second._refCount).toBe(3);

        targetMesh.morphTargetManager = null;
        expect(second._refCount).toBe(2);
        expect(target.morphTargets).toBeNull();

        targetMesh.morphTargetManager = firstManager;
        disposeMeshGpu(source);
        expect(first._disposed).not.toBe(true);
        disposeMeshGpu(target);
        expect(first._disposed).not.toBe(true);
        firstManager.dispose();
        expect(first._disposed).toBe(true);
        disposeMeshGpu(secondSource);
        secondManager.dispose();
        expect(second._disposed).toBe(true);
    });

    it("clears loader morph data before the manager getter is read", () => {
        const loaded = morphData("loaded");
        const lite = liteMesh("morphed", loaded);
        const mesh = Mesh._fromLite(lite);

        mesh.morphTargetManager = null;

        expect(lite.morphTargets).toBeNull();
        expect(loaded._disposed).toBe(true);
        expect(mesh.morphTargetManager).toBeNull();
    });

    it("keeps a saved discovered manager alive while detached and restores it safely", () => {
        const loaded = morphData("loaded");
        const lite = liteMesh("morphed", loaded);
        const mesh = Mesh._fromLite(lite);
        const manager = mesh.morphTargetManager!;

        mesh.morphTargetManager = null;
        expect(loaded._disposed).not.toBe(true);

        mesh.morphTargetManager = manager;
        expect(lite.morphTargets).toBe(loaded);
        expect(() => {
            manager.getTarget(0).influence = 0.5;
        }).not.toThrow();

        mesh.morphTargetManager = null;
        manager.dispose();
        expect(loaded._disposed).toBe(true);
    });

    it("releases discovered manager ownership during scene teardown", () => {
        const loaded = morphData("loaded");
        const lite = liteMesh("morphed", loaded);
        const scene = new Scene(new NullEngine());
        scene._lite.meshes.push(lite);
        const mesh = Mesh._fromLite(lite, undefined, scene);

        expect(mesh.morphTargetManager).not.toBeNull();
        expect(loaded._refCount).toBe(2);

        scene.dispose();

        expect(loaded._disposed).toBe(true);
        expect(loaded.deltasBuffer.destroy).toHaveBeenCalledOnce();
        expect(loaded.weightsBuffer.destroy).toHaveBeenCalledOnce();
    });

    it("releases discovered manager ownership during asset-container teardown", () => {
        const loaded = morphData("loaded");
        const lite = liteMesh("morphed", loaded);
        const root = { name: "__root__", children: [lite] };
        const container = new AssetContainer({ entities: [root] } as never, () => disposeMeshGpu(lite));
        const mesh = container.meshes[1]!;

        expect(mesh.morphTargetManager).not.toBeNull();
        expect(loaded._refCount).toBe(2);

        container.dispose();

        expect(loaded._disposed).toBe(true);
        expect(loaded.deltasBuffer.destroy).toHaveBeenCalledOnce();
        expect(loaded.weightsBuffer.destroy).toHaveBeenCalledOnce();
    });

    it("cancels a stale authored build when a discovered manager is restored before startup", () => {
        const loaded = morphData("loaded");
        const lite = liteMesh("morphed", loaded);
        lite._cpuPositions = new Float32Array([0, 0, 0]);
        lite._cpuNormals = new Float32Array([0, 0, 1]);
        const scene = new (class {
            public readonly pending: Array<{ mesh: { morphTargetManager: unknown }; manager: MorphTargetManager }> = [];
            public _getLiteEngine(): never {
                return { _device: { queue: { writeBuffer: vi.fn() } } } as never;
            }
            public _registerMesh(): void {}
            public _registerMorphTargetManager(mesh: { morphTargetManager: unknown }, manager: MorphTargetManager | null): void {
                this.pending.splice(0, this.pending.length, ...(manager ? [{ mesh, manager }] : []));
            }
            public flush(): void {
                for (const { mesh, manager } of this.pending) {
                    if (mesh.morphTargetManager === manager) {
                        manager._build(mesh as never, this._getLiteEngine());
                    }
                }
            }
        })();
        const mesh = Mesh._fromLite(lite, undefined, scene as unknown as Scene);
        const discovered = mesh.morphTargetManager!;
        const authored = new MorphTargetManager();
        const authoredBuild = vi.spyOn(authored, "_build");
        const discoveredBuild = vi.spyOn(discovered, "_build");

        mesh.morphTargetManager = authored;
        expect(scene.pending).toEqual([{ mesh, manager: authored }]);
        mesh.morphTargetManager = discovered;
        expect(scene.pending).toEqual([]);
        scene.flush();

        expect(authoredBuild).not.toHaveBeenCalled();
        expect(discoveredBuild).not.toHaveBeenCalled();
        expect(lite.morphTargets).toBe(loaded);
        expect((lite.morphTargets as MorphTargetData).targets[0]!.positions).toEqual(new Float32Array());
    });
});
