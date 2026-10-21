/** Image export: GPU readback, decode blit, row order, channel ops, content dedup and PNG encoding. */

import { BU, SS, TU } from "../engine/gpu-flags.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { ExportContext, PixelData, SlotMapping } from "./export-context.js";
import { encodePng } from "./export-png.js";

/** WGSL for the decode blit: one fragment per target texel copies the source texel verbatim
 *  (no filtering), clamped to [0, 1]. Minimal whitespace per the repo's inline-WGSL convention. */
const BLIT_WGSL = `@group(0) @binding(0) var src:texture_2d<f32>;
struct V{@builtin(position) p:vec4f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V{
let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
return V(vec4f(p,0,1));
}
@fragment fn fs(v:V)->@location(0) vec4f{
return clamp(textureLoad(src,vec2i(v.p.xy),0),vec4f(0),vec4f(1));
}`;

/** @internal Why a texture cannot be read back on this engine, or null when it can: no GPU device
 *  (null engine), not a single 2D image, or a format/usage combination neither path can copy. */
export function textureReadIssue(ctx: ExportContext, tex: Texture2D): "engine" | "dimension" | null {
    const gpu = tex.texture;
    if (!ctx.engine._device || !gpu) {
        return "engine";
    }
    if (gpu.dimension !== "2d" || gpu.depthOrArrayLayers > 1) {
        return "dimension";
    }
    return readbackPath(gpu) === null ? "engine" : null;
}

/** @internal Check, synchronously, whether a slot's texture can be read back. When it cannot, log
 *  the slot's warning and return false. Also logs the 8-bit clamp warning for float formats. */
export function checkTextureReadable(ctx: ExportContext, tex: Texture2D, materialName: string): boolean {
    const issue = textureReadIssue(ctx, tex);
    if (issue === "engine") {
        ctx.warn(`Texture pixels for material "${materialName}" are not readable on this engine; exporting the material without that texture.`);
        return false;
    }
    if (issue === "dimension") {
        ctx.warn(`Texture for material "${materialName}" is not a single 2D image; exporting the material without that texture.`);
        return false;
    }
    if (tex.texture.format.endsWith("float")) {
        ctx.warn(`Texture for material "${materialName}" has a floating-point format; exporting it clamped to 8 bits.`);
    }
    return true;
}

/** How a readable texture's mip 0 reaches a staging buffer. */
function readbackPath(gpu: GPUTexture): "direct" | "blit" | null {
    const f = gpu.format;
    if ((f === "rgba8unorm" || f === "rgba8unorm-srgb" || f === "bgra8unorm" || f === "bgra8unorm-srgb") && gpu.usage & TU.COPY_SRC) {
        return "direct";
    }
    if (gpu.usage & TU.TEXTURE_BINDING && isFloatSampleable(gpu.format)) {
        return "blit";
    }
    return null;
}

function isFloatSampleable(format: GPUTextureFormat): boolean {
    return !(format.startsWith("depth") || format.startsWith("stencil") || format.endsWith("sint") || format.endsWith("uint"));
}

/** @internal Return the cached pixel promise for a texture, submitting its readback on first use.
 *  Must only be called for textures that passed {@link checkTextureReadable}. The GPU copy is
 *  encoded and submitted synchronously, so the pixels are those of the call's capture step. */
export function requestPixels(ctx: ExportContext, tex: Texture2D): Promise<PixelData | null> {
    const gpu = tex.texture;
    let pending = ctx.pixelCache.get(gpu);
    if (!pending) {
        const errorSlot = ctx.readbackErrors.length;
        ctx.readbackErrors.push(undefined);
        pending = submitReadback(ctx, gpu).catch((error: unknown) => {
            ctx.readbackErrors[errorSlot] = error ?? new Error("Texture readback failed");
            return null;
        });
        ctx.pixelCache.set(gpu, pending);
    }
    return pending;
}

