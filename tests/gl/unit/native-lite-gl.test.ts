import { afterEach, describe, expect, it, vi } from "vitest";
import {
    beginFrame,
    bindMeshVao,
    bindRenderTarget,
    clearEngine,
    createEffect,
    createIndexBuffer,
    createNativeEngine,
    createRawTexture,
    createRenderTarget,
    createVertexBuffer,
    createMeshVao,
    drawMesh,
    disposeEffect,
    disposeBuffer,
    disposeMeshVao,
    disposeNativeEngine,
    disposeRenderTarget,
    disposeTexture,
    endFrame,
    getEffectCompilationError,
    isEffectReady,
    disableScissor,
    getCurrentRenderTarget,
    restoreDefaultFramebuffer,
    setBlendMode,
    setEffectFloat,
    setEffectFloatArray4,
    setEffectTexture,
    setScissor,
    setViewport,
    updateWrappedNativeTexture,
    useEffect,
    wrapNativeTexture,
} from "../../../packages/babylon-lite-gl/src/native/index.js";
import { COMMAND_STREAM_WORDS, CommandStream } from "../../../packages/babylon-lite-gl/src/native/command-stream.js";
import type { GLMeshVertexBuffer, NativeGLFamily } from "../../../packages/babylon-lite-gl/src/native/index.js";
import type { NativeEngineConstructor, NativeRuntime } from "../../../packages/babylon-lite-gl/src/native/runtime.js";
import type { GLFamily, GLKit } from "../../../packages/babylon-lite-gl/src/family.js";
import * as Web from "../../../packages/babylon-lite-gl/src/index.js";
import { createMockCanvas, createMockGL } from "./_lite-gl-mock.js";

const RGBA = 0x1908;
const UNSIGNED_BYTE = 0x1401;

function makeRuntime(validation = false) {
    let nextHandle = 2000;
    let nextCommand = 100000;
    let flushStream: () => void = () => {};
    let reset: () => void = () => {};
    const words: number[] = [];
    const handle = () => new Uint32Array([nextHandle++]);
    class Stream {
        static VALIDATION_ENABLED = validation;
        static VALIDATION_UINT_32 = 1;
        static VALIDATION_INT_32 = 2;
        static VALIDATION_FLOAT_32 = 3;
        static VALIDATION_FLOAT_32_ARRAY = 4;
        static VALIDATION_NATIVE_DATA = 5;
        static VALIDATION_BOOLEAN = 6;

        constructor(flush: () => void) {
            flushStream = flush;
        }

        writeBuffer(buffer: ArrayBuffer, length: number) {
            words.push(...new Uint32Array(buffer, 0, length));
        }
    }
    class Engine {
        static PROTOCOL_VERSION = 9;
        static CAPS_LIMITS_MAX_TEXTURE_SIZE = 16384;
        static ATTRIB_TYPE_FLOAT = 5126;
        static TEXTURE_FORMAT_RGBA8 = 12;
        static TEXTURE_LINEAR_LINEAR = 0;
        static TEXTURE_NEAREST_NEAREST = 1;
        static ADDRESS_MODE_CLAMP = 0;
        static DEPTH_TEST_ALWAYS = 0;
        static ALPHA_DISABLE = 0;
        static ALPHA_ADD = 1;
        static ALPHA_COMBINE = 2;
        static ALPHA_PREMULTIPLIED = 7;

        dispose = vi.fn();
        setHardwareScalingLevel = vi.fn();
        setCommandDataStream = vi.fn();
        submitCommands = vi.fn(() => flushStream());
        getRenderWidth = () => 640;
        getRenderHeight = () => 360;
        setRenderResetCallback = (callback: () => void) => {
            reset = callback;
        };
        createProgram = vi.fn(handle);
        getUniforms = (_program: Uint32Array, names: string[]) => names.map((name) => (name === "missing" ? null : handle()));
        getAttributes = (_program: Uint32Array, names: string[]) => names.map((_, index) => index);
        createVertexBuffer = vi.fn(handle);
        createIndexBuffer = vi.fn(handle);
        createVertexArray = vi.fn(handle);
        recordVertexBuffer = vi.fn();
        recordIndexBuffer = vi.fn();
        createTexture = vi.fn(handle);
        initializeTexture = vi.fn();
        loadRawTexture = vi.fn();
        getTextureWidth = () => 640;
        getTextureHeight = () => 360;
        deleteTexture = vi.fn();
        createFrameBuffer = vi.fn(handle);
    }
    const commands = new Map<string, Uint32Array<ArrayBuffer>>();
    const constructor = new Proxy(Engine, {
        get(target, name, receiver) {
            if (typeof name === "string" && name.startsWith("COMMAND_")) {
                let command = commands.get(name);
                if (!command) {
                    command = new Uint32Array([nextCommand++]);
                    commands.set(name, command);
                }
                return command;
            }
            return Reflect.get(target, name, receiver);
        },
    }) as unknown as NativeEngineConstructor;
    const runtime: NativeRuntime = { Engine: constructor, NativeDataStream: Stream };
    vi.stubGlobal("_native", runtime);
    return {
        runtime,
        Engine,
        words,
        count(name: string) {
            const value = commands.get(`COMMAND_${name}`)?.[0];
            return words.filter((word) => word === value).length;
        },
        after(name: string, length: number) {
            const start = words.lastIndexOf(commands.get(`COMMAND_${name}`)?.[0] ?? -1) + 1;
            return words.slice(start, start + length);
        },
        floats(name: string, length: number) {
            return Array.from(new Float32Array(new Uint32Array(this.after(name, length)).buffer));
        },
        reset: () => reset(),
        clear: () => {
            words.length = 0;
        },
    };
}

