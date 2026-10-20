import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
    scene: { camera: null },
    stream: {
        maxSplats: 1_000_000,
        screenError: 2,
        firstFrameReady: Promise.resolve(),
        stats: {
            phase: "streaming",
            firstFrameMs: 123,
            selectedSplats: 1000,
            visibleLeaves: 2,
            coveredLeaves: 3,
            residentGpuBytes: 1024,
            allocatedGpuBytes: 2048,
            residentFiles: 1,
            pendingRequests: 0,
        },
    },
    gps: {
        colorRenderMode: false,
        pointScale: 1,
        renderScale: "auto" as number | "auto",
        occlusionCulling: false,
        maxAccumFrames: 255,
        progress: null as { renderedFrameCount: number; accumulatedSamples: number; pixelCycleLength: number } | null,
    },
    enable: vi.fn(),
    disable: vi.fn(),
    onBeforeRender: vi.fn(),
    disposeStream: vi.fn(),
}));

vi.mock("../../../packages/babylon-lite/src/index.ts", () => ({
    createEngine: vi.fn(async () => ({})),
    createSceneContext: () => mock.scene,
    loadGaussianSplatStream: vi.fn(async () => mock.stream),
    loadSplatVoxelCollision: () => new Promise(() => {}),
    attachGaussianSplatStream: vi.fn(),
    enableGaussianPointSplatting: mock.enable,
    disableGaussianPointSplatting: mock.disable,
    disposeGaussianSplatStream: mock.disposeStream,
    disposeEngine: vi.fn(),
    disposeScene: vi.fn(),
    onBeforeRender: mock.onBeforeRender,
    registerScene: vi.fn(async () => {}),
    startEngine: vi.fn(async () => {}),
}));
vi.mock("../../../lab/lite/src/demos/trogir-camera", () => ({ createTrogirCamera: () => ({}), attachTrogirCameraControls: vi.fn() }));
vi.mock("../../../lab/lite/src/demos/trogir-streaming-placement", () => ({ placeTrogirStream: vi.fn() }));

class HudElement extends EventTarget {
    value = "";
    checked = false;
    hidden = false;
    open = false;
    max = "";
    textContent = "";
    dataset: Record<string, string> = {};
    classList = { add: vi.fn() };
}

const html = readFileSync(resolve(__dirname, "../../../lab/lite/demo-trogir-streaming.html"), "utf8");
let elements: Map<string, HudElement>;
let page: EventTarget;

async function start(query = ""): Promise<(deltaMs: number) => void> {
    vi.stubGlobal("location", { href: `https://example.test/lite/demo-trogir-streaming.html${query}` });
    await import("../../../lab/lite/src/demos/trogir-streaming");
    await vi.waitFor(() => {
        expect(elements.get("renderCanvas")!.dataset.error).toBeUndefined();
        expect(elements.get("renderCanvas")!.dataset.ready).toBe("true");
    });
    return mock.onBeforeRender.mock.calls[0]![1] as (deltaMs: number) => void;
}

function change(id: string, value: string | boolean, event = "change"): void {
    const element = elements.get(id)!;
    if (typeof value === "boolean") {
        element.checked = value;
    } else {
        element.value = value;
    }
    element.dispatchEvent(new Event(event));
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mock.stream.maxSplats = 1_000_000;
    Object.assign(mock.gps, { colorRenderMode: false, pointScale: 1, renderScale: "auto", occlusionCulling: false, maxAccumFrames: 255, progress: null });
    mock.enable.mockReturnValue(mock.gps);
    elements = new Map();
    for (const match of html.matchAll(/<\w+\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const element = new HudElement();
        element.value = /\bvalue="([^"]+)"/.exec(match[1]!)?.[1] ?? "";
        element.hidden = /\bhidden\b/.test(match[1]!);
        elements.set(match[2]!, element);
    }
    elements.get("renderScale")!.value = "auto";
    page = Object.assign(new EventTarget(), { setTimeout: vi.fn() });
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", { getElementById: (id: string) => elements.get(id) ?? null });
});

afterEach(() => {
    page.dispatchEvent(new Event("pagehide"));
    vi.unstubAllGlobals();
});

