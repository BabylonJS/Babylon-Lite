import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LottieFile } from "../src/animation/lottie-raw.js";
import { resolveImageAssetUrls } from "../src/player/full-player.js";
import type { createController as CreateController } from "../src/worker/controller.js";
import type { WorkerInbound, WorkerOutbound } from "../src/worker/protocol.js";
import { runLottieWorker } from "../src/worker/dispatch.js";

const controller = vi.hoisted(() => ({
    createController: vi.fn<typeof CreateController>(() => ({}) as ReturnType<typeof CreateController>),
    disposeController: vi.fn(),
    resizeController: vi.fn(),
    startController: vi.fn(),
}));

vi.mock("../src/worker/controller.js", () => controller);

const file = { v: "5.7.0", w: 200, h: 100, ip: 0, op: 10, fr: 30, layers: [] } as unknown as LottieFile;
let post: ReturnType<typeof vi.fn<(message: WorkerOutbound) => void>>;
let dispatch: (event: MessageEvent) => Promise<void>;

beforeEach(() => {
    post = vi.fn();
    vi.stubGlobal("self", { onmessage: null });
    vi.stubGlobal("postMessage", post);
    controller.createController.mockReset().mockReturnValue({} as ReturnType<typeof CreateController>);
    controller.disposeController.mockReset();
    controller.resizeController.mockReset();
    controller.startController.mockReset();
    runLottieWorker(vi.fn(), resolveImageAssetUrls);
    dispatch = (self.onmessage as (event: MessageEvent) => Promise<void>).bind(self);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function send(message: WorkerInbound): Promise<void> {
    return dispatch({ data: message } as MessageEvent);
}

describe("worker dispatch", () => {
    it("reports HTTP failures without shipping error text", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

        await send({ type: "load", url: "https://example.test/missing.json" });

        expect(post).toHaveBeenCalledWith({ type: "error" });
    });

    it("reports fetch exceptions with the compact signal", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network details")));

        await send({ type: "load", url: "https://example.test/animation.json" });

        expect(post).toHaveBeenCalledWith({ type: "error" });
    });

    it("reports JSON parse exceptions with the compact signal", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockRejectedValue(new Error("parse details")) }));

        await send({ type: "load", url: "https://example.test/animation.json" });

        expect(post).toHaveBeenCalledWith({ type: "error" });
    });

    it("reports invalid starts and controller failures with the compact signal", async () => {
        await send({ type: "start", canvas: {} as OffscreenCanvas, displayWidth: 100, displayHeight: 50, devicePixelRatio: 1, loop: true });
        controller.createController.mockImplementationOnce(() => {
            throw new Error("WebGL details");
        });
        await send({ type: "start", canvas: {} as OffscreenCanvas, file, displayWidth: 100, displayHeight: 50, devicePixelRatio: 1, loop: true });
        controller.startController.mockImplementationOnce(() => {
            throw new Error("render loop details");
        });
        await send({ type: "start", canvas: {} as OffscreenCanvas, file, displayWidth: 100, displayHeight: 50, devicePixelRatio: 1, loop: true });

        expect(post).toHaveBeenNthCalledWith(1, { type: "error" });
        expect(post).toHaveBeenNthCalledWith(2, { type: "error" });
        expect(post).toHaveBeenNthCalledWith(3, { type: "error" });
    });

    it("loads, starts, and reports the first rendered frame", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(file) }));

        await send({ type: "load", url: "https://example.test/animation.json" });
        await send({ type: "start", canvas: {} as OffscreenCanvas, displayWidth: 100, displayHeight: 50, devicePixelRatio: 1, loop: true });
        const onFirstRender = controller.createController.mock.calls[0]?.[7] as () => void;
        onFirstRender();

        expect(post).toHaveBeenNthCalledWith(1, { type: "size", width: 200, height: 100 });
        expect(controller.startController).toHaveBeenCalledOnce();
        expect(post).toHaveBeenNthCalledWith(2, { type: "firstRender" });
    });

    it("resolves external image assets relative to the final animation URL", async () => {
        const imageFile = {
            ...file,
            assets: [
                { id: "external", w: 16, h: 16, u: "images/", p: "pattern.png" },
                { id: "embedded", w: 1, h: 1, p: "data:image/png;base64,AA==", e: 1 },
            ],
        } as LottieFile;
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, url: "https://cdn.example.test/animations/scene.json", json: vi.fn().mockResolvedValue(imageFile) }));

        await send({ type: "load", url: "https://example.test/scene.json" });
        await send({ type: "start", canvas: {} as OffscreenCanvas, displayWidth: 100, displayHeight: 50, devicePixelRatio: 1, loop: true });

        const loaded = controller.createController.mock.calls[0]?.[1] as LottieFile;
        expect(loaded.assets?.[0]).toMatchObject({ u: "", p: "https://cdn.example.test/animations/images/pattern.png" });
        expect(loaded.assets?.[1]).toMatchObject({ p: "data:image/png;base64,AA==" });
    });
});
