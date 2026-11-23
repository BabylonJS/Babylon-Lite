import { afterEach, describe, expect, it, vi } from "vitest";
import { createGLEngine, disposeGLEngine, onContextLost, onContextRestored } from "../../../packages/babylon-lite-gl/src/context";
import { createEffect, isEffectReady, useEffect } from "../../../packages/babylon-lite-gl/src/effect";
import { bindAttributes, createIndexBuffer, createMeshVao, createVertexBuffer, disposeBuffer, drawMesh, updateVertexBuffer } from "../../../packages/babylon-lite-gl/src/mesh";
import { bindTexture, createRawTexture, loadTexture2D, updateRawTexture } from "../../../packages/babylon-lite-gl/src/texture";
import { createTexture3DFromPixels } from "../../../packages/babylon-lite-gl/src/texture-3d";
import { createTextureFromSource } from "../../../packages/babylon-lite-gl/src/texture-source";
import { createDynamicTexture, updateDynamicTexture } from "../../../packages/babylon-lite-gl/src/dynamic-texture";
import { createHtmlElementTexture, updateHtmlElementTexture } from "../../../packages/babylon-lite-gl/src/html-texture";
import { createRenderTarget } from "../../../packages/babylon-lite-gl/src/render-target";
import { createSpriteRenderer, renderSprites } from "../../../packages/babylon-lite-gl/src/sprites";
import { runRenderLoop } from "../../../packages/babylon-lite-gl/src/render-loop";
import { createMockCanvas, createMockGL, fireLost, fireRestored } from "./_lite-gl-mock";

function setup(doNotHandleContextLost = false) {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas, { doNotHandleContextLost });
    return { mock, canvas, engine };
}

function readyEffect(engine: ReturnType<typeof setup>["engine"]) {
    const effect = createEffect(engine, { name: "recovery", vertexSource: "v", fragmentSource: "f", uniformNames: [], samplerNames: [], attributeNames: ["a"] });
    expect(isEffectReady(effect)).toBe(true);
    return effect;
}

afterEach(() => vi.unstubAllGlobals());

