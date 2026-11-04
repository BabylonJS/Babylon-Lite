import type { LoadUsdOptions, UsdBinaryInput, UsdExtraction, UsdProgress } from "./usd-types.js";
import { usdAbortable } from "./usd-abort.js";

type WorkerResponse =
    | ({ type: "result"; requestId: number } & UsdExtraction)
    | { type: "progress"; requestId: number; progress: UsdProgress }
    | { type: "log"; requestId: number; level: number; message: string }
    | { type: "error"; requestId: number; message: string };

/** @internal Normalize virtual file paths without collapsing meaningful directories. */
export function usdPath(path: string): string {
    const value = path.replace(/\\/g, "/");
    const parts = value.split("/").filter((part) => part && part !== ".");
    if (!parts.length || value.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(value) || parts.includes("..") || value.includes("\0")) {
        throw new Error(`USD file path must be relative: ${path}`);
    }
    return parts.join("/");
}

async function readBytes(input: UsdBinaryInput, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    signal?.throwIfAborted();
    if (input instanceof Blob) {
        return new Uint8Array(await usdAbortable(input.arrayBuffer(), signal));
    }
    if (ArrayBuffer.isView(input)) {
        const bytes = new Uint8Array(input.byteLength);
        bytes.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
        return bytes;
    }
    return new Uint8Array(input.slice(0));
}

/** @internal Stage a self-contained asset or explicitly supplied file set and run the shared worker. */
export async function extractUsd(source: string | UsdBinaryInput, options: LoadUsdOptions): Promise<UsdExtraction> {
    const { signal } = options;
    signal?.throwIfAborted();
    options.onProgress?.({ phase: "fetching", message: "Reading USD files..." });
    let input: UsdBinaryInput = typeof source === "string" ? new ArrayBuffer(0) : source;
    let inferredName = typeof File !== "undefined" && source instanceof File ? source.name : "";
    if (typeof source === "string") {
        const response = await fetch(source, { signal });
        if (!response.ok) {
            throw new Error(`Could not load USD: HTTP ${response.status}`);
        }
        input = await response.arrayBuffer();
        inferredName = decodeURIComponent(new URL(source, globalThis.location?.href ?? "http://localhost/").pathname.split("/").pop() ?? "");
    }
    const bytes = await readBytes(input, signal);
    const suppliedName = options.rootFileName ?? inferredName;
    const extension = bytes[0] === 0x50 && bytes[1] === 0x4b ? "usdz" : bytes[0] === 0x50 && bytes[1] === 0x58 ? "usdc" : "usd";
    const fileName = usdPath(/\.(usd|usda|usdc|usdz)$/i.test(suppliedName) ? suppliedName : `${suppliedName || "scene"}.${extension}`);
    const files: Record<string, Uint8Array<ArrayBuffer>> = Object.create(null);
    for (const [path, contents] of Object.entries(options.files ?? {})) {
        const normalized = usdPath(path);
        if (normalized === fileName || Object.hasOwn(files, normalized)) {
            throw new Error(`Duplicate USD virtual file: ${normalized}`);
        }
        files[normalized] = await readBytes(contents, signal);
    }
    signal?.throwIfAborted();
    const location = globalThis.location;
    const base = new URL((options.runtimeBaseUrl ?? "https://cdn.babylonjs.com/babylonUsdImporter/5/").replace(/\/?$/, "/"), location?.href ?? "http://localhost/");
    const runtimeUrl = (name: string) => new URL(`babylon-usd-importer${name}`, base).href;
    let bootstrap: string | undefined;
    let worker: Worker | undefined;
    try {
        let workerUrl = runtimeUrl(".worker.js");
        if (location && new URL(workerUrl).origin !== location.origin) {
            bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(workerUrl)};`], { type: "application/javascript" }));
            workerUrl = bootstrap;
        }
        worker = new Worker(workerUrl, { type: "module" });
        const extraction = new Promise<UsdExtraction>((resolve, reject) => {
            worker!.addEventListener("error", (event) => reject(new Error(event.message || "USD worker failed")));
            worker!.addEventListener("messageerror", () => reject(new Error("Invalid USD worker message")));
            worker!.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
                const response = event.data;
                if (!response || typeof response !== "object" || response.requestId !== 1) {
                    reject(new Error("Unexpected USD worker response"));
                    return;
                }
                try {
                    switch (response.type) {
                        case "result":
                            resolve(response);
                            break;
                        case "error":
                            reject(new Error(response.message));
                            break;
                        case "progress":
                            options.onProgress?.(response.progress);
                            break;
                        case "log":
                            options.onLog?.(response.level >= 2 ? "error" : response.level === 1 ? "warning" : "info", response.message);
                            break;
                        default:
                            reject(new Error("Unknown USD worker response type"));
                            break;
                    }
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
            worker!.postMessage(
                {
                    type: "extract",
                    requestId: 1,
                    asset: {
                        bytes,
                        fileName,
                        files,
                        resolveByFileName: options.resolveByFileName ?? true,
                        glueUrl: runtimeUrl(".js"),
                        wasmUrl: runtimeUrl(".wasm"),
                        dataUrl: runtimeUrl(".data"),
                    },
                },
                [bytes.buffer, ...Object.values(files).map((file) => file.buffer)]
            );
        });
        return await usdAbortable(extraction, signal);
    } finally {
        worker?.terminate();
        if (bootstrap) {
            URL.revokeObjectURL(bootstrap);
        }
    }
}
