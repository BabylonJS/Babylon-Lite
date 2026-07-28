import { afterEach, describe, expect, it, vi } from "vitest";

const lite = vi.hoisted(() => ({
    createEngine: vi.fn(),
    startEngine: vi.fn(),
    stopEngine: vi.fn(),
    resizeEngine: vi.fn(),
    setEngineSize: vi.fn(),
    disposeEngine: vi.fn(),
    registerScene: vi.fn(),
    registerSceneWithShadowSupport: vi.fn(),
    onBeforeRender: vi.fn(),
    createNullEngine: vi.fn(),
    stepScene: vi.fn(),
    VERSION: "test-version",
}));

vi.mock("babylon-lite", () => lite);

import { WebGPUEngine } from "../src/engine/engine";
import { Logger } from "../src/misc/misc-utils";

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("engine startup error reporting", () => {
    it("reports registerScene rejections through Logger.Error and the optional startup hook", async () => {
        const startupError = new Error("registerScene failed");
        lite.registerScene.mockRejectedValueOnce(startupError);

        const loggerError = vi.spyOn(Logger, "Error").mockImplementation(() => {});
        const engine = new WebGPUEngine({ width: 1, height: 1 } as never);
        (engine as unknown as { _initialized: boolean; _lite: unknown })._initialized = true;
        (engine as unknown as { _initialized: boolean; _lite: unknown })._lite = {};

        const scene = {
            _lite: {},
            _buildShadowGenerators: vi.fn(),
            _parseNodeMaterials: vi.fn().mockResolvedValue(undefined),
            _awaitPendingTextures: vi.fn().mockResolvedValue(undefined),
            _bakeGroundUvs: vi.fn(),
            _flushPendingAdds: vi.fn(),
            _buildMorphTargets: vi.fn(),
            _loadPendingEnvironment: vi.fn().mockResolvedValue(undefined),
            _hasShadows: vi.fn(() => false),
        };
        (engine as unknown as { _scenes: unknown[] })._scenes.push(scene);

        const reported = new Promise<unknown>((resolve) => {
            engine.onStartupError = resolve;
        });

        engine.runRenderLoop(() => {});

        await expect(reported).resolves.toBe(startupError);
        expect(lite.registerScene).toHaveBeenCalledWith(scene._lite);
        expect(loggerError).toHaveBeenCalledTimes(1);
        expect(loggerError.mock.calls[0]?.[0]).toContain("WebGPUEngine.runRenderLoop startup failed");
        expect(loggerError.mock.calls[0]?.[0]).toContain("Error: registerScene failed");
    });
});
