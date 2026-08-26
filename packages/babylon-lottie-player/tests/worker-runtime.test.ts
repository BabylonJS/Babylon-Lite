import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LottieFile } from "../src/animation/lottie-raw.js";
import { createLottieWorkerPlayer } from "../src/standalone.js";
import { createWorkerPlayer, disposeWorkerPlayer, playWorkerAnimationAsync, type LottieWorkerInput } from "../src/client/runtime.js";

const NativeURL = URL;

class FakeCanvas {
    public readonly style: Record<string, string> = {};
    public parentNode: FakeContainer | null = null;
    public readonly offscreen = { kind: "offscreen" };

    public transferControlToOffscreen(): OffscreenCanvas {
        return this.offscreen as unknown as OffscreenCanvas;
    }
}

class FakeContainer {
    public readonly children: FakeCanvas[] = [];

    public constructor(
        public clientWidth: number,
        public clientHeight: number
    ) {}

    public appendChild(canvas: FakeCanvas): void {
        canvas.parentNode = this;
        this.children.push(canvas);
    }

    public removeChild(canvas: FakeCanvas): void {
        const index = this.children.indexOf(canvas);
        if (index !== -1) {
            this.children.splice(index, 1);
        }
        canvas.parentNode = null;
    }
}

class FakeResizeObserver {
    public static instances: FakeResizeObserver[] = [];
    public observed: unknown = null;
    public disconnected = false;

    public constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this);
    }

    public observe(target: unknown): void {
        this.observed = target;
    }

    public disconnect(): void {
        this.disconnected = true;
    }

    public notify(): void {
        this.callback([], this as unknown as ResizeObserver);
    }
}

class FakeWorker {
    public onmessage: ((event: MessageEvent) => void) | null = null;
    public onerror: ((event: ErrorEvent) => void) | null = null;
    public onmessageerror: ((event: MessageEvent) => void) | null = null;
    public readonly messages: { message: Record<string, unknown>; transfer?: Transferable[] }[] = [];
    public terminated = false;

    public postMessage(message: Record<string, unknown>, transfer?: Transferable[]): void {
        this.messages.push({ message, transfer });
    }

    public terminate(): void {
        this.terminated = true;
    }

    public emit(message: Record<string, unknown>): void {
        this.onmessage?.({ data: message } as MessageEvent);
    }
}

function animation(width = 200, height = 100): LottieFile {
    return { v: "5.7.0", w: width, h: height, ip: 0, op: 10, fr: 30, layers: [] } as unknown as LottieFile;
}

