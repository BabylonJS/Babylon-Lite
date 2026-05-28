import { describe, expect, it } from "vitest";

import type { EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";
import type { MatrixAllocator } from "../../packages/babylon-lite/src/math/_matrix-allocator";
import { createF64MatrixAllocator } from "../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { resolveScenePrecisionPolicy } from "../../packages/babylon-lite/src/scene/_scene-precision";

// `createSceneContext` requires a WebGPU device (via `createFrameGraph`), so
// it cannot run under Vitest. We instead exercise the pure resolver directly;
// it captures the observable surface of `scene._matrixPolicy` for Task 2.1.

function f32Allocator(): MatrixAllocator {
    return {
        storageKind: "f32",
        allocate: () => new Float32Array(16) as unknown as never,
    };
}

function fakeEngine(allocator: MatrixAllocator): EngineContextInternal {
    return { _matrixPolicy: allocator } as unknown as EngineContextInternal;
}

describe("scene precision policy resolver", () => {
    it("HPM-off engine yields an F32 scene policy that references the engine allocator", () => {
        const alloc = f32Allocator();
        const engine = fakeEngine(alloc);
        const policy = resolveScenePrecisionPolicy(engine, {});
        expect(policy.useHighPrecisionMatrix).toBe(false);
        expect(policy.storageKind).toBe("f32");
        expect(policy.allocator).toBe(alloc);
    });

    it("HPM-on engine yields an F64 scene policy that references the engine allocator", () => {
        const alloc = createF64MatrixAllocator();
        const engine = fakeEngine(alloc);
        const policy = resolveScenePrecisionPolicy(engine, {});
        expect(policy.useHighPrecisionMatrix).toBe(true);
        expect(policy.storageKind).toBe("f64");
        expect(policy.allocator).toBe(alloc);
    });

    it("two scenes on the same engine share the same allocator reference", () => {
        const alloc = f32Allocator();
        const engine = fakeEngine(alloc);
        const p1 = resolveScenePrecisionPolicy(engine, {});
        const p2 = resolveScenePrecisionPolicy(engine, { useFloatingOrigin: true });
        expect(p1.allocator).toBe(p2.allocator);
        // ScenePrecisionPolicy objects are per-call (distinct refs) — that's
        // intentional so callers can compare identity per scene if needed.
        expect(p1).not.toBe(p2);
    });

    it("scenes on different engines do NOT share allocator references", () => {
        const engineA = fakeEngine(f32Allocator());
        const engineB = fakeEngine(createF64MatrixAllocator());
        const pA = resolveScenePrecisionPolicy(engineA, {});
        const pB = resolveScenePrecisionPolicy(engineB, {});
        expect(pA.allocator).not.toBe(pB.allocator);
        expect(pA.storageKind).toBe("f32");
        expect(pB.storageKind).toBe("f64");
    });

    it("ignores per-scene options for M0 (useFloatingOrigin does not flip storage)", () => {
        // M1 will add validation; M0 must be a pure mirror per task plan.
        const alloc = f32Allocator();
        const engine = fakeEngine(alloc);
        const policy = resolveScenePrecisionPolicy(engine, { useFloatingOrigin: true });
        expect(policy.storageKind).toBe("f32");
    });
});
