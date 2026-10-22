import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
    enable: vi.fn(),
    disable: vi.fn(),
    disposeEngine: vi.fn(),
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
    onBeforeRender: vi.fn(),
}));

vi.mock("../../../packages/babylon-lite/src/index.ts", () => ({
    createEngine: vi.fn(async () => ({})),
    createSceneContext: () => mock.scene,
    loadGaussianSplatStream: vi.fn(async () => mock.stream),
    loadSplatVoxelCollision: () => new Promise(() => {}),
    attachGaussianSplatStream: vi.fn(),
    enableGaussianPointSplatting: mock.enable,
    disableGaussianPointSplatting: mock.disable,
    disposeGaussianSplatStream: vi.fn(),
    disposeEngine: mock.disposeEngine,
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
    textContent = "";
    dataset: Record<string, string> = {};
    classList = { add: vi.fn() };
}

const html = readFileSync(resolve(__dirname, "../../../lab/lite/demo-trogir-streaming.html"), "utf8");
let elements: Map<string, HudElement>;
let page: EventTarget;

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mock.enable.mockImplementation(() => {
        throw new RangeError("Unsupported point buffer size");
    });
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

describe("Trogir unsupported point activation", () => {
    it.each(["", "?points=1"])("keeps classic streaming alive and permits retry after activation failure (%s)", async (query) => {
        vi.stubGlobal("location", { href: `https://example.test/lite/demo-trogir-streaming.html${query}` });
        await import("../../../lab/lite/src/demos/trogir-streaming");
        const canvas = elements.get("renderCanvas")!;
        await vi.waitFor(() => expect(canvas.dataset.ready).toBe("true"));
        const checkbox = elements.get("pointSampling")!;
        if (!query) {
            checkbox.checked = true;
            expect(() => checkbox.dispatchEvent(new Event("change"))).not.toThrow();
        }
        expect(mock.enable).toHaveBeenCalledOnce();
        expect(checkbox.checked).toBe(false);
        expect(elements.get("pointSamplingOptions")!.hidden).toBe(true);
        expect(elements.get("pointSamplingStatus")!.hidden).toBe(false);
        expect(elements.get("pointSamplingStatus")!.textContent).toContain("Unsupported point buffer size");
        expect(elements.get("pointSamplingStatus")!.textContent).toContain("Classic rendering remains active");
        expect(canvas.dataset.error).toBeUndefined();
        expect(mock.disposeEngine).not.toHaveBeenCalled();
        const frame = mock.onBeforeRender.mock.calls[0]![1] as (delta: number) => void;
        expect(() => frame(16)).not.toThrow();
        expect(canvas.dataset.streamPhase).toBe("streaming");
        const handle = { colorRenderMode: false, progress: null };
        mock.enable.mockReturnValue(handle);
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event("change"));
        expect(handle.colorRenderMode).toBe(true);
        expect(elements.get("pointSamplingStatus")!.hidden).toBe(true);
        expect(elements.get("pointSamplingOptions")!.hidden).toBe(false);
        page.dispatchEvent(new Event("pagehide"));
        expect(mock.disable).toHaveBeenCalledWith(mock.scene, handle);
    });
});
