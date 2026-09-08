import { createHeadlessCanvas, encodePng, installHeadlessKtx2Transcoder, installHeadlessWebGpu, installImageDecoder, type HeadlessGpu } from "@knervous/shado/devtools";
import { createCanvas as createRasterCanvas, ImageData as RasterImageData } from "@napi-rs/canvas";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import sharp from "sharp";
import { createServer, type Plugin, type ViteDevServer } from "vite";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const LAB_ROOT = path.join(REPO_ROOT, "lab");
const LITE_BUILD_ROOT = path.join(REPO_ROOT, "packages/babylon-lite/build/lib");
const LITE_MODULE_URL = pathToFileURL(path.join(LITE_BUILD_ROOT, "index.js")).href;
const VIRTUAL_LITE_MODULE = "\0shado-parity-lite";
const ROW_ALIGNMENT = 256;

interface HeadlessCanvasContext {
    texture: GPUTexture | null;
}

interface TestCanvas {
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    dataset: Record<string, string>;
    style: Record<string, string>;
    _context: HeadlessCanvasContext;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    removeAttribute(name: string): void;
    setAttribute(name: string, value: string): void;
}

interface TestEngine {
    _device: GPUDevice;
}

interface LiteRuntime {
    disposeEngine(engine: TestEngine): void;
    stopEngine(engine: TestEngine): void;
}

interface TestGlobals {
    __shadoParityEngines?: TestEngine[];
}

interface HeadlessImageBitmap extends Uint8Array {
    height: number;
    width: number;
}

class BrowserWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((error: Error) => void) | null = null;
    readonly #worker: NodeWorker;

    constructor(url: string | URL, options?: { name?: string }) {
        const sourceUrl = String(url);
        const prefix = "data:text/javascript;charset=utf-8,";
        if (!sourceUrl.startsWith(prefix)) {
            // Vite's inline worker wrapper catches this and retries with a data URL.
            throw new Error(`Unsupported headless worker URL: ${sourceUrl}`);
        }
        const workerSource = decodeURIComponent(sourceUrl.slice(prefix.length));
        const bootstrap = `
            const { parentPort } = require("node:worker_threads");
            globalThis.self = globalThis;
            globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
            parentPort.on("message", (data) => globalThis.onmessage?.({ data }));
        `;
        this.#worker = new NodeWorker(`${bootstrap}\n${workerSource}`, { eval: true, name: options?.name });
        this.#worker.on("message", (data: unknown) => this.onmessage?.({ data }));
        this.#worker.on("error", (error) => {
            const workerError = error instanceof Error ? error : new Error(String(error));
            if (this.onerror) {
                this.onerror(workerError);
            } else {
                console.error(workerError);
            }
        });
    }

    addEventListener(type: string, listener: (event: Error) => void): void {
        if (type === "error") {
            this.#worker.on("error", listener);
        }
    }

    postMessage(message: unknown, transferList: Transferable[] = []): void {
        this.#worker.postMessage(
            message,
            transferList.filter((item): item is ArrayBuffer => item instanceof ArrayBuffer)
        );
    }

    removeEventListener(type: string, listener: (event: Error) => void): void {
        if (type === "error") {
            this.#worker.off("error", listener);
        }
    }

    terminate(): void {
        void this.#worker.terminate();
    }
}

export interface ShadoSceneResult {
    actualPath: string;
    dataset: Record<string, string>;
}

export interface ShadoSceneOptions {
    clipHeight?: number;
    clipWidth?: number;
    height?: number;
    query?: string;
    settleMs?: number;
    timeoutMs?: number;
    waitFlag?: string;
    width?: number;
}

let server: ViteDevServer | null = null;
let headlessGpu: HeadlessGpu | null = null;
let lite: LiteRuntime | null = null;
let serverOrigin = "";
let originalFetch: typeof fetch | null = null;

function bindMember(target: object, property: PropertyKey): unknown {
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
}

function isHeadlessImageBitmap(value: unknown): value is HeadlessImageBitmap {
    return value instanceof Uint8Array && typeof Reflect.get(value, "width") === "number" && typeof Reflect.get(value, "height") === "number";
}

function liteAliasPlugin(): Plugin {
    return {
        name: "shado-parity-lite-alias",
        enforce: "pre",
        resolveId(id) {
            if (id === "babylon-lite") {
                return VIRTUAL_LITE_MODULE;
            }
            if (id.startsWith("babylon-lite/")) {
                const relativePath = id.slice("babylon-lite/".length);
                return path.join(LITE_BUILD_ROOT, path.extname(relativePath) ? relativePath : `${relativePath}.js`);
            }
            return null;
        },
        load(id) {
            if (id !== VIRTUAL_LITE_MODULE) {
                return null;
            }
            return `
                export * from ${JSON.stringify(LITE_MODULE_URL)};
                import { createEngine as createEngineBase } from ${JSON.stringify(LITE_MODULE_URL)};
                export async function createEngine(...args) {
                    const engine = await createEngineBase(...args);
                    (globalThis.__shadoParityEngines ??= []).push(engine);
                    return engine;
                }
            `;
        },
    };
}

