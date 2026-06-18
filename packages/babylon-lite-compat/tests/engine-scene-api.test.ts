import { describe, expect, it } from "vitest";

import { WebGPUEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";

/**
 * The Engine/Scene compat wrappers add Babylon.js-shaped accessors that don't
 * need a GPU device to verify: the scalar engine getters (derived from the
 * canvas / last frame delta) and the scene entity registries
 * (`cameras`/`lights`/`materials` + the `getXByName` lookups). These tests
 * exercise that pure logic on prototype-backed instances, mirroring the
 * GPU-free style of the scene-graph hierarchy tests.
 */

/** A Scene instance with just the registry fields the tested methods touch. */
function fakeScene(): Scene {
    const scene = Object.create(Scene.prototype) as Scene & {
        _cameras: unknown[];
        _lights: unknown[];
        _materials: unknown[];
        _trackedMeshes: unknown[];
    };
    scene._cameras = [];
    scene._lights = [];
    scene._materials = [];
    scene._trackedMeshes = [];
    return scene;
}

/** A WebGPUEngine instance with just the fields the tested getters read. */
function fakeEngine(canvas: { width: number; height: number }, deltaMs: number): WebGPUEngine {
    const engine = Object.create(WebGPUEngine.prototype) as WebGPUEngine & { _canvas: unknown; _lastDeltaMs: number };
    (engine as unknown as { _canvas: unknown })._canvas = canvas;
    engine._lastDeltaMs = deltaMs;
    return engine;
}

describe("WebGPUEngine scalar getters", () => {
    it("derives render width/height/aspect from the canvas", () => {
        const engine = fakeEngine({ width: 800, height: 600 }, 16);
        expect(engine.getRenderWidth()).toBe(800);
        expect(engine.getRenderHeight()).toBe(600);
        expect(engine.getScreenAspectRatio()).toBeCloseTo(800 / 600);
        expect(engine.getAspectRatio()).toBeCloseTo(800 / 600);
    });

    it("reports WebGPU and a hardware-scaling parity level", () => {
        const engine = fakeEngine({ width: 1, height: 1 }, 16);
        expect(engine.isWebGPU).toBe(true);
        engine.setHardwareScalingLevel(0.5);
        expect(engine.getHardwareScalingLevel()).toBe(0.5);
    });

    it("computes fps from the last frame delta", () => {
        expect(fakeEngine({ width: 1, height: 1 }, 20).getFps()).toBeCloseTo(50);
        // A zero delta (before the first frame) falls back to 60.
        expect(fakeEngine({ width: 1, height: 1 }, 0).getFps()).toBe(60);
    });

    it("derives compressed-texture caps from the WebGPU device features", () => {
        const engine = fakeEngine({ width: 1, height: 1 }, 16) as WebGPUEngine & { _lite: unknown };
        (engine as unknown as { _lite: unknown })._lite = { _device: { features: new Set(["texture-compression-bc", "texture-compression-etc2"]) } };
        const caps = engine.getCaps();
        expect(caps.s3tc).toBe(true);
        expect(caps.bc7).toBe(true);
        expect(caps.astc).toBe(false);
        expect(caps.etc2).toBe(true);
        // ETC1 has no WebGPU feature flag — never reported as available, even when
        // ETC2 (which can decode ETC1 content) is present.
        expect(caps.etc1).toBe(false);
        // WebGPU baseline flags are always reported.
        expect(caps.textureFloat).toBe(true);
        expect(caps.uintIndices).toBe(true);
    });

    it("reports all compressed caps off when there is no device (NullEngine)", () => {
        const engine = fakeEngine({ width: 1, height: 1 }, 16) as WebGPUEngine & { _lite: unknown };
        (engine as unknown as { _lite: unknown })._lite = {};
        const caps = engine.getCaps();
        expect(caps.s3tc).toBe(false);
        expect(caps.astc).toBe(false);
        expect(caps.etc2).toBe(false);
        expect(caps.etc1).toBe(false);
    });
});

describe("Scene entity registries", () => {
    it("registers and looks up cameras by name", () => {
        const scene = fakeScene();
        const cam = { name: "main" } as never;
        scene._registerCamera(cam);
        scene._registerCamera(cam); // de-duped
        expect(scene.cameras).toEqual([cam]);
        expect(scene.getCameraByName("main")).toBe(cam);
        expect(scene.getCameraByName("nope")).toBeNull();
    });

    it("registers and looks up lights and materials by name", () => {
        const scene = fakeScene();
        const light = { name: "sun" } as never;
        const mat = { name: "steel" } as never;
        scene._registerLight(light);
        scene._registerMaterial(mat);
        expect(scene.lights).toEqual([light]);
        expect(scene.materials).toEqual([mat]);
        expect(scene.getLightByName("sun")).toBe(light);
        expect(scene.getMaterialByName("steel")).toBe(mat);
    });

    it("drops nodes and materials from their registries on unregister", () => {
        const scene = fakeScene();
        const cam = { name: "c" } as never;
        const light = { name: "l" } as never;
        const mat = { name: "m" } as never;
        scene._registerCamera(cam);
        scene._registerLight(light);
        scene._registerMaterial(mat);
        scene._unregisterNode(cam);
        scene._unregisterNode(light);
        scene._unregisterMaterial(mat);
        expect(scene.cameras).toEqual([]);
        expect(scene.lights).toEqual([]);
        expect(scene.materials).toEqual([]);
    });

    it("finds tracked meshes via getMeshByName / getNodeByName", () => {
        const scene = fakeScene();
        const mesh = { name: "box" } as never;
        (scene as unknown as { _trackedMeshes: unknown[] })._trackedMeshes.push(mesh);
        expect(scene.getMeshByName("box")).toBe(mesh);
        expect(scene.getMeshByName("missing")).toBeNull();
        expect(scene.getNodeByName("box")).toBe(mesh);
    });

    it("finds tracked meshes by id via getMeshById / getMeshByID (legacy alias)", () => {
        const scene = fakeScene();
        const mesh = { name: "dragon", id: "dragonLR" } as never;
        (scene as unknown as { _trackedMeshes: unknown[] })._trackedMeshes.push(mesh);
        expect(scene.getMeshById("dragonLR")).toBe(mesh);
        expect(scene.getMeshByID("dragonLR")).toBe(mesh);
        expect(scene.getMeshById("missing")).toBeNull();
    });

    it("finds cameras / lights / materials / nodes by id", () => {
        const scene = fakeScene();
        const cam = { name: "c", id: "cam-1" } as never;
        const light = { name: "l", id: "light-1" } as never;
        const mat = { name: "m", id: "mat-1" } as never;
        scene._registerCamera(cam);
        scene._registerLight(light);
        scene._registerMaterial(mat);
        expect(scene.getCameraById("cam-1")).toBe(cam);
        expect(scene.getLightById("light-1")).toBe(light);
        expect(scene.getMaterialById("mat-1")).toBe(mat);
        expect(scene.getNodeById("cam-1")).toBe(cam);
        expect(scene.getNodeById("light-1")).toBe(light);
        expect(scene.getCameraById("missing")).toBeNull();
    });

    it("reports its class name and a unique id", () => {
        const a = fakeScene() as Scene & { uniqueId: number };
        const b = fakeScene() as Scene & { uniqueId: number };
        a.uniqueId = 1;
        b.uniqueId = 2;
        expect(a.getClassName()).toBe("Scene");
        expect(a.getUniqueId()).toBe(1);
        expect(b.getUniqueId()).toBe(2);
    });
});
