/**
 * Numerical equivalence and identity stability tests for the zero-allocation
 * CSM cascade refactor and shadow-base ToRef helpers.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { buildLightViewMatrix, casterVersionSum } from "../../../packages/babylon-lite/src/shadow/shadow-base.js";
import {
    _biasViewProjection,
    _createCascadeScratch,
    _computeCsmCascades,
    _writeCsmUbo,
    buildLightViewMatrixInto,
} from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks.js";

// Minimal mock of getViewProjectionMatrix — returns an invertible perspective-like matrix.
vi.mock("../../../packages/babylon-lite/src/camera/camera.js", () => {
    const _vpMat = new Float32Array([1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2002, 0]);
    return {
        getViewProjectionMatrix: () => _vpMat,
        getEffectiveAspectRatio: () => 1.5,
        _cameraChangeKey: () => 1,
    };
});

describe("shadow-base ToRef numerical equivalence", () => {
    it("buildLightViewMatrixInto produces identical output to buildLightViewMatrix", () => {
        const params: [number, number, number, number, number, number][] = [
            [0, -1, 0, 5, 10, 3],
            [1, -1, 1, 0, 0, 0],
            [0.3, -0.9, 0.1, -10, 20, -5],
            [0, -1, 0.0001, 100, 200, 300], // near-vertical
        ];
        for (const [dx, dy, dz, px, py, pz] of params) {
            const alloc = buildLightViewMatrix(dx, dy, dz, px, py, pz);
            const into = new Float32Array(16);
            buildLightViewMatrixInto(into, dx, dy, dz, px, py, pz);
            for (let i = 0; i < 16; i++) {
                expect(into[i]).toBe(alloc[i]);
            }
        }
    });
});

describe("_biasViewProjection", () => {
    it("applies the bias in place without replacing or rewriting the matrix", () => {
        const vp = new Float32Array([1, 0.5, 0.3, 0.1, 0, 1, 0.2, 0.05, 0, 0, 1, 0.01, 0, 0, 0, 1]);
        const before = Array.from(vp);
        const clipOffset = 0.005;

        _biasViewProjection(vp, clipOffset);

        for (let i = 0; i < 16; i++) {
            expect(vp[i]).toBe(i === 14 ? new Float32Array([before[i]! + clipOffset])[0] : before[i]);
        }
    });
});

describe("CsmCascadeScratch identity stability", () => {
    it("returns the same arrays on repeated fits via _createCascadeScratch", () => {
        const scratch = _createCascadeScratch(3);
        const cascades = scratch._cascades;
        // Capture references
        const transforms0 = cascades._transforms[0];
        const views0 = cascades._views[0];
        const nearArr = cascades._near;
        const farArr = cascades._far;
        const vfzArr = cascades._viewFrustumZ;
        const flArr = cascades._frustumLengths;

        // Simulate a "second fit" by mutating values
        cascades._transforms[0]![0] = 99;
        cascades._near[1] = 42;

        // References must be the same objects
        expect(cascades._transforms[0]).toBe(transforms0);
        expect(cascades._views[0]).toBe(views0);
        expect(cascades._near).toBe(nearArr);
        expect(cascades._far).toBe(farArr);
        expect(cascades._viewFrustumZ).toBe(vfzArr);
        expect(cascades._frustumLengths).toBe(flArr);
    });

    it("pre-allocates all temporary fitting storage", () => {
        const scratch = _createCascadeScratch(4);

        expect(scratch._view).toHaveLength(16);
        expect(scratch._invViewProj).toHaveLength(16);
        expect(scratch._corners).toHaveLength(8);
        expect(scratch._corners.every((corner) => corner.length === 3)).toBe(true);
        expect(scratch._aabb).toHaveLength(6);
    });

    it("_writeCsmUbo produces consistent output from scratch cascades", () => {
        const scratch = _createCascadeScratch(2);
        const cascades = scratch._cascades;
        // Fill with known values
        for (let i = 0; i < 2; i++) {
            cascades._transforms[i]!.fill(i + 1);
            cascades._viewFrustumZ[i] = 10 + i;
            cascades._frustumLengths[i] = 5 + i;
            cascades._near[i] = i * 0.1;
            cascades._far[i] = i * 10 + 100;
        }
        const cfg = { _darkness: 0.5, _mapSize: 1024, _frustumEdgeFalloff: 0, _cascadeBlendPercentage: 0.1, _numCascades: 2 };
        const ubo1 = new Float32Array(80);
        _writeCsmUbo(ubo1, cascades, cfg as any);

        // Run again with same data → same output
        const ubo2 = new Float32Array(80);
        _writeCsmUbo(ubo2, cascades, cfg as any);
        for (let i = 0; i < 80; i++) {
            expect(ubo2[i]).toBe(ubo1[i]);
        }
    });
});

describe("_computeCsmCascades zero-allocation", () => {
    // Minimal stubs — only the fields accessed by _computeCsmCascades
    function makeStubs(numCascades: number) {
        const worldMat = new Float32Array(16);
        worldMat[0] = 1;
        worldMat[5] = 1;
        worldMat[10] = 1;
        worldMat[15] = 1;
        const camera = {
            nearPlane: 0.1,
            farPlane: 100,
            fov: 0.8,
            viewport: null,
            _vpCache: new Float32Array(16),
            _vpVer: -1,
            _vpAspect: -1,
            worldMatrix: worldMat,
        } as any;
        const light = { direction: { x: 0.3, y: -0.9, z: 0.1 } } as any;
        const scene = { surface: { scRT: { _width: 800, _height: 600 } } } as any;
        const cfg = {
            _numCascades: numCascades,
            _lambda: 0.5,
            _cascadeBlendPercentage: 0.1,
            _stabilizeCascades: true,
            _shadowMaxZ: null,
            _bias: 0.005,
            _worldSpaceBias: null,
            _darkness: 0.5,
            _frustumEdgeFalloff: 0,
            _mapSize: 1024,
            _forceRefreshEveryFrame: true,
        };
        const mesh = {
            thinInstances: null,
            worldMatrix: worldMat,
            worldMatrixVersion: 1,
            boundMin: [-1, -1, -1],
            boundMax: [1, 1, 1],
            material: null,
            _shadowMaxCascade: undefined,
        } as any;
        return { camera, light, scene, cfg, casterMeshes: [mesh] as any[] };
    }

    it("returns the same CsmCascades object and stable inner arrays across calls", () => {
        const n = 3;
        const scratch = _createCascadeScratch(n);
        const { camera, light, scene, cfg, casterMeshes } = makeStubs(n);

        const result1 = _computeCsmCascades(scene, camera, light, cfg, casterMeshes, scratch);
        // Capture all references
        const transforms = result1._transforms;
        const views = result1._views;
        const nearArr = result1._near;
        const farArr = result1._far;
        const vfzArr = result1._viewFrustumZ;
        const flArr = result1._frustumLengths;
        const t0 = result1._transforms[0];
        const v0 = result1._views[0];

        // Call again (simulating next frame)
        const result2 = _computeCsmCascades(scene, camera, light, cfg, casterMeshes, scratch);

        // Same top-level object
        expect(result2).toBe(result1);
        // Same array containers
        expect(result2._transforms).toBe(transforms);
        expect(result2._views).toBe(views);
        expect(result2._near).toBe(nearArr);
        expect(result2._far).toBe(farArr);
        expect(result2._viewFrustumZ).toBe(vfzArr);
        expect(result2._frustumLengths).toBe(flArr);
        // Same per-cascade Float32Arrays
        expect(result2._transforms[0]).toBe(t0);
        expect(result2._views[0]).toBe(v0);
    });

    it("produces identical numerical output on repeated calls with same inputs", () => {
        const n = 4;
        const scratch = _createCascadeScratch(n);
        const { camera, light, scene, cfg, casterMeshes } = makeStubs(n);

        const result1 = _computeCsmCascades(scene, camera, light, cfg, casterMeshes, scratch);
        // Snapshot values
        const snap: number[][] = [];
        for (let c = 0; c < n; c++) {
            snap.push(Array.from(result1._transforms[c]!));
        }
        const nearSnap = [...result1._near];
        const farSnap = [...result1._far];

        // Mutate and re-call
        result1._transforms[0]![0] = 999;
        const result2 = _computeCsmCascades(scene, camera, light, cfg, casterMeshes, scratch);
        for (let c = 0; c < n; c++) {
            for (let i = 0; i < 16; i++) {
                expect(result2._transforms[c]![i]).toBe(snap[c]![i]);
            }
        }
        expect([...result2._near]).toEqual(nearSnap);
        expect([...result2._far]).toEqual(farSnap);
    });

    it("scratch AABB storage is reused across calls (no new objects)", () => {
        const n = 2;
        const scratch = _createCascadeScratch(n);
        const { camera, light, scene, cfg, casterMeshes } = makeStubs(n);
        const aabbRef = scratch._aabb;

        _computeCsmCascades(scene, camera, light, cfg, casterMeshes, scratch);
        expect(scratch._aabb).toBe(aabbRef);
        expect(scratch._aabb).toEqual([-1, -1, -1, 1, 1, 1]);

        _computeCsmCascades(scene, camera, light, cfg, casterMeshes, scratch);
        expect(scratch._aabb).toBe(aabbRef);
    });
});