function decorateCanvas(canvas: TestCanvas): TestCanvas {
    const attributes = new Map<string, string>();
    canvas.dataset = {};
    canvas.style = {};
    canvas.getAttribute = (name) => attributes.get(name) ?? null;
    canvas.hasAttribute = (name) => attributes.has(name);
    canvas.removeAttribute = (name) => attributes.delete(name);
    canvas.setAttribute = (name, value) => attributes.set(name, String(value));
    return canvas;
}

function createRasterCanvasElement(): TestCanvas {
    const canvas = createRasterCanvas(1, 1);
    return new Proxy(canvas, {
        set(target, property, value) {
            return Reflect.set(target, property, value, target);
        },
        get(target, property) {
            if (property !== "getContext") {
                return bindMember(target, property);
            }
            return (contextId: string, options?: unknown) => {
                const context = Reflect.apply(target.getContext, target, [contextId, options]);
                if (contextId !== "2d" || !context) {
                    return context;
                }
                return new Proxy(context, {
                    set(contextTarget, contextProperty, value) {
                        return Reflect.set(contextTarget, contextProperty, value, contextTarget);
                    },
                    get(contextTarget, contextProperty) {
                        if (contextProperty !== "drawImage") {
                            return bindMember(contextTarget, contextProperty);
                        }
                        return (image: unknown, ...args: unknown[]) => {
                            if (!isHeadlessImageBitmap(image)) {
                                return Reflect.apply(contextTarget.drawImage, contextTarget, [image, ...args]);
                            }
                            const source = createRasterCanvas(image.width, image.height);
                            const sourceContext = source.getContext("2d");
                            const pixels = new Uint8ClampedArray(image.buffer, image.byteOffset, image.byteLength);
                            sourceContext.putImageData(new RasterImageData(pixels, image.width, image.height), 0, 0);
                            return Reflect.apply(contextTarget.drawImage, contextTarget, [source, ...args]);
                        };
                    },
                });
            };
        },
    }) as unknown as TestCanvas;
}

function installDom(canvas: TestCanvas, query: string): void {
    const listeners = new EventTarget();
    const createElement = (tagName: string): Record<string, unknown> => {
        if (tagName.toLowerCase() === "canvas") {
            return decorateCanvas(createRasterCanvasElement()) as unknown as Record<string, unknown>;
        }
        return {
            style: {},
            dataset: {},
            appendChild: () => {},
            remove: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            setAttribute: () => {},
            click: () => {},
        };
    };
    const body = {
        style: {},
        appendChild: () => {},
        removeChild: () => {},
    };
    const documentShim = {
        body,
        documentElement: body,
        createElement,
        getElementById: (id: string) => (id === "renderCanvas" ? canvas : null),
        querySelector: (selector: string) => (selector === "canvas" || selector === "#renderCanvas" ? canvas : null),
        addEventListener: listeners.addEventListener.bind(listeners),
        removeEventListener: listeners.removeEventListener.bind(listeners),
    };

    Object.defineProperty(globalThis, "document", { configurable: true, value: documentShim });
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: {
            href: `${serverOrigin}/scene.html${query}`,
            origin: serverOrigin,
            pathname: "/scene.html",
            search: query,
        },
    });
    Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 1 });
    Object.assign(globalThis, {
        addEventListener: listeners.addEventListener.bind(listeners),
        removeEventListener: listeners.removeEventListener.bind(listeners),
        Worker: BrowserWorker,
    });
}

