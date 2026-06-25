import { describe, expect, it } from "vitest";
import { GLBlendMode, createGLEngine, createRawTexture, disposeGLEngine } from "../../../packages/babylon-lite-gl/src/index";
import { createSpriteRenderer, disposeSpriteRenderer, renderSprites, setSpriteRendererTexture, type GLSprite } from "../../../packages/babylon-lite-gl/src/sprites";
import { applyGLStates } from "../../../packages/babylon-lite-gl/src/apply-states";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockCall, type MockGL } from "./_lite-gl-mock";

const VIEW = new Float32Array(16);
const PROJ = new Float32Array(16);

function setup() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    mock.setParallelComplete(true);
    const gl = engine.gl;
    // A 64x64 sheet of 32x32 cells (2x2 = 4 cells). `null` data is fine — the
    // mock records but never reads it; width/height/isReady are what matter.
    const texture = createRawTexture(engine, null, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE);
    return { mock, canvas, engine, gl, texture };
}

function makeSprite(overrides?: Partial<GLSprite>): GLSprite {
    return { position: { x: 0, y: 0, z: 0 }, width: 1, height: 1, angle: 0, cellIndex: 0, ...overrides };
}

/** All recorded calls with the given name, in order. */
function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

describe("lite-gl sprites: createSpriteRenderer", () => {
    it("allocates its own VAO + VBO + IBO and the six attribute pointers", () => {
        const { mock, engine, texture } = setup();
        mock.clear();
        createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        expect(mock.count("createVertexArray")).toBe(1);
        expect(mock.count("createBuffer")).toBe(2); // VBO + IBO
        expect(mock.count("bufferData")).toBe(2); // dynamic vertex store + static indices
        expect(mock.count("enableVertexAttribArray")).toBe(6);
        expect(mock.count("vertexAttribPointer")).toBe(6);
    });

    it("uploads the dynamic vertex store with DYNAMIC_DRAW", () => {
        const { mock, engine, gl, texture } = setup();
        mock.clear();
        createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        const usages = callsNamed(mock, "bufferData").map((c) => c.args[2]);
        expect(usages).toContain(gl.DYNAMIC_DRAW);
        expect(usages).toContain(gl.STATIC_DRAW);
    });

    it("rejects invalid capacity or cell size", () => {
        const { engine, texture } = setup();
        expect(() => createSpriteRenderer(engine, { capacity: 0, cellWidth: 32, cellHeight: 32, texture })).toThrow();
        expect(() => createSpriteRenderer(engine, { capacity: 1.5, cellWidth: 32, cellHeight: 32, texture })).toThrow();
        expect(() => createSpriteRenderer(engine, { capacity: 999999, cellWidth: 32, cellHeight: 32, texture })).toThrow();
        expect(() => createSpriteRenderer(engine, { capacity: 4, cellWidth: 0, cellHeight: 32, texture })).toThrow();
        expect(() => createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: -1, texture })).toThrow();
    });

    it("defaults blendMode to ALPHA and disableDepthWrite to false", () => {
        const { engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        expect(renderer.blendMode).toBe(GLBlendMode.ALPHA);
        expect(renderer.disableDepthWrite).toBe(false);
        expect(renderer.capacity).toBe(4);
    });
});

