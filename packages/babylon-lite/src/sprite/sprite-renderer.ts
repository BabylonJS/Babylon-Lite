/**
 * `SpriteRenderer` — owns the WGSL, pipeline cache, shared index buffer,
 * and per-layer GPU state required to draw `Sprite2DLayer`s. Implements
 * `RenderingContext` directly, so it plugs into `engine._renderingContexts`
 * the same way a `SceneContext` does.
 *
 * PR 1 scope (intentionally minimal):
 *   - Pure-2D path only — no `SceneContext`, no camera, no lights.
 *   - One pipeline cache per renderer instance, keyed on
 *     `(sampleCount << 8) | (blendMode << 4) | (hasDepth ? 1 : 0)`. PR 1
 *     populates at most two keys (alpha + premultiplied), both with
 *     `hasDepth=0` and the engine's MSAA sample count.
 *   - The renderer draws **into the engine's shared pass** — it does not
 *     own a render target. Off-screen / HUD-to-texture rendering and
 *     per-renderer MSAA / depth attachments are deferred to a later PR;
 *     the relevant fields will be re-added to `SpriteRendererOptions`
 *     when that work lands. See `docs/sprites/pr1-pure-2d-sprites-scope.md`.
 */
import type { EngineContext, EngineContextInternal, RenderingContext } from "../engine/engine.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { INSTANCE_STRIDE_BYTES } from "./sprite-2d.js";
import type { SpriteBlendMode } from "./shared/sprite-atlas.js";

/** Tag used by the engine and by tests to identify a sprite renderer. */
const KIND = "sprite-renderer" as const;

/** Options accepted by `createSpriteRenderer`. */
export interface SpriteRendererOptions {
    /** Layers to draw, in registration order. The renderer also re-sorts internally each frame. */
    layers: Sprite2DLayer[];
    /** Default `{ r: 0, g: 0, b: 0, a: 1 }`. */
    clearValue?: GPUColorDict;
}

/**
 * A `SpriteRenderer` — pure data, plugs into `engine._renderingContexts`.
 * Inherits `clearColor`, `_drawCallsPre`, `_update`, `_record` from `RenderingContext`;
 * adds only its discriminator tag and the mutable layer list.
 */
export interface SpriteRenderer extends RenderingContext {
    readonly _kind: typeof KIND;
    /** Mutable: callers may push / splice layers between frames. */
    layers: Sprite2DLayer[];
}

/** @internal A single cached pipeline + its bind group layout. */
interface PipelineEntry {
    pipeline: GPURenderPipeline;
    bgl: GPUBindGroupLayout;
}

/** @internal Per-layer GPU resources owned by the renderer. */
interface LayerGpu {
    layer: Sprite2DLayer;
    instanceBuffer: GPUBuffer;
    instanceBufferCapacity: number;
    uniformBuffer: GPUBuffer;
    /** Built once per layer; the bind group binds the uniform buffer + atlas texture/sampler,
     *  none of which change after construction (atlas is `readonly` on the layer; uniform
     *  buffer is allocated once in `ensureLayerGpu`). Cleared if we ever recreate either. */
    bindGroup: GPUBindGroup | null;
    uploadedVersion: number;
}

interface SpriteRendererInternal extends SpriteRenderer {
    _engine: EngineContextInternal;
    _device: GPUDevice;
    _format: GPUTextureFormat;
    _msaa: number;
    _shaderModule: GPUShaderModule;
    _indexBuffer: GPUBuffer;
    _pipelineCache: Map<number, PipelineEntry>;
    _layerGpu: Map<Sprite2DLayer, LayerGpu>;
    /** Captured each `_update`, read in `_record`. */
    _targetWidth: number;
    _targetHeight: number;
    _disposed: boolean;
}

const LAYER_UBO_BYTES = 48;
const SHARED_INDEX_DATA: Readonly<Uint16Array> = new Uint16Array([0, 1, 2, 0, 2, 3]);

