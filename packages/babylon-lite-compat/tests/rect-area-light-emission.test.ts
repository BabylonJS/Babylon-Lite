import { beforeEach, describe, expect, it, vi } from "vitest";

const liteMocks = vi.hoisted(() => ({
    addToScene: vi.fn(),
    enableRectAreaLights: vi.fn(),
    rebuildSceneRenderables: vi.fn(),
    removeFromScene: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return { ...actual, ...liteMocks };
});

import type { RectAreaLight as LiteRectAreaLight, SceneContext, Texture2D } from "babylon-lite";

import type { WebGPUEngine } from "../src/engine/engine";
import { PointLight, RectAreaLight } from "../src/lights/lights";
import { Vector3 } from "../src/math/vector";
import type { Scene } from "../src/scene/scene";
import { BaseTexture } from "../src/textures/textures";

class ReadyTexture extends BaseTexture {
    public constructor(texture: Texture2D) {
        super();
        this._lite = texture;
    }

    public whenReadyAsync(): Promise<void> {
        return Promise.resolve();
    }
}

describe("RectAreaLight emission texture", () => {
    beforeEach(() => {
        liteMocks.addToScene.mockReset();
        liteMocks.enableRectAreaLights.mockReset();
        liteMocks.rebuildSceneRenderables.mockReset();
        liteMocks.removeFromScene.mockReset();
    });

    it("reconciles receiver pipelines when a solid area light is added after startup", async () => {
        const lateWork: Array<() => Promise<void>> = [];
        const engine = {
            _registerLateWork: (work: () => Promise<void>) => lateWork.push(work),
            _pauseForSceneMutation: vi.fn(),
            _resumeAfterSceneMutation: vi.fn(),
        } as unknown as WebGPUEngine;
        const liteScene = {} as SceneContext;
        const scene = {
            _lite: liteScene,
            _hasStarted: true,
            _registerLight: vi.fn(),
            getEngine: () => engine,
        } as unknown as Scene;

        const light = new RectAreaLight("panel", new Vector3(0, 1, 0), 2, 3, scene);

        expect(liteMocks.addToScene).not.toHaveBeenCalled();
        expect(lateWork).toHaveLength(1);
        await lateWork[0]!();
        expect(liteMocks.addToScene).toHaveBeenCalledWith(liteScene, light._lite);
        expect(liteMocks.enableRectAreaLights).toHaveBeenCalledWith(liteScene);
        expect(liteMocks.rebuildSceneRenderables).toHaveBeenCalledWith(liteScene);
    });

    it("reconciles emission slots when an area light is disposed after startup", async () => {
        const lateWork: Array<() => Promise<void>> = [];
        const engine = {
            _registerLateWork: (work: () => Promise<void>) => lateWork.push(work),
            _pauseForSceneMutation: vi.fn(),
            _resumeAfterSceneMutation: vi.fn(),
        } as unknown as WebGPUEngine;
        const liteScene = {} as SceneContext;
        const scene = {
            _lite: liteScene,
            _hasStarted: true,
            _registerLight: vi.fn(),
            _unregisterNode: vi.fn(),
            getEngine: () => engine,
        } as unknown as Scene;
        const light = new RectAreaLight("panel", new Vector3(0, 1, 0), 2, 3, scene);
        await lateWork.shift()!();
        liteMocks.enableRectAreaLights.mockClear();
        liteMocks.rebuildSceneRenderables.mockClear();

        light.dispose();

        expect(liteMocks.removeFromScene).not.toHaveBeenCalled();
        expect(lateWork).toHaveLength(1);
        await lateWork[0]!();
        expect(liteMocks.removeFromScene).toHaveBeenCalledWith(liteScene, light._lite);
        expect(liteMocks.enableRectAreaLights).toHaveBeenCalledWith(liteScene);
        expect(liteMocks.rebuildSceneRenderables).toHaveBeenCalledWith(liteScene);
    });

    it("reconciles textured emission mappings when a preceding non-area light is disposed", async () => {
        const lateWork: Array<() => Promise<void>> = [];
        const engine = {
            _registerLateWork: (work: () => Promise<void>) => lateWork.push(work),
            _pauseForSceneMutation: vi.fn(),
            _resumeAfterSceneMutation: vi.fn(),
        } as unknown as WebGPUEngine;
        const liteScene = { lights: [] } as unknown as SceneContext;
        const scene = {
            _lite: liteScene,
            _hasStarted: false,
            _registerLight: vi.fn(),
            _unregisterNode: vi.fn(),
            getEngine: () => engine,
        } as unknown as Scene;
        const point = new PointLight("point", new Vector3(0, 1, 0), scene);
        const area = new RectAreaLight("panel", new Vector3(0, 1, 0), 2, 3, scene);
        const textureHandle = { width: 1024, height: 1024 } as Texture2D;
        area.emissionTexture = new ReadyTexture(textureHandle);
        liteScene.lights.push(point._lite, area._lite);
        (scene as unknown as { _hasStarted: boolean })._hasStarted = true;

        point.dispose();

        expect(liteMocks.removeFromScene).not.toHaveBeenCalled();
        expect(lateWork).toHaveLength(1);
        await lateWork[0]!();
        expect(liteMocks.removeFromScene).toHaveBeenCalledWith(liteScene, point._lite);
        expect(liteMocks.enableRectAreaLights).toHaveBeenCalledWith(liteScene);
        expect(liteMocks.rebuildSceneRenderables).toHaveBeenCalledWith(liteScene);
    });

    it("defers callback-driven light removal until the active frame has finished", async () => {
        const lateWork: Array<() => Promise<void>> = [];
        const calls: string[] = [];
        const engine = {
            _lite: { _currentEncoder: {} },
            _registerLateWork: (work: () => Promise<void>) => lateWork.push(work),
            _pauseForSceneMutation: vi.fn(() => calls.push("pause")),
            _resumeAfterSceneMutation: vi.fn(() => {
                calls.push("resume");
                return Promise.resolve();
            }),
        } as unknown as WebGPUEngine;
        const liteScene = { lights: [] } as unknown as SceneContext;
        const scene = {
            _lite: liteScene,
            _hasStarted: false,
            _registerLight: vi.fn(),
            _unregisterNode: vi.fn(),
            getEngine: () => engine,
        } as unknown as Scene;
        const point = new PointLight("point", new Vector3(0, 1, 0), scene);
        const area = new RectAreaLight("panel", new Vector3(0, 1, 0), 2, 3, scene);
        area.emissionTexture = new ReadyTexture({ width: 1024, height: 1024 } as Texture2D);
        liteScene.lights.push(point._lite, area._lite);
        (scene as unknown as { _hasStarted: boolean })._hasStarted = true;
        liteMocks.removeFromScene.mockImplementation(() => calls.push("remove"));

        point.dispose();

        expect(liteMocks.removeFromScene).not.toHaveBeenCalled();
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(calls).toEqual([]);
        expect(lateWork).toHaveLength(1);
        await lateWork[0]!();
        expect(calls).toEqual(["pause", "remove", "resume"]);
        expect(liteMocks.enableRectAreaLights).toHaveBeenCalledWith(liteScene);
        expect(liteMocks.rebuildSceneRenderables).toHaveBeenCalledWith(liteScene);
    });

    it("leaves area-light topology reconciliation to the startup build before the scene starts", () => {
        const registerLateWork = vi.fn();
        const liteScene = {} as SceneContext;
        const scene = {
            _lite: liteScene,
            _hasStarted: false,
            _registerLight: vi.fn(),
            getEngine: () => ({ _registerLateWork: registerLateWork }) as unknown as WebGPUEngine,
        } as unknown as Scene;

        new RectAreaLight("panel", new Vector3(0, 1, 0), 2, 3, scene);

        expect(registerLateWork).not.toHaveBeenCalled();
    });

    it("reconciles emission resources and rebuilds scene materials after startup", async () => {
        const lateWork: Array<() => Promise<void>> = [];
        const engine = {
            _registerLateWork: (work: () => Promise<void>) => lateWork.push(work),
            _pauseForSceneMutation: vi.fn(),
            _resumeAfterSceneMutation: vi.fn(),
        } as unknown as WebGPUEngine;
        const liteScene = {} as SceneContext;
        const scene = { _lite: liteScene, _hasStarted: true, getEngine: () => engine } as unknown as Scene;
        const liteLight = { emissionTexture: null } as LiteRectAreaLight;
        const light = Object.create(RectAreaLight.prototype) as RectAreaLight;
        Object.assign(light, { _lite: liteLight, _scene: scene });
        const textureHandle = { width: 1024, height: 1024 } as Texture2D;
        const texture = new ReadyTexture(textureHandle);

        light.emissionTexture = texture;

        expect(liteLight.emissionTexture).toBeNull();
        expect(lateWork).toHaveLength(1);
        await lateWork[0]!();
        expect(liteLight.emissionTexture).toBe(textureHandle);
        expect(liteMocks.enableRectAreaLights).toHaveBeenCalledWith(liteScene);
        expect(liteMocks.rebuildSceneRenderables).toHaveBeenCalledWith(liteScene);
        expect(liteMocks.enableRectAreaLights.mock.invocationCallOrder[0]).toBeLessThan(liteMocks.rebuildSceneRenderables.mock.invocationCallOrder[0]!);
        expect(engine._pauseForSceneMutation).toHaveBeenCalledOnce();
        expect(engine._resumeAfterSceneMutation).toHaveBeenCalledOnce();
    });

    it("reconciles solid-to-textured, replacement, and clear transitions on one running light", async () => {
        const lateWork: Array<() => Promise<void>> = [];
        const engine = {
            _registerLateWork: (work: () => Promise<void>) => lateWork.push(work),
            _pauseForSceneMutation: vi.fn(),
            _resumeAfterSceneMutation: vi.fn(),
        } as unknown as WebGPUEngine;
        const liteScene = {} as SceneContext;
        const scene = { _lite: liteScene, _hasStarted: true, getEngine: () => engine } as unknown as Scene;
        const liteLight = { emissionTexture: null } as LiteRectAreaLight;
        const light = Object.create(RectAreaLight.prototype) as RectAreaLight;
        Object.assign(light, { _lite: liteLight, _scene: scene });
        const firstHandle = { width: 1024, height: 1024, id: "first" } as unknown as Texture2D;
        const secondHandle = { width: 1024, height: 1024, id: "second" } as unknown as Texture2D;

        light.emissionTexture = new ReadyTexture(firstHandle);
        await lateWork.shift()!();
        expect(liteLight.emissionTexture).toBe(firstHandle);

        light.emissionTexture = new ReadyTexture(secondHandle);
        await lateWork.shift()!();
        expect(liteLight.emissionTexture).toBe(secondHandle);

        light.emissionTexture = null;
        await lateWork.shift()!();
        expect(liteLight.emissionTexture).toBeNull();
        expect(liteMocks.enableRectAreaLights).toHaveBeenCalledTimes(3);
        expect(liteMocks.rebuildSceneRenderables).toHaveBeenCalledTimes(3);
        expect(engine._pauseForSceneMutation).toHaveBeenCalledTimes(3);
        expect(engine._resumeAfterSceneMutation).toHaveBeenCalledTimes(3);
    });

    it("defers reconciliation to the startup build before the scene starts", () => {
        const registerLateWork = vi.fn();
        const scene = {
            _lite: {} as SceneContext,
            _hasStarted: false,
            getEngine: () => ({ _registerLateWork: registerLateWork }) as unknown as WebGPUEngine,
        } as unknown as Scene;
        const liteLight = { emissionTexture: null } as LiteRectAreaLight;
        const light = Object.create(RectAreaLight.prototype) as RectAreaLight;
        Object.assign(light, { _lite: liteLight, _scene: scene });
        const textureHandle = { width: 1024, height: 1024 } as Texture2D;

        light.emissionTexture = new ReadyTexture(textureHandle);

        expect(liteLight.emissionTexture).toBe(textureHandle);
        expect(registerLateWork).not.toHaveBeenCalled();
    });

    it("coalesces overlapping updates and retries the latest assignment after stale preparation fails", async () => {
        const lateWork: Array<() => Promise<void>> = [];
        const engine = {
            _registerLateWork: (work: () => Promise<void>) => lateWork.push(work),
            _pauseForSceneMutation: vi.fn(),
            _resumeAfterSceneMutation: vi.fn(),
        } as unknown as WebGPUEngine;
        const liteScene = {} as SceneContext;
        const scene = { _lite: liteScene, _hasStarted: true, getEngine: () => engine } as unknown as Scene;
        const firstLiteLight = { emissionTexture: null } as LiteRectAreaLight;
        const firstLight = Object.create(RectAreaLight.prototype) as RectAreaLight;
        Object.assign(firstLight, { _lite: firstLiteLight, _scene: scene });
        const latestLiteLight = { emissionTexture: null } as LiteRectAreaLight;
        const latestLight = Object.create(RectAreaLight.prototype) as RectAreaLight;
        Object.assign(latestLight, { _lite: latestLiteLight, _scene: scene });
        const firstHandle = { width: 1024, height: 1024, id: "first" } as unknown as Texture2D;
        const latestHandle = { width: 1024, height: 1024, id: "latest" } as unknown as Texture2D;
        let rejectFirst!: (error: Error) => void;
        liteMocks.enableRectAreaLights
            .mockImplementationOnce(
                () =>
                    new Promise<void>((_resolve, reject) => {
                        rejectFirst = reject;
                    })
            )
            .mockResolvedValueOnce(undefined);
        liteMocks.rebuildSceneRenderables.mockResolvedValue(undefined);

        firstLight.emissionTexture = new ReadyTexture(firstHandle);
        const reconciliation = lateWork[0]!();
        await vi.waitFor(() => expect(liteMocks.enableRectAreaLights).toHaveBeenCalledTimes(1));

        latestLight.emissionTexture = new ReadyTexture(latestHandle);
        expect(lateWork).toHaveLength(1);
        rejectFirst(new Error("stale area-light preparation"));

        await reconciliation;
        expect(firstLiteLight.emissionTexture).toBe(firstHandle);
        expect(latestLiteLight.emissionTexture).toBe(latestHandle);
        expect(liteMocks.enableRectAreaLights).toHaveBeenCalledTimes(2);
        expect(liteMocks.rebuildSceneRenderables).toHaveBeenCalledTimes(1);
        expect(engine._pauseForSceneMutation).toHaveBeenCalledOnce();
        expect(engine._resumeAfterSceneMutation).toHaveBeenCalledOnce();
    });

    it("keeps rendering paused while a pending reconciliation absorbs an area-light removal", async () => {
        const lateWork: Array<() => Promise<void>> = [];
        const calls: string[] = [];
        const engine = {
            _registerLateWork: (work: () => Promise<void>) => lateWork.push(work),
            _pauseForSceneMutation: vi.fn(() => calls.push("pause")),
            _resumeAfterSceneMutation: vi.fn(() => {
                calls.push("resume");
                return Promise.resolve();
            }),
        } as unknown as WebGPUEngine;
        const liteScene = { lights: [] } as unknown as SceneContext;
        const scene = {
            _lite: liteScene,
            _hasStarted: false,
            _registerLight: vi.fn(),
            _unregisterNode: vi.fn(),
            getEngine: () => engine,
        } as unknown as Scene;
        const light = new RectAreaLight("panel", new Vector3(0, 1, 0), 2, 3, scene);
        const textureHandle = { width: 1024, height: 1024 } as Texture2D;
        liteScene.lights.push(light._lite);
        (scene as unknown as { _hasStarted: boolean })._hasStarted = true;
        let resolveFirst!: () => void;
        liteMocks.enableRectAreaLights
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        calls.push("prepare-1");
                        resolveFirst = resolve;
                    })
            )
            .mockImplementationOnce(() => {
                calls.push("prepare-2");
                return Promise.resolve();
            });
        liteMocks.rebuildSceneRenderables.mockImplementation(() => {
            calls.push("rebuild");
            return Promise.resolve();
        });

        light.emissionTexture = new ReadyTexture(textureHandle);
        const reconciliation = lateWork[0]!();
        await vi.waitFor(() => expect(calls).toContain("prepare-1"));

        light.dispose();
        expect(lateWork).toHaveLength(1);
        resolveFirst();
        await reconciliation;

        expect(calls).toEqual(["pause", "prepare-1", "rebuild", "prepare-2", "rebuild", "resume"]);
        expect(liteMocks.removeFromScene).toHaveBeenCalledWith(liteScene, light._lite);
    });
});
