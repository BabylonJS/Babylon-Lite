import { SS, TU } from "../engine/gpu-flags.js";
import { readTexturePixels } from "./read-texture-pixels.js";
import type { EngineContext } from "../engine/engine.js";
import type { CubeTexture } from "./cube-texture.js";
import type { Texture2D } from "./texture-2d.js";

/** Allocation metadata for texture preview controls. Does not guarantee the texture is still live. */
export interface TextureReadbackInfo {
    kind: "2d" | "cube" | "2d-array" | "3d";
    width: number;
    height: number;
    depthOrArrayLayers: number;
    mipLevelCount: number;
}

/** Select exactly one subresource. All indices default to zero. */
export interface TextureReadbackOptions {
    mipLevel?: number;
    /** Cube face in +X, -X, +Y, -Y, +Z, -Z order. Cube textures only. */
    face?: number;
    /** Array layer, unaffected by mip level. 2D arrays only. */
    layer?: number;
    /** Volume slice at the selected mip level. 3D textures only. */
    slice?: number;
    /** Reverse storage rows. Default false; material UV transforms and invertY are ignored. */
    flipY?: boolean;
}

/** Tightly packed RGBA8 pixels, storage row zero first unless flipY was requested. */
export interface TextureReadbackResult {
    pixels: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
}

function nativeTexture(texture: Texture2D | CubeTexture): GPUTexture {
    return "_texture" in texture ? texture._texture : texture.texture;
}

/** Inspect allocation dimensions without exposing native GPU handles, including opaque cubes. */
export function getTextureReadbackInfo(texture: Texture2D | CubeTexture): TextureReadbackInfo {
    const native = nativeTexture(texture);
    const kind = "_texture" in texture ? "cube" : native.dimension === "3d" ? "3d" : "layers" in texture || native.depthOrArrayLayers > 1 ? "2d-array" : "2d";
    return {
        kind,
        width: native.width,
        height: native.height,
        depthOrArrayLayers: native.depthOrArrayLayers,
        mipLevelCount: native.mipLevelCount,
    };
}

function index(value: number, count: number, name: string): number {
    if (!Number.isInteger(value) || value < 0 || value >= count) {
        throw new Error(`readTexturePixelsRGBA8: ${name} must be an integer in [0, ${count}) (got ${value})`);
    }
    return value;
}

/**
 * Read a sampleable color texture without changing it or requiring COPY_SRC usage.
 * Normalized/float/compressed inputs become RGBA8; sRGB transfer encoding is preserved,
 * linear inputs stay linear, and values clamp to [0,1]. No tone mapping, exposure,
 * alpha unpremultiplication or implicit orientation correction is applied.
 *
 * Rejects depth/stencil, integer, multisampled, non-sampleable, destroyed and wrong-device
 * textures. Only already-submitted rendering is observed; an active frame is not flushed.
 */
export async function readTexturePixelsRGBA8(engine: EngineContext, texture: Texture2D | CubeTexture, options: TextureReadbackOptions = {}): Promise<TextureReadbackResult> {
    const source = nativeTexture(texture);
    const info = getTextureReadbackInfo(texture);
    if (
        (source.dimension !== "2d" && source.dimension !== "3d") ||
        source.sampleCount !== 1 ||
        !(source.usage & TU.TEXTURE_BINDING) ||
        /depth|stencil|uint|sint/.test(source.format)
    ) {
        throw new Error(`readTexturePixelsRGBA8: unsupported texture (${source.dimension}, ${source.format}, samples=${source.sampleCount}, usage=${source.usage})`);
    }
    const mip = index(options.mipLevel ?? 0, info.mipLevelCount, "mipLevel");
    const width = Math.max(1, Math.floor(info.width / 2 ** mip));
    const height = Math.max(1, Math.floor(info.height / 2 ** mip));
    for (const selector of ["face", "layer", "slice"] as const) {
        const expected = selector === "face" ? "cube" : selector === "layer" ? "2d-array" : "3d";
        if (options[selector] !== undefined && info.kind !== expected) {
            throw new Error(`readTexturePixelsRGBA8: ${selector} is only valid for ${expected} textures`);
        }
    }
    const depth = info.kind === "3d" ? Math.max(1, Math.floor(info.depthOrArrayLayers / 2 ** mip)) : info.depthOrArrayLayers;
    const selected = index(options.face ?? options.layer ?? options.slice ?? 0, info.kind === "cube" ? 6 : depth, "face/layer/slice");
    const volume = info.kind === "3d";
    const format = source.format.endsWith("-srgb") ? "rgba8unorm-srgb" : "rgba8unorm";
    const device = engine._device;
    let output: GPUTexture | undefined;
    device.pushErrorScope("validation");
    device.pushErrorScope("out-of-memory");
    try {
        let pending: Promise<Uint8Array<ArrayBuffer>>;
        try {
            output = device.createTexture({
                label: "texture-preview",
                size: [width, height],
                format,
                usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC,
            });
            const view = source.createView({
                dimension: volume ? "3d" : "2d",
                baseMipLevel: mip,
                mipLevelCount: 1,
                ...(volume ? {} : { baseArrayLayer: selected, arrayLayerCount: 1 }),
            });
            const layout = device.createBindGroupLayout({
                entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: volume ? "3d" : "2d" } }],
            });
            const shader = device.createShaderModule({
                code: `
@group(0) @binding(0) var source: texture_${volume ? "3d" : "2d"}<f32>;
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
return textureLoad(source, ${volume ? `vec3i(vec2i(p.xy), ${selected})` : "vec2i(p.xy)"}, 0);
}`,
            });
            const pipeline = device.createRenderPipeline({
                layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                vertex: { module: shader, entryPoint: "vertex" },
                fragment: { module: shader, entryPoint: "fragment", targets: [{ format }] },
                primitive: { topology: "triangle-list" },
            });
            const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: view }] });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: output.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.draw(3);
            pass.end();
            device.queue.submit([encoder.finish()]);
            pending = readTexturePixels(device, output);
        } catch (error) {
            pending = Promise.reject(error instanceof Error ? error : new Error("readTexturePixelsRGBA8: GPU setup failed", { cause: error }));
        }
        // Pop synchronously before awaiting: scopes must not overlap concurrent reads or application work.
        const [pixels, errors] = await Promise.all([pending, Promise.all([device.popErrorScope(), device.popErrorScope()])]);
        const error = errors.find((entry) => entry !== null);
        if (error) {
            throw new Error(`readTexturePixelsRGBA8: ${error.message}`);
        }
        if (options.flipY) {
            const rowBytes = width * 4;
            const row = new Uint8Array(rowBytes);
            for (let y = 0; y < Math.floor(height / 2); y++) {
                const top = y * rowBytes;
                const bottom = (height - y - 1) * rowBytes;
                row.set(pixels.subarray(top, top + rowBytes));
                pixels.copyWithin(top, bottom, bottom + rowBytes);
                pixels.set(row, bottom);
            }
        }
        return { pixels, width, height };
    } finally {
        output?.destroy();
    }
}
