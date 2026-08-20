import { describe, expect, it, vi } from "vitest";

import type { EngineContext, RenderingContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";
import { enableDeviceLostSpriteRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-sprite-recovery";
import { createTexture2DFromPixels, createRenderTexture2D } from "../../../packages/babylon-lite/src/texture/pixels-texture";
import { createSprite2DLayer, addSprite2DIndex } from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import { createSprite2DCustomShader } from "../../../packages/babylon-lite/src/sprite/sprite-custom-shader";
import { createGridSpriteAtlas } from "../../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import { createSpriteRenderer, registerSpriteRenderer, setSpriteRendererTarget } from "../../../packages/babylon-lite/src/sprite/sprite-renderer";
import { rebuildRegisteredSpriteRenderers } from "../../../packages/babylon-lite/src/sprite/sprite-recovery";
import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createGlyphStorage } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createTextData } from "../../../packages/babylon-lite/src/text/text-data";
import { updateTextData } from "../../../packages/babylon-lite/src/text/text-data";
import { createTextLayer, createTextRenderer, registerTextRenderer } from "../../../packages/babylon-lite/src/text/text-renderer";
import { rebuildRegisteredTextRenderers } from "../../../packages/babylon-lite/src/text/text-recovery";

interface FakeBuffer extends GPUBuffer {
    readonly _id: number;
    readonly _label: string;
}

interface FakeTexture extends GPUTexture {
    readonly _id: number;
}

interface BufferWrite {
    readonly label: string;
    readonly firstFloat: number;
}

interface FakeDeviceProbe {
    readonly device: GPUDevice;
    readonly bufferWrites: BufferWrite[];
    readonly textureWrites: Uint8Array[];
}

let nextResourceId = 1;

function makeDevice(): FakeDeviceProbe {
    const bufferWrites: BufferWrite[] = [];
    const textureWrites: Uint8Array[] = [];
    const device = {
        features: new Set<GPUFeatureName>(),
        lost: new Promise<GPUDeviceLostInfo>(() => undefined),
        queue: {
            writeBuffer(buffer: FakeBuffer, _offset: number, data: ArrayBuffer, dataOffset = 0): void {
                bufferWrites.push({ label: buffer._label, firstFloat: new Float32Array(data, dataOffset, 1)[0] ?? 0 });
            },
            writeTexture(_destination: GPUTexelCopyTextureInfo, data: Uint8Array): void {
                textureWrites.push(new Uint8Array(data));
            },
        },
        createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
            const size = Number(descriptor.size);
            const buffer = {
                _id: nextResourceId++,
                _label: descriptor.label ?? "",
                destroy: vi.fn(),
                getMappedRange: vi.fn(() => new ArrayBuffer(size)),
                unmap: vi.fn(),
            } as unknown as FakeBuffer;
            return buffer;
        },
        createTexture(): GPUTexture {
            const texture = {
                _id: nextResourceId++,
                createView: vi.fn(() => ({ _textureId: texture._id }) as unknown as GPUTextureView),
                destroy: vi.fn(),
            } as unknown as FakeTexture;
            return texture;
        },
        createSampler: vi.fn(() => ({ _id: nextResourceId++ }) as unknown as GPUSampler),
        createShaderModule: vi.fn(() => ({ _id: nextResourceId++ }) as unknown as GPUShaderModule),
        createBindGroupLayout: vi.fn(() => ({ _id: nextResourceId++ }) as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn(() => ({ _id: nextResourceId++ }) as unknown as GPUPipelineLayout),
        createRenderPipeline: vi.fn(
            () =>
                ({
                    _id: nextResourceId++,
                    getBindGroupLayout: vi.fn(() => ({ _id: nextResourceId++ }) as unknown as GPUBindGroupLayout),
                }) as unknown as GPURenderPipeline
        ),
        createBindGroup: vi.fn(() => ({ _id: nextResourceId++ }) as unknown as GPUBindGroup),
    } as unknown as GPUDevice;
    return { device, bufferWrites, textureWrites };
}

