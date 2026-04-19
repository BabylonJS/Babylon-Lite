/**
 * AnchoredSpriteLayer renderable builder.
 *
 * Dynamic-imported by the layer's deferred build hook. Owns the bind group
 * layouts, pipeline cache, per-layer UBO, and the per-frame upload of the
 * packed instance buffer.
 *
 * Bind groups (see docs/architecture/26-sprites.md and
 * `shared/sprite-3d-scene-ubo.ts` for the chosen binding model):
 *   group 0 binding 0 — Sprite3DSceneUBO (viewProjection + camera basis + viewport, 128 B)
 *   group 1 binding 0 — atlas texture
 *   group 1 binding 1 — atlas sampler
 *   group 1 binding 2 — SpriteLayerUBO (32 B, opacity at offset 0)
 */

import type { SceneContext, SceneContextInternal } from "../scene/scene.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { Renderable } from "../render/renderable.js";
import type { AnchoredSpriteLayer } from "./sprite-anchored.js";
import { _tickAnchoredSpriteClips } from "./sprite-anchored.js";
import type { SpriteBlendMode } from "./shared/sprite-atlas.js";
import { syncSpriteStorage, disposeSpriteStorage } from "./shared/sprite-gpu.js";
import { ensureSprite3DSceneUBO } from "./shared/sprite-3d-scene-ubo.js";
import { computeSpriteCentroid, createSpriteSortState, disposeSpriteSortState, syncSpriteSortIndices } from "./shared/sprite-sort.js";
import { composeAnchoredSprite } from "./sprite-anchored-shader.js";
import { createPipelineCache, type PipelineCache, type PipelineCacheEntry } from "../material/pipeline-cache.js";

const SPRITE_LAYER_UBO_BYTES = 32;

interface AnchoredPipelineVariant extends PipelineCacheEntry {
    pipeline: GPURenderPipeline;
    sceneBGL: GPUBindGroupLayout;
    layerBGL: GPUBindGroupLayout;
}

let _cache: PipelineCache<AnchoredPipelineVariant> | null = null;
function getCache(): PipelineCache<AnchoredPipelineVariant> {
    if (!_cache) {
        _cache = createPipelineCache();
    }
    return _cache;
}

