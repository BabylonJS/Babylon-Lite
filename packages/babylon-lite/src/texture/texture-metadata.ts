import { TU } from "../engine/gpu-flags.js";
import type { Texture2D, Texture2DRecoverySource } from "./texture-2d.js";

export interface TextureTransform {
    readonly uOffset: number;
    readonly vOffset: number;
    readonly uScale: number;
    readonly vScale: number;
    readonly uAng: number;
}

export interface TextureSamplerMetadata {
    readonly addressModeU?: GPUAddressMode;
    readonly addressModeV?: GPUAddressMode;
    readonly addressModeW?: GPUAddressMode;
    readonly magFilter?: GPUFilterMode;
    readonly minFilter?: GPUFilterMode;
    readonly mipmapFilter?: GPUMipmapFilterMode;
    readonly maxAnisotropy?: number;
}

export interface TextureCapabilities {
    readonly renderAttachment?: boolean;
    readonly dynamicUpdate?: boolean;
    readonly sampledDepth?: boolean;
}

export interface TextureMetadata {
    readonly kind: "2d" | "2d-array" | "3d" | "cube";
    readonly name?: string;
    readonly origin?: "url-raster" | "solid" | "pixels" | "external-image" | "render-target" | "dynamic" | "html" | "sampled-depth";
    readonly width?: number;
    readonly height?: number;
    readonly layers?: number;
    readonly depth?: number;
    readonly format?: string;
    readonly mipLevelCount?: number;
    readonly sampleType?: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
    readonly colorSpace?: "linear" | "srgb";
    readonly invertY?: boolean;
    readonly sampler?: TextureSamplerMetadata;
    readonly capabilities: TextureCapabilities;
}

interface TextureShape {
    readonly kind: TextureMetadata["kind"];
    readonly wrapper: Record<string, unknown>;
    readonly gpuTexture?: Record<string, unknown>;
    readonly width?: number;
    readonly height?: number;
    readonly layers?: number;
    readonly depth?: number;
}

interface RetainedSampler {
    readonly addressModeU?: unknown;
    readonly addressModeV?: unknown;
    readonly addressModeW?: unknown;
    readonly magFilter?: unknown;
    readonly minFilter?: unknown;
    readonly mipmapFilter?: unknown;
    readonly maxAnisotropy?: unknown;
}

/** Return a side-effect-free, handle-free metadata snapshot for a supported Lite texture. */
export function getTextureMetadata(texture: unknown): TextureMetadata | undefined {
    const shape = detectTextureShape(texture);
    if (!shape) {
        return undefined;
    }
    try {
        const origin = readOrigin(shape);
        const format = readString(shape.gpuTexture?.format);
        const sampleType = readSampleType(shape, format);
        const sampler = readSamplerMetadata(readRetainedSampler(shape));
        return {
            kind: shape.kind,
            name: readName(shape),
            origin,
            width: shape.width,
            height: shape.height,
            layers: shape.layers,
            depth: shape.depth,
            format,
            mipLevelCount: readInteger(shape.gpuTexture?.mipLevelCount, 1),
            sampleType,
            colorSpace: readColorSpace(format, sampleType),
            invertY: shape.kind === "2d" ? shape.wrapper.invertY === true : undefined,
            sampler,
            capabilities: {
                renderAttachment: readRenderAttachment(shape),
                dynamicUpdate: origin ? origin === "dynamic" || origin === "html" : undefined,
                sampledDepth: sampleType ? sampleType === "depth" : undefined,
            },
        };
    } catch {
        return undefined;
    }
}

/** Return the effective transform on a transform-capable 2D texture wrapper. */
export function getTextureTransform(texture: Texture2D): TextureTransform | undefined {
    const shape = detectTextureShape(texture);
    if (!shape || !supportsTransform(shape)) {
        return undefined;
    }
    return readTransform(shape.wrapper);
}

/** Write an effective transform to exactly the supplied wrapper.
 *  Returns `false` without writing when the effective values are unchanged. */
export function setTextureTransform(texture: Texture2D, transform: TextureTransform): boolean {
    const normalized = normalizeTransform(transform);
    const current = getTextureTransform(texture);
    if (!current) {
        throw new Error("This texture does not support UV transforms.");
    }
    if (sameTransform(current, normalized)) {
        return false;
    }
    texture.uOffset = normalized.uOffset;
    texture.vOffset = normalized.vOffset;
    texture.uScale = normalized.uScale;
    texture.vScale = normalized.vScale;
    texture.uAng = normalized.uAng;
    const state = texture as Texture2D & { _hasTx?: true };
    if (isIdentityTransform(normalized)) {
        delete state._hasTx;
    } else {
        state._hasTx = true;
    }
    return true;
}