function makeEngine(probe: FakeDeviceProbe): EngineContext {
    const engine = {
        canvas: { width: 320, height: 180 } as HTMLCanvasElement,
        format: "bgra8unorm",
        msaaSamples: 1,
        maxDevicePixelRatio: 1,
        drawCallCount: 0,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: probe.device,
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentDelta: 100,
        _currentEncoder: {} as GPUCommandEncoder,
        _cbs: [],
        scRT: {
            _colorView: {} as GPUTextureView,
            _colorTexture: {} as GPUTexture,
            _depthTexture: null,
            _depthView: null,
            _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 320, height: 180 } },
            _width: 320,
            _height: 180,
            _eager: true,
        },
    } as unknown as EngineContext;
    const surfaces = [engine as unknown as SurfaceContext];
    Object.assign(engine, { engine, surfaces, _surfaces: surfaces });
    return engine;
}

function unrelatedContext(): RenderingContext & { touched: boolean } {
    return {
        _kind: "scene",
        touched: false,
        _drawCallsPre: 0,
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
        _update(): void {
            this.touched = true;
        },
        _record(): number {
            return 0;
        },
    };
}

function glyph(): GlyphCurves {
    return {
        glyphId: 1,
        curves: [{ p0x: 0, p0y: 0, p1x: 4, p1y: 8, p2x: 8, p2y: 0 }],
        bounds: { xMin: 0, yMin: 0, xMax: 8, yMax: 8 },
    };
}

describe("SpriteRenderer device-lost recovery", () => {
    it("rebuilds owned buffers, textures, target view, and FX with a fresh elapsed timer without touching another context kind", async () => {
        const oldProbe = makeDevice();
        const engine = makeEngine(oldProbe);
        const recovery = enableDeviceLostSpriteRecovery(engine);
        const atlasTexture = createTexture2DFromPixels(engine, new Uint8Array([255, 0, 0, 255]), 1, 1);
        const extraTexture = createTexture2DFromPixels(engine, new Uint8Array([0, 255, 0, 255]), 1, 1);
        const target = createRenderTexture2D(engine, 320, 180);
        const atlas = createGridSpriteAtlas(atlasTexture, { cellWidthPx: 1, cellHeightPx: 1 });
        const shader = createSprite2DCustomShader({
            fragment: "return textureSample(extraTex, extraSamp, in.uv) * in.tint;",
            extraTextures: [{ name: "extra", texture: extraTexture }],
        });
        const layer = createSprite2DLayer(atlas, { customShader: shader });
        addSprite2DIndex(layer, { positionPx: [10, 20], sizePx: [16, 16], frame: 0 });
        const renderer = createSpriteRenderer(engine, { layers: [layer], clear: false });
        setSpriteRendererTarget(renderer, target);
        registerSpriteRenderer(renderer);
        const other = unrelatedContext();
        engine._renderingContexts.push(other);
        renderer._update();

        const oldIndex = renderer._indexBuffer;
        const oldLayerGpu = renderer._layerGpu.get(layer)!;
        const oldInstance = oldLayerGpu.instanceBuffer;
        const oldUniform = oldLayerGpu.uniformBuffer;
        const oldFx = oldLayerGpu.fx;
        const oldAtlasTexture = atlasTexture.texture;
        const oldExtraTexture = extraTexture.texture;
        const oldTargetTexture = target.texture;

        const newProbe = makeDevice();
        engine._device = newProbe.device;
        engine._currentDelta = 50;
        await rebuildRegisteredSpriteRenderers(engine);
        renderer._update();

        const rebuiltLayerGpu = renderer._layerGpu.get(layer)!;
        expect(renderer._indexBuffer).not.toBe(oldIndex);
        expect(rebuiltLayerGpu.instanceBuffer).not.toBe(oldInstance);
        expect(rebuiltLayerGpu.uniformBuffer).not.toBe(oldUniform);
        expect(rebuiltLayerGpu.fx).not.toBe(oldFx);
        expect(rebuiltLayerGpu.uploadedVersion).toBe(layer._version);
        expect(atlasTexture.texture).not.toBe(oldAtlasTexture);
        expect(extraTexture.texture).not.toBe(oldExtraTexture);
        expect(target.texture).not.toBe(oldTargetTexture);
        expect(renderer._targetView).toBe(target.view);
        expect(renderer.layers).toEqual([layer]);
        expect(layer.count).toBe(1);
        expect(renderer._clear).toBe(false);
        expect(other.touched).toBe(false);
        expect(newProbe.bufferWrites.find((write) => write.label === "sprite-layer-fx-ubo")?.firstFloat).toBeCloseTo(0.05);
        recovery.disable();
    });
});