function blendState(mode: SpriteBlendMode): GPUBlendState | undefined {
    switch (mode) {
        case "alpha":
            return {
                color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case "premultiplied":
            return {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case "additive":
            return {
                color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            };
        case "multiply":
            return {
                color: { srcFactor: "dst", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case "cutout":
            return undefined;
    }
}

function pipelineKey(format: GPUTextureFormat, msaaSamples: number, layer: AnchoredSpriteLayer): string {
    return `sa|${format}|${msaaSamples}|${layer.blendMode}|${layer.pixelSnap ? 1 : 0}|${layer.depthTest ? 1 : 0}|${layer.alphaCutoff.toFixed(4)}`;
}

function getOrCreatePipeline(engine: EngineContextInternal, format: GPUTextureFormat, msaaSamples: number, layer: AnchoredSpriteLayer): AnchoredPipelineVariant {
    const cache = getCache();
    cache.ensureDevice(engine);
    const key = pipelineKey(format, msaaSamples, layer);
    const hit = cache.getOrIncRef(key);
    if (hit) {
        return hit;
    }
    const device = engine.device;
    const composed = composeAnchoredSprite({ pixelSnap: layer.pixelSnap, blendMode: layer.blendMode, alphaCutoff: layer.alphaCutoff });

    const sceneBGL = device.createBindGroupLayout({
        label: "sprite-anchored-scene-bgl",
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const layerBGL = device.createBindGroupLayout({
        label: "sprite-anchored-layer-bgl",
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            // Per blocker 4 of 26-sprites.md — packed sprite data lives in a
            // storage buffer; per-instance vertex attribute is just the sort index.
            { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        ],
    });

    const vertModule = device.createShaderModule({ code: composed.vertexWGSL, label: "sprite-anchored-vert" });
    const fragModule = device.createShaderModule({ code: composed.fragmentWGSL, label: "sprite-anchored-frag" });

    // Per-instance buffer = Uint32 sort indirection (4 B per instance). The
    // packed sprite data lives in the storage buffer at @group(1) @binding(3).
    const instanceLayout: GPUVertexBufferLayout = {
        arrayStride: 4,
        stepMode: "instance",
        attributes: [{ shaderLocation: 0, offset: 0, format: "uint32" }],
    };

    const isCutout = layer.blendMode === "cutout";
    const colorTarget: GPUColorTargetState = { format, blend: blendState(layer.blendMode) };

    const pipelineDesc: GPURenderPipelineDescriptor = {
        label: "sprite-anchored-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBGL, layerBGL] }),
        vertex: { module: vertModule, entryPoint: "vs_main", buffers: [instanceLayout] },
        fragment: { module: fragModule, entryPoint: "fs_main", targets: [colorTarget] },
        primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
        multisample: { count: msaaSamples },
        depthStencil: {
            format: "depth24plus-stencil8",
            depthCompare: layer.depthTest ? "less-equal" : "always",
            // Cutout writes depth (opaque queue); blended modes do not.
            depthWriteEnabled: isCutout,
        },
    };
    const pipeline = device.createRenderPipeline(pipelineDesc);

    const variant: AnchoredPipelineVariant = { pipeline, sceneBGL, layerBGL, refCount: 1 };
    cache.set(key, variant);
    return variant;
}

/**
 * Build the renderable for an AnchoredSpriteLayer and register it with the scene.
 * Called from the layer's deferred build hook (dynamic-imported).
 */
export async function buildAnchoredSpriteRenderable(layer: AnchoredSpriteLayer, scene: SceneContext): Promise<void> {
    const ctx = scene as SceneContextInternal;
    const engine = ctx.engine as EngineContextInternal;

    // Per-frame clip tick — register once per layer. Use `unshift` (not push)
    // so the tick runs BEFORE user-registered `onBeforeRender` callbacks, which
    // matches the Sprite2D convention. This ensures freeze-flag user callbacks
    // observe the fully-advanced clip state on the freeze frame (otherwise the
    // clip loses one tick of animation on the frame that sets `animationFrozen`).
    ctx._beforeRender.unshift((dt) => _tickAnchoredSpriteClips(layer, dt));

    // Shared per-scene Sprite3DSceneUBO (created lazily, registered once).
    const sceneUBO = ensureSprite3DSceneUBO(scene);

    const variant = getOrCreatePipeline(engine, engine.format, engine.msaaSamples, layer);
    const device = engine.device;

    const layerUBO = device.createBuffer({
        label: "sprite-anchored-layer-ubo",
        size: SPRITE_LAYER_UBO_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layerScratch = new Float32Array(SPRITE_LAYER_UBO_BYTES / 4);

    const sceneBG = device.createBindGroup({
        label: "sprite-anchored-scene-bg",
        layout: variant.sceneBGL,
        entries: [{ binding: 0, resource: { buffer: sceneUBO } }],
    });

    const isCutout = layer.blendMode === "cutout";

    // Per blocker 4 — separate sort indirection buffer + storage buffer rebind on
    // capacity grow. Cutout uses sequential indirection (no per-frame back-to-front sort).
    const sortState = createSpriteSortState(!isCutout);
    let layerBG: GPUBindGroup | null = null;
    let cachedStorageBuffer: GPUBuffer | null = null;
    function rebuildLayerBG(storageBuffer: GPUBuffer): void {
        layerBG = device.createBindGroup({
            label: "sprite-anchored-layer-bg",
            layout: variant.layerBGL,
            entries: [
                { binding: 0, resource: layer.atlas.texture.view },
                { binding: 1, resource: layer.atlas.texture.sampler },
                { binding: 2, resource: { buffer: layerUBO } },
                { binding: 3, resource: { buffer: storageBuffer } },
            ],
        });
        cachedStorageBuffer = storageBuffer;
    }

    const renderable: Renderable = {
        // Cutout = opaque queue (110 + order); blended = transparent queue (210 + order).
        order: (isCutout ? 110 : 210) + layer.order,
        isTransparent: !isCutout,
        _pipeline: variant.pipeline,
        _sceneBG: sceneBG,
        // Anchor world-Z is computed per-frame for the transparent sort path.
        _worldCenter: [0, 0, 0],
        updateUBOs(): void {
            layerScratch[0] = layer.opacity;
            device.queue.writeBuffer(layerUBO, 0, layerScratch.buffer, layerScratch.byteOffset, SPRITE_LAYER_UBO_BYTES);
            syncSpriteStorage(engine, layer._storage, "sprite-anchored-instances");
            if (layer._storage.gpuBuffer && layer._storage.gpuBuffer !== cachedStorageBuffer) {
                rebuildLayerBG(layer._storage.gpuBuffer);
            }
            const cam = ctx.camera;
            const wm = cam ? cam.worldMatrix : null;
            const cx = wm ? wm[12]! : 0;
            const cy = wm ? wm[13]! : 0;
            const cz = wm ? wm[14]! : 0;
            syncSpriteSortIndices(engine, sortState, layer._storage, layer._sortVersion, cx, cy, cz, "sprite-anchored-sort");
            const c = computeSpriteCentroid(sortState, layer._storage);
            this._worldCenter![0] = c[0];
            this._worldCenter![1] = c[1];
            this._worldCenter![2] = c[2];
        },
        draw(pass): number {
            if (!layer.visible || layer._storage.count === 0 || !layer._storage.gpuBuffer || !layerBG || !sortState.indexBuffer) {
                return 0;
            }
            pass.setBindGroup(1, layerBG);
            pass.setVertexBuffer(0, sortState.indexBuffer);
            pass.draw(6, layer._storage.count);
            return 1;
        },
    };

    ctx._renderables.push(renderable);
    ctx._disposables.push(() => {
        layerUBO.destroy();
        disposeSpriteSortState(sortState);
        disposeSpriteStorage(layer._storage);
    });
}