async function waitForFlag(canvas: TestCanvas, flag: string, deadline: number, timeoutMs: number): Promise<void> {
    while (canvas.dataset[flag] !== "true") {
        if (canvas.dataset.error) {
            throw new Error(canvas.dataset.error);
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms waiting for canvas.dataset.${flag}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function captureCanvas(engine: TestEngine, canvas: TestCanvas): Promise<Uint8Array> {
    const texture = canvas._context.texture;
    if (!texture) {
        throw new Error("The headless canvas has no configured texture");
    }

    lite!.stopEngine(engine);
    await engine._device.queue.onSubmittedWorkDone();

    const bytesPerRow = Math.ceil((canvas.width * 4) / ROW_ALIGNMENT) * ROW_ALIGNMENT;
    const buffer = engine._device.createBuffer({
        size: bytesPerRow * canvas.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
        const encoder = engine._device.createCommandEncoder({ label: "shado-parity-readback" });
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: canvas.height }, { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 });
        engine._device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);

        const mapped = new Uint8Array(buffer.getMappedRange());
        const rgba = new Uint8Array(canvas.width * canvas.height * 4);
        const rowBytes = canvas.width * 4;
        for (let y = 0; y < canvas.height; y++) {
            rgba.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
        }
        buffer.unmap();

        for (let i = 0; i < rgba.length; i += 4) {
            const red = rgba[i]!;
            rgba[i] = rgba[i + 2]!;
            rgba[i + 2] = red;
        }
        return rgba;
    } finally {
        buffer.destroy();
    }
}

export async function startShadoSceneRunner(): Promise<void> {
    if (server) {
        return;
    }

    headlessGpu = await installHeadlessWebGpu();
    await installHeadlessKtx2Transcoder();
    installImageDecoder(async (bytes) => {
        const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return {
            width: info.width,
            height: info.height,
            data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        };
    });
    lite = (await import(LITE_MODULE_URL)) as LiteRuntime;

    server = await createServer({
        configFile: false,
        root: LAB_ROOT,
        appType: "custom",
        plugins: [liteAliasPlugin()],
        optimizeDeps: {
            noDiscovery: true,
        },
        server: {
            host: "127.0.0.1",
            port: 0,
        },
    });
    await server.listen();
    serverOrigin = server.resolvedUrls?.local[0]?.replace(/\/$/, "") ?? "";
    if (!serverOrigin) {
        throw new Error("Vite did not expose a local server URL");
    }

    originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
        if (typeof input === "string" && input.startsWith("/")) {
            return originalFetch!(`${serverOrigin}${input}`, init);
        }
        if (input instanceof URL && input.origin === "http://localhost") {
            return originalFetch!(new URL(`${input.pathname}${input.search}`, serverOrigin), init);
        }
        return originalFetch!(input, init);
    };
}

export async function stopShadoSceneRunner(): Promise<void> {
    if (originalFetch) {
        globalThis.fetch = originalFetch;
        originalFetch = null;
    }
    await server?.close();
    server = null;
    headlessGpu?.dispose();
    headlessGpu = null;
    lite = null;
}

export async function renderShadoScene(sceneId: number, outputPath: string, options: ShadoSceneOptions = {}): Promise<ShadoSceneResult> {
    if (!server || !lite) {
        throw new Error("The Shado scene runner has not been started");
    }

    const query = options.query ?? "";
    const timeoutMs = options.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    const canvas = decorateCanvas(createHeadlessCanvas(options.width ?? 1280, options.height ?? 720) as unknown as TestCanvas);
    installDom(canvas, query);

    const globals = globalThis as typeof globalThis & TestGlobals;
    globals.__shadoParityEngines = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
        const detail = args.find((value): value is Error => value instanceof Error) ?? args[0];
        canvas.dataset.error ??= detail instanceof Error ? detail.message : String(detail);
        originalConsoleError(...args);
    };

    try {
        await server.ssrLoadModule(`/lite/src/lite/scene${sceneId}.ts?shado=${Date.now()}`);
        await waitForFlag(canvas, "ready", deadline, timeoutMs);
        if (options.waitFlag) {
            await waitForFlag(canvas, options.waitFlag, deadline, timeoutMs);
        }
        await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 100));

        const engine = globals.__shadoParityEngines.at(-1);
        if (!engine) {
            throw new Error(`Scene ${sceneId} did not create a Babylon Lite engine`);
        }
        const rgba = await captureCanvas(engine, canvas);
        const clipWidth = options.clipWidth ?? canvas.width;
        const clipHeight = options.clipHeight ?? canvas.height;
        if (clipWidth < canvas.width || clipHeight < canvas.height) {
            for (let y = 0; y < canvas.height; y++) {
                const clippedRowStart = (y * canvas.width + Math.min(clipWidth, canvas.width)) * 4;
                const clippedRowEnd = (y + 1) * canvas.width * 4;
                rgba.fill(0, y >= clipHeight ? y * canvas.width * 4 : clippedRowStart, clippedRowEnd);
            }
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, encodePng(rgba, canvas.width, canvas.height));
        return {
            actualPath: outputPath,
            dataset: { ...canvas.dataset },
        };
    } finally {
        console.error = originalConsoleError;
        for (const engine of globals.__shadoParityEngines) {
            lite.disposeEngine(engine);
        }
        globals.__shadoParityEngines = [];
    }
}
