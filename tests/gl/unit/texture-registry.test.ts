import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDynamicTexture,
    createEffect,
    createFloatTexture,
    createGLEngine,
    createHtmlElementTexture,
    createRawTexture,
    createTexture3DFromPixels,
    createTextureFromHandle,
    createTextureFromSource,
    disposeGLEngine,
    disposeTexture,
    disposeTexture3D,
    loadTexture2D,
    onContextLost,
    onContextRestored,
    type GLEngineContext,
    type GLTexture,
    type GLTexture3D,
} from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored } from "./_lite-gl-mock";

function setup() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine, gl: engine.gl };
}

function mixedTextures(engine: GLEngineContext, count: number): (GLTexture | GLTexture3D)[] {
    return Array.from({ length: count }, (_, index) =>
        index % 2 === 0
            ? createRawTexture(engine, new Uint8Array([index, 0, 0, 255]), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE)
            : createTexture3DFromPixels(engine, new Uint8Array([index, 0, 0, 255]), 1, 1, 1)
    );
}

function release(engine: GLEngineContext, tex: GLTexture | GLTexture3D): void {
    if ("depth" in tex) {
        disposeTexture3D(engine, tex);
    } else {
        disposeTexture(engine, tex);
    }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("lite-gl texture registry", () => {
    it("registers every managed factory in creation order", async () => {
        const { mock, engine, gl } = setup();
        vi.stubGlobal("HTMLImageElement", class {});
        vi.stubGlobal("HTMLVideoElement", class {});
        const source = { width: 2, height: 1, close: vi.fn() } as ImageBitmap;
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(source));
        const textures = [
            createRawTexture(engine, null, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE),
            createFloatTexture(engine, null, 1, 1),
            createDynamicTexture(engine, 1, 1),
            createTextureFromSource(engine, source),
            createHtmlElementTexture(engine, createMockCanvas(mock)),
            createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1),
        ];
        textures.push(
            await new Promise<GLTexture>((resolve, reject) => {
                loadTexture2D(engine, "mock.png", undefined, resolve, reject);
            })
        );
        expect(Array.from(engine._textures)).toEqual(textures);
        for (const tex of textures) {
            expect(engine._textures.has(tex)).toBe(true);
            release(engine, tex);
            expect(engine._textures.has(tex)).toBe(false);
        }
        expect(engine._textures.size).toBe(0);
    });

    it("removes front/middle/end and arbitrary batches from 15,000 textures with one registry delete per release", () => {
        const { mock, engine, gl } = setup();
        const textures = Array.from({ length: 15_000 }, () => createRawTexture(engine, null, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE));
        const indices = [7_500, 14_999, 0, ...Array.from({ length: 100 }, (_, index) => (index * 127 + 37) % textures.length)];
        const removed = new Set(indices.map((index) => textures[index]!));
        const deletion = vi.spyOn(engine._textures, "delete");
        mock.clear();
        for (const tex of removed) {
            disposeTexture(engine, tex);
            disposeTexture(engine, tex);
        }
        expect(deletion).toHaveBeenCalledTimes(removed.size);
        expect(mock.log.filter((call) => call.name === "deleteTexture").map((call) => call.args[0])).toEqual(Array.from(removed, (tex) => tex.handle));
        expect(Array.from(engine._textures)).toEqual(textures.filter((tex) => !removed.has(tex)));
        expect(engine._textures.size).toBe(textures.length - removed.size);
        expect(engine._state.boundTextures[0]).toBeNull();
    });

    it.each(["2D", "3D"])("keeps a shared %s texture registered until its final release", (kind) => {
        const { mock, engine, gl } = setup();
        const tex = kind === "2D" ? createRawTexture(engine, null, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE) : createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        tex._refCount = 2;
        const deletion = vi.spyOn(engine._textures, "delete");
        mock.clear();
        release(engine, tex);
        expect(tex._refCount).toBe(1);
        expect(tex._disposed).toBe(false);
        expect(engine._textures.has(tex)).toBe(true);
        expect(deletion).not.toHaveBeenCalled();
        expect(mock.log).toEqual([]);
        release(engine, tex);
        release(engine, tex);
        expect(deletion).toHaveBeenCalledTimes(1);
        expect(engine._textures.has(tex)).toBe(false);
        expect(mock.log).toEqual([{ name: "deleteTexture", args: [tex.handle] }]);
    });

    it("safely disposes unregistered and already-removed textures without disturbing live entries", () => {
        const { mock, engine, gl } = setup();
        const live = createRawTexture(engine, null, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE);
        const removed = createRawTexture(engine, null, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE);
        engine._textures.delete(removed);
        const external = createTextureFromHandle(engine, {} as WebGLTexture, 1, 1);
        mock.clear();
        disposeTexture(engine, external);
        disposeTexture(engine, removed);
        disposeTexture(engine, external);
        disposeTexture(engine, removed);
        expect(Array.from(engine._textures)).toEqual([live]);
        expect(mock.log).toEqual([
            { name: "deleteTexture", args: [external.handle] },
            { name: "deleteTexture", args: [removed.handle] },
        ]);
    });

    it("can dispose every mixed 2D/3D texture while traversing the live registry", () => {
        const { mock, engine } = setup();
        const textures = mixedTextures(engine, 32);
        mock.clear();
        for (const tex of engine._textures) {
            release(engine, tex);
        }
        expect(engine._textures.size).toBe(0);
        expect(textures.every((tex) => tex._disposed)).toBe(true);
        expect(mock.log.filter((call) => call.name === "deleteTexture").map((call) => call.args[0])).toEqual(textures.map((tex) => tex.handle));
    });

    it("restores exactly the surviving mixed set in creation order after arbitrary and loss-callback evictions", () => {
        const { mock, canvas, engine } = setup();
        const textures = mixedTextures(engine, 12);
        const oldHandles = textures.map((tex) => tex.handle);
        const removed = new Set([textures[7]!, textures[0]!, textures[11]!, textures[4]!, textures[5]!]);
        const replayed: (GLTexture | GLTexture3D)[] = [];
        for (const tex of textures) {
            const upload = tex._upload;
            tex._upload = (target) => {
                replayed.push(tex);
                upload(target);
            };
        }
        for (const index of [7, 0, 11]) {
            release(engine, textures[index]!);
        }
        onContextLost(engine, () => {
            release(engine, textures[4]!);
            release(engine, textures[5]!);
        });
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        const live = textures.filter((tex) => !removed.has(tex));
        expect(replayed).toEqual(live);
        expect(Array.from(engine._textures)).toEqual(live);
        expect(mock.count("createTexture")).toBe(live.length);
        expect(mock.count("texImage2D") + mock.count("texImage3D")).toBe(live.length);
        for (let index = 0; index < textures.length; index++) {
            const tex = textures[index]!;
            if (removed.has(tex)) {
                expect(tex.handle).toBe(oldHandles[index]);
            } else {
                expect(tex.handle).not.toBe(oldHandles[index]);
                expect(tex.isReady).toBe(true);
            }
        }
    });

    it("does not skip survivors when a restore upload disposes an earlier and an unvisited texture", () => {
        const { mock, canvas, engine } = setup();
        const textures = mixedTextures(engine, 6);
        const replayed: (GLTexture | GLTexture3D)[] = [];
        for (const tex of textures) {
            const upload = tex._upload;
            tex._upload = (target) => {
                replayed.push(tex);
                upload(target);
                if (tex === textures[1]) {
                    release(engine, textures[0]!);
                    release(engine, textures[3]!);
                }
            };
        }
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(replayed).toEqual([textures[0], textures[1], textures[2], textures[4], textures[5]]);
        expect(Array.from(engine._textures)).toEqual([textures[1], textures[2], textures[4], textures[5]]);
        expect(mock.count("createTexture")).toBe(5);
        onContextRestored(engine, () => {
            for (const tex of engine._textures) {
                release(engine, tex);
            }
        });
        fireLost(canvas);
        fireRestored(canvas);
        expect(engine._textures.size).toBe(0);
    });

    it("force-deletes each live handle once during teardown despite reentrant disposal and shared references", () => {
        const { mock, engine, gl } = setup();
        const textures = mixedTextures(engine, 32);
        release(engine, textures[0]!);
        release(engine, textures[9]!);
        const live = Array.from(engine._textures);
        textures[2]!._refCount = 2;
        const deleteTexture = gl.deleteTexture.bind(gl);
        let reentered = false;
        vi.spyOn(gl, "deleteTexture").mockImplementation((handle) => {
            deleteTexture(handle);
            if (!reentered) {
                reentered = true;
                release(engine, textures[2]!);
                release(engine, textures[7]!);
                disposeGLEngine(engine);
            }
        });
        mock.clear();
        disposeGLEngine(engine);
        disposeGLEngine(engine);
        for (const tex of textures) {
            release(engine, tex);
        }
        expect(engine._textures.size).toBe(0);
        expect(textures.every((tex) => tex._disposed)).toBe(true);
        expect(mock.log.filter((call) => call.name === "deleteTexture").map((call) => call.args[0])).toEqual(live.map((tex) => tex.handle));
    });

    it("still frees a texture disposed reentrantly during effect teardown", () => {
        const { mock, engine, gl } = setup();
        const textures = mixedTextures(engine, 4);
        createEffect(engine, {
            name: "teardown",
            vertexSource: "#version 300 es\nvoid main(){ gl_Position = vec4(0.0); }",
            fragmentSource: "#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main(){ color = vec4(1.0); }",
            uniformNames: [],
            samplerNames: [],
        });
        const deleteProgram = gl.deleteProgram.bind(gl);
        vi.spyOn(gl, "deleteProgram").mockImplementation((handle) => {
            deleteProgram(handle);
            release(engine, textures[0]!);
            release(engine, textures[1]!);
        });
        mock.clear();
        disposeGLEngine(engine);
        expect(engine._textures.size).toBe(0);
        expect(textures.every((tex) => tex._disposed)).toBe(true);
        expect(mock.log.filter((call) => call.name === "deleteTexture").map((call) => call.args[0])).toEqual(textures.map((tex) => tex.handle));
    });
});
