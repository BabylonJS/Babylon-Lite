import { describe, expect, it } from "vitest";

import { MorphTarget, MorphTargetManager } from "../src/morph/morph";

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
});