const WGSL_SHADER = `struct Layer {
viewPos: vec2<f32>,
viewScale: f32,
viewRot: f32,
screenSize: vec2<f32>,
pivot: vec2<f32>,
// Per-layer opacity, pre-shaped for the layer's blend mode (CPU-side):
//   straight-alpha:  (1, 1, 1, opacity)  — only alpha is scaled
//   premultiplied:   (opacity, opacity, opacity, opacity) — RGB and A scale together
// One uniform, no shader branch.
opacityMul: vec4<f32>,
};
@group(0) @binding(0) var<uniform> L: Layer;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSamp: sampler;
struct VIn {
@builtin(vertex_index) vid: u32,
@location(0) iPos: vec2<f32>,
@location(1) iSize: vec2<f32>,
@location(2) iUvMin: vec2<f32>,
@location(3) iUvMax: vec2<f32>,
@location(4) iRot: f32,
@location(5) iColor: vec4<f32>,
};
struct VOut {
@builtin(position) pos: vec4<f32>,
@location(0) uv: vec2<f32>,
@location(1) tint: vec4<f32>,
};
@vertex
fn vs(in: VIn) -> VOut {
var corners = array<vec2<f32>, 4>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));
let c = corners[in.vid];
let local = (c - L.pivot) * in.iSize;
let cr = cos(in.iRot);
let sr = sin(in.iRot);
let rotated = vec2<f32>(local.x * cr - local.y * sr, local.x * sr + local.y * cr);
let layerPx = in.iPos + rotated;
let centered = layerPx - L.viewPos;
let lc = cos(L.viewRot);
let ls = sin(L.viewRot);
let viewRot = vec2<f32>(centered.x * lc - centered.y * ls, centered.x * ls + centered.y * lc);
let screenPx = viewRot * L.viewScale;
let ndc = vec2<f32>(screenPx.x / L.screenSize.x * 2.0 - 1.0, 1.0 - screenPx.y / L.screenSize.y * 2.0);
let uv = mix(in.iUvMin, in.iUvMax, c);
var out: VOut;
out.pos = vec4<f32>(ndc, 0.0, 1.0);
out.uv = uv;
out.tint = in.iColor;
return out;
}
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
let s = textureSample(atlasTex, atlasSamp, in.uv);
return s * in.tint * L.opacityMul;
}`;

/**
 * Single source of truth for blend-mode → (key index, GPU descriptor). Adding a new
 * mode is one entry here. The pipeline-cache key uses `index` (4 bits, room for 16
 * modes); `descriptor` is what the pipeline factory hands to WebGPU.
 */
const BLEND_MODE_TABLE: Readonly<Record<SpriteBlendMode, { index: number; descriptor: GPUBlendState }>> = {
    // Straight-alpha source. Matches BJS `ALPHA_COMBINE`.
    alpha: {
        index: 0,
        descriptor: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
    },
    // Premultiplied source (RGB already multiplied by A on the CPU or at decode).
    premultiplied: {
        index: 1,
        descriptor: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
    },
    // Forward-compat — layer factory throws on these in PR 1, but the descriptors
    // are wired so adding support is a one-line removal of the throw.
    additive: {
        index: 2,
        descriptor: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        },
    },
    multiply: {
        index: 3,
        descriptor: {
            color: { srcFactor: "dst", dstFactor: "zero", operation: "add" },
            alpha: { srcFactor: "dst-alpha", dstFactor: "zero", operation: "add" },
        },
    },
    cutout: {
        // Alpha-tested; blend descriptor is irrelevant (fragment discards), but the
        // pipeline still needs one. Behave like `alpha` for the rare blended pixel.
        index: 4,
        descriptor: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
    },
};

/**
 * Pack the three pipeline-distinguishing knobs into one integer cache key.
 * Layout: `(sampleCount << 8) | (blendIndex << 4) | hasDepthBit`. Two layers with the
 * same key share a `GPURenderPipeline`; two with different keys must each compile one.
 */
function pipelineKey(sampleCount: number, blendMode: SpriteBlendMode, hasDepth: boolean): number {
    return (sampleCount << 8) | (BLEND_MODE_TABLE[blendMode].index << 4) | (hasDepth ? 1 : 0);
}

/**
 * Compile one render pipeline for a specific (blendMode, hasDepth) combination + the
 * renderer's MSAA. Bundles the bind-group layout, vertex layout (40-byte instance stride),
 * fragment blend descriptor, and depth-stencil settings into an immutable GPU object.
 * Expensive (driver lowers shaders to native code); call only on cache miss.
 */
