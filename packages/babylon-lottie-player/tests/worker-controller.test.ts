import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LottieFile } from "../src/animation/lottie-raw.js";
import { createController } from "../src/worker/controller.js";

const mocks = vi.hoisted(() => ({
    createVectorEngine: vi.fn(() => ({ canvas: {} })),
    renderLottieFrame: vi.fn(),
    runRenderLoop: vi.fn(),
    setGLEngineSize: vi.fn(),
}));

vi.mock("@babylonjs/lite-gl", () => ({
    runRenderLoop: mocks.runRenderLoop,
    setGLEngineSize: mocks.setGLEngineSize,
}));

vi.mock("../src/player/player-core.js", () => ({
    createVectorEngine: mocks.createVectorEngine,
    isPlayerReady: vi.fn(() => true),
    renderLottieFrame: mocks.renderLottieFrame,
}));

const file = { v: "5.7.0", w: 200, h: 100, ip: 0, op: 10, fr: 30, layers: [] } as unknown as LottieFile;

describe("worker controller readiness", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("signals first render only after a frame is drawn", () => {
        mocks.renderLottieFrame.mockReturnValueOnce(false).mockReturnValue(true);
        const onFirstRender = vi.fn();
        const controller = createController(
            {} as OffscreenCanvas,
            file,
            vi.fn(() => ({}) as never),
            200,
            100,
            1,
            true,
            onFirstRender
        );

        controller.tick();
        expect(onFirstRender).not.toHaveBeenCalled();

        controller.tick();
        controller.tick();
        expect(onFirstRender).toHaveBeenCalledOnce();
    });

    it("passes asynchronous resource failures to the player factory", () => {
        const factory = vi.fn(() => ({}) as never);
        const onError = vi.fn();

        createController({} as OffscreenCanvas, file, factory, 200, 100, 1, true, undefined, undefined, onError);

        expect(factory).toHaveBeenCalledWith(expect.anything(), file, { variables: undefined }, onError);
    });
});
