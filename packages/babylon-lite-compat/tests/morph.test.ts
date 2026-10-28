import { describe, expect, it, vi } from "vitest";
import type { MorphTargetData } from "babylon-lite";

import { MorphTarget, MorphTargetManager } from "../src/morph/morph";
import { Mesh } from "../src/meshes/meshes";
import type { Scene } from "../src/scene/scene";

describe("MorphTarget / MorphTargetManager (compat over native createMorphTargets)", () => {
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
});