describe("lite-gl sprites: renderSprites draw", () => {
    it("draws N visible sprites with one bufferSubData and one drawElements of count N*6", () => {
        const { mock, engine, gl, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 16, cellWidth: 32, cellHeight: 32, texture });
        const sprites = [makeSprite(), makeSprite(), makeSprite()];
        mock.clear();
        renderSprites(renderer, sprites, 0, VIEW, PROJ);
        expect(mock.count("bufferSubData")).toBe(1);
        const dc = callsNamed(mock, "drawElements");
        expect(dc).toHaveLength(1);
        expect(dc[0]?.args[0]).toBe(gl.TRIANGLES);
        expect(dc[0]?.args[1]).toBe(3 * 6);
        expect(dc[0]?.args[2]).toBe(gl.UNSIGNED_SHORT);
        expect(dc[0]?.args[3]).toBe(0);
        // view + projection matrices uploaded once each.
        expect(mock.count("uniformMatrix4fv")).toBe(2);
    });

    it("accepts plain number[] matrices as well as Float32Array", () => {
        const { mock, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        const view = new Array<number>(16).fill(0);
        mock.clear();
        expect(() => renderSprites(renderer, [makeSprite()], 0, view, PROJ)).not.toThrow();
        expect(mock.count("drawElements")).toBe(1);
    });

    it("skips sprites with isVisible === false", () => {
        const { mock, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 16, cellWidth: 32, cellHeight: 32, texture });
        const sprites = [makeSprite(), makeSprite({ isVisible: false }), makeSprite()];
        mock.clear();
        renderSprites(renderer, sprites, 0, VIEW, PROJ);
        expect(callsNamed(mock, "drawElements")[0]?.args[1]).toBe(2 * 6);
    });

    it("ignores sprites beyond capacity", () => {
        const { mock, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 2, cellWidth: 32, cellHeight: 32, texture });
        const sprites = [makeSprite(), makeSprite(), makeSprite(), makeSprite(), makeSprite()];
        mock.clear();
        renderSprites(renderer, sprites, 0, VIEW, PROJ);
        expect(callsNamed(mock, "drawElements")[0]?.args[1]).toBe(2 * 6);
    });

    it("does nothing when all sprites are invisible", () => {
        const { mock, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        mock.clear();
        renderSprites(renderer, [makeSprite({ isVisible: false })], 0, VIEW, PROJ);
        expect(mock.count("bufferSubData")).toBe(0);
        expect(mock.count("drawElements")).toBe(0);
    });

    it("does nothing for an empty sprite list", () => {
        const { mock, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        mock.clear();
        renderSprites(renderer, [], 0, VIEW, PROJ);
        expect(mock.count("drawElements")).toBe(0);
    });

    it("reuses the preallocated vertex buffer across frames (no per-frame allocation)", () => {
        const { engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        const vd = renderer._vertexData;
        renderSprites(renderer, [makeSprite(), makeSprite()], 0, VIEW, PROJ);
        renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ);
        expect(renderer._vertexData).toBe(vd);
    });
});

describe("lite-gl sprites: blend mode", () => {
    it("renders with ALPHA blending by default, then resets to DISABLE", () => {
        const { mock, engine, gl, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        mock.clear();
        renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ);
        const fc = callsNamed(mock, "blendFuncSeparate");
        expect(fc).toHaveLength(1);
        expect(fc[0]?.args).toEqual([gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE]);
        // autoReset (Babylon autoResetAlpha) records a deferred DISABLE; it is
        // flushed by the next draw / applyGLStates, leaving blending disabled.
        applyGLStates(engine);
        expect(mock.count("disable")).toBe(1);
    });

    it("honours an explicit ADD blend mode", () => {
        const { mock, engine, gl, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture, blendMode: GLBlendMode.ADD });
        mock.clear();
        renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ);
        const fc = callsNamed(mock, "blendFuncSeparate");
        expect(fc).toHaveLength(1);
        expect(fc[0]?.args).toEqual([gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE]);
    });
});