function submitReadback(ctx: ExportContext, gpu: GPUTexture): Promise<PixelData> {
    const device = ctx.engine._device;
    const width = gpu.width;
    const height = gpu.height;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const direct = readbackPath(gpu) === "direct";
    const encoder = device.createCommandEncoder({ label: "gltf-export-readback" });
    let target: GPUTexture | null = null;
    let source = gpu;
    if (!direct) {
        target = device.createTexture({
            label: "gltf-export-blit",
            size: { width, height },
            format: gpu.format.endsWith("-srgb") ? "rgba8unorm-srgb" : "rgba8unorm",
            usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC,
        });
        encodeBlit(ctx, encoder, gpu, target);
        source = target;
    }
    const staging = device.createBuffer({ label: "gltf-export-staging", size: bytesPerRow * height, usage: BU.MAP_READ | BU.COPY_DST });
    encoder.copyTextureToBuffer({ texture: source, mipLevel: 0 }, { buffer: staging, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
    device.queue.submit([encoder.finish()]);
    const swapRB = direct && gpu.format.startsWith("bgra");
    return finishReadback(staging, target, width, height, bytesPerRow, swapRB);
}

async function finishReadback(staging: GPUBuffer, target: GPUTexture | null, width: number, height: number, bytesPerRow: number, swapRB: boolean): Promise<PixelData> {
    try {
        // GPUMapMode.READ, as a literal so the module never dereferences the WebGPU global namespace.
        await staging.mapAsync(0x0001);
        const src = new Uint8Array(staging.getMappedRange());
        const rgba = new Uint8Array(width * height * 4);
        const rowBytes = width * 4;
        for (let y = 0; y < height; y++) {
            rgba.set(src.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
        }
        staging.unmap();
        if (swapRB) {
            for (let i = 0; i < rgba.length; i += 4) {
                const b = rgba[i]!;
                rgba[i] = rgba[i + 2]!;
                rgba[i + 2] = b;
            }
        }
        return { width, height, rgba };
    } finally {
        staging.destroy();
        target?.destroy();
    }
}

function encodeBlit(ctx: ExportContext, encoder: GPUCommandEncoder, src: GPUTexture, target: GPUTexture): void {
    const device = ctx.engine._device;
    let blit = ctx.blit;
    if (!blit) {
        const layout = device.createBindGroupLayout({
            label: "gltf-export-blit",
            entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }],
        });
        blit = {
            layout,
            pipelines: new Map(),
            module: device.createShaderModule({ label: "gltf-export-blit", code: BLIT_WGSL }),
            pipelineLayout: device.createPipelineLayout({ label: "gltf-export-blit", bindGroupLayouts: [layout] }),
        };
        ctx.blit = blit;
    }
    let pipeline = blit.pipelines.get(target.format);
    if (!pipeline) {
        pipeline = device.createRenderPipeline({
            label: "gltf-export-blit",
            layout: blit.pipelineLayout,
            vertex: { module: blit.module, entryPoint: "vs" },
            fragment: { module: blit.module, entryPoint: "fs", targets: [{ format: target.format }] },
            primitive: { topology: "triangle-list", cullMode: "none" },
        });
        blit.pipelines.set(target.format, pipeline);
    }
    const view = src.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 });
    const bindGroup = device.createBindGroup({ label: "gltf-export-blit", layout: blit.layout, entries: [{ binding: 0, resource: view }] });
    const pass = encoder.beginRenderPass({
        label: "gltf-export-blit",
        colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
}

/** @internal Apply a slot's row order and channel inversion to read-back pixels, then return the
 *  index of a glTF image holding exactly those bytes: an existing one with equal content, or a new
 *  `{ mimeType: "image/png" }` image named after `slot`. Its bytes are encoded by {@link encodeImages}. */
export function insertImage(ctx: ExportContext, pixels: PixelData, mapping: SlotMapping, slot: string): number {
    const bytes = applyChannelOps(pixels, mapping);
    const key = `${pixels.width}x${pixels.height}:${mapping.rowOrder}:${mapping.invert ?? ""}:${fnv1a32(bytes)}`;
    const candidates = ctx.imageIndex.get(key);
    if (candidates) {
        for (const index of candidates) {
            if (bytesEqual(ctx.imagePixels[index]!.rgba, bytes)) {
                return index;
            }
        }
    }
    const index = ctx.doc.images.push({ name: slot, mimeType: "image/png" }) - 1;
    ctx.imagePixels[index] = { width: pixels.width, height: pixels.height, rgba: bytes };
    if (candidates) {
        candidates.push(index);
    } else {
        ctx.imageIndex.set(key, [index]);
    }
    return index;
}

function applyChannelOps(pixels: PixelData, mapping: SlotMapping): Uint8Array {
    const { width, height, rgba } = pixels;
    if (mapping.rowOrder === "storage" && !mapping.invert) {
        return rgba;
    }
    const out = new Uint8Array(rgba.length);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
        const srcRow = mapping.rowOrder === "reversed" ? height - 1 - y : y;
        out.set(rgba.subarray(srcRow * rowBytes, srcRow * rowBytes + rowBytes), y * rowBytes);
    }
    if (mapping.invert) {
        const invertG = mapping.invert === "rg";
        for (let i = 0; i < out.length; i += 4) {
            out[i] = 255 - out[i]!;
            if (invertG) {
                out[i + 1] = 255 - out[i + 1]!;
            }
        }
    }
    return out;
}

/** @internal FNV-1a 32-bit hash. */
export function fnv1a32(bytes: Uint8Array): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i]!;
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

/** @internal Encode every image to PNG, then add the bytes as bufferViews in image-index order, so
 *  the layout never depends on encoder completion order. */
export async function encodeImages(ctx: ExportContext): Promise<void> {
    const pngs = await Promise.all(ctx.imagePixels.map((p) => encodePng(p.width, p.height, p.rgba)));
    for (let i = 0; i < pngs.length; i++) {
        ctx.doc.images[i]!.bufferView = ctx.buffers.addBufferView(pngs[i]!);
    }
}
