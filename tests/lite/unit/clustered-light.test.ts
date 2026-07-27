import { describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import {
    buildClusteredLightGpuState,
    createClusteredLightContainer,
    createClusteredPointLight,
    markClusteredLightContainerDirty,
} from "../../../packages/babylon-lite/src/light/clustered";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { enableOrthographicCamera } from "../../../packages/babylon-lite/src/camera/orthographic";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function identity(): Mat4 {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;
}

function camera(): Camera {
    return {
        nearPlane: 0.1,
        farPlane: 100,
        fov: Math.PI / 3,
        worldMatrix: identity(),
        worldMatrixVersion: 1,
        children: [],
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
    };
}

function setup() {
    const writeBuffer = vi.fn();
    const writeTexture = vi.fn();
    const device = {
        limits: { maxTextureDimension2D: 8192 },
        queue: { writeBuffer, writeTexture },
        createBuffer: vi.fn(() => ({ destroy: vi.fn() }) as unknown as GPUBuffer),
        createTexture: vi.fn(
            () =>
                ({
                    createView: vi.fn(() => ({}) as GPUTextureView),
                    destroy: vi.fn(),
                }) as unknown as GPUTexture
        ),
    } as unknown as GPUDevice;
    const activeCamera = camera();
    const engine = { canvas: { width: 1024, height: 800 }, _device: device } as unknown as EngineContext;
    const scene = { camera: activeCamera } as unknown as SceneContext;
    return { engine, scene, activeCamera, writeBuffer, writeTexture };
}

describe("clustered light uploads", () => {
    it("compacts inactive lights and uploads only the addressed texture region", () => {
        const { engine, scene, writeBuffer, writeTexture } = setup();
        const container = createClusteredLightContainer();
        createClusteredPointLight(container, { position: [0, 1, 5], diffuse: [1, 1, 1], range: 4, intensity: 2 });
        createClusteredPointLight(container, { position: [1, 1, 5], diffuse: [1, 0, 0], range: 4, intensity: 0 });

        buildClusteredLightGpuState(engine, scene, container);

        const params = writeBuffer.mock.calls.at(-1)![2] as Float32Array;
        expect(new Uint32Array(params.buffer, params.byteOffset, params.length)[3]).toBe(1);
        const extents = writeTexture.mock.calls.map((call) => call[3] as GPUExtent3DDict);
        expect(extents).toContainEqual({ width: 2, height: 1 });
        expect(extents).toContainEqual({ width: 16, height: 1 });
        expect(extents).toContainEqual({ width: 4096, height: 1 });
    });

    it("uploads only light data when color changes without moving cluster topology", () => {
        const { engine, scene, activeCamera, writeBuffer, writeTexture } = setup();
        const container = createClusteredLightContainer();
        const light = createClusteredPointLight(container, { position: [0, 1, 5], diffuse: [1, 1, 1], range: 4, intensity: 2 });
        const state = buildClusteredLightGpuState(engine, scene, container);
        writeBuffer.mockClear();
        writeTexture.mockClear();

        light.diffuse[0] = 0.5;
        markClusteredLightContainerDirty(container);
        state.refresh(activeCamera, 1024, 800);

        expect(writeBuffer).not.toHaveBeenCalled();
        expect(writeTexture).toHaveBeenCalledTimes(1);
        expect(writeTexture.mock.calls[0]![3]).toEqual({ width: 2, height: 1 });
    });

    it("rebuilds topology and light count when lights are removed directly", () => {
        const { engine, scene, activeCamera, writeBuffer, writeTexture } = setup();
        const container = createClusteredLightContainer();
        createClusteredPointLight(container, { position: [0, 1, 5], diffuse: [1, 1, 1], range: 4, intensity: 2 });
        createClusteredPointLight(container, { position: [1, 1, 5], diffuse: [1, 0, 0], range: 4, intensity: 2 });
        const state = buildClusteredLightGpuState(engine, scene, container);
        writeBuffer.mockClear();
        writeTexture.mockClear();

        container.pointLights.pop();
        state.refresh(activeCamera, 1024, 800);

        const params = writeBuffer.mock.calls.at(-1)![2] as Float32Array;
        expect(new Uint32Array(params.buffer, params.byteOffset, params.length)[3]).toBe(1);
        expect(writeTexture).toHaveBeenCalled();
    });
});

/** Tile assignment under an orthographic projection.
 *
 *  `projectedSphereBounds` originally had only a perspective path: it divided the sphere's
 *  rotated silhouette by view depth and read just `proj[0]` / `proj[5]`, ignoring the
 *  off-center translation in `proj[12]` / `proj[13]`. Under an orthographic projection that
 *  produces tile spans that shrink with distance and are not recentred for an off-center
 *  volume, so point lights get binned into the wrong tiles (or none).
 *
 *  The defining orthographic property is that the projected silhouette is depth-independent:
 *  a sphere of a given radius covers the same screen box wherever it sits along the view
 *  axis. That is what these assert, through the public build path rather than the internal
 *  helper. */
describe("clustered light tile assignment under orthographic projection", () => {
    /** The tile-mask upload for one build. The mask is indexed by screen tile (and light
     *  batch), unlike the slice and light-data textures which carry z-ranges and world
     *  positions — so only this payload isolates tile assignment from the light's
     *  coordinates. It is the only single-component texture, i.e. the one whose row stride
     *  is exactly 4 bytes per texel. */
    function tileMask(depth: number, bounds?: { halfHeight?: number; left?: number; right?: number }): number[] {
        const { engine, scene, activeCamera, writeTexture } = setup();
        enableOrthographicCamera(activeCamera, { halfHeight: 8, ...bounds });
        const container = createClusteredLightContainer();
        createClusteredPointLight(container, { position: [0, 0, depth], diffuse: [1, 1, 1], range: 3, intensity: 2 });
        buildClusteredLightGpuState(engine, scene, container);
        const call = writeTexture.mock.calls.find((c) => (c[2] as GPUTexelCopyBufferLayout).bytesPerRow === (c[3] as GPUExtent3DDict).width * 4);
        expect(call, "no single-component (mask) texture upload found — did the upload layout or row padding change?").toBeDefined();
        return Array.from(new Uint32Array(call![1] as ArrayBuffer));
    }

    /** Number of screen tiles the light was binned into. */
    function tileCount(depth: number, bounds?: { halfHeight?: number; left?: number; right?: number }): number {
        return tileMask(depth, bounds).filter((v) => v !== 0).length;
    }

    it("covers a depth-independent, correctly-sized region", () => {
        // The orthographic silhouette is the sphere's own radius scaled by proj[0]/proj[5],
        // independent of view depth. With halfHeight 8 on a 1024x800 target that is a large
        // span; the perspective path divides by depth instead and collapses it to a couple
        // of tiles, so the magnitude assertion is what discriminates the two.
        const near = tileCount(20);
        const far = tileCount(60);
        expect(near).toBe(far);
        expect(near).toBeGreaterThan(100);
    });

    it("still varies with the light's projected size", () => {
        // A much tighter volume magnifies the light, so coverage must grow — proves the
        // comparison above is not passing because the mask is constant.
        expect(tileCount(20, { halfHeight: 2 })).toBeGreaterThan(tileCount(20));
    });

    it("honours an off-center volume's projection offset", () => {
        // proj[12] is non-zero only for an off-center volume. The perspective path ignored it
        // entirely, so a shifted volume produced unshifted coverage. Assert the *direction*:
        // shifting the volume's window to the right (left/right both increase) moves the world
        // origin toward the left of the screen, so the light's tiles must move to lower X.
        const centreTileX = (bounds: { left: number; right: number }) => {
            const mask = tileMask(20, bounds);
            const set = mask.flatMap((v, i) => (v !== 0 ? [i] : []));
            return set.reduce((a, b) => a + b, 0) / set.length;
        };
        expect(centreTileX({ left: -2, right: 14 })).toBeLessThan(centreTileX({ left: -8, right: 8 }));
    });

    it("re-bins after a bound changes on an already-built state", () => {
        // The gate substitution matters only once the state has settled: the earlier cases all
        // build fresh, so they would still pass with the stale `worldMatrixVersion` key.
        const { engine, scene, activeCamera, writeTexture } = setup();
        const ortho = enableOrthographicCamera(activeCamera, { halfHeight: 8 });
        const container = createClusteredLightContainer();
        createClusteredPointLight(container, { position: [0, 0, 20], diffuse: [1, 1, 1], range: 3, intensity: 2 });
        const state = buildClusteredLightGpuState(engine, scene, container);

        state.refresh(activeCamera, 1024, 800);
        writeTexture.mockClear();
        state.refresh(activeCamera, 1024, 800);
        expect(writeTexture, "settled state must not re-upload").not.toHaveBeenCalled();

        ortho.halfHeight = 2;
        state.refresh(activeCamera, 1024, 800);
        expect(writeTexture, "a zoom change must re-bin the light tiles").toHaveBeenCalled();
    });
});