function input(container: FakeContainer, source: string | LottieFile, onFirstRender?: () => void, onError?: () => void): LottieWorkerInput {
    return {
        container: container as unknown as HTMLElement,
        animationSource: source,
        onFirstRender,
        onError,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    FakeResizeObserver.instances.length = 0;
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("HTMLCanvasElement", FakeCanvas);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("document", { createElement: () => new FakeCanvas() });
    vi.stubGlobal("location", { href: "https://example.test/app/index.html" });
    vi.stubGlobal("self", { location: { href: "https://example.test/app/index.html" } });
    vi.stubGlobal("window", {
        devicePixelRatio: 2,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("worker runtime", () => {
    it("loads a URL in the worker, contain-fits after size, resizes, and disposes", async () => {
        const worker = new FakeWorker();
        const container = new FakeContainer(300, 100);
        const firstRender = vi.fn();
        const player = createWorkerPlayer(() => worker as unknown as Worker);

        await expect(playWorkerAnimationAsync(player, input(container, "./animation.json", firstRender))).resolves.toBe(true);
        expect(worker.messages[0]?.message).toEqual({ type: "load", url: "https://example.test/app/animation.json" });

        worker.emit({ type: "size", width: 200, height: 100 });
        const canvas = container.children[0]!;
        expect(canvas.style).toEqual({ width: "200px", height: "100px" });
        expect(worker.messages[1]?.message).toMatchObject({
            type: "start",
            canvas: canvas.offscreen,
            displayWidth: 200,
            displayHeight: 100,
            devicePixelRatio: 2,
            loop: true,
        });
        expect(worker.messages[1]?.transfer).toEqual([canvas.offscreen]);

        container.clientWidth = 100;
        container.clientHeight = 100;
        FakeResizeObserver.instances[0]!.notify();
        await vi.runAllTimersAsync();
        expect(worker.messages.at(-1)?.message).toEqual({ type: "resize", displayWidth: 100, displayHeight: 50, devicePixelRatio: 2 });

        worker.emit({ type: "firstRender" });
        expect(firstRender).toHaveBeenCalledOnce();

        const messageCount = worker.messages.length;
        disposeWorkerPlayer(player);
        expect(worker.messages).toHaveLength(messageCount);
        expect(worker.terminated).toBe(true);
        expect(container.children).toHaveLength(0);
        expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true);
    });

    it("starts an inline document immediately and forwards options", async () => {
        const worker = new FakeWorker();
        const container = new FakeContainer(100, 100);
        const file = animation();
        const player = createWorkerPlayer(() => worker as unknown as Worker);

        await expect(
            playWorkerAnimationAsync(player, {
                ...input(container, file),
                loop: false,
                variables: { title: "Localized" },
            })
        ).resolves.toBe(true);

        expect(worker.messages).toHaveLength(1);
        expect(worker.messages[0]?.message).toMatchObject({
            type: "start",
            file,
            displayWidth: 100,
            displayHeight: 50,
            loop: false,
            variables: { title: "Localized" },
        });
    });

    it("rejects a second play while a URL is still loading", async () => {
        const worker = new FakeWorker();
        const container = new FakeContainer(100, 100);
        const player = createWorkerPlayer(() => worker as unknown as Worker);

        await expect(playWorkerAnimationAsync(player, input(container, "./first.json"))).resolves.toBe(true);
        await expect(playWorkerAnimationAsync(player, input(container, "./second.json"))).resolves.toBe(false);

        expect(worker.messages).toHaveLength(1);
        expect(worker.messages[0]?.message).toMatchObject({ url: "https://example.test/app/first.json" });
    });

    it("reports worker errors and disposes a partially started player", async () => {
        const worker = new FakeWorker();
        const container = new FakeContainer(100, 100);
        const onError = vi.fn();
        const player = createWorkerPlayer(() => worker as unknown as Worker);

        await playWorkerAnimationAsync(player, input(container, animation(), undefined, onError));
        expect(container.children).toHaveLength(1);
        worker.emit({ type: "error" });

        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith();
        expect(worker.terminated).toBe(true);
        expect(container.children).toHaveLength(0);

        worker.emit({ type: "error" });
        worker.onerror?.({} as ErrorEvent);
        expect(onError).toHaveBeenCalledOnce();
    });

    it("disposes before invoking application error code", async () => {
        const worker = new FakeWorker();
        const container = new FakeContainer(100, 100);
        const player = createWorkerPlayer(() => worker as unknown as Worker);

        await playWorkerAnimationAsync(
            player,
            input(container, animation(), undefined, () => {
                throw new Error("application callback");
            })
        );

        expect(() => worker.emit({ type: "error" })).toThrow("application callback");
        expect(worker.terminated).toBe(true);
        expect(container.children).toHaveLength(0);
    });

    it.each(["onerror", "onmessageerror"] as const)("reports native worker failures from %s", async (eventName) => {
        const worker = new FakeWorker();
        const onError = vi.fn();
        const player = createWorkerPlayer(() => worker as unknown as Worker);

        await playWorkerAnimationAsync(player, input(new FakeContainer(100, 100), "./animation.json", undefined, onError));
        if (eventName === "onerror") {
            worker.onerror?.({} as ErrorEvent);
        } else {
            worker.onmessageerror?.({} as MessageEvent);
        }

        expect(onError).toHaveBeenCalledOnce();
        expect(worker.terminated).toBe(true);
    });

    it("does not play after disposal", async () => {
        const spawn = vi.fn(() => new FakeWorker() as unknown as Worker);
        const player = createWorkerPlayer(spawn);

        disposeWorkerPlayer(player);

        await expect(playWorkerAnimationAsync(player, input(new FakeContainer(100, 100), animation()))).resolves.toBe(false);
        expect(spawn).not.toHaveBeenCalled();
    });

    it("creates the standalone player from an explicit classic worker URL", async () => {
        let createdBlob: Blob | MediaSource | undefined;
        const createObjectURL = vi.fn((blob: Blob | MediaSource) => {
            createdBlob = blob;
            return "blob:worker";
        });
        const revokeObjectURL = vi.fn((_url: string) => {});
        const workers: BrowserWorker[] = [];
        class FakeURL extends NativeURL {
            public static createObjectURL = createObjectURL;
            public static revokeObjectURL = revokeObjectURL;
        }
        class FakeBlob {
            public constructor(
                public readonly parts: string[],
                public readonly options: BlobPropertyBag
            ) {}
        }
        class BrowserWorker extends FakeWorker {
            public constructor(public readonly url: string) {
                super();
                workers.push(this);
            }
        }
        vi.stubGlobal("URL", FakeURL);
        vi.stubGlobal("Blob", FakeBlob);
        vi.stubGlobal("Worker", BrowserWorker);

        const player = createLottieWorkerPlayer({ workerUrl: "./render.worker.js" });
        const container = new FakeContainer(100, 100);
        await expect(playWorkerAnimationAsync(player, input(container, animation()))).resolves.toBe(true);
        const blob = createdBlob as unknown as FakeBlob;
        expect(blob.parts.join("")).toContain("https://example.test/app/render.worker.js");
        expect(blob.parts.join("")).toContain("importScripts");
        expect(blob.options).toEqual({ type: "text/javascript" });
        expect(workers[0]?.url).toBe("blob:worker");
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:worker");
        expect(workers[0]!.messages[0]?.message).toMatchObject({ type: "start" });
        disposeWorkerPlayer(player);
        expect(workers[0]!.terminated).toBe(true);
    });
});