describe("lite-gl: host-owned recovery", () => {
    it.each([false, true])("preserves exact buffer upload/update/delete streams with opt-out=%s", (optOut) => {
        const { mock, engine } = setup(optOut);
        const vertices = new Float32Array(8);
        const indices = new Uint16Array([0, 1, 2]);
        const next = new Float32Array(8);
        const partial = new Float32Array(2);
        mock.clear();
        const vb = createVertexBuffer(engine, vertices, true);
        const ib = createIndexBuffer(engine, indices);
        updateVertexBuffer(vb, next);
        updateVertexBuffer(vb, partial, 8);
        expect(vb.byteLength).toBe(next.byteLength);
        expect(ib.count).toBe(3);
        expect(ib.is32Bits).toBe(false);
        expect(vb._data).toBe(optOut ? undefined : next);
        expect(ib._data).toBe(optOut ? undefined : indices);
        expect(typeof vb._restore).toBe(optOut ? "undefined" : "function");
        expect(typeof ib._restore).toBe(optOut ? "undefined" : "function");
        disposeBuffer(vb);
        disposeBuffer(vb);
        updateVertexBuffer(vb, vertices);
        disposeBuffer(ib);
        expect(vb._data).toBeUndefined();
        expect(vb._restore).toBeUndefined();
        expect(ib._data).toBeUndefined();
        expect(ib._restore).toBeUndefined();
        expect(engine._buffers).toEqual([]);
        expect(mock.log).toEqual([
            { name: "createBuffer", args: [] },
            { name: "bindBuffer", args: [engine.gl.ARRAY_BUFFER, vb.handle] },
            { name: "bufferData", args: [engine.gl.ARRAY_BUFFER, vertices, engine.gl.DYNAMIC_DRAW] },
            { name: "createBuffer", args: [] },
            // The VAO binding is unknown on a fresh engine; the element upload must land in the default VAO.
            { name: "bindVertexArray", args: [null] },
            { name: "bindBuffer", args: [engine.gl.ELEMENT_ARRAY_BUFFER, ib.handle] },
            { name: "bufferData", args: [engine.gl.ELEMENT_ARRAY_BUFFER, indices, engine.gl.STATIC_DRAW] },
            { name: "bufferSubData", args: [engine.gl.ARRAY_BUFFER, 0, next] },
            { name: "bufferSubData", args: [engine.gl.ARRAY_BUFFER, 8, partial] },
            { name: "deleteBuffer", args: [vb.handle] },
            { name: "deleteBuffer", args: [ib.handle] },
        ]);
    });

    it("default recovery prevents loss and replays the latest retained buffer data", () => {
        const { mock, canvas, engine } = setup();
        const vb = createVertexBuffer(engine, new Float32Array(8));
        const ib = createIndexBuffer(engine, new Uint32Array([0, 1, 2]));
        const next = new Float32Array(8);
        updateVertexBuffer(vb, next);
        const preventDefault = vi.fn();
        canvas.__listeners.find((entry) => entry.type === "webglcontextlost")!.cb({ preventDefault } as unknown as Event);
        expect(preventDefault).toHaveBeenCalledOnce();
        mock.clear();
        fireRestored(canvas);
        expect(engine._isLost).toBe(false);
        expect(mock.log).toEqual([
            { name: "createBuffer", args: [] },
            { name: "bindBuffer", args: [engine.gl.ARRAY_BUFFER, vb.handle] },
            { name: "bufferData", args: [engine.gl.ARRAY_BUFFER, next, engine.gl.STATIC_DRAW] },
            { name: "createBuffer", args: [] },
            { name: "bindVertexArray", args: [null] },
            { name: "bindBuffer", args: [engine.gl.ELEMENT_ARRAY_BUFFER, ib.handle] },
            { name: "bufferData", args: [engine.gl.ELEMENT_ARRAY_BUFFER, ib._data, engine.gl.STATIC_DRAW] },
        ]);
    });

    it("opt-out notifies loss without requesting restoration; the host recreates the engine", () => {
        const { mock, canvas, engine } = setup(true);
        const requestFrame = vi.fn().mockReturnValue(42);
        const cancelFrame = vi.fn();
        vi.stubGlobal("requestAnimationFrame", requestFrame);
        vi.stubGlobal("cancelAnimationFrame", cancelFrame);
        runRenderLoop(engine, vi.fn());
        const effect = readyEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array(8));
        const tex = createRawTexture(engine, new Uint8Array(4), 1, 1);
        const lost = vi.fn();
        const restored = vi.fn();
        onContextLost(engine, lost);
        onContextRestored(engine, restored);
        const preventDefault = vi.fn();
        expect(canvas.__listeners.map((entry) => entry.type)).toEqual(["webglcontextlost"]);
        canvas.__listeners[0]!.cb({ preventDefault } as unknown as Event);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(lost).toHaveBeenCalledOnce();
        expect(engine._isLost).toBe(true);
        expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(42);
        expect(engine._rafId).toBe(0);
        mock.clear();
        bindAttributes(vb, [{ index: 0, size: 2 }], effect);
        updateVertexBuffer(vb, new Float32Array(8));
        bindTexture(tex, 0);
        fireRestored(canvas);
        expect(mock.log).toEqual([]);
        expect(restored).not.toHaveBeenCalled();
        expect(requestFrame).toHaveBeenCalledOnce();
        expect(engine._isLost).toBe(true);
        disposeGLEngine(engine);
        expect(canvas.__listeners).toEqual([]);
        const replacement = createGLEngine(canvas, { doNotHandleContextLost: true });
        const freshEffect = readyEffect(replacement);
        const freshBuffer = createVertexBuffer(replacement, new Float32Array(8));
        mock.clear();
        bindAttributes(freshBuffer, [{ index: 0, size: 2, divisor: 0 }], freshEffect);
        expect(mock.log).toEqual([
            { name: "bindVertexArray", args: [null] },
            { name: "enableVertexAttribArray", args: [0] },
            { name: "vertexAttribPointer", args: [0, 2, replacement.gl.FLOAT, false, 0, 0] },
            { name: "vertexAttribDivisor", args: [0, 0] },
        ]);
    });

    it.each([false, true])("engine disposal releases retained buffer references exactly once (opt-out=%s)", (optOut) => {
        const { mock, engine } = setup(optOut);
        const vb = createVertexBuffer(engine, new Float32Array(8));
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        mock.clear();
        disposeGLEngine(engine);
        disposeGLEngine(engine);
        disposeBuffer(vb);
        disposeBuffer(ib);
        expect(mock.log).toEqual([
            { name: "deleteBuffer", args: [vb.handle] },
            { name: "deleteBuffer", args: [ib.handle] },
        ]);
        for (const buffer of [vb, ib]) {
            expect(buffer._data).toBeUndefined();
            expect(buffer._restore).toBeUndefined();
        }
    });

    it("does not keep replay-only program/RT/VAO/sprite hooks; recorded VAOs still draw", () => {
        const { mock, engine } = setup(true);
        const effect = readyEffect(engine);
        const vb = createVertexBuffer(engine, new Float32Array(8));
        const ib = createIndexBuffer(engine, new Uint16Array([0, 1, 2]));
        const vao = createMeshVao(engine, [{ buffer: vb, attributes: [{ index: 0, size: 2, divisor: 0 }] }], ib, effect);
        const rt = createRenderTarget(engine, 4, 4);
        const sprite = createSpriteRenderer(engine, { texture: rt.texture, cellWidth: 1, cellHeight: 1, capacity: 1 });
        expect(effect._restore).toBeUndefined();
        expect(rt._restore).toBeUndefined();
        expect(vao._restore).toBeUndefined();
        expect(vao._bindings).toEqual([]);
        expect(sprite._restore).toBeUndefined();
        expect(sprite._indices).toBeNull();
        expect(engine._onRestored).toEqual([]);
        useEffect(effect);
        mock.clear();
        drawMesh(vao);
        expect(mock.log).toEqual([
            { name: "bindVertexArray", args: [vao.handle] },
            { name: "drawElements", args: [engine.gl.TRIANGLES, 3, engine.gl.UNSIGNED_SHORT, 0] },
        ]);
        expect(isEffectReady(sprite._effect)).toBe(true);
        mock.clear();
        const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        renderSprites(sprite, [{ position: { x: 0, y: 0, z: 0 }, width: 1, height: 1, angle: 0 }], 0, identity, identity);
        expect(mock.log.filter((call) => call.name === "drawElements")).toEqual([{ name: "drawElements", args: [engine.gl.TRIANGLES, 6, engine.gl.UNSIGNED_SHORT, 0] }]);
        expect(mock.log.filter((call) => call.name === "bufferData")).toEqual([]);
    });

    it("raw/3D/source textures release replay-only inputs, while raw updates still upload", () => {
        const { mock, engine } = setup(true);
        const raw = createRawTexture(engine, new Uint8Array(4), 1, 1);
        const next = new Uint8Array(16);
        updateRawTexture(raw, next, { width: 2, height: 2 });
        expect(
            mock.log
                .filter((call) => call.name === "texImage2D")
                .at(-1)
                ?.args.at(-1)
        ).toBe(next);
        mock.clear();
        // Inspect private replay hooks to prove they no longer close over pixels.
        raw._upload(engine);
        expect(mock.log.find((call) => call.name === "texImage2D")?.args.at(-1)).toBeNull();
        const volume = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        mock.clear();
        volume._upload(engine);
        expect(mock.log.find((call) => call.name === "texImage3D")?.args.at(-1)).toBeNull();
        const decoded = createTextureFromSource(engine, { width: 1, height: 1 } as ImageBitmap);
        mock.clear();
        decoded._upload(engine);
        expect(mock.log.find((call) => call.name === "texImage2D")?.args.at(-1)).toBeNull();
    });

    it("dynamic uploads forget their source, while HTML-element updates still use their element", () => {
        const { mock, engine } = setup(true);
        const source = { width: 2, height: 3 } as HTMLCanvasElement;
        const dynamic = createDynamicTexture(engine, 1, 1);
        updateDynamicTexture(dynamic, source);
        expect(dynamic._dynSource).toBeNull();
        expect([dynamic.width, dynamic.height]).toEqual([2, 3]);
        const html = createHtmlElementTexture(engine, source);
        mock.clear();
        updateHtmlElementTexture(html);
        expect(mock.log.find((call) => call.name === "texImage2D")?.args.at(-1)).toBe(source);
    });

    it.each([false, true])("async image bitmaps are closed after upload only with opt-out=%s", async (optOut) => {
        const { engine } = setup(optOut);
        const close = vi.fn();
        const bitmap = { width: 2, height: 2, close };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve({}) }));
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
        await new Promise<void>((resolve, reject) => {
            loadTexture2D(engine, "test.png", undefined, () => resolve(), reject);
        });
        expect(close).toHaveBeenCalledTimes(optOut ? 1 : 0);
    });

    it.each([false, true])("handles decode completing during context loss with opt-out=%s", async (optOut) => {
        const { mock, canvas, engine } = setup(optOut);
        const close = vi.fn();
        const bitmap = { width: 2, height: 2, close };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve({}) }));
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
        const loaded = new Promise<ReturnType<typeof loadTexture2D>>((resolve, reject) => {
            loadTexture2D(engine, "test.png", undefined, resolve, reject);
        });
        fireLost(canvas);
        mock.clear();
        const tex = await loaded;
        expect(mock.log).toEqual([]);
        expect(tex.isReady).toBe(false);
        expect(close).toHaveBeenCalledTimes(optOut ? 1 : 0);
        fireRestored(canvas);
        if (optOut) {
            expect(mock.log).toEqual([]);
            expect(tex.isReady).toBe(false);
        } else {
            expect(tex.isReady).toBe(true);
            expect(mock.log.find((call) => call.name === "texImage2D")?.args.at(-1)).toBe(bitmap);
        }
    });
});