describe("lite-gl sprites: texture swap", () => {
    it("setSpriteRendererTexture replaces the sampled texture", () => {
        const { engine, gl, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        const tex2 = createRawTexture(engine, null, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE);
        setSpriteRendererTexture(renderer, tex2);
        expect(renderer.texture).toBe(tex2);
    });

    it("setSpriteRendererTexture is a no-op after disposal", () => {
        const { engine, gl, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        const tex2 = createRawTexture(engine, null, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE);
        disposeSpriteRenderer(renderer);
        setSpriteRendererTexture(renderer, tex2);
        expect(renderer.texture).toBe(texture);
    });
});

describe("lite-gl sprites: manual UV rects (lottie atlas path)", () => {
    it("creates a renderer without cellWidth/cellHeight (defaults to 1)", () => {
        const { engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, texture });
        expect(renderer.cellWidth).toBe(1);
        expect(renderer.cellHeight).toBe(1);
    });

    it("writes the per-sprite UV rect into cellInfo (offset normalized, size ÷ texW/texH)", () => {
        const { engine, texture } = setup(); // 64x64 texture
        const renderer = createSpriteRenderer(engine, { capacity: 4, texture });
        const sprite = makeSprite({ cellIndex: undefined, uOffset: 0.25, vOffset: 0.5, uSize: 16, vSize: 8 });
        renderSprites(renderer, [sprite], 0, VIEW, PROJ);
        const vd = renderer._vertexData;
        // cellInfo = floats 10..13 of vertex 0: (uOffset, vOffset, uSize/64, vSize/64)
        expect(vd[10]).toBeCloseTo(0.25, 6);
        expect(vd[11]).toBeCloseTo(0.5, 6);
        expect(vd[12]).toBeCloseTo(16 / 64, 6);
        expect(vd[13]).toBeCloseTo(8 / 64, 6);
    });

    it("supports uSize=0 (solid-color single-texel sample) and ignores cellIndex", () => {
        const { engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        const sprite = makeSprite({ cellIndex: 3, uOffset: 0.1, vOffset: 0.2, uSize: 0, vSize: 0 });
        renderSprites(renderer, [sprite], 0, VIEW, PROJ);
        const vd = renderer._vertexData;
        // Manual UV (uSize is defined) wins over the cellIndex grid.
        expect(vd[10]).toBeCloseTo(0.1, 6);
        expect(vd[11]).toBeCloseTo(0.2, 6);
        expect(vd[12]).toBe(0);
        expect(vd[13]).toBe(0);
    });

    it("still uses the cellIndex grid when no manual UV rect is set", () => {
        const { engine, texture } = setup(); // 64x64, cells 32x32 => rowSize 2
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        // cellIndex 3 => row 1, col 1 => left=(1*32)/64=0.5, top=(1*32)/64=0.5
        renderSprites(renderer, [makeSprite({ cellIndex: 3 })], 0, VIEW, PROJ);
        const vd = renderer._vertexData;
        expect(vd[10]).toBeCloseTo(0.5, 6);
        expect(vd[11]).toBeCloseTo(0.5, 6);
        expect(vd[12]).toBeCloseTo(0.5, 6);
        expect(vd[13]).toBeCloseTo(0.5, 6);
    });
});

describe("lite-gl sprites: epsilon (UV/position inset)", () => {
    it("defaults epsilon to 0.01 (Babylon SpriteRenderer default) and insets the quad corners", () => {
        const { engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, texture });
        expect(renderer.epsilon).toBe(0.01);
        renderSprites(renderer, [makeSprite({ uOffset: 0, vOffset: 0, uSize: 8, vSize: 8 })], 0, VIEW, PROJ);
        // Vertex 0 is corner (0,0): its position/UV offset (floats 6,7) is inset to +eps.
        expect(renderer._vertexData[6]).toBeCloseTo(0.01, 6);
        expect(renderer._vertexData[7]).toBeCloseTo(0.01, 6);
    });

    it("honours epsilon: 0 (lottie atlas path) so quad corners are exactly 0 and 1", () => {
        const { engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, texture, epsilon: 0 });
        expect(renderer.epsilon).toBe(0);
        renderSprites(renderer, [makeSprite({ uOffset: 0, vOffset: 0, uSize: 8, vSize: 8 })], 0, VIEW, PROJ);
        const stride = 18; // FLOATS_PER_VERTEX
        // Corner (0,0) stays 0; corner (1,1) on vertex 2 stays 1 — full-size quad (no shrink).
        expect(renderer._vertexData[6]).toBe(0);
        expect(renderer._vertexData[7]).toBe(0);
        expect(renderer._vertexData[2 * stride + 6]).toBe(1);
        expect(renderer._vertexData[2 * stride + 7]).toBe(1);
    });
});

describe("lite-gl sprites: autoResetAlpha", () => {
    it("leaves the blend mode applied after drawing when autoResetAlpha is false", () => {
        const { mock, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, {
            capacity: 4,
            texture,
            blendMode: GLBlendMode.PREMULTIPLIED,
            autoResetAlpha: false,
        });
        mock.clear();
        renderSprites(renderer, [makeSprite({ uOffset: 0, vOffset: 0, uSize: 1, vSize: 1 })], 0, VIEW, PROJ);
        // No reset-to-DISABLE: the premultiplied mode persists for the next pass.
        expect(mock.count("disable")).toBe(0);
        expect(renderer.autoResetAlpha).toBe(false);
    });

    it("defaults autoResetAlpha to true", () => {
        const { engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, texture });
        expect(renderer.autoResetAlpha).toBe(true);
    });
});

