import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GLEngineContext } from "@babylonjs/lite-gl";
import { createFillRenderer } from "../src/rendering/fill-renderer.js";
import type { ParsedLayer } from "../src/animation/parse.js";

const glMocks = vi.hoisted(() => ({
    setEffectFloatArray: vi.fn(),
    setEffectFloatArray4: vi.fn(),
    setEffectInt: vi.fn(),
}));

vi.mock("@babylonjs/lite-gl", () => ({
    GLBlendMode: { PREMULTIPLIED: 1 },
    bindAttributes: vi.fn(),
    createEffect: vi.fn(() => ({})),
    createIndexBuffer: vi.fn(() => ({})),
    createVertexBuffer: vi.fn(() => ({})),
    disposeBuffer: vi.fn(),
    disposeEffect: vi.fn(),
    drawIndexed: vi.fn(),
    isEffectReady: vi.fn(() => true),
    setBlendMode: vi.fn(),
    setColorMask: vi.fn(),
    setCullState: vi.fn(),
    setEffectFloat: vi.fn(),
    setEffectFloat2: vi.fn(),
    setEffectFloat4: vi.fn(),
    setEffectFloatArray: glMocks.setEffectFloatArray,
    setEffectFloatArray4: glMocks.setEffectFloatArray4,
    setEffectInt: glMocks.setEffectInt,
    setStencilState: vi.fn(),
    updateVertexBuffer: vi.fn(),
    useEffect: vi.fn(),
}));

const OFFSETS = [0, 0.028, 0.055, 0.128, 0.2, 0.498, 0.795, 0.898, 1];
const COLORS = OFFSETS.map((offset) => [offset, 1 - offset, 0.5, 1]);

function createGradientLayer(): ParsedLayer {
    const zero = { a: 0, k: [0, 0] } as const;
    return {
        kind: 4,
        ind: 1,
        name: "nine-stop gradient",
        transform: {},
        ip: 0,
        op: 1,
        st: 0,
        ops: [
            {
                contours: [
                    {
                        path: {
                            a: 0,
                            k: {
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
                            },
                        },
                    },
                ],
                transforms: [{}],
                paint: {
                    kind: "linear",
                    start: zero,
                    end: { a: 0, k: [100, 0] },
                    stops: { count: OFFSETS.length, data: { a: 0, k: OFFSETS.flatMap((offset, index) => [offset, ...COLORS[index].slice(0, 3)]) } },
                },
            },
        ],
    };
}

function mockEngine(): GLEngineContext {
    return {
        gl: {
            ALWAYS: 0x0207,
            BACK: 0x0405,
            DECR_WRAP: 0x8508,
            FRONT: 0x0404,
            INCR_WRAP: 0x8507,
            KEEP: 0x1e00,
            NOTEQUAL: 0x0205,
            ZERO: 0,
        },
    } as unknown as GLEngineContext;
}

describe("gradient stop uploads", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uploads every stop of a nine-stop gradient", () => {
        const renderer = createFillRenderer(mockEngine());
        const context = { frame: 0, screenW: 100, screenH: 100 };

        renderer.beginFrame(context);
        const token = renderer.emitLayer(createGradientLayer(), [1, 0, 0, 1, 0, 0], 1, context);
        renderer.flush(context);
        renderer.recordLayer(token);

        const stopCountCall = glMocks.setEffectInt.mock.calls.find((call) => call[2] === "uStopCount");
        const offsetCall = glMocks.setEffectFloatArray.mock.calls.find((call) => call[2] === "uOffsets");
        const colorCall = glMocks.setEffectFloatArray4.mock.calls.find((call) => call[2] === "uColors");
        const uploadedOffsets = offsetCall?.[3] as Float32Array;
        const uploadedColors = colorCall?.[3] as Float32Array;

        expect(stopCountCall?.[3]).toBe(OFFSETS.length);
        expect(uploadedOffsets.length).toBeGreaterThanOrEqual(OFFSETS.length);
        expect(Array.from(uploadedOffsets.slice(0, OFFSETS.length))).toEqual(OFFSETS.map((value) => Math.fround(value)));
        expect(uploadedColors.length).toBeGreaterThanOrEqual(COLORS.length * 4);
        expect(Array.from(uploadedColors.slice(0, COLORS.length * 4))).toEqual(COLORS.flat().map((value) => Math.fround(value)));

        renderer.dispose();
    });

    it("interpolates animated gradient colors at the current frame", () => {
        const layer = createGradientLayer();
        const paint = layer.ops[0].paint;
        if (paint.kind === "solid" || paint.kind === "stroke") {
            throw new Error("expected gradient paint");
        }
        const start = [0, 1, 0.8, 0.2, 1, 0.2, 0.7, 0.3];
        const end = [0, 0.8, 0.2, 0.8, 1, 0.1, 0.7, 0.9];
        paint.stops = {
            count: 2,
            data: {
                a: 1,
                k: [
                    { t: 0, s: start, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
                    { t: 30, s: end },
                ],
            },
        };
        const renderer = createFillRenderer(mockEngine());
        const context = { frame: 15, screenW: 100, screenH: 100 };

        renderer.beginFrame(context);
        const token = renderer.emitLayer(layer, [1, 0, 0, 1, 0, 0], 1, context);
        renderer.flush(context);
        renderer.recordLayer(token);

        const colorCall = glMocks.setEffectFloatArray4.mock.calls.find((call) => call[2] === "uColors");
        const uploaded = Array.from((colorCall?.[3] as Float32Array).slice(0, 8));
        const expected = [0.9, 0.5, 0.5, 1, 0.15, 0.7, 0.6, 1].map((value) => Math.fround(value));
        expect(uploaded).toEqual(expected);

        renderer.dispose();
    });
});
