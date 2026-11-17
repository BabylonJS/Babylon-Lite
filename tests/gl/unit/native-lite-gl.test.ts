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
    restoreDefaultFramebuffer,
    setBlendMode,
    setEffectFloat,
    setEffectFloatArray4,
    setEffectTexture,
    setViewport,
    updateWrappedNativeTexture,
    wrapNativeTexture,
} from "../../../packages/babylon-lite-gl/src/native/index.js";
import { CommandStream } from "../../../packages/babylon-lite-gl/src/native/command-stream.js";
import type { NativeEngineConstructor, NativeRuntime } from "../../../packages/babylon-lite-gl/src/native/runtime.js";

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
        floats(name: string, length: number) {
            const start = words.lastIndexOf(commands.get(`COMMAND_${name}`)?.[0] ?? -1) + 1;
            return Array.from(new Float32Array(new Uint32Array(words.slice(start, start + length)).buffer));
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
        stream.array([1, 2]);
        stream.finish();
        expect(mock.words).toEqual([]);
        stream.end();
        expect(mock.words).toEqual([5, 100, 1, 42, 2, 0xfffffffe, 3, 0x3f000000, 6, 1, 4, 2, 0x3f800000, 0x40000000]);
        expect(() => stream.end()).toThrow("not active");
        stream.begin();
        expect(() => stream.begin()).toThrow("already active");
        stream.end();
    });

    it("preserves command data when the reusable stream rolls over", () => {
        const mock = makeRuntime();
        const native = new mock.runtime.Engine({ version: "test", nonFloatVertexBuffers: true });
        const stream = new CommandStream(mock.runtime, native);
        stream.begin();
        for (let index = 0; index < 17000; index++) {
            stream.uint(index);
        }
        stream.end();
        expect(mock.words).toEqual(Array.from({ length: 17000 }, (_, index) => index));
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
});
