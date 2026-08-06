import { afterEach, describe, expect, it, vi } from "vitest";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { mat4Identity } from "../../../packages/babylon-lite/src/math/mat4";
import { createParticleBuffer } from "../../../packages/babylon-lite/src/particle/particle-buffer";
import { createParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import { particleTextureSourceBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/texture-source-block";
import { applyFlowMapToParticle, updateFlowMapBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/update-flow-map-block";
import type { NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { loadNpeTextureContent } from "../../../packages/babylon-lite/src/particle/node/npe-texture-content";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { NpeGetter, NpeTextureContent, NpeTextureValue } from "../../../packages/babylon-lite/src/particle/node/npe-value";

function flowMap(data: number[]): NpeTextureContent {
    return { width: 2, height: 2, data: new Uint8ClampedArray(data) };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("NPE UpdateFlowMapBlock", () => {
    it("samples projected RGBA flow with alpha-weighted strength", () => {
        const map = flowMap([255, 128, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const buffer = createParticleBuffer(1);
        const screen = { x: 0, y: 0, z: 0 };
        buffer.posX[0] = -0.5;
        buffer.posY[0] = 0.5;
        buffer.dirX[0] = 1;

        applyFlowMapToParticle(map, mat4Identity(), 2, buffer, 0, screen);

        const scale = 2 * (128 / 255);
        expect(buffer.dirX[0]).toBeCloseTo(1 + scale, 6);
        expect(buffer.dirY[0]).toBeCloseTo((1 / 255) * scale, 6);
        expect(buffer.dirZ[0]).toBeCloseTo(-scale, 6);
    });

    it("rejects samples outside the screen and ignores transparent pixels", () => {
        const map = flowMap([255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
        const buffer = createParticleBuffer(1);
        const screen = { x: 0, y: 0, z: 0 };
        buffer.posX[0] = -0.5;
        buffer.posY[0] = 0.5;
        buffer.dirX[0] = 3;

        applyFlowMapToParticle(map, mat4Identity(), 4, buffer, 0, screen);
        expect(buffer.dirX[0]).toBe(3);

        buffer.posX[0] = 1;
        applyFlowMapToParticle(map, mat4Identity(), 4, buffer, 0, screen);
        expect(buffer.dirX[0]).toBe(3);
    });

    it("evaluates strength per particle and applies the current scaled step", async () => {
        const system = createParticleSystem(1);
        const map: NpeTextureContent = { width: 1, height: 1, data: new Uint8ClampedArray([255, 128, 128, 255]) };
        const source: NpeTextureValue = {
            url: "flow.png",
            invertY: false,
            _content: Promise.resolve(map),
        };
        const camera = createArcRotateCamera(0, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        const promises: Promise<void>[] = [];
        let strength = 8;
        let strengthCalls = 0;
        const ctx = {
            state: {
                system,
                buffer: system.buffer,
                scene: { camera, surface: { canvas: { width: 100, height: 100 } } },
            },
            input(_block: ParsedParticleBlock, name: string): NpeGetter<NpeTextureValue> | NpeGetter {
                if (name === "flowMap") {
                    return () => source;
                }
                return () => {
                    strengthCalls++;
                    return strength;
                };
            },
            addBuildPromise(promise: Promise<void>) {
                promises.push(promise);
            },
        } as unknown as NpeBuildContext;
        const block = { id: 1, className: "UpdateFlowMapBlock", name: "flow", inputs: [], serialized: {} } as ParsedParticleBlock;

        updateFlowMapBlock.build(block, ctx);
        await Promise.all(promises);

        system._scaledStep = 0.25;
        system.updateSteps[0]!(0);
        strength = 4;
        system._scaledStep = 0.5;
        system.updateSteps[0]!(0);

        expect(system.buffer.dirX[0]).toBeCloseTo(4, 6);
        expect(strengthCalls).toBe(2);
    });

    it("caches converter-style data URL decoding and honors invertY", async () => {
        const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
        const setTransform = vi.fn();
        const drawImage = vi.fn();
        const getImageData = vi.fn(() => ({ data }));
        const context = { setTransform, drawImage, getImageData };
        const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => ({}) }));
        const close = vi.fn();
        const createImageBitmapMock = vi.fn(async () => ({ width: 2, height: 1, close }));
        const OffscreenCanvasMock = vi.fn(function (this: { getContext: () => typeof context }) {
            this.getContext = () => context;
        });
        vi.stubGlobal("fetch", fetchMock);
        vi.stubGlobal("createImageBitmap", createImageBitmapMock);
        vi.stubGlobal("OffscreenCanvas", OffscreenCanvasMock);
        const source = { url: "data:image/png;base64,AA==", invertY: true } as NpeTextureValue;

        const first = loadNpeTextureContent(source);
        const second = loadNpeTextureContent(source);

        expect(second).toBe(first);
        await expect(first).resolves.toEqual({ width: 2, height: 1, data });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(createImageBitmapMock).toHaveBeenCalledWith(expect.anything(), {
            premultiplyAlpha: "none",
            colorSpaceConversion: "none",
        });
        expect(setTransform).toHaveBeenCalledWith(1, 0, 0, -1, 0, 1);
        expect(drawImage).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });

    it("prefers serialized textureDataUrl for a texture output", () => {
        const block = {
            id: 3,
            className: "ParticleTextureSourceBlock",
            name: "flow texture",
            inputs: [],
            serialized: { url: "fallback.png", textureDataUrl: "data:image/png;base64,AA==", invertY: true },
        } as ParsedParticleBlock;
        let output: NpeGetter<NpeTextureValue> | undefined;
        const ctx = {
            state: { textureBaseUrl: "https://example.test/textures/", billboardTextureBlockId: 2 },
            setOutput(_blockId: number, _name: string, getter: NpeGetter<NpeTextureValue>) {
                output = getter;
            },
        } as unknown as NpeBuildContext;

        particleTextureSourceBlock.build(block, ctx);

        expect(output?.(0)).toMatchObject({ url: "data:image/png;base64,AA==", invertY: true });
    });
});