describe("lite-gl sprites: lost / disposed safety", () => {
    it("renderSprites is a no-op on a lost context and does not throw", () => {
        const { mock, canvas, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        fireLost(canvas);
        mock.clear();
        expect(() => renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ)).not.toThrow();
        expect(mock.count("drawElements")).toBe(0);
        expect(mock.count("bufferSubData")).toBe(0);
    });

    it("renderSprites bails when the texture is not ready", () => {
        const { mock, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        renderer.texture.isReady = false;
        mock.clear();
        renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ);
        expect(mock.count("drawElements")).toBe(0);
    });

    it("renderSprites bails until the effect is ready, then draws", () => {
        const mock = createMockGL();
        const canvas = createMockCanvas(mock);
        const engine = createGLEngine(canvas);
        mock.setParallelComplete(false);
        const gl = engine.gl;
        const texture = createRawTexture(engine, null, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE);
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ);
        expect(mock.count("drawElements")).toBe(0);
        mock.setParallelComplete(true);
        renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ);
        expect(mock.count("drawElements")).toBe(1);
    });

    it("disposeSpriteRenderer releases the VAO/VBO/IBO + effect and is idempotent", () => {
        const { mock, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        mock.clear();
        disposeSpriteRenderer(renderer);
        expect(mock.count("deleteVertexArray")).toBe(1);
        expect(mock.count("deleteBuffer")).toBe(2);
        expect(mock.count("deleteProgram")).toBe(1);
        expect(mock.count("deleteTexture")).toBe(0); // consumer owns the texture
        disposeSpriteRenderer(renderer);
        disposeSpriteRenderer(renderer);
        expect(mock.count("deleteVertexArray")).toBe(1);
        expect(mock.count("deleteProgram")).toBe(1);
        expect(() => renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ)).not.toThrow();
    });

    it("renderSprites is a no-op after the engine is disposed", () => {
        const { mock, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 4, cellWidth: 32, cellHeight: 32, texture });
        disposeGLEngine(engine);
        mock.clear();
        expect(() => renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ)).not.toThrow();
        expect(mock.count("drawElements")).toBe(0);
    });
});

describe("lite-gl sprites: context restore", () => {
    it("rebuilds GPU buffers on webglcontextrestored and renders again", () => {
        const { mock, canvas, engine, texture } = setup();
        const renderer = createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        fireLost(canvas);
        fireRestored(canvas);
        expect(renderer._vao).not.toBeNull();
        expect(renderer._vbo).not.toBeNull();
        mock.clear();
        // The owned effect is rebuilt by the engine; buffers by our restore hook.
        renderSprites(renderer, [makeSprite()], 0, VIEW, PROJ);
        expect(mock.count("drawElements")).toBe(1);
    });
});

describe("lite-gl sprites: multiple renderers share one program (redundant-useProgram fix)", () => {
    it("two sprite renderers reuse ONE cached program but own separate geometry", () => {
        const { mock, engine, texture } = setup();
        mock.clear();
        const a = createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        const b = createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        // The identical sprite shader compiles ONE program, shared via the
        // source-keyed effect cache (pre-fix this was 2 distinct programs).
        expect(mock.count("createProgram")).toBe(1);
        expect(a._effect).toBe(b._effect);
        expect(a._effect.program).toBe(b._effect.program);
        // ...but each renderer still owns its own VAO/VBO/IBO.
        expect(a._vao).not.toBe(b._vao);
        expect(a._vbo).not.toBe(b._vbo);
    });

    it("drawing both renderers binds the shared program at most once (no per-renderer useProgram)", () => {
        const { mock, engine, texture } = setup();
        const a = createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        const b = createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        mock.clear();
        renderSprites(a, [makeSprite()], 0, VIEW, PROJ);
        renderSprites(b, [makeSprite()], 0, VIEW, PROJ);
        // Both layers drew, yet the program was bound at most once across them —
        // the second renderer's draw does NOT re-issue gl.useProgram (was 2 pre-fix).
        expect(mock.count("drawElements")).toBe(2);
        expect(mock.count("useProgram")).toBeLessThanOrEqual(1);
    });

    it("the shared program is ref-counted: disposing one renderer keeps it alive for the other", () => {
        const { mock, engine, texture } = setup();
        const a = createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        const b = createSpriteRenderer(engine, { capacity: 8, cellWidth: 32, cellHeight: 32, texture });
        mock.clear();
        disposeSpriteRenderer(a);
        // b still references the shared program → not deleted yet.
        expect(mock.count("deleteProgram")).toBe(0);
        disposeSpriteRenderer(b);
        // Last reference gone → program torn down exactly once.
        expect(mock.count("deleteProgram")).toBe(1);
    });
});
