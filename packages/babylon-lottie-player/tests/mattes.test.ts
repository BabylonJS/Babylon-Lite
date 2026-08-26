import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GLEngineContext } from "@babylonjs/lite-gl";
import { createFillRenderer } from "../src/rendering/fill-renderer.js";
import type { LayerRenderer } from "../src/rendering/layer-renderer.js";
import type { LottieFile } from "../src/animation/lottie-raw.js";
import { parseAnimation } from "../src/animation/parse.js";
import { buildPlayer, renderLottieFrame } from "../src/player/player-core.js";

const glMocks = vi.hoisted(() => ({
    setColorMask: vi.fn(),
    setStencilState: vi.fn(),
}));

vi.mock("@babylonjs/lite-gl", () => ({
    GLBlendMode: { PREMULTIPLIED: 1 },
    bindAttributes: vi.fn(),
    clearEngine: vi.fn(),
    createEffect: vi.fn(() => ({})),
    createGLEngine: vi.fn(),
    createIndexBuffer: vi.fn(() => ({})),
    createVertexBuffer: vi.fn(() => ({})),
    disableScissor: vi.fn(),
    disposeBuffer: vi.fn(),
    disposeEffect: vi.fn(),
    drawIndexed: vi.fn(),
    isEffectReady: vi.fn(() => true),
    setBlendMode: vi.fn(),
    setColorMask: glMocks.setColorMask,
    setCullState: vi.fn(),
    setEffectFloat: vi.fn(),
    setEffectFloat2: vi.fn(),
    setEffectFloat4: vi.fn(),
    setEffectFloatArray: vi.fn(),
    setEffectFloatArray4: vi.fn(),
    setEffectInt: vi.fn(),
    setScissor: vi.fn(),
    setStencilState: glMocks.setStencilState,
    setViewport: vi.fn(),
    updateVertexBuffer: vi.fn(),
    useEffect: vi.fn(),
}));

const path = {
    c: true,
    v: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
    ],
    i: [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
    ],
    o: [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
    ],
};

const transform = {
    o: { a: 0, k: 100 },
    p: { a: 0, k: [0, 0] },
    a: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] },
    r: { a: 0, k: 0 },
};

function shapeLayer(ind: number, color: number[], matte: { td?: number; tt?: number } = {}): object {
    return {
        ind,
        ty: 4,
        nm: `layer ${ind}`,
        ks: transform,
        ip: 0,
        op: 10,
        st: 0,
        ...matte,
        shapes: [
            {
                ty: "gr",
                it: [
                    { ty: "sh", ks: { a: 0, k: path } },
                    { ty: "fl", c: { a: 0, k: color }, o: { a: 0, k: 100 } },
                    { ty: "tr", ...transform },
                ],
            },
        ],
    };
}

function matteDocument(): LottieFile {
    return {
        v: "5.7.0",
        w: 100,
        h: 100,
        ip: 0,
        op: 10,
        fr: 30,
        layers: [shapeLayer(1, [1, 1, 1, 1], { td: 1 }), shapeLayer(2, [1, 0, 0, 1], { tt: 1 }), shapeLayer(3, [0, 0, 1, 1])],
    } as unknown as LottieFile;
}

function mockEngine(): GLEngineContext {
    return {
        canvas: { width: 100, height: 100 },
        gl: {
            ALWAYS: 0x0207,
            BACK: 0x0405,
            DECR_WRAP: 0x8508,
            EQUAL: 0x0202,
            FRONT: 0x0404,
            INCR: 0x1e02,
            INCR_WRAP: 0x8507,
            KEEP: 0x1e00,
            NOTEQUAL: 0x0205,
            REPLACE: 0x1e01,
            ZERO: 0,
        },
    } as unknown as GLEngineContext;
}

describe("alpha track mattes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("pairs a matte consumer with the source layer immediately above it", () => {
        const layers = parseAnimation(matteDocument()).layers;

        expect(layers[0]).toMatchObject({ ind: 1, matteOnly: true });
        expect(layers[1]).toMatchObject({ ind: 2, matteMode: 1, matteSource: 1 });
    });

    it("records the source as the consumer's matte instead of visible content", () => {
        const anim = parseAnimation(matteDocument());
        const events: string[] = [];
        const renderer: LayerRenderer = {
            kind: 4,
            isReady: () => true,
            beginFrame: () => events.push("begin"),
            emitLayer: (layer) => {
                events.push(`emit:${layer.ind}`);
                return layer.ind;
            },
            flush: () => events.push("flush"),
            recordLayer: (token, matteToken?: number) => events.push(`record:${token}:${matteToken ?? -1}`),
            dispose: vi.fn(),
        };
        const player = buildPlayer(mockEngine(), anim, new Map([[4, renderer]]));

        renderLottieFrame(player, 0);

        expect(events).toEqual(["begin", "emit:3", "emit:1", "emit:2", "flush", "record:3:-1", "record:2:1"]);
    });

    it("omits unsupported matte modes instead of rendering the consumer unclipped", () => {
        const document = matteDocument();
        document.layers[1].tt = 3;
        const anim = parseAnimation(document);
        const emitted: number[] = [];
        const renderer: LayerRenderer = {
            kind: 4,
            isReady: () => true,
            beginFrame: vi.fn(),
            emitLayer: (layer) => {
                emitted.push(layer.ind);
                return layer.ind;
            },
            flush: vi.fn(),
            recordLayer: vi.fn(),
            dispose: vi.fn(),
        };
        const player = buildPlayer(mockEngine(), anim, new Map([[4, renderer]]));

        renderLottieFrame(player, 0);

        expect(emitted).toEqual([3]);
    });

    it("uses matte coverage to gate the consumer without painting the source", () => {
        const layers = parseAnimation(matteDocument()).layers;
        const engine = mockEngine();
        const renderer = createFillRenderer(engine);
        const context = { frame: 0, screenW: 100, screenH: 100 };

        renderer.beginFrame(context);
        const matteToken = renderer.emitLayer(layers[0], [1, 0, 0, 1, 0, 0], 1, context);
        const contentToken = renderer.emitLayer(layers[1], [1, 0, 0, 1, 0, 0], 1, context);
        renderer.flush(context);
        (renderer.recordLayer as (token: number, matteToken: number) => void)(contentToken, matteToken);

        const clipState = glMocks.setStencilState.mock.calls.find(([, state]) => state.func === engine.gl.EQUAL && state.ref !== 0 && state.funcMask === state.ref);
        const colorDraws = glMocks.setColorMask.mock.calls.filter(([, r, g, b, a]) => r && g && b && a);
        expect(clipState).toBeDefined();
        expect(colorDraws).toHaveLength(1);

        renderer.dispose();
    });

    it("intersects matte coverage with an existing layer mask", () => {
        const layers = parseAnimation(matteDocument()).layers;
        layers[1].masks = [{ mode: "a", inverted: false, path: { a: 0, k: path } }];
        const engine = mockEngine();
        const renderer = createFillRenderer(engine);
        const context = { frame: 0, screenW: 100, screenH: 100 };

        renderer.beginFrame(context);
        const matteToken = renderer.emitLayer(layers[0], [1, 0, 0, 1, 0, 0], 1, context);
        const contentToken = renderer.emitLayer(layers[1], [1, 0, 0, 1, 0, 0], 1, context);
        renderer.flush(context);
        renderer.recordLayer(contentToken, matteToken);

        expect(glMocks.setStencilState).toHaveBeenCalledWith(engine, expect.objectContaining({ func: engine.gl.EQUAL, ref: 0xc0, funcMask: 0xc0 }));

        renderer.dispose();
    });
});