function buildPipeline(rr: SpriteRendererInternal, blendMode: SpriteBlendMode, hasDepth: boolean): PipelineEntry {
    const bgl = rr._device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
    });
    const layout = rr._device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const pipeline = rr._device.createRenderPipeline({
        layout,
        vertex: {
            module: rr._shaderModule,
            entryPoint: "vs",
            buffers: [
                {
                    arrayStride: INSTANCE_STRIDE_BYTES,
                    stepMode: "instance",
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: "float32x2" }, // positionPx
                        { shaderLocation: 1, offset: 8, format: "float32x2" }, // sizePx
                        { shaderLocation: 2, offset: 16, format: "float32x2" }, // uvMin
                        { shaderLocation: 3, offset: 24, format: "float32x2" }, // uvMax
                        { shaderLocation: 4, offset: 32, format: "float32" }, // rotation
                        { shaderLocation: 5, offset: 36, format: "unorm8x4" }, // color (RGBA8)
                    ],
                },
            ],
        },
        fragment: {
            module: rr._shaderModule,
            entryPoint: "fs",
            targets: [{ format: rr._format, blend: BLEND_MODE_TABLE[blendMode].descriptor, writeMask: GPUColorWrite.ALL }],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        // Engine pass always has a depth-stencil attachment; we must declare one even when
        // we don't use it. PR 1 keeps depth disabled for every layer (`depth: "none"`).
        depthStencil: {
            format: "depth24plus-stencil8",
            depthCompare: hasDepth ? "less-equal" : "always",
            depthWriteEnabled: false,
        },
        multisample: { count: rr._msaa },
    });
    return { pipeline, bgl };
}

/**
 * Cached `buildPipeline`. Returns the existing entry for `(msaa, blendMode, hasDepth)`
 * if present; otherwise builds, caches, and returns. Hot-path safe — every layer calls
 * this every frame in `_record`.
 */
function getOrBuildPipeline(rr: SpriteRendererInternal, blendMode: SpriteBlendMode, hasDepth: boolean): PipelineEntry {
    const key = pipelineKey(rr._msaa, blendMode, hasDepth);
    let entry = rr._pipelineCache.get(key);
    if (!entry) {
        entry = buildPipeline(rr, blendMode, hasDepth);
        rr._pipelineCache.set(key, entry);
    }
    return entry;
}

/**
 * Lazy GPU-resource provisioner for one layer. On first sight: allocates the per-instance
 * vertex buffer + the 48 B layer UBO and stashes a `LayerGpu` record in `_layerGpu`. On
 * subsequent calls where the layer's CPU `_capacity` outgrew the GPU buffer (after
 * `growCapacity` doubled the array): destroys + reallocates the instance buffer at the
 * new size and forces a full re-upload via `uploadedVersion = -1`. The bind group is
 * left intact — it doesn't reference the instance buffer (vertex buffers are bound
 * separately at draw time), only the uniform buffer + atlas, neither of which moves.
 */
