import { describe, expect, it, vi } from "vitest";

import {
    createSplatStreamRequestManager,
    SplatGpuBudgetPressureError,
    SplatRequestPriority,
    type SplatSourceRequest,
} from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-requests";
import { createSplatStreamGpuLedger } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-gpu-ledger";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function metadata(imagePrefix = "image", count = 1): unknown {
    const codebook = Array.from({ length: 256 }, (_, index) => index);
    return {
        version: 2,
        count,
        means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: [`${imagePrefix}-0.webp`, `${imagePrefix}-1.webp`] },
        scales: { codebook, files: [`${imagePrefix}-2.webp`] },
        quats: { files: [`${imagePrefix}-3.webp`] },
        sh0: { codebook, files: [`${imagePrefix}-4.webp`] },
    };
}

function request(url: string, fileId: number, priority = SplatRequestPriority.Upgrade, generation = 1): SplatSourceRequest {
    return { url, fileId, priority, generation, intervals: [{ offset: 0, count: 1 }] };
}

function response(body: unknown, status = 200, type = "application/json"): Response {
    return new Response(body instanceof Uint8Array ? Uint8Array.from(body).buffer : typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": type },
    });
}

function webp(width = 1, height = 1): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(30);
    bytes.set([82, 73, 70, 70], 0);
    bytes.set([87, 69, 66, 80, 86, 80, 56, 88], 8);
    const write24 = (offset: number, value: number): void => {
        bytes[offset] = value & 255;
        bytes[offset + 1] = (value >>> 8) & 255;
        bytes[offset + 2] = (value >>> 16) & 255;
    };
    write24(24, width - 1);
    write24(27, height - 1);
    return bytes;
}

function gpu(): {
    device: GPUDevice;
    textures: Array<{ destroy: ReturnType<typeof vi.fn> }>;
    buffers: Array<{ destroy: ReturnType<typeof vi.fn> }>;
    copies: Array<[GPUImageCopyExternalImage, GPUImageCopyTextureTagged, GPUExtent3DStrict]>;
} {
    const textures: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    const buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    const copies: Array<[GPUImageCopyExternalImage, GPUImageCopyTextureTagged, GPUExtent3DStrict]> = [];
    const device = {
        createTexture: vi.fn(() => {
            const texture = { destroy: vi.fn() };
            textures.push(texture);
            return texture;
        }),
        createBuffer: vi.fn(() => {
            const buffer = { destroy: vi.fn() };
            buffers.push(buffer);
            return buffer;
        }),
        queue: {
            copyExternalImageToTexture: vi.fn((...args: [GPUImageCopyExternalImage, GPUImageCopyTextureTagged, GPUExtent3DStrict]) => copies.push(args)),
            writeBuffer: vi.fn(),
        },
    } as unknown as GPUDevice;
    return { device, textures, buffers, copies };
}

function bitmap(width = 1, height = 1): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
    return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function standardFetch(calls: string[]): typeof fetch {
    return vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        return url.endsWith("meta.json") ? response(metadata()) : response(webp(), 200, "image/webp");
    }) as unknown as typeof fetch;
}

