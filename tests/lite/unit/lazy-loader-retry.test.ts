import { afterEach, describe, expect, it, vi } from "vitest";

interface ScriptMock {
    src: string;
    onload?: () => void;
    onerror?: () => void;
    remove(): void;
}

function installScriptDocument(onAppend: (script: ScriptMock) => void): void {
    vi.stubGlobal("document", {
        createElement: () => ({ src: "", async: false, remove: vi.fn() }),
        head: { appendChild: onAppend },
    });
}

afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
});

describe("lazy decoder retries", () => {
    it("retries meshopt script loading after a transient failure", async () => {
        const scripts: ScriptMock[] = [];
        let fail = true;
        installScriptDocument((script) => {
            scripts.push(script);
            queueMicrotask(() => {
                if (fail) {
                    script.onerror?.();
                } else {
                    vi.stubGlobal("MeshoptDecoder", { ready: Promise.resolve(), decodeGltfBuffer: () => undefined });
                    script.onload?.();
                }
            });
        });
        const decoder = await import("../../../packages/babylon-lite/src/loader-gltf/meshopt-decode.js");

        await expect(decoder.getMeshoptDecoder()).rejects.toThrow("Failed to load");
        fail = false;
        decoder.setMeshoptBaseUrl("/retry");

        await expect(decoder.getMeshoptDecoder()).resolves.toBeDefined();
        expect(scripts).toHaveLength(2);
        expect(scripts[1]!.src).toBe("/retry/meshopt_decoder.js");
        expect(scripts.every((script) => vi.mocked(script.remove).mock.calls.length === 1)).toBe(true);
    });

    it("retries both Draco script and module initialization failures", async () => {
        const scripts: ScriptMock[] = [];
        let failScript = true;
        let factoryCalls = 0;
        const heap = new ArrayBuffer(16);
        const factory = vi.fn(async () => {
            factoryCalls++;
            if (factoryCalls === 1) {
                throw new Error("transient wasm failure");
            }
            return {
                Decoder: class {
                    public DecodeBufferToMesh() {
                        return { ok: () => true, error_msg: () => "" };
                    }
                    public GetTrianglesUInt32Array(): void {}
                    public GetAttributeByUniqueId(): undefined {
                        return undefined;
                    }
                    public GetAttributeDataArrayForAllPoints(): boolean {
                        return true;
                    }
                },
                DecoderBuffer: class {
                    public Init(): void {}
                },
                Mesh: class {
                    public num_faces(): number {
                        return 0;
                    }
                    public num_points(): number {
                        return 0;
                    }
                },
                destroy: () => undefined,
                HEAPF32: new Float32Array(heap),
                HEAPU32: new Uint32Array(heap),
                HEAP32: new Int32Array(heap),
                DT_FLOAT32: 0,
                DT_INT32: 1,
                _malloc: () => 0,
                _free: () => undefined,
            };
        });
        installScriptDocument((script) => {
            scripts.push(script);
            queueMicrotask(() => {
                if (failScript) {
                    script.onerror?.();
                } else {
                    vi.stubGlobal("DracoDecoderModule", factory);
                    script.onload?.();
                }
            });
        });
        const decoder = await import("../../../packages/babylon-lite/src/loader-gltf/draco-decode.js");
        const decode = () => decoder.decodeDracoPrimitive(new Uint8Array(), {}, {});

        await expect(decode()).rejects.toThrow("Failed to load");
        failScript = false;
        decoder.setDracoBaseUrl("/retry");
        await expect(decode()).rejects.toThrow("transient wasm failure");
        await expect(decode()).resolves.toMatchObject({ _vertexCount: 0, _indexCount: 0 });
        expect(scripts).toHaveLength(2);
        expect(scripts[1]!.src).toBe("/retry/draco_decoder.js");
        expect(scripts.every((script) => vi.mocked(script.remove).mock.calls.length === 1)).toBe(true);
        expect(factory).toHaveBeenCalledTimes(2);
    });
});