/** Return the texture wrapper's selected material UV set. */
export function getTextureCoordinateIndex(texture: Texture2D): 0 | 1 {
    return (texture as Texture2D & { readonly _texCoord?: unknown })._texCoord === 1 ? 1 : 0;
}

/** Return whether the effective texture transform differs from identity. */
export function hasTextureTransform(texture: Texture2D): boolean {
    const transform = getTextureTransform(texture);
    return transform !== undefined && !isIdentityTransform(transform);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function readInteger(value: unknown, minimum: number): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= minimum ? value : undefined;
}

function detectTextureShape(texture: unknown): TextureShape | undefined {
    if (!isRecord(texture)) {
        return undefined;
    }
    try {
        if ("_texture" in texture && "_view" in texture && "_sampler" in texture) {
            const gpuTexture = isRecord(texture._texture) ? texture._texture : undefined;
            return {
                kind: "cube",
                wrapper: texture,
                gpuTexture,
                width: readInteger(gpuTexture?.width, 0),
                height: readInteger(gpuTexture?.height, 0),
                layers: readInteger(gpuTexture?.depthOrArrayLayers, 1) ?? 6,
            };
        }
        if (!("texture" in texture) || !("view" in texture) || !("sampler" in texture)) {
            return undefined;
        }
        const width = readInteger(texture.width, 0);
        const height = readInteger(texture.height, 0);
        if (width === undefined || height === undefined) {
            return undefined;
        }
        const gpuTexture = isRecord(texture.texture) ? texture.texture : undefined;
        if ("layers" in texture) {
            const layers = readInteger(texture.layers, 0);
            return layers === undefined ? undefined : { kind: "2d-array", wrapper: texture, gpuTexture, width, height, layers };
        }
        if ("depth" in texture) {
            const depth = readInteger(texture.depth, 0);
            return depth === undefined ? undefined : { kind: "3d", wrapper: texture, gpuTexture, width, height, depth };
        }
        return { kind: "2d", wrapper: texture, gpuTexture, width, height };
    } catch {
        return undefined;
    }
}