type MockEngine = InstanceType<ReturnType<typeof makeRuntime>["Engine"]>;

function effect(engine: ReturnType<typeof createNativeEngine>) {
    return createEffect(engine, {
        name: "composition",
        vertexSource: "#version 300 es\nvoid main() {}",
        fragmentSource: "#version 300 es\nvoid main() {}",
        uniformNames: ["alpha", "colors", "missing"],
        samplerNames: ["plane"],
    });
}

afterEach(() => vi.unstubAllGlobals());

type AttributeOps = "createEffect" | "isEffectReady" | "createVertexBuffer" | "createIndexBuffer" | "createMeshVao";

/** Records two meshes whose `uv` attribute the shared effect did not declare. */
function recordUndeclaredUv<F extends GLFamily>(kit: GLKit<F, AttributeOps>, engine: F["engine"]): void {
    const program = kit.createEffect(engine, { name: "uv", vertexSource: "v", fragmentSource: "f", uniformNames: [], samplerNames: [], attributeNames: ["position"] });
    kit.isEffectReady(program);
    const buffer = kit.createVertexBuffer(engine, new Float32Array(16));
    const indices = kit.createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
    for (let index = 0; index < 2; index++) {
        kit.createMeshVao(
            engine,
            [
                {
                    buffer,
                    computeStride: true,
                    attributes: [
                        { name: "position", size: 2, divisor: 0 },
                        { name: "uv", size: 2, offset: 8, divisor: 0 },
                    ],
                },
            ],
            indices,
            program
        );
    }
}

const ATTRIBUTE_LOCATIONS: Record<string, number> = { position: 0, uv: 3 };

