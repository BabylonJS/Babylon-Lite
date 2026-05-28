import { describe, expect, it } from "vitest";

import type { EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";
import type { MatrixAllocator } from "../../packages/babylon-lite/src/math/_matrix-allocator";
import { createF64MatrixAllocator } from "../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { asMat4Storage } from "../../packages/babylon-lite/src/math/_mat4-storage";
import { resolveScenePrecisionPolicy } from "../../packages/babylon-lite/src/scene/_scene-precision";
import { bindEntityMatrixPolicy } from "../../packages/babylon-lite/src/scene/_entity-precision-bind";
import { createSceneNode } from "../../packages/babylon-lite/src/scene/scene-node";
import { createArcRotateCamera } from "../../packages/babylon-lite/src/camera/arc-rotate";
import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera";
import { getProjectionMatrix, getViewMatrix, getViewProjectionMatrix } from "../../packages/babylon-lite/src/camera/camera";
import { createDirectionalLight } from "../../packages/babylon-lite/src/light/directional-light";
import { createHemisphericLight } from "../../packages/babylon-lite/src/light/hemispheric";
import { createSpotLight } from "../../packages/babylon-lite/src/light/spot-light";

// Vitest cannot create a real engine (no WebGPU), so we synthesize a policy
// with the same shape and bind entities directly. This validates Task 2.3's
// "HPM-on path actually uses F64" invariant end-to-end on the CPU side.

function f32Allocator(): MatrixAllocator {
    return {
        storageKind: "f32",
        allocate: () => new Float32Array(16) as unknown as never,
    };
}

function fakeEngine(allocator: MatrixAllocator): EngineContextInternal {
    return { _matrixPolicy: allocator } as unknown as EngineContextInternal;
}

function bind(entity: unknown, allocator: MatrixAllocator): void {
    const policy = resolveScenePrecisionPolicy(fakeEngine(allocator), {});
    bindEntityMatrixPolicy(entity as { _boundPolicy?: unknown; _rebindAllocator?: (a: MatrixAllocator) => void }, policy);
}

describe("matrix cache storage follows precision policy", () => {
    describe("HPM off (default F32 path)", () => {
        const alloc = f32Allocator();

        it("scene-node world matrix storage is Float32Array", () => {
            const node = createSceneNode("n", 1, 2, 3);
            bind(node, alloc);
            // Force computation through the policy-allocated _ownedWorld by parenting
            // to another node so the multiply-into path runs.
            const parent = createSceneNode("p", 4, 5, 6);
            bind(parent, alloc);
            node.parent = parent;
            const w = node.worldMatrix;
            expect(asMat4Storage(w)).toBeInstanceOf(Float32Array);
        });

        it("arc-rotate camera local matrix + view/proj/vp caches are Float32Array", () => {
            const cam = createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
            bind(cam, alloc);
            // Force lazy-init of all caches:
            getViewMatrix(cam);
            getProjectionMatrix(cam, 1.0);
            getViewProjectionMatrix(cam, 1.0);
            expect(cam._viewCache).toBeInstanceOf(Float32Array);
            expect(cam._projCache).toBeInstanceOf(Float32Array);
            expect(cam._vpCache).toBeInstanceOf(Float32Array);
            // World matrix flows through _localMat (re-allocated by _rebindAllocator)
            expect(asMat4Storage(cam.worldMatrix)).toBeInstanceOf(Float32Array);
        });

        it("free camera local matrix is Float32Array", () => {
            const cam = createFreeCamera({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 0 });
            bind(cam, alloc);
            expect(asMat4Storage(cam.worldMatrix)).toBeInstanceOf(Float32Array);
        });

        it("directional / hemispheric / spot light local matrices are Float32Array", () => {
            const d = createDirectionalLight([0, -1, 0]);
            bind(d, alloc);
            expect(asMat4Storage(d.worldMatrix)).toBeInstanceOf(Float32Array);

            const h = createHemisphericLight([0, 1, 0]);
            bind(h, alloc);
            expect(asMat4Storage(h.worldMatrix)).toBeInstanceOf(Float32Array);

            const s = createSpotLight([0, 5, 0], [0, -1, 0], Math.PI / 4, 1);
            bind(s, alloc);
            expect(asMat4Storage(s.worldMatrix)).toBeInstanceOf(Float32Array);
        });
    });

    describe("HPM on (F64 path)", () => {
        const alloc = createF64MatrixAllocator();

        it("scene-node world matrix storage is Float64Array", () => {
            const node = createSceneNode("n", 1, 2, 3);
            bind(node, alloc);
            const parent = createSceneNode("p", 4, 5, 6);
            bind(parent, alloc);
            node.parent = parent;
            const w = node.worldMatrix;
            expect(asMat4Storage(w)).toBeInstanceOf(Float64Array);
        });

        it("arc-rotate camera local matrix + view/proj/vp caches are Float64Array", () => {
            const cam = createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
            bind(cam, alloc);
            getViewMatrix(cam);
            getProjectionMatrix(cam, 1.0);
            getViewProjectionMatrix(cam, 1.0);
            expect(cam._viewCache).toBeInstanceOf(Float64Array);
            expect(cam._projCache).toBeInstanceOf(Float64Array);
            expect(cam._vpCache).toBeInstanceOf(Float64Array);
            expect(asMat4Storage(cam.worldMatrix)).toBeInstanceOf(Float64Array);
        });

        it("free camera local matrix is Float64Array", () => {
            const cam = createFreeCamera({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 0 });
            bind(cam, alloc);
            expect(asMat4Storage(cam.worldMatrix)).toBeInstanceOf(Float64Array);
        });

        it("directional / hemispheric / spot light local matrices are Float64Array", () => {
            const d = createDirectionalLight([0, -1, 0]);
            bind(d, alloc);
            expect(asMat4Storage(d.worldMatrix)).toBeInstanceOf(Float64Array);

            const h = createHemisphericLight([0, 1, 0]);
            bind(h, alloc);
            expect(asMat4Storage(h.worldMatrix)).toBeInstanceOf(Float64Array);

            const s = createSpotLight([0, 5, 0], [0, -1, 0], Math.PI / 4, 1);
            bind(s, alloc);
            expect(asMat4Storage(s.worldMatrix)).toBeInstanceOf(Float64Array);
        });
    });

    it("unbound entities (no _boundPolicy) still allocate F32 — keeps the default path bit-exact", () => {
        const node = createSceneNode("n", 1, 2, 3);
        const parent = createSceneNode("p", 4, 5, 6);
        node.parent = parent;
        const w = node.worldMatrix;
        expect(asMat4Storage(w)).toBeInstanceOf(Float32Array);
    });
});