function ensureLayerGpu(rr: SpriteRendererInternal, layer: Sprite2DLayer): LayerGpu {
    let lg = rr._layerGpu.get(layer);
    if (!lg) {
        const cap = layer._capacity;
        const instanceBuffer = rr._device.createBuffer({
            size: cap * INSTANCE_STRIDE_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        const uniformBuffer = rr._device.createBuffer({
            size: LAYER_UBO_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        lg = {
            layer,
            instanceBuffer,
            instanceBufferCapacity: cap,
            uniformBuffer,
            bindGroup: null,
            uploadedVersion: -1,
        };
        rr._layerGpu.set(layer, lg);
    }
    if (lg.instanceBufferCapacity < layer._capacity) {
        lg.instanceBuffer.destroy();
        lg.instanceBuffer = rr._device.createBuffer({
            size: layer._capacity * INSTANCE_STRIDE_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        lg.instanceBufferCapacity = layer._capacity;
        lg.uploadedVersion = -1;
    }
    return lg;
}

/**
 * Sync one layer's GPU state to its CPU state. Two uploads, two strategies:
 *  1. **Per-instance vertex data** — version-gated and incremental: skip if `_version`
 *     unchanged; otherwise upload `[0, count)` on first sight (`uploadedVersion === -1`)
 *     or just `[_dirtyMin, min(_dirtyMax, count))` on subsequent edits. Resets the dirty
 *     range and bumps `uploadedVersion` after upload.
 *  2. **Per-layer UBO** — always rewrites all 48 B. The view (camera) and target dims
 *     can change without going through any setter, so version-tracking would buy nothing.
 *     Tiny (one `writeBuffer`), so unconditional is simpler than dirty-tracking.
 */
function uploadLayer(rr: SpriteRendererInternal, lg: LayerGpu): void {
    const layer = lg.layer;
    if (lg.uploadedVersion !== layer._version && layer.count > 0) {
        // First sight (or post-grow `uploadedVersion = -1`): upload the whole live range.
        // Subsequent: upload only the dirty span, clamped to live count (a `remove` may have
        // marked a slot beyond `count` as dirty; that data is no longer live).
        let lo: number;
        let hi: number;
        if (lg.uploadedVersion === -1) {
            lo = 0;
            hi = layer.count;
        } else {
            lo = layer._dirtyMin;
            hi = Math.min(layer._dirtyMax, layer.count);
        }
        if (hi > lo) {
            const offsetBytes = lo * INSTANCE_STRIDE_BYTES;
            const bytes = (hi - lo) * INSTANCE_STRIDE_BYTES;
            rr._device.queue.writeBuffer(lg.instanceBuffer, offsetBytes, layer._instanceData.buffer, layer._instanceData.byteOffset + offsetBytes, bytes);
        }
        layer._dirtyMin = 0;
        layer._dirtyMax = 0;
        lg.uploadedVersion = layer._version;
    }

    // Layer UBO — small + cheap; rewrite each frame so view / opacity / target dims stay in sync.
    // Float layout matches the WGSL `Layer` struct (48 B total, 12 floats):
    //   [0..1]  viewPos.xy   [2] viewScale   [3] viewRot
    //   [4..5]  screenSize.xy   [6..7] pivot.xy
    //   [8..11] opacityMul.rgba  (per-blend-mode pre-shaped, see WGSL `Layer` struct)
    const ubo = _scratchUbo;
    ubo[0] = layer.view.positionPx[0];
    ubo[1] = layer.view.positionPx[1];
    ubo[2] = layer.view.zoom;
    ubo[3] = layer.view.rotation;
    ubo[4] = rr._targetWidth;
    ubo[5] = rr._targetHeight;
    ubo[6] = layer.pivot[0];
    ubo[7] = layer.pivot[1];
    // Premultiplied sources need RGB *and* A scaled by opacity for a correct fade;
    // straight-alpha needs only A scaled (the blend stage already uses src.a as the factor).
    const op = layer.opacity;
    if (layer.blendMode === "premultiplied") {
        ubo[8] = op;
        ubo[9] = op;
        ubo[10] = op;
        ubo[11] = op;
    } else {
        ubo[8] = 1;
        ubo[9] = 1;
        ubo[10] = 1;
        ubo[11] = op;
    }
    rr._device.queue.writeBuffer(lg.uniformBuffer, 0, ubo.buffer, ubo.byteOffset, LAYER_UBO_BYTES);
}

const _scratchUbo = new Float32Array(LAYER_UBO_BYTES / 4);

/**
 * Build (and cache) the bind group that attaches `lg.uniformBuffer` + atlas texture +
 * sampler to the pipeline's `@group(0)` schema. All three resources are immutable for
 * the layer's lifetime, so this runs at most once per layer; subsequent calls return
 * the cached group. The instance buffer is **not** in the bind group — it's a vertex
 * buffer, bound separately at draw time — which is why instance-buffer growth in
 * `ensureLayerGpu` doesn't invalidate this cache.
 */
function ensureBindGroup(rr: SpriteRendererInternal, lg: LayerGpu, entry: PipelineEntry): GPUBindGroup {
    if (lg.bindGroup) {
        return lg.bindGroup;
    }
    const tex = lg.layer.atlas.texture;
    lg.bindGroup = rr._device.createBindGroup({
        layout: entry.bgl,
        entries: [
            { binding: 0, resource: { buffer: lg.uniformBuffer } },
            { binding: 1, resource: tex.view },
            { binding: 2, resource: tex.sampler },
        ],
    });
    return lg.bindGroup;
}

/** Sort key for layers within a renderer: ascending `order` (back-to-front draw order). */
function compareLayers(a: Sprite2DLayer, b: Sprite2DLayer): number {
    if (a.order !== b.order) {
        return a.order - b.order;
    }
    return 0;
}

/** Create a `SpriteRenderer` for `engine`, pre-warming pipelines for the layers' blend modes. */
export function createSpriteRenderer(engine: EngineContext, opts: SpriteRendererOptions): SpriteRenderer {
    const eng = engine as EngineContextInternal;
    const shaderModule = eng.device.createShaderModule({ code: WGSL_SHADER });
    const indexBuffer = eng.device.createBuffer({
        size: SHARED_INDEX_DATA.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    eng.device.queue.writeBuffer(indexBuffer, 0, SHARED_INDEX_DATA.buffer, SHARED_INDEX_DATA.byteOffset, SHARED_INDEX_DATA.byteLength);

    const rr: SpriteRendererInternal = {
        _kind: KIND,
        _engine: eng,
        _device: eng.device,
        _format: eng.format,
        _msaa: eng.msaaSamples,
        _shaderModule: shaderModule,
        _indexBuffer: indexBuffer,
        _pipelineCache: new Map(),
        _layerGpu: new Map(),
        _targetWidth: eng._targets.width,
        _targetHeight: eng._targets.height,
        _disposed: false,
        layers: opts.layers.slice(),
        clearColor: opts.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
        _drawCallsPre: 0,
        _update(encoder: GPUCommandEncoder, _deltaMs: number): GPUCommandEncoder {
            spriteRendererUpdate(rr, encoder);
            return encoder;
        },
        _record(pass: GPURenderPassEncoder): number {
            return spriteRendererRecord(rr, pass);
        },
    };

    // Pre-warm a pipeline for every distinct blend mode currently in use, so the
    // first frame doesn't pay the compile cost.
    const seen = new Set<number>();
    for (const layer of rr.layers) {
        const k = pipelineKey(rr._msaa, layer.blendMode, false);
        if (!seen.has(k)) {
            getOrBuildPipeline(rr, layer.blendMode, false);
            seen.add(k);
        }
    }

    return rr;
}

/**
 * Per-frame **update** pass (called by the engine before the render pass opens).
 * Refreshes target dims (canvas may have resized), sorts `rr.layers` in place by
 * `order` (TimSort is O(n) on already-sorted input — effectively free in steady state),
 * then walks every visible non-empty layer and runs `ensureLayerGpu` + `uploadLayer`.
 * No GPU draw work here — only buffer uploads via `writeBuffer`.
 */
function spriteRendererUpdate(rr: SpriteRendererInternal, _encoder: GPUCommandEncoder): void {
    if (rr._disposed) {
        return;
    }
    rr._targetWidth = rr._engine._targets.width;
    rr._targetHeight = rr._engine._targets.height;

    // Sort layers in place by `order` once per frame. TimSort is O(n) on already-sorted input,
    // so this is effectively free in the steady state. Documented side-effect on `rr.layers`
    // (registration order is not the ground truth — `layer.order` is).
    rr.layers.sort(compareLayers);

    for (const layer of rr.layers) {
        if (!layer.visible || layer.count === 0) {
            continue;
        }
        const lg = ensureLayerGpu(rr, layer);
        uploadLayer(rr, lg);
    }
}

/**
 * Per-frame **record** pass (called by the engine inside the open render pass).
 * Binds the shared index buffer once, then for each visible non-empty layer:
 * `setPipeline` → `setBindGroup` → `setVertexBuffer` → `drawIndexed(6, layer.count)`.
 * One draw call per layer — 1000 sprites in a layer = 1 draw call (instancing).
 * Returns the draw-call count for the engine's telemetry.
 */
function spriteRendererRecord(rr: SpriteRendererInternal, pass: GPURenderPassEncoder): number {
    if (rr._disposed) {
        return 0;
    }
    let drawCalls = 0;
    pass.setIndexBuffer(rr._indexBuffer, "uint16");

    for (const layer of rr.layers) {
        if (!layer.visible || layer.count === 0) {
            continue;
        }
        const lg = rr._layerGpu.get(layer);
        if (!lg) {
            continue;
        }
        const entry = getOrBuildPipeline(rr, layer.blendMode, false);
        const bg = ensureBindGroup(rr, lg, entry);
        pass.setPipeline(entry.pipeline);
        pass.setBindGroup(0, bg);
        pass.setVertexBuffer(0, lg.instanceBuffer);
        pass.drawIndexed(6, layer.count, 0, 0, 0);
        drawCalls++;
    }

    return drawCalls;
}

/** Push the renderer onto `engine._renderingContexts`. Idempotent — a second call is a no-op. */
export function registerSpriteRenderer(engine: EngineContext, sr: SpriteRenderer): void {
    const list = (engine as EngineContextInternal)._renderingContexts;
    if (list.indexOf(sr) !== -1) {
        return;
    }
    list.push(sr);
}

/** Splice the renderer out of `engine._renderingContexts`. No-op if not present. */
export function unregisterSpriteRenderer(engine: EngineContext, sr: SpriteRenderer): void {
    const list = (engine as EngineContextInternal)._renderingContexts;
    const i = list.indexOf(sr);
    if (i !== -1) {
        list.splice(i, 1);
    }
}

/** Destroy all GPU resources owned by the renderer and clear `layers`. */
export function disposeSpriteRenderer(sr: SpriteRenderer): void {
    const rr = sr as SpriteRendererInternal;
    if (rr._disposed) {
        return;
    }
    rr._disposed = true;
    for (const lg of rr._layerGpu.values()) {
        lg.instanceBuffer.destroy();
        lg.uniformBuffer.destroy();
    }
    rr._layerGpu.clear();
    rr._indexBuffer.destroy();
    rr._pipelineCache.clear();
    rr.layers.length = 0;
}

/** @internal Test-only accessor for pipeline-cache size. */
export function _spriteRendererPipelineCacheSize(sr: SpriteRenderer): number {
    return (sr as SpriteRendererInternal)._pipelineCache.size;
}