describe("TextRenderer device-lost recovery", () => {
    it("rebuilds layer buffers and shared glyph atlases while preserving TextData and layer state", async () => {
        const oldProbe = makeDevice();
        const engine = makeEngine(oldProbe);
        const storage = createGlyphStorage(new Map([["font", new Map([[1, glyph()]])]]));
        const data = createTextData(storage, [{ curveSet: "font", glyphs: [{ glyphId: 1, x: 2, y: 3 }], pixelsPerFontUnit: 1 }]);
        const layer = createTextLayer(data, { positionPx: { x: 12, y: 24 }, opacity: 0.75, coverageGamma: 2 });
        const renderer = createTextRenderer(engine, { layers: [layer], clear: false });
        registerTextRenderer(renderer);
        const other = unrelatedContext();
        engine._renderingContexts.unshift(other);
        renderer._update();

        const atlas = storage._curveSets.get("font")!._atlas;
        const oldAtlasGpu = atlas._gpu!;
        const oldLayerGpu = renderer._layerGpu.get(layer)!;
        const oldUniform = oldLayerGpu._textU;
        const oldInstance = oldLayerGpu._instanceBuf;

        const newProbe = makeDevice();
        engine._device = newProbe.device;
        await rebuildRegisteredTextRenderers(engine);

        const rebuiltLayerGpu = renderer._layerGpu.get(layer)!;
        expect(rebuiltLayerGpu._textU).not.toBe(oldUniform);
        expect(rebuiltLayerGpu._instanceBuf).not.toBe(oldInstance);
        expect(rebuiltLayerGpu._uploadedDataVersion).toBe(data._version);
        expect(rebuiltLayerGpu._pipeline).not.toBeNull();
        expect(atlas._gpu).not.toBe(oldAtlasGpu);
        expect(atlas._gpu?._device).toBe(newProbe.device);
        expect(renderer.layers).toEqual([layer]);
        expect(layer.data).toBe(data);
        expect(layer.positionPx).toEqual({ x: 12, y: 24 });
        expect(layer.opacity).toBe(0.75);
        expect(layer.coverageGamma).toBe(2);
        expect(renderer._clear).toBe(false);
        expect(other.touched).toBe(false);
    });

    it("leaves the per-draw-group bind-group cache consistent when the group list shrank before recovery", async () => {
        const engine = makeEngine(makeDevice());
        const storage = createGlyphStorage(
            new Map([
                ["a", new Map([[1, glyph()]])],
                ["b", new Map([[1, glyph()]])],
            ])
        );
        const runA = { curveSet: "a", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 };
        const runB = { curveSet: "b", glyphs: [{ glyphId: 1, x: 8, y: 0 }], pixelsPerFontUnit: 1 };
        const data = createTextData(storage, [runA, runB]);
        const layer = createTextLayer(data);
        const renderer = createTextRenderer(engine, { layers: [layer] });
        registerTextRenderer(renderer);
        renderer._update();

        expect(renderer._layerGpu.get(layer)!._bindGroupCache.map((e) => e._curveSetId)).toEqual(["a", "b"]);

        // Drop a curve set *before* recovery runs, so the rebuild — not a later `_update()` —
        // is what has to reconcile the cache with the shorter group list. Truncation in
        // `uploadLayer` only shrinks a cache that is longer than the group list, so an entry
        // the rebuild failed to discard would never be trimmed back out.
        updateTextData(data, { update: "reset", runs: [runB] });
        engine._device = makeDevice().device;
        await rebuildRegisteredTextRenderers(engine);

        expect(renderer._layerGpu.get(layer)!._bindGroupCache.map((e) => e._curveSetId)).toEqual(["b"]);
    });
});