describe("Native Lite GL protocol", () => {
    it("rejects unavailable and incompatible runtimes before engine creation", () => {
        vi.stubGlobal("_native", undefined);
        expect(() => createNativeEngine()).toThrow("requires the Babylon Native runtime");
        const mock = makeRuntime();
        mock.Engine.PROTOCOL_VERSION = 8;
        expect(() => createNativeEngine()).toThrow("requires protocol 9");
    });

    it("encodes validation tags, signed and floating data, arrays, and native handles", () => {
        const mock = makeRuntime(true);
        const native = new mock.runtime.Engine({ version: "test", nonFloatVertexBuffers: true });
        const stream = new CommandStream(mock.runtime, native);
        stream.begin();
        stream.start(new Uint32Array([100]));
        stream.uint(42);
        stream.int(-2);
        stream.float(0.5);
        stream.bool(true);
        stream.array([1, 2, 3], 2);
        stream.finish();
        expect(mock.words).toEqual([]);
        stream.end();
        expect(mock.words).toEqual([5, 100, 1, 42, 2, 0xfffffffe, 3, 0x3f000000, 6, 1, 4, 2, 0x3f800000, 0x40000000]);
        expect(() => stream.end()).toThrow("not active");
        stream.begin();
        expect(() => stream.begin()).toThrow("already active");
        stream.end();
    });

    it("preserves command data when the reusable stream fills and rolls over", () => {
        const mock = makeRuntime();
        const native = new mock.runtime.Engine({ version: "test", nonFloatVertexBuffers: true });
        const stream = new CommandStream(mock.runtime, native);
        stream.begin();
        for (let index = 0; index < COMMAND_STREAM_WORDS; index++) {
            stream.uint(index);
        }
        expect(mock.words).toEqual([]);
        stream.uint(COMMAND_STREAM_WORDS);
        expect(mock.words).toHaveLength(COMMAND_STREAM_WORDS);
        stream.end();
        expect(mock.words).toEqual(Array.from({ length: COMMAND_STREAM_WORDS + 1 }, (_, index) => index));
    });

    it("rejects an oversized or invalid-length uniform array without recording any part of its command", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const first = effect(engine);
        const second = effect(engine);
        mock.clear();
        beginFrame(engine);
        setEffectFloat(second, "alpha", 1);
        expect(() => setEffectFloatArray4(first, "colors", new Float32Array(COMMAND_STREAM_WORDS))).toThrow(Error);
        for (const length of [-1, Number.NaN, 1.5]) {
            expect(() => setEffectFloatArray4(first, "colors", { length })).toThrow(RangeError);
        }
        setEffectFloat(second, "alpha", 0.5);
        setEffectFloatArray4(first, "colors", [1, 2, 3, 4]);
        endFrame(engine);
        expect(mock.count("SETPROGRAM")).toBe(2);
        expect(mock.count("SETFLOAT")).toBe(2);
        expect(mock.count("SETFLOATARRAY4")).toBe(1);
        expect(mock.floats("SETFLOATARRAY4", 6).slice(2)).toEqual([1, 2, 3, 4]);
    });

    it("rejects an array whose values cannot be read without recording or caching any of it", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const first = effect(engine);
        const second = effect(engine);
        const unreadable = new Proxy([1, 2, 3, 4], {
            get(target, key, receiver) {
                if (key === "1") {
                    throw new Error("unreadable value");
                }
                return Reflect.get(target, key, receiver);
            },
        });
        mock.clear();
        beginFrame(engine);
        setEffectFloat(second, "alpha", 1);
        expect(() => setEffectFloatArray4(first, "colors", unreadable)).toThrow("unreadable value");
        setEffectFloat(second, "alpha", 0.5);
        setEffectFloatArray4(first, "colors", [1, 2, 3, 4]);
        setEffectFloatArray4(first, "colors", [1, 2, 3, 4]);
        endFrame(engine);
        expect(mock.count("SETPROGRAM")).toBe(2);
        expect(mock.count("SETFLOAT")).toBe(2);
        expect(mock.count("SETFLOATARRAY4")).toBe(1);
        expect(mock.floats("SETFLOATARRAY4", 6).slice(2)).toEqual([1, 2, 3, 4]);
    });

    it("rejects an array upload whose value reads make another array upload, keeping the nested upload", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const outer = effect(engine);
        const inner = effect(engine);
        const reentrant = new Proxy([1, 2, 3, 4], {
            get(target, key, receiver) {
                if (key === "3") {
                    setEffectFloatArray4(inner, "colors", [5, 6, 7, 8]);
                }
                return Reflect.get(target, key, receiver);
            },
        });
        mock.clear();
        beginFrame(engine);
        expect(() => setEffectFloatArray4(outer, "colors", reentrant)).toThrow(Error);
        setEffectFloatArray4(inner, "colors", [5, 6, 7, 8]);
        endFrame(engine);
        expect(mock.count("SETPROGRAM")).toBe(1);
        expect(mock.count("SETFLOATARRAY4")).toBe(1);
        expect(mock.floats("SETFLOATARRAY4", 6).slice(2)).toEqual([5, 6, 7, 8]);
        mock.clear();
        setEffectFloatArray4(outer, "colors", [5, 6, 7, 8]);
        expect(mock.count("SETPROGRAM")).toBe(1);
        expect(mock.count("SETFLOATARRAY4")).toBe(1);
        expect(mock.floats("SETFLOATARRAY4", 6).slice(2)).toEqual([5, 6, 7, 8]);
    });

    it("retains per-program uniform values and notices in-place array changes", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const first = effect(engine);
        const second = effect(engine);
        mock.clear();
        const colors = [1, 0, 0, 1];
        setEffectFloat(first, "alpha", 1);
        setEffectFloat(first, "alpha", 1);
        setEffectFloat(first, "missing", 2);
        setEffectFloat(second, "alpha", 0.5);
        setEffectFloat(first, "alpha", 1);
        setEffectFloatArray4(first, "colors", colors);
        setEffectFloatArray4(first, "colors", colors);
        colors[0] = 0;
        setEffectFloatArray4(first, "colors", colors);
        expect(mock.count("SETFLOAT")).toBe(2);
        expect(mock.count("SETFLOATARRAY4")).toBe(2);
    });

    it("rebinds textures after program changes and across native frames", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const first = effect(engine);
        const second = effect(engine);
        const texture = wrapNativeTexture(engine, new Uint32Array([700]));
        mock.clear();
        beginFrame(engine);
        setEffectTexture(first, "plane", texture);
        setEffectTexture(first, "plane", texture);
        setEffectTexture(second, "plane", texture);
        setEffectTexture(first, "plane", texture);
        endFrame(engine);
        expect(mock.count("SETTEXTURE")).toBe(3);
        beginFrame(engine);
        setEffectTexture(first, "plane", texture);
        endFrame(engine);
        expect(mock.count("SETTEXTURE")).toBe(4);
    });

    it("owns recorded vertex arrays while eliding repeated vertex bindings", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const program = effect(engine);
        const vertex = createVertexBuffer(engine, new Float32Array([0, 0, 1, 1]));
        const indices = createIndexBuffer(engine, new Uint16Array([0, 1, 0]));
        const native = engine._native as unknown as InstanceType<typeof mock.Engine>;
        mock.clear();
        const mesh = createMeshVao(engine, [{ buffer: vertex, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, program);
        bindMeshVao(mesh);
        drawMesh(mesh, 0, 0, 3);
        expect(native.createVertexArray).toHaveBeenCalledTimes(1);
        expect(native.recordVertexBuffer).toHaveBeenCalledWith(expect.anything(), vertex._handle, 0, 0, 8, 2, 5126, false, 0);
        expect(mock.count("BINDVERTEXARRAY")).toBe(1);
        disposeEffect(program);
        disposeEffect(program);
        expect(mock.count("DELETEVERTEXARRAY")).toBe(0);
        disposeMeshVao(mesh);
        disposeMeshVao(mesh);
        disposeBuffer(vertex);
        disposeBuffer(indices);
        expect(mock.count("DELETEVERTEXARRAY")).toBe(1);
        expect(mock.count("DELETEPROGRAM")).toBe(1);
        expect(mock.count("DELETEVERTEXBUFFER")).toBe(1);
        expect(mock.count("DELETEINDEXBUFFER")).toBe(1);
    });

    it("rebuilds borrowed output framebuffers without deleting host texture storage", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const native = engine._native as unknown as InstanceType<typeof mock.Engine>;
        const borrowed = wrapNativeTexture(engine, new Uint32Array([700]));
        expect(borrowed.isReady).toBe(true);
        const target = createRenderTarget(engine, 640, 360, { colorTexture: borrowed });
        bindRenderTarget(target);
        const oldFramebuffer = target._framebuffer;
        const replacement = new Uint32Array([701]);
        mock.clear();
        updateWrappedNativeTexture(borrowed, replacement);
        expect(target._framebuffer).not.toBe(oldFramebuffer);
        expect(native.createFrameBuffer).toHaveBeenLastCalledWith(replacement, 640, 360, false, false, 1);
        expect(mock.count("UNBINDFRAMEBUFFER")).toBe(1);
        expect(mock.count("DELETEFRAMEBUFFER")).toBe(1);
        disposeRenderTarget(target);
        disposeTexture(borrowed);
        expect(borrowed.isReady).toBe(false);
        expect(native.deleteTexture).not.toHaveBeenCalled();
        const owned = createRawTexture(engine, new Uint8Array(4), 1, 1, { format: RGBA, type: UNSIGNED_BYTE });
        disposeTexture(owned);
        disposeTexture(owned);
        expect(owned.isReady).toBe(false);
        expect(native.deleteTexture).toHaveBeenCalledTimes(1);
    });

    it("maps pixel viewports onto the bound target and gives each binding a full viewport", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const target = createRenderTarget(engine, 320, 180);
        bindRenderTarget(target);
        expect(mock.floats("SETVIEWPORT", 4)).toEqual([0, 0, 1, 1]);
        setViewport(engine, { x: 80, y: 45, w: 160, h: 90 });
        expect(mock.floats("SETVIEWPORT", 4)).toEqual([0.25, 0.25, 0.5, 0.5]);
        mock.clear();
        bindRenderTarget(target);
        expect(mock.count("BINDFRAMEBUFFER")).toBe(0);
        expect(mock.floats("SETVIEWPORT", 4)).toEqual([0, 0, 1, 1]);
        setViewport(engine);
        expect(mock.floats("SETVIEWPORT", 4)).toEqual([0, 0, 2, 2]);
        restoreDefaultFramebuffer(engine);
        setViewport(engine, { x: 0, y: 0, w: 320, h: 180 });
        expect(mock.floats("SETVIEWPORT", 4)).toEqual([0, 0, 0.5, 0.5]);
    });

    it("clears only the requested buffers", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        mock.clear();
        clearEngine(engine, { color: { r: 0.25, g: 0.5, b: 0.75 }, stencil: true });
        const words = mock.words.slice(-9);
        expect([words[0], words[5], words[7], words[8]]).toEqual([1, 0, 1, 0]);
        expect(mock.floats("CLEAR", 5).slice(1)).toEqual([0.25, 0.5, 0.75, 1]);
        clearEngine(engine, { depth: true });
        expect(mock.words.slice(-9).filter((_, index) => index !== 4 && index !== 6)).toEqual([0, 0, 0, 0, 1, 0, 0]);
    });

    it("compiles Lite GL sources with defines in place of the WebGL2 version header", () => {
        makeRuntime();
        const engine = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        createEffect(engine, {
            name: "defined",
            vertexSource: "#version 300 es\nvoid main() {}",
            fragmentSource: "void main() {}",
            uniformNames: [],
            samplerNames: [],
            defines: "#define A",
        });
        expect(native.createProgram).toHaveBeenLastCalledWith("#define A\nvoid main() {}", "#define A\nvoid main() {}");
        const program = effect(engine);
        expect(native.createProgram).toHaveBeenLastCalledWith("void main() {}", "void main() {}");
        expect(isEffectReady(program)).toBe(true);
        expect(getEffectCompilationError(program)).toBeNull();
    });

    it("strips a version directive that follows leading whitespace and comments", () => {
        makeRuntime();
        const engine = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        createEffect(engine, {
            name: "commented",
            vertexSource: "\n  // header\n/* licence\n */\n# version 300 es\nvoid main() {}",
            fragmentSource: "void main() {}\n#version 300 es\n",
            uniformNames: [],
            samplerNames: [],
        });
        expect(native.createProgram).toHaveBeenLastCalledWith("\n  // header\n/* licence\n */\nvoid main() {}", "void main() {}\n#version 300 es\n");
        createEffect(engine, {
            name: "spaced",
            vertexSource: "#          \t version 300 es\nvoid main() {}",
            fragmentSource: "#          versioned\nvoid main() {}",
            uniformNames: [],
            samplerNames: [],
        });
        expect(native.createProgram).toHaveBeenLastCalledWith("void main() {}", "#          versioned\nvoid main() {}");
    });

    it("rejects texture sizes the host cannot allocate before any host call", () => {
        const mock = makeRuntime();
        mock.Engine.CAPS_LIMITS_MAX_TEXTURE_SIZE = 2048;
        const engine = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        for (const [width, height] of [
            [0, 1],
            [1.5, 1],
            [1, 2049],
            [Number.NaN, 1],
        ] as const) {
            expect(() => createRawTexture(engine, new Uint8Array(4), width, height)).toThrow("positive integers no larger than 2048");
            expect(() => createRenderTarget(engine, width, height)).toThrow("positive integers no larger than 2048");
        }
        expect(native.createTexture).not.toHaveBeenCalled();
        expect(native.createFrameBuffer).not.toHaveBeenCalled();
        expect(createRenderTarget(engine, 2048, 1).width).toBe(2048);
    });

    it("rejects raw texture formats it cannot upload", () => {
        makeRuntime();
        const engine = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        expect(() => createRawTexture(engine, new Uint8Array(16), 1, 1, { format: RGBA, type: 0x1406 })).toThrow("RGBA / UNSIGNED_BYTE");
        expect(native.createTexture).not.toHaveBeenCalled();
    });

    it("invalidates bindings and restores composition state after native reset", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        setBlendMode(engine, 2);
        setViewport(engine);
        mock.clear();
        setBlendMode(engine, 2);
        setViewport(engine, { x: 0, y: 0, w: 640, h: 360 });
        expect(mock.words).toEqual([]);
        mock.reset();
        setBlendMode(engine, 2);
        setViewport(engine);
        expect(mock.count("SETDEPTHTEST")).toBe(1);
        expect(mock.count("SETDEPTHWRITE")).toBe(1);
        expect(mock.count("SETSTATE")).toBe(1);
        expect(mock.count("SETBLENDMODE")).toBe(1);
        expect(mock.count("SETVIEWPORT")).toBe(1);
        const native = engine._native as unknown as InstanceType<typeof mock.Engine>;
        disposeNativeEngine(engine);
        disposeNativeEngine(engine);
        expect(native.dispose).toHaveBeenCalledTimes(1);
    });

    it("keeps owned texture storage until the commands recorded before its disposal are submitted", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        const program = effect(engine);
        const texture = createRawTexture(engine, new Uint8Array(4), 1, 1);
        const target = createRenderTarget(engine, 320, 180);
        const handles = [texture._handle, target.texture._handle];
        beginFrame(engine);
        bindRenderTarget(target);
        setEffectTexture(program, "plane", texture);
        disposeTexture(texture);
        restoreDefaultFramebuffer(engine);
        setEffectTexture(program, "plane", target.texture);
        disposeRenderTarget(target);
        for (let index = 0; index < COMMAND_STREAM_WORDS; index++) {
            setEffectFloat(program, "alpha", index);
        }
        expect(mock.words.length).toBeGreaterThan(0);
        expect(native.deleteTexture).not.toHaveBeenCalled();
        endFrame(engine);
        expect(native.deleteTexture.mock.calls.map(([handle]) => handle)).toEqual(handles);
        expect(native.deleteTexture.mock.invocationCallOrder[0]).toBeGreaterThan(native.submitCommands.mock.invocationCallOrder.at(-1) ?? Infinity);
        beginFrame(engine);
        endFrame(engine);
        expect(native.deleteTexture).toHaveBeenCalledTimes(2);
    });

    it("keeps borrowed output framebuffers when a replacement cannot be created", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        const borrowed = wrapNativeTexture(engine, new Uint32Array([700]));
        const first = createRenderTarget(engine, 640, 360, { colorTexture: borrowed });
        const second = createRenderTarget(engine, 640, 360, { colorTexture: borrowed });
        bindRenderTarget(first);
        const framebuffers = [first._framebuffer, second._framebuffer];
        const created = new Uint32Array([900]);
        native.createFrameBuffer
            .mockImplementationOnce(() => created)
            .mockImplementationOnce(() => {
                throw new Error("host framebuffer failure");
            });
        mock.clear();
        expect(() => updateWrappedNativeTexture(borrowed, new Uint32Array([701]))).toThrow("host framebuffer failure");
        expect([first._framebuffer, second._framebuffer]).toEqual(framebuffers);
        expect(borrowed._handle).toEqual(new Uint32Array([700]));
        expect(getCurrentRenderTarget(engine)).toBe(first);
        expect(mock.count("UNBINDFRAMEBUFFER")).toBe(0);
        expect(mock.count("DELETEFRAMEBUFFER")).toBe(1);
        expect(mock.after("DELETEFRAMEBUFFER", 1)).toEqual([900]);
    });

    it("ignores disposed effects, textures, geometry, targets and engines like the web backend", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const live = effect(engine);
        const disposed = effect(engine);
        const texture = createRawTexture(engine, new Uint8Array(4), 1, 1);
        const disposedTexture = createRawTexture(engine, new Uint8Array(4), 1, 1);
        const target = createRenderTarget(engine, 320, 180);
        const vertex = createVertexBuffer(engine, new Float32Array([0, 0, 1, 1]));
        const indices = createIndexBuffer(engine, new Uint16Array([0, 1, 0]));
        const mesh = createMeshVao(engine, [{ buffer: vertex, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, live);
        const liveMesh = createMeshVao(engine, [{ buffer: vertex, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, live);
        const liveTarget = createRenderTarget(engine, 320, 180);
        bindRenderTarget(liveTarget);
        disposeEffect(disposed);
        disposeTexture(disposedTexture);
        disposeRenderTarget(target);
        disposeMeshVao(mesh);
        mock.clear();
        useEffect(disposed);
        setEffectFloat(disposed, "alpha", 1);
        setEffectFloatArray4(disposed, "colors", [1, 2, 3, 4]);
        setEffectTexture(disposed, "plane", texture);
        setEffectTexture(live, "plane", disposedTexture);
        bindMeshVao(mesh);
        bindRenderTarget(target);
        expect(mock.words).toEqual([]);
        const native = engine._native as unknown as MockEngine;
        const deletedTextures = native.deleteTexture.mock.calls.length;
        disposeNativeEngine(engine);
        useEffect(live);
        setEffectFloat(live, "alpha", 1);
        setEffectTexture(live, "plane", texture);
        setViewport(engine);
        setScissor(engine, 1, 2, 3, 4);
        disableScissor(engine);
        setBlendMode(engine, 1);
        clearEngine(engine, { color: { r: 1, g: 0, b: 0 } });
        restoreDefaultFramebuffer(engine);
        disposeEffect(live);
        disposeTexture(texture);
        disposeBuffer(vertex);
        disposeBuffer(indices);
        disposeMeshVao(liveMesh);
        disposeRenderTarget(liveTarget);
        expect(mock.words).toEqual([]);
        expect([live._disposed, texture._disposed, vertex._disposed, indices._disposed, liveMesh._disposed, liveTarget._disposed, liveTarget.texture._disposed]).toEqual([
            true,
            true,
            true,
            true,
            true,
            true,
            true,
        ]);
        expect(native.deleteTexture).toHaveBeenCalledTimes(deletedTextures);
        expect(() => createMeshVao(engine, [], indices, disposed)).toThrow(Error);
        expect(native.createVertexArray).toHaveBeenCalledTimes(2);
    });

    it("rejects mesh and render-target creation after engine disposal before any host call", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        const program = effect(engine);
        const vertex = createVertexBuffer(engine, new Float32Array(8));
        const indices = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        disposeNativeEngine(engine);
        mock.clear();
        expect(() => createMeshVao(engine, [{ buffer: vertex, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, program)).toThrow(Error);
        expect(() => createRenderTarget(engine, 640, 360)).toThrow(Error);
        expect(native.createVertexArray).not.toHaveBeenCalled();
        expect(native.createTexture).not.toHaveBeenCalled();
        expect(native.createFrameBuffer).not.toHaveBeenCalled();
        expect(mock.words).toEqual([]);
    });

    it("validates a sampler name before switching programs", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const first = effect(engine);
        const second = effect(engine);
        const texture = wrapNativeTexture(engine, new Uint32Array([700]));
        useEffect(second);
        mock.clear();
        setEffectTexture(first, "alpha", texture);
        setEffectTexture(first, "toString", texture);
        setEffectTexture(first, "undeclared", texture);
        expect(mock.words).toEqual([]);
        setEffectTexture(first, "plane", texture);
        expect(mock.count("SETPROGRAM")).toBe(1);
        expect(mock.count("SETTEXTURE")).toBe(1);
    });

    it("resolves mesh attributes the effect did not declare once from its program", () => {
        makeRuntime();
        const engine = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        const program = effect(engine);
        const getAttributes = vi.spyOn(native, "getAttributes").mockReturnValue([3]);
        const vertex = createVertexBuffer(engine, new Float32Array(8));
        const indices = createIndexBuffer(engine, new Uint16Array([0, 1, 0]));
        const binding: GLMeshVertexBuffer = {
            buffer: vertex,
            attributes: [
                { name: "position", size: 2, divisor: 0 },
                { name: "uv", size: 2, divisor: 0 },
            ],
        };
        createMeshVao(engine, [binding], indices, program);
        createMeshVao(engine, [binding], indices, program);
        expect(getAttributes).toHaveBeenCalledTimes(1);
        expect(native.recordVertexBuffer.mock.calls.map((call) => call[2])).toEqual([0, 3, 0, 3]);
    });

    it("resolves an undeclared attribute to the same location as the web backend", () => {
        const webMock = createMockGL();
        const getAttribLocation = vi.spyOn(webMock.gl, "getAttribLocation").mockImplementation((_program, name) => ATTRIBUTE_LOCATIONS[name] ?? -1);
        const webEngine = Web.createGLEngine(createMockCanvas(webMock));
        const webKit: GLKit<Web.WebGLFamily, AttributeOps> = {
            createEffect: Web.createEffect,
            isEffectReady: Web.isEffectReady,
            createVertexBuffer: Web.createVertexBuffer,
            createIndexBuffer: Web.createIndexBuffer,
            createMeshVao: Web.createMeshVao,
        };
        recordUndeclaredUv(webKit, webEngine);
        expect(webMock.log.filter((call) => call.name === "vertexAttribPointer").map((call) => call.args[0])).toEqual([0, 3, 0, 3]);
        expect(getAttribLocation.mock.calls.filter(([, name]) => name === "uv")).toHaveLength(1);
        Web.disposeGLEngine(webEngine);

        makeRuntime();
        const engine = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        const getAttributes = vi.spyOn(native, "getAttributes").mockImplementation((_program, names) => names.map((name) => ATTRIBUTE_LOCATIONS[name] ?? -1));
        const nativeKit: GLKit<NativeGLFamily, AttributeOps> = { createEffect, isEffectReady, createVertexBuffer, createIndexBuffer, createMeshVao };
        recordUndeclaredUv(nativeKit, engine);
        expect(native.recordVertexBuffer.mock.calls.map((call) => call[2])).toEqual([0, 3, 0, 3]);
        expect(getAttributes.mock.calls.filter(([, names]) => names.includes("uv"))).toHaveLength(1);
    });

    it("draws the remaining indices from a start offset by default", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const program = effect(engine);
        const vertex = createVertexBuffer(engine, new Float32Array(8));
        const indices = createIndexBuffer(engine, new Uint16Array([0, 1, 2, 0, 2, 3]));
        const mesh = createMeshVao(engine, [{ buffer: vertex, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, program);
        useEffect(program);
        drawMesh(mesh, 0, 3);
        expect(mock.after("DRAWINDEXED", 3)).toEqual([0, 3, 3]);
        drawMesh(mesh);
        expect(mock.after("DRAWINDEXED", 3)).toEqual([0, 0, 6]);
        mock.clear();
        for (const [start, count] of [
            [4, 3],
            [7, undefined],
            [-1, 2],
            [0, -1],
            [0.5, 2],
            [0, 1.5],
        ] as const) {
            expect(() => drawMesh(mesh, 0, start, count)).toThrow(RangeError);
        }
        expect(mock.words).toEqual([]);
        drawMesh(mesh, 0, 6);
        expect(mock.after("DRAWINDEXED", 3)).toEqual([0, 6, 0]);
    });

    it("draws nothing without a current program", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const program = effect(engine);
        const vertex = createVertexBuffer(engine, new Float32Array(8));
        const indices = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const mesh = createMeshVao(engine, [{ buffer: vertex, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, program);
        mock.clear();
        drawMesh(mesh);
        expect(mock.words).toEqual([]);
        useEffect(program);
        disposeEffect(program);
        mock.clear();
        drawMesh(mesh);
        expect(mock.words).toEqual([]);
    });

    it("draws and clears nothing while the scissor rectangle is empty", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const program = effect(engine);
        const vertex = createVertexBuffer(engine, new Float32Array(8));
        const indices = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const mesh = createMeshVao(engine, [{ buffer: vertex, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, program);
        useEffect(program);
        mock.clear();
        setScissor(engine, 4, 4, 0, 10);
        clearEngine(engine, { color: { r: 1, g: 0, b: 0 } });
        drawMesh(mesh);
        setScissor(engine, 4, 4, 10, -1);
        drawMesh(mesh);
        expect(mock.words).toEqual([]);
        setScissor(engine, 1, 2, 3, 4);
        expect(mock.floats("SETSCISSOR", 4)).toEqual([1, 2, 3, 4]);
        drawMesh(mesh);
        expect(mock.count("DRAWINDEXED")).toBe(1);
        setScissor(engine, 0, 0, 0, 0);
        disableScissor(engine);
        expect(mock.floats("SETSCISSOR", 4)).toEqual([0, 0, 0, 0]);
        clearEngine(engine, { color: { r: 1, g: 0, b: 0 } });
        drawMesh(mesh);
        expect(mock.count("CLEAR")).toBe(1);
        expect(mock.count("DRAWINDEXED")).toBe(2);
    });

    it("removes an empty or active scissor rectangle on native reset", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        setScissor(engine, 4, 4, 0, 10);
        mock.reset();
        expect(mock.floats("SETSCISSOR", 4)).toEqual([0, 0, 0, 0]);
        const program = effect(engine);
        const vertex = createVertexBuffer(engine, new Float32Array(8));
        const indices = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const mesh = createMeshVao(engine, [{ buffer: vertex, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, program);
        useEffect(program);
        mock.clear();
        clearEngine(engine, { color: { r: 1, g: 0, b: 0 } });
        drawMesh(mesh);
        expect(mock.count("CLEAR")).toBe(1);
        expect(mock.count("DRAWINDEXED")).toBe(1);
        setScissor(engine, 1, 2, 3, 4);
        mock.clear();
        mock.reset();
        expect(mock.count("SETSCISSOR")).toBe(1);
        expect(mock.floats("SETSCISSOR", 4)).toEqual([0, 0, 0, 0]);
    });

    it("rejects resources of another engine or disposed resources before any host call", () => {
        const mock = makeRuntime();
        const engine = createNativeEngine();
        const other = createNativeEngine();
        const native = engine._native as unknown as MockEngine;
        const program = effect(engine);
        const foreignProgram = effect(other);
        const vertex = createVertexBuffer(engine, new Float32Array(8));
        const indices = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const foreignVertex = createVertexBuffer(other, new Float32Array(8));
        const foreignIndices = createIndexBuffer(other, new Uint16Array([0, 1, 2]));
        const disposedVertex = createVertexBuffer(engine, new Float32Array(8));
        const disposedIndices = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const foreignTexture = wrapNativeTexture(other, new Uint32Array([700]));
        const disposedTexture = wrapNativeTexture(engine, new Uint32Array([701]));
        disposeBuffer(disposedVertex);
        disposeBuffer(disposedIndices);
        disposeTexture(disposedTexture);
        const attributes = [{ name: "position", size: 2, divisor: 0 as const }];
        mock.clear();
        for (const [buffer, indexBuffer, shader] of [
            [vertex, indices, foreignProgram],
            [foreignVertex, indices, program],
            [vertex, foreignIndices, program],
            [disposedVertex, indices, program],
            [vertex, disposedIndices, program],
        ] as const) {
            expect(() => createMeshVao(engine, [{ buffer, attributes }], indexBuffer, shader)).toThrow(Error);
        }
        for (const colorTexture of [foreignTexture, disposedTexture]) {
            expect(() => createRenderTarget(engine, 640, 360, { colorTexture })).toThrow(Error);
        }
        setEffectTexture(program, "plane", foreignTexture);
        expect(native.createVertexArray).not.toHaveBeenCalled();
        expect(native.createTexture).not.toHaveBeenCalled();
        expect(native.createFrameBuffer).not.toHaveBeenCalled();
        expect(mock.words).toEqual([]);
    });
});