function readOrigin(shape: TextureShape): TextureMetadata["origin"] {
    if (shape.kind === "2d" && "_readyState" in shape.wrapper && "_element" in shape.wrapper) {
        return "html";
    }
    if (shape.wrapper._sampleType === "depth") {
        return "sampled-depth";
    }
    const source = shape.wrapper._recoverySource as Texture2DRecoverySource | undefined;
    switch (source?.kind) {
        case "url":
            return "url-raster";
        case "solid":
            return "solid";
        case "pixels":
            return "pixels";
        case "external":
        case "bitmap":
            return "external-image";
        case "render":
            return "render-target";
        case "dynamic":
            return "dynamic";
        default:
            return undefined;
    }
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readName(shape: TextureShape): string | undefined {
    return readString(shape.wrapper.name) ?? readString(shape.gpuTexture?.label);
}

function readSampleType(shape: TextureShape, format: string | undefined): TextureMetadata["sampleType"] {
    if (shape.wrapper._sampleType === "depth" || format?.startsWith("depth") || format === "stencil8") {
        return "depth";
    }
    if (format?.endsWith("sint")) {
        return "sint";
    }
    if (format?.endsWith("uint")) {
        return "uint";
    }
    if (format === "r32float" || format === "rg32float" || format === "rgba32float") {
        return "unfilterable-float";
    }
    return format || shape.wrapper._sampleType === "float" ? "float" : undefined;
}

function readColorSpace(format: string | undefined, sampleType: TextureMetadata["sampleType"]): TextureMetadata["colorSpace"] {
    if (!format || !sampleType || sampleType === "depth" || sampleType === "sint" || sampleType === "uint") {
        return undefined;
    }
    return format.endsWith("-srgb") ? "srgb" : "linear";
}

function readRetainedSampler(shape: TextureShape): RetainedSampler | undefined {
    if (shape.kind === "cube") {
        return { magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" };
    }
    const source = shape.wrapper._recoverySource as Texture2DRecoverySource | undefined;
    switch (source?.kind) {
        case "url": {
            const mipmaps = source.opts?.mipMaps !== false;
            const minFilter = source.opts?.minFilter ?? "linear";
            const magFilter = source.opts?.magFilter ?? "linear";
            return {
                addressModeU: source.opts?.addressModeU ?? "repeat",
                addressModeV: source.opts?.addressModeV ?? "repeat",
                minFilter,
                magFilter,
                mipmapFilter: mipmaps ? "linear" : "nearest",
                maxAnisotropy: mipmaps && minFilter === "linear" && magFilter === "linear" ? 4 : 1,
            };
        }
        case "solid":
            return { magFilter: "linear", minFilter: "linear" };
        case "pixels":
            return {
                addressModeU: source.options?.addressModeU,
                addressModeV: source.options?.addressModeV,
                minFilter: source.options?.minFilter,
                magFilter: source.options?.magFilter,
            };
        case "external":
        case "render":
        case "dynamic":
            return source.samplerDesc;
        default:
            return undefined;
    }
}

function readSamplerMetadata(sampler: RetainedSampler | undefined): TextureSamplerMetadata | undefined {
    if (!sampler) {
        return undefined;
    }
    return {
        addressModeU: readAddressMode(sampler.addressModeU ?? "clamp-to-edge"),
        addressModeV: readAddressMode(sampler.addressModeV ?? "clamp-to-edge"),
        addressModeW: readAddressMode(sampler.addressModeW ?? "clamp-to-edge"),
        magFilter: readFilterMode(sampler.magFilter ?? "nearest"),
        minFilter: readFilterMode(sampler.minFilter ?? "nearest"),
        mipmapFilter: readFilterMode(sampler.mipmapFilter ?? "nearest"),
        maxAnisotropy: readInteger(sampler.maxAnisotropy ?? 1, 1),
    };
}

function readAddressMode(value: unknown): GPUAddressMode | undefined {
    return value === "clamp-to-edge" || value === "repeat" || value === "mirror-repeat" ? value : undefined;
}

function readFilterMode(value: unknown): GPUFilterMode | undefined {
    return value === "nearest" || value === "linear" ? value : undefined;
}

function readRenderAttachment(shape: TextureShape): boolean | undefined {
    const usage = shape.gpuTexture?.usage;
    return typeof usage === "number" && TU ? (usage & TU.RENDER_ATTACHMENT) !== 0 : undefined;
}

function supportsTransform(shape: TextureShape): boolean {
    const origin = readOrigin(shape);
    return shape.kind === "2d" && origin !== "render-target" && origin !== "sampled-depth";
}

function readTransform(wrapper: Record<string, unknown>): TextureTransform | undefined {
    const uOffset = readTransformNumber(wrapper.uOffset, 0);
    const vOffset = readTransformNumber(wrapper.vOffset, 0);
    const uScale = readTransformNumber(wrapper.uScale, 1);
    const vScale = readTransformNumber(wrapper.vScale, 1);
    const uAng = readTransformNumber(wrapper.uAng, 0);
    return uOffset === undefined || vOffset === undefined || uScale === undefined || vScale === undefined || uAng === undefined
        ? undefined
        : { uOffset, vOffset, uScale, vScale, uAng };
}

function readTransformNumber(value: unknown, fallback: number): number | undefined {
    return value === undefined ? fallback : typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTransform(transform: TextureTransform): TextureTransform {
    if (!isRecord(transform)) {
        throw new TypeError("Texture transform must be an object.");
    }
    const values = [transform.uOffset, transform.vOffset, transform.uScale, transform.vScale, transform.uAng];
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new RangeError("Texture transform values must be finite numbers.");
    }
    return {
        uOffset: normalizeZero(transform.uOffset),
        vOffset: normalizeZero(transform.vOffset),
        uScale: normalizeZero(transform.uScale),
        vScale: normalizeZero(transform.vScale),
        uAng: normalizeZero(transform.uAng),
    };
}

function normalizeZero(value: number): number {
    return Object.is(value, -0) ? 0 : value;
}

function sameTransform(a: TextureTransform, b: TextureTransform): boolean {
    return a.uOffset === b.uOffset && a.vOffset === b.vOffset && a.uScale === b.uScale && a.vScale === b.vScale && a.uAng === b.uAng;
}

function isIdentityTransform(transform: TextureTransform): boolean {
    return transform.uOffset === 0 && transform.vOffset === 0 && transform.uScale === 1 && transform.vScale === 1 && transform.uAng === 0;
}