describe("Trogir streaming HUD", () => {
    it("starts in classic mode, averages FPS over 500 ms, and preserves stream controls", async () => {
        const frame = await start();
        expect(mock.enable).not.toHaveBeenCalled();
        expect(elements.get("pointSampling")!.checked).toBe(false);
        expect(elements.get("pointSamplingOptions")!.hidden).toBe(true);
        for (let i = 0; i < 25; i++) {
            frame(20);
        }
        expect(elements.get("fps")!.value).toBe("50.0 FPS · 20.0 ms");
        for (let i = 0; i < 10; i++) {
            frame(50);
        }
        expect(elements.get("fps")!.value).toBe("20.0 FPS · 50.0 ms");
        expect(elements.get("selectedSplats")!.value).toBe("1,000");
        change("screenError", "1.25", "input");
        change("splatBudget", "500000", "input");
        expect(mock.stream.screenError).toBe(1.25);
        expect(mock.stream.maxSplats).toBe(500000);
        expect(elements.get("screenErrorValue")!.value).toBe("1.25 px");
        expect(elements.get("splatBudgetValue")!.value).toBe("500k");
    });

    it("retains one handle across toggles, applies all options live, and releases it on pagehide", async () => {
        const frame = await start();
        change("pointSampling", true);
        expect(mock.enable).toHaveBeenCalledExactlyOnceWith(mock.scene, mock.stream, { colorRenderMode: false });
        expect(mock.gps.colorRenderMode).toBe(true);
        expect(elements.get("pointSamplingOptions")!.hidden).toBe(false);
        expect(mock.gps.renderScale).toBe("auto");
        change("pointScale", "2.5", "input");
        change("occlusionCulling", true);
        change("maxAccumFrames", "64", "input");
        expect(mock.gps).toMatchObject({ pointScale: 2.5, occlusionCulling: true, maxAccumFrames: 64 });
        expect(elements.get("pointScaleValue")!.value).toBe("2.5×");
        expect(elements.get("maxAccumFramesValue")!.value).toBe("64");
        for (const divisor of ["1", "2", "3", "4"]) {
            change("renderScale", divisor);
            expect(mock.gps.renderScale).toBe(Number(divisor));
            expect(html).toContain(`<option value="${divisor}">${divisor === "1" ? "1 (full)" : `1/${divisor}`}</option>`);
        }
        frame(16);
        expect(elements.get("accumulatedFrames")!.value).toBe("—");
        mock.gps.progress = { renderedFrameCount: 1024, accumulatedSamples: 64, pixelCycleLength: 16 };
        frame(16);
        expect(elements.get("accumulatedFrames")!.value).toBe("64 / 64");
        expect(elements.get("pixelCycleLength")!.value).toBe("16 frames");
        change("pointSampling", false);
        expect(mock.gps.colorRenderMode).toBe(false);
        expect(elements.get("pointSamplingOptions")!.hidden).toBe(true);
        change("pointSampling", true);
        expect(mock.enable).toHaveBeenCalledOnce();
        expect(mock.gps.colorRenderMode).toBe(true);
        expect(mock.gps.pointScale).toBe(2.5);
        page.dispatchEvent(new Event("pagehide"));
        expect(mock.disable).toHaveBeenCalledExactlyOnceWith(mock.scene, mock.gps);
        expect(mock.disable.mock.invocationCallOrder[0]).toBeLessThan(mock.disposeStream.mock.invocationCallOrder[0]!);
        change("pointSampling", false);
        change("pointScale", "3", "input");
        expect(mock.gps.colorRenderMode).toBe(true);
        expect(mock.gps.pointScale).toBe(2.5);
    });

    it("supports startup opt-in and returning to automatic render scale", async () => {
        await start("?points=1");
        expect(mock.enable).toHaveBeenCalledOnce();
        expect(mock.gps.colorRenderMode).toBe(true);
        expect(elements.get("pointSamplingOptions")!.hidden).toBe(false);
        change("renderScale", "3");
        change("renderScale", "auto");
        expect(mock.gps.renderScale).toBe("auto");
    });
});
