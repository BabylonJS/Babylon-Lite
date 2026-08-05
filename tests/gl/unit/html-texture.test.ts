import { beforeAll, describe, expect, it } from "vitest";
import { createGLEngine } from "../../../packages/babylon-lite-gl/src/index";
import { GLSamplingMode, createHtmlElementTexture, updateHtmlElementTexture } from "../../../packages/babylon-lite-gl/src/html-texture";
import { bindTexture } from "../../../packages/babylon-lite-gl/src/texture";
import { createMockCanvas, createMockGL, type MockGL } from "./_lite-gl-mock";

// The gl-unit project runs in the `node` environment, which has no DOM globals.
// createHtmlElementTexture uses `instanceof HTMLVideoElement / HTMLImageElement`,
// so we stub those constructors; the source element is a plain canvas-like object
// (not an instance of either), which routes through the canvas size branch.
beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    if (g.HTMLVideoElement === undefined) {
        g.HTMLVideoElement = class {
            readonly kind = "video";
        };
    }
    if (g.HTMLImageElement === undefined) {
        g.HTMLImageElement = class {
            readonly kind = "image";
        };
    }
    if (g.HTMLCanvasElement === undefined) {
        g.HTMLCanvasElement = class {
            readonly kind = "canvas";
        };
    }
});

const GL_NEAREST = 0x2600;
const GL_LINEAR = 0x2601;
const GL_LINEAR_MIPMAP_LINEAR = 0x2703;
const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_TEXTURE_MIN_FILTER = 0x2801;

function sourceElement(width = 4, height = 4): HTMLCanvasElement {
    return { width, height } as unknown as HTMLCanvasElement;
}

function makeCtx() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, engine };
}

/** Last value passed to `gl.texParameteri` for a given parameter name. */
function paramValue(mock: MockGL, pname: number): number | undefined {
    for (let i = mock.log.length - 1; i >= 0; i--) {
        const c = mock.log[i];
        if (c !== undefined && c.name === "texParameteri" && c.args[1] === pname) {
            return c.args[2] as number;
        }
    }
    return undefined;
}

describe("lite-gl: html-texture samplingMode", () => {
    it("NEAREST sets nearest min + mag, no mipmaps", () => {
        const { mock, engine } = makeCtx();
        createHtmlElementTexture(engine, sourceElement(), { samplingMode: GLSamplingMode.NEAREST });
        expect(paramValue(mock, GL_TEXTURE_MIN_FILTER)).toBe(GL_NEAREST);
        expect(paramValue(mock, GL_TEXTURE_MAG_FILTER)).toBe(GL_NEAREST);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("BILINEAR sets linear min + mag, no mipmaps", () => {
        const { mock, engine } = makeCtx();
        createHtmlElementTexture(engine, sourceElement(), { samplingMode: GLSamplingMode.BILINEAR });
        expect(paramValue(mock, GL_TEXTURE_MIN_FILTER)).toBe(GL_LINEAR);
        expect(paramValue(mock, GL_TEXTURE_MAG_FILTER)).toBe(GL_LINEAR);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("TRILINEAR sets a mipmap min filter and generates mipmaps", () => {
        const { mock, engine } = makeCtx();
        createHtmlElementTexture(engine, sourceElement(), { samplingMode: GLSamplingMode.TRILINEAR });
        expect(paramValue(mock, GL_TEXTURE_MIN_FILTER)).toBe(GL_LINEAR_MIPMAP_LINEAR);
        expect(paramValue(mock, GL_TEXTURE_MAG_FILTER)).toBe(GL_LINEAR);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("omitting samplingMode keeps the linear GL defaults", () => {
        const { mock, engine } = makeCtx();
        createHtmlElementTexture(engine, sourceElement());
        expect(paramValue(mock, GL_TEXTURE_MIN_FILTER)).toBe(GL_LINEAR);
        expect(paramValue(mock, GL_TEXTURE_MAG_FILTER)).toBe(GL_LINEAR);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("explicit minFilter/magFilter override the preset", () => {
        const { mock, engine } = makeCtx();
        createHtmlElementTexture(engine, sourceElement(), { samplingMode: GLSamplingMode.NEAREST, minFilter: GL_LINEAR, magFilter: GL_LINEAR });
        expect(paramValue(mock, GL_TEXTURE_MIN_FILTER)).toBe(GL_LINEAR);
        expect(paramValue(mock, GL_TEXTURE_MAG_FILTER)).toBe(GL_LINEAR);
    });

    it("accepts a raw Babylon sampling-mode integer (3 = TRILINEAR)", () => {
        const { mock, engine } = makeCtx();
        createHtmlElementTexture(engine, sourceElement(), { samplingMode: 3 });
        expect(mock.count("generateMipmap")).toBe(1);
    });
});

describe("lite-gl: updateHtmlElementTexture", () => {
    it("re-uploads the texture from its source element", () => {
        const { mock, engine } = makeCtx();
        const tex = createHtmlElementTexture(engine, sourceElement());
        mock.clear();
        updateHtmlElementTexture(engine, tex);
        expect(mock.count("texImage2D")).toBe(1);
    });

    it("forces unit 0 active before re-upload even when another unit is left active (regression)", () => {
        const { mock, engine } = makeCtx();
        // A prior multi-sampler draw can leave a non-zero unit active while this
        // texture's handle is still the one bound on unit 0. Reproduce: create the
        // texture (uploads on unit 0), then bind an unrelated texture on unit 1.
        const other = createHtmlElementTexture(engine, sourceElement());
        const tex = createHtmlElementTexture(engine, sourceElement());
        bindTexture(engine, 1, other); // leaves unit 1 active; boundTextures[0] is still `tex`

        mock.clear();
        updateHtmlElementTexture(engine, tex);

        // texImage2D writes into the texture on the ACTIVE unit, so the upload MUST
        // have re-selected unit 0 first. Without the fix, the unit-0 bind is elided,
        // unit 1 stays active, and the canvas is uploaded onto `other`.
        const log = mock.log;
        const texIdx = log.findIndex((c) => c !== undefined && c.name === "texImage2D");
        expect(texIdx).toBeGreaterThanOrEqual(0);
        let activeUnit: number | undefined;
        for (let i = texIdx - 1; i >= 0; i--) {
            const c = log[i];
            if (c !== undefined && c.name === "activeTexture") {
                activeUnit = c.args[0] as number;
                break;
            }
        }
        expect(activeUnit).toBe(engine.gl.TEXTURE0);
    });
});
