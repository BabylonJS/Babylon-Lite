import { beforeEach, describe, expect, it, vi } from "vitest";

const liteMocks = vi.hoisted(() => ({
    enableRectAreaLights: vi.fn(),
    rebuildSceneRenderables: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return { ...actual, ...liteMocks };
});

import type { RectAreaLight as LiteRectAreaLight, SceneContext, Texture2D } from "babylon-lite";

import type { WebGPUEngine } from "../src/engine/engine";
import { RectAreaLight } from "../src/lights/lights";
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
        liteMocks.enableRectAreaLights.mockReset();
        liteMocks.rebuildSceneRenderables.mockReset();
    });

    it("reconciles emission resources and rebuilds scene materials after startup", async () => {
        const lateWork: Array<() => Promise<void>> = [];
        const engine = { _registerLateWork: (work: () => Promise<void>) => lateWork.push(work) } as unknown as WebGPUEngine;
        const liteScene = {} as SceneContext;
        const scene = { _lite: liteScene, _hasStarted: true, getEngine: () => engine } as unknown as Scene;
        const liteLight = { emissionTexture: null } as LiteRectAreaLight;
        const light = Object.create(RectAreaLight.prototype) as RectAreaLight;
        Object.assign(light, { _lite: liteLight, _scene: scene });
        const textureHandle = { width: 1024, height: 1024 } as Texture2D;
        const texture = new ReadyTexture(textureHandle);

        light.emissionTexture = texture;

        expect(liteLight.emissionTexture).toBe(textureHandle);
        expect(lateWork).toHaveLength(1);
        await lateWork[0]!();
        expect(liteMocks.enableRectAreaLights).toHaveBeenCalledWith(liteScene);
        expect(liteMocks.rebuildSceneRenderables).toHaveBeenCalledWith(liteScene);
        expect(liteMocks.enableRectAreaLights.mock.invocationCallOrder[0]).toBeLessThan(liteMocks.rebuildSceneRenderables.mock.invocationCallOrder[0]!);
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
        const engine = { _registerLateWork: (work: () => Promise<void>) => lateWork.push(work) } as unknown as WebGPUEngine;
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
    });
});