describe("splat stream transport", () => {
    it("rejects when retained decoded images plus encoded payload and the next bitmap exceed the real CPU peak", async () => {
        const fakeGpu = gpu();
        const encoded = new Uint8Array(768 * 1024);
        encoded.set(webp(512, 512));
        const fetchMock = vi.fn(async (input: string | URL | Request) =>
            String(input).endsWith("meta.json") ? response(metadata("image", 512 * 512)) : response(encoded, 200, "image/webp")
        ) as unknown as typeof fetch;
        const decode = vi.fn(async () => bitmap(512, 512));
        const manager = createSplatStreamRequestManager(1, 1, 5.5 * 1024 * 1024, 0, {
            device: fakeGpu.device,
            fetch: fetchMock,
            decode,
        });
        await expect(manager.request(request("https://a.test/meta.json", 0))).rejects.toThrow("payloads retained by the same preparation");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(decode).not.toHaveBeenCalled();
        expect(manager.cpuBytes).toBe(0);
    });

    it("charges the retained encoded body and every decoded bitmap slot together at decoder entry", async () => {
        const encoded = new Uint8Array(768 * 1024);
        encoded.set(webp(512, 512));
        const fetchMock = vi.fn(async (input: string | URL | Request) =>
            String(input).endsWith("meta.json") ? response(metadata("image", 512 * 512)) : response(encoded, 200, "image/webp")
        ) as unknown as typeof fetch;
        const decoderLedgerBytes: number[] = [];
        const manager = createSplatStreamRequestManager(1, 1, 6 * 1024 * 1024, 0, {
            device: gpu().device,
            fetch: fetchMock,
            decode: async () => {
                decoderLedgerBytes.push(manager.cpuBytes);
                return bitmap(512, 512);
            },
        });
        await manager.request(request("https://a.test/meta.json", 0));
        expect(decoderLedgerBytes).toEqual(Array.from({ length: 5 }, () => 5.75 * 1024 * 1024));
        expect(manager.cpuBytes).toBe(0);
    });

    it("admits concurrent known and streamed payload preparations without retained-byte cycles", async () => {
        const encoded = new Uint8Array(768 * 1024);
        encoded.set(webp(512, 512));
        const firstDecode = deferred<void>();
        let decodeCount = 0;
        const payloadFetches: string[] = [];
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.endsWith("meta.json")) {
                return response(metadata(url.includes("/a/") ? "a" : "b", 512 * 512));
            }
            payloadFetches.push(url);
            if (url.includes("/a/")) {
                return new Response(encoded, {
                    headers: { "content-type": "image/webp", "content-length": String(encoded.byteLength) },
                });
            }
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoded);
                        controller.close();
                    },
                }),
                { headers: { "content-type": "image/webp" } }
            );
        }) as unknown as typeof fetch;
        const manager = createSplatStreamRequestManager(2, 2, 6 * 1024 * 1024, 0, {
            device: gpu().device,
            fetch: fetchMock,
            decode: async () => {
                if (decodeCount++ === 0) {
                    await firstDecode.promise;
                }
                return bitmap(512, 512);
            },
        });
        const a = manager.request(request("https://a.test/a/meta.json", 0));
        const b = manager.request(request("https://a.test/b/meta.json", 1));
        await vi.waitFor(() => expect(decodeCount).toBe(1));
        expect(payloadFetches.some((url) => url.includes("/b/"))).toBe(false);
        firstDecode.resolve();
        await expect(Promise.race([Promise.all([a, b]), new Promise((_, reject) => setTimeout(() => reject(new Error("preparations stalled")), 2000))])).resolves.toHaveLength(2);
        expect(payloadFetches.filter((url) => url.includes("/a/"))).toHaveLength(5);
        expect(payloadFetches.filter((url) => url.includes("/b/"))).toHaveLength(5);
        expect(manager.cpuBytes).toBe(0);
    });

    it("does not let metadata hold the only HTTP slot while the payload-lane owner needs its next image", async () => {
        const image = new Uint8Array(4096);
        image.set(webp(512, 512));
        const firstDecode = deferred<void>();
        let decodeCount = 0;
        const fetches: string[] = [];
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            fetches.push(url);
            if (url.endsWith("meta.json")) {
                const json = JSON.stringify(metadata(url.includes("/a/") ? "a" : "b", 512 * 512));
                const body = url.includes("/b/") ? json.padEnd(8192, " ") : json;
                return new Response(body, {
                    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).byteLength) },
                });
            }
            return new Response(image, {
                headers: { "content-type": "image/webp", "content-length": String(image.byteLength) },
            });
        }) as unknown as typeof fetch;
        const manager = createSplatStreamRequestManager(1, 1, 5 * 1024 * 1024 + image.byteLength, 0, {
            device: gpu().device,
            fetch: fetchMock,
            decode: async () => {
                decodeCount++;
                if (decodeCount === 1) {
                    await firstDecode.promise;
                }
                return bitmap(512, 512);
            },
        });

        const a = manager.request(request("https://a.test/a/meta.json", 0));
        const b = manager.request(request("https://a.test/b/meta.json", 1));
        await vi.waitFor(() => expect(decodeCount).toBe(1));
        expect(fetches).not.toContain("https://a.test/b/meta.json");
        firstDecode.resolve();
        await expect(Promise.race([Promise.all([a, b]), new Promise((_, reject) => setTimeout(() => reject(new Error("preparations stalled")), 2000))])).resolves.toHaveLength(2);
        expect(fetches).toContain("https://a.test/b/meta.json");
        expect(manager.cpuBytes).toBe(0);
    });

    it("does not let a superseded generation signal cancel the replacement job", async () => {
        const firstDecode = deferred<void>();
        let decodeCount = 0;
        const firstController = new AbortController();
        const manager = createSplatStreamRequestManager(2, 2, 10_000, 0, {
            device: gpu().device,
            fetch: standardFetch([]),
            decode: async () => {
                if (decodeCount++ === 0) {
                    await firstDecode.promise;
                }
                return bitmap();
            },
        });
        const first = manager.request({ ...request("https://a.test/meta.json", 0, SplatRequestPriority.Upgrade, 1), signal: firstController.signal });
        await vi.waitFor(() => expect(decodeCount).toBe(1));
        const replacement = manager.request(request("https://a.test/meta.json", 0, SplatRequestPriority.Upgrade, 2));
        firstController.abort();
        firstDecode.resolve();
        await expect(first).rejects.toThrow("aborted");
        await expect(replacement).resolves.toMatchObject({ generation: 2 });
    });

    it("deduplicates resolved URLs and uploads five byte-preserving RGBA8 textures", async () => {
        const calls: string[] = [];
        const fakeGpu = gpu();
        const bitmaps = Array.from({ length: 5 }, () => bitmap());
        const decodeOptions: ImageBitmapOptions[] = [];
        const manager = createSplatStreamRequestManager(2, 2, 10_000, 0, {
            device: fakeGpu.device,
            fetch: standardFetch(calls),
            decode: async (_blob, options) => {
                decodeOptions.push(options);
                return bitmaps.shift()!;
            },
        });
        const first = manager.request(request("https://a.test/path/../meta.json", 0));
        const duplicate = manager.request(request("https://a.test/meta.json", 0, SplatRequestPriority.Bootstrap));
        expect(first).toBe(duplicate);
        const source = await first;

        expect(calls.filter((url) => url.endsWith("meta.json"))).toHaveLength(1);
        expect(source.textures).toHaveLength(5);
        expect(source.gpuBytes).toBe(2068);
        expect(vi.mocked(fakeGpu.device.createTexture).mock.calls.every(([descriptor]) => (descriptor.usage & GPUTextureUsage.RENDER_ATTACHMENT) !== 0)).toBe(true);
        expect(decodeOptions).toEqual(Array.from({ length: 5 }, () => ({ premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" })));
        expect(
            fakeGpu.copies.every(([origin, , rawSize]) => {
                const size = rawSize as GPUExtent3DDictStrict;
                return origin.flipY === false && size.width === 1 && size.height === 1;
            })
        ).toBe(true);
        expect(manager.cpuBytes).toBe(0);
    });

    it("orders queued files by priority while bounding active chunk preparations", async () => {
        const gates = new Map<string, ReturnType<typeof deferred<Response>>>();
        const order: string[] = [];
        const fetchMock = vi.fn((input: string | URL | Request) => {
            const url = String(input);
            order.push(url);
            if (url.endsWith("meta.json")) {
                const gate = deferred<Response>();
                gates.set(url, gate);
                return gate.promise;
            }
            return Promise.resolve(response(webp(), 200, "image/webp"));
        }) as unknown as typeof fetch;
        const manager = createSplatStreamRequestManager(8, 1, 10_000, 0, { device: gpu().device, fetch: fetchMock, decode: async () => bitmap() });
        const a = manager.request(request("https://a.test/a/meta.json", 0));
        const b = manager.request(request("https://a.test/b/meta.json", 1));
        const low = manager.request(request("https://a.test/low/meta.json", 2, SplatRequestPriority.Prefetch));
        const high = manager.request(request("https://a.test/high/meta.json", 3, SplatRequestPriority.Uncovered));
        await Promise.resolve();
        expect(order).toEqual(["https://a.test/a/meta.json"]);
        gates.get("https://a.test/a/meta.json")!.resolve(response(metadata()));
        await a;
        await vi.waitFor(() => expect(order).toContain("https://a.test/high/meta.json"));
        expect(order).not.toContain("https://a.test/b/meta.json");
        expect(order).not.toContain("https://a.test/low/meta.json");
        void b.catch(() => undefined);
        void low.catch(() => undefined);
        void high.catch(() => undefined);
        manager.dispose();
    });

    it("shares HTTP/decode semaphores and serializes CPU admission", async () => {
        let activeHttp = 0;
        let maxHttp = 0;
        let activeDecode = 0;
        let maxDecode = 0;
        const decodeOrder: string[] = [];
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            activeHttp++;
            maxHttp = Math.max(maxHttp, activeHttp);
            await Promise.resolve();
            activeHttp--;
            return url.endsWith("meta.json") ? response(metadata()) : response(webp(15, 10), 200, "image/webp");
        }) as unknown as typeof fetch;
        const manager = createSplatStreamRequestManager(1, 1, 5_000, 0, {
            device: gpu().device,
            fetch: fetchMock,
            decode: async (blob) => {
                activeDecode++;
                maxDecode = Math.max(maxDecode, activeDecode);
                decodeOrder.push(await blob.text());
                await Promise.resolve();
                activeDecode--;
                return bitmap(15, 10);
            },
        });
        await Promise.all([manager.request(request("https://a.test/a/meta.json", 0)), manager.request(request("https://a.test/b/meta.json", 1))]);
        expect(maxHttp).toBe(1);
        expect(maxDecode).toBe(1);
        expect(decodeOrder).toHaveLength(10);
        expect(manager.cpuBytes).toBe(0);
    });

    it("retries transient failures, does not retry terminal responses, and cancels generation-safe work", async () => {
        let attempts = 0;
        const delays: number[] = [];
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("retry") && url.endsWith("meta.json") && attempts++ === 0) {
                return response("", 503);
            }
            if (url.includes("terminal")) {
                return response("", 404);
            }
            return url.endsWith("meta.json") ? response(metadata()) : response(webp(), 200, "image/webp");
        }) as unknown as typeof fetch;
        let currentGeneration = 1;
        const manager = createSplatStreamRequestManager(2, 1, 10_000, 2, {
            device: gpu().device,
            fetch: fetchMock,
            decode: async () => bitmap(),
            delay: async (milliseconds) => {
                delays.push(milliseconds);
            },
            isGenerationCurrent: (_url, generation) => generation === currentGeneration,
        });
        await expect(manager.request(request("https://a.test/retry/meta.json", 7))).resolves.toMatchObject({ generation: 1 });
        expect(attempts).toBe(2);
        expect(delays).toHaveLength(1);
        await expect(manager.request(request("https://a.test/terminal/meta.json", 8))).rejects.toThrow("HTTP 404");

        currentGeneration = 2;
        const stale = manager.request(request("https://a.test/stale/meta.json", 9, SplatRequestPriority.Upgrade, 1));
        await expect(stale).rejects.toMatchObject({ name: "AbortError" });
        manager.dispose();
        manager.dispose();
        await expect(manager.request(request("https://a.test/after/meta.json", 10))).rejects.toThrow("disposed");
    });

    it("closes every bitmap and destroys partial GPU allocations on upload failure", async () => {
        const fakeGpu = gpu();
        const images = Array.from({ length: 5 }, () => bitmap());
        let imageIndex = 0;
        vi.mocked(fakeGpu.device.createTexture).mockImplementation(() => {
            if (fakeGpu.textures.length === 2) {
                throw new Error("device allocation failed");
            }
            const texture = { destroy: vi.fn() };
            fakeGpu.textures.push(texture);
            return texture as unknown as GPUTexture;
        });
        const manager = createSplatStreamRequestManager(2, 2, 10_000, 0, {
            device: fakeGpu.device,
            fetch: standardFetch([]),
            decode: async () => images[imageIndex++]!,
        });
        await expect(manager.request(request("https://a.test/meta.json", 0))).rejects.toThrow("device allocation failed");
        expect(images.every((image) => image.close.mock.calls.length === 1)).toBe(true);
        expect(fakeGpu.textures.every((texture) => texture.destroy.mock.calls.length === 1)).toBe(true);
    });

    it("releases decoded preparation immediately when source GPU admission is temporarily blocked", async () => {
        const fakeGpu = gpu();
        const images = Array.from({ length: 5 }, () => bitmap());
        const reserveGpuBytes = vi.fn(() => false);
        const gpuLedger = createSplatStreamGpuLedger(10_000, (dispose) => dispose());
        const manager = createSplatStreamRequestManager(2, 2, 10_000, 3, {
            device: fakeGpu.device,
            fetch: standardFetch([]),
            decode: async () => images.shift()!,
            reserveGpuBytes,
            gpuLedger,
        });

        await expect(manager.request(request("https://a.test/blocked/meta.json", 0))).rejects.toBeInstanceOf(SplatGpuBudgetPressureError);
        expect(reserveGpuBytes).toHaveBeenCalledTimes(1);
        expect(fakeGpu.textures).toHaveLength(0);
        expect(fakeGpu.buffers).toHaveLength(0);
        expect(images).toHaveLength(0);
        expect(manager.cpuBytes).toBe(0);
        expect(manager.queuedFiles).toBe(0);
        expect(manager.pendingRequests).toBe(0);
    });

    it("requires a GPU ledger whenever custom source reservation is configured", () => {
        expect(() =>
            createSplatStreamRequestManager(1, 1, 10_000, 0, {
                device: gpu().device,
                fetch: standardFetch([]),
                decode: async () => bitmap(),
                reserveGpuBytes: () => true,
            })
        ).toThrow("reserveGpuBytes requires gpuLedger");
    });

    it("rejects an oversized Content-Length before reading the response body", async () => {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls++;
                controller.enqueue(new Uint8Array([1]));
                controller.close();
            },
        });
        const fetchMock = vi.fn(async () => new Response(body, { headers: { "content-length": "10001" } })) as unknown as typeof fetch;
        const manager = createSplatStreamRequestManager(1, 1, 10_000, 0, { device: gpu().device, fetch: fetchMock, decode: async () => bitmap() });
        await expect(manager.request(request("https://a.test/meta.json", 0))).rejects.toThrow("cannot admit 10001 bytes");
        expect(pulls).toBe(1);
        expect(manager.cpuBytes).toBe(0);
    });

    it("bounds unknown-length streamed bodies and reserves decoded dimensions before decode", async () => {
        const decode = vi.fn(async () => bitmap(40, 40));
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.endsWith("meta.json")) {
                return response(metadata());
            }
            return new Response(webp(40, 40).buffer, { headers: { "content-type": "image/webp" } });
        }) as unknown as typeof fetch;
        const manager = createSplatStreamRequestManager(1, 1, 7_000, 0, { device: gpu().device, fetch: fetchMock, decode });
        await expect(manager.request(request("https://a.test/meta.json", 0))).rejects.toThrow("decoded images require 32000 bytes");
        expect(decode).not.toHaveBeenCalled();
        expect(manager.cpuBytes).toBe(0);
    });
});
