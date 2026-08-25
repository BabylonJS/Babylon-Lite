import { describe, expect, it } from "vitest";
import { clearDynamicTextureSource, createDynamicTexture, createGLEngine, updateDynamicTexture } from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockCall, type MockGL } from "./_lite-gl-mock";

function setup() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    mock.setParallelComplete(true);
    return { mock, canvas, engine, gl: engine.gl };
}

function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

/** A fake 2D source (canvas/OffscreenCanvas stand-in). The mock never reads it. */
function fakeSource(w: number, h: number): TexImageSource {
    return { width: w, height: h } as unknown as TexImageSource;
}

describe("lite-gl createDynamicTexture()", () => {
    it("allocates a blank RGBA8 texture of the requested size and is immediately ready", () => {
        const { mock, engine, gl } = setup();
        mock.clear();
        const tex = createDynamicTexture(engine, 256, 128);
        expect(tex.width).toBe(256);
        expect(tex.height).toBe(128);
        expect(tex.isReady).toBe(true);
        const up = callsNamed(mock, "texImage2D");
        expect(up).toHaveLength(1);
        // internalFormat=RGBA8, width=256, height=128, format=RGBA, type=UNSIGNED_BYTE, pixels=null
        expect(up[0]?.args[2]).toBe(gl.RGBA8);
        expect(up[0]?.args[3]).toBe(256);
        expect(up[0]?.args[4]).toBe(128);
        expect(up[0]?.args[8]).toBeNull();
        // Clamp + linear by default.
        expect(mock.count("texParameteri")).toBe(4);
    });

    it("clamps non-positive dimensions to 1", () => {
        const { engine } = setup();
        const tex = createDynamicTexture(engine, 0, -5);
        expect(tex.width).toBe(1);
        expect(tex.height).toBe(1);
    });
});

describe("lite-gl updateDynamicTexture()", () => {
    it("uploads the source with the right unpack flags (invertY + premultiply off by default)", () => {
        const { mock, engine } = setup();
        const tex = createDynamicTexture(engine, 64, 64);
        // Prime the cache to the opposite (flip + premultiply ON) so the default
        // update's explicit reset-to-0 is observable — the state cache elides no-ops.
        updateDynamicTexture(engine, tex, fakeSource(64, 64), true, true);
        mock.clear();
        updateDynamicTexture(engine, tex, fakeSource(64, 64));
        const flips = callsNamed(mock, "pixelStorei");
        // both UNPACK flags reset to 0
        expect(flips.some((c) => c.args[0] === engine.gl.UNPACK_FLIP_Y_WEBGL && c.args[1] === 0)).toBe(true);
        expect(flips.some((c) => c.args[0] === (engine.gl as { UNPACK_PREMULTIPLY_ALPHA_WEBGL: number }).UNPACK_PREMULTIPLY_ALPHA_WEBGL && c.args[1] === 0)).toBe(true);
        // source uploaded (the 6th texImage2D arg is the source, not null)
        const up = callsNamed(mock, "texImage2D");
        expect(up).toHaveLength(1);
        expect(up[0]?.args[8]).not.toBeNull();
    });

    it("honors invertY and premultiplyAlpha flags", () => {
        const { mock, engine } = setup();
        const tex = createDynamicTexture(engine, 64, 64);
        mock.clear();
        updateDynamicTexture(engine, tex, fakeSource(64, 64), true, true);
        const flips = callsNamed(mock, "pixelStorei");
        expect(flips.some((c) => c.args[0] === engine.gl.UNPACK_FLIP_Y_WEBGL && c.args[1] === 1)).toBe(true);
        expect(flips.some((c) => c.args[0] === (engine.gl as { UNPACK_PREMULTIPLY_ALPHA_WEBGL: number }).UNPACK_PREMULTIPLY_ALPHA_WEBGL && c.args[1] === 1)).toBe(true);
    });

    it("replays the last source on webglcontextrestored", () => {
        const { mock, canvas, engine } = setup();
        const tex = createDynamicTexture(engine, 64, 64);
        updateDynamicTexture(engine, tex, fakeSource(64, 64));
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        // After restore: a fresh handle is created and the source replayed (not blank).
        expect(mock.count("createTexture")).toBe(1);
        const up = callsNamed(mock, "texImage2D");
        expect(up).toHaveLength(1);
        expect(up[0]?.args[8]).not.toBeNull();
    });

    it("re-blanks on restore when no update happened yet", () => {
        const { mock, canvas, engine } = setup();
        createDynamicTexture(engine, 32, 16);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        const up = callsNamed(mock, "texImage2D");
        expect(up).toHaveLength(1);
        expect(up[0]?.args[8]).toBeNull(); // blank
        expect(up[0]?.args[3]).toBe(32);
        expect(up[0]?.args[4]).toBe(16);
    });

    it("is a no-op on a lost context", () => {
        const { mock, canvas, engine } = setup();
        const tex = createDynamicTexture(engine, 64, 64);
        fireLost(canvas);
        mock.clear();
        updateDynamicTexture(engine, tex, fakeSource(64, 64));
        expect(mock.count("texImage2D")).toBe(0);
    });
});

describe("lite-gl clearDynamicTextureSource()", () => {
    it("drops the retained source so a later restore re-blanks instead of replaying", () => {
        const { mock, canvas, engine } = setup();
        const tex = createDynamicTexture(engine, 32, 16);
        updateDynamicTexture(engine, tex, fakeSource(32, 16));
        clearDynamicTextureSource(tex);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        const up = callsNamed(mock, "texImage2D");
        expect(up).toHaveLength(1);
        expect(up[0]?.args[8]).toBeNull(); // re-blanked at the original size, not replayed
        expect(up[0]?.args[3]).toBe(32);
        expect(up[0]?.args[4]).toBe(16);
    });
});

describe("lite-gl dynamic texture: texParameteri caching", () => {
    it("does NOT re-apply texParameteri on per-frame updates (filter/wrap persist on the same handle)", () => {
        const { mock, engine } = setup();
        const tex = createDynamicTexture(engine, 64, 64); // 4 texParameteri at create
        mock.clear();
        updateDynamicTexture(engine, tex, fakeSource(64, 64));
        updateDynamicTexture(engine, tex, fakeSource(64, 64));
        // Same handle across updates → GL retains the filter/wrap → zero redundant
        // texParameteri (the scene13 redundancy fix)...
        expect(mock.count("texParameteri")).toBe(0);
        // ...while the pixels still upload on every update.
        expect(mock.count("texImage2D")).toBe(2);
    });

    it("re-applies texParameteri on webglcontextrestored (the fresh handle starts at GL defaults)", () => {
        const { mock, canvas, engine } = setup();
        const tex = createDynamicTexture(engine, 64, 64);
        updateDynamicTexture(engine, tex, fakeSource(64, 64)); // same handle → no re-apply
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        // A new handle is created → all four filter/wrap params must be re-applied.
        expect(mock.count("createTexture")).toBe(1);
        expect(mock.count("texParameteri")).toBe(4);
    });
});
