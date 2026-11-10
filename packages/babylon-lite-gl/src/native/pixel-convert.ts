/**
 * CPU pixel-layout helpers for the Babylon Native backend. Native uploads
 * (`loadRawTexture`) take tightly packed rows in a native format and have no
 * `UNPACK_*` pixel-store state, so the WebGL upload semantics lite-gl exposes
 * (row alignment, unsized RGB / luminance / alpha formats, premultiplied alpha)
 * are emulated here, on the cold upload path only. Not part of the public API.
 */

/** WebGL format / type enums accepted by the raw-texture factories. */
const RGBA = 0x1908;
const RGB = 0x1907;
const RG = 0x8227;
const RED = 0x1903;
const ALPHA = 0x1906;
const LUMINANCE = 0x1909;
const LUMINANCE_ALPHA = 0x190a;
const UNSIGNED_BYTE = 0x1401;
const HALF_FLOAT = 0x140b;
const FLOAT = 0x1406;

/** Sized WebGL internal formats and the (format, type) family they imply. */
const SIZED_FORMATS: { readonly [internalFormat: number]: readonly [format: number, type: number] } = {
    0x8058: [RGBA, UNSIGNED_BYTE], // RGBA8
    0x8051: [RGB, UNSIGNED_BYTE], // RGB8
    0x822b: [RG, UNSIGNED_BYTE], // RG8
    0x8229: [RED, UNSIGNED_BYTE], // R8
    0x881a: [RGBA, HALF_FLOAT], // RGBA16F
    0x881b: [RGB, HALF_FLOAT], // RGB16F
    0x822f: [RG, HALF_FLOAT], // RG16F
    0x822d: [RED, HALF_FLOAT], // R16F
    0x8814: [RGBA, FLOAT], // RGBA32F
    0x8815: [RGB, FLOAT], // RGB32F
    0x8230: [RG, FLOAT], // RG32F
    0x822e: [RED, FLOAT], // R32F
};

/** A resolved native upload layout for a WebGL (format, type) pair. */
export interface NativeRawLayout {
    /** Native `TEXTURE_FORMAT_*` the data is uploaded as. */
    nativeFormat: number;
    /** WebGL source format (drives the CPU expansion to RGBA, if any). */
    format: number;
    /** WebGL source type. */
    type: number;
    /** Channels per texel in the SOURCE data. */
    channels: number;
    /** Bytes per channel. */
    channelBytes: number;
    /** True when the source must be expanded to RGBA before upload. */
    expand: boolean;
}

/**
 * Resolve the native upload layout for a WebGL `format` / `type` (and optional
 * sized `internalFormat`), throwing a clear error for combinations Native cannot
 * represent (e.g. sRGB or integer formats).
 * @param fn - Public function name, for the error message.
 */
export function resolveRawLayout(fn: string, format: number, type: number, internalFormat?: number): NativeRawLayout {
    const E = _native.Engine;
    if (internalFormat !== undefined && internalFormat !== format) {
        const sized = SIZED_FORMATS[internalFormat];
        if (sized === undefined || sized[0] !== format || sized[1] !== type) {
            throw new Error(`lite-gl: ${fn} internalFormat 0x${internalFormat.toString(16)} is not supported on Babylon Native`);
        }
    }
    const channelBytes = type === UNSIGNED_BYTE ? 1 : type === HALF_FLOAT ? 2 : type === FLOAT ? 4 : 0;
    if (channelBytes === 0) {
        throw new Error(`lite-gl: ${fn} type 0x${type.toString(16)} is not supported on Babylon Native`);
    }
    const rgba = type === UNSIGNED_BYTE ? E.TEXTURE_FORMAT_RGBA8 : type === HALF_FLOAT ? E.TEXTURE_FORMAT_RGBA16F : E.TEXTURE_FORMAT_RGBA32F;
    // Native uploads go through bimg (`PrepareImage`), which accepts only R8,
    // RGB8, RGBA8, RG16F, RG32F and RGBA16F/32F sources. Every other layout is
    // expanded to RGBA of the same channel type with the exact texel values
    // WebGL samples (missing G/B read 0, missing A reads 1).
    switch (format) {
        case RGBA:
            return { nativeFormat: rgba, format, type, channels: 4, channelBytes, expand: false };
        case RG:
            if (type !== UNSIGNED_BYTE) {
                return { nativeFormat: type === HALF_FLOAT ? E.TEXTURE_FORMAT_RG16F : E.TEXTURE_FORMAT_RG32F, format, type, channels: 2, channelBytes, expand: false };
            }
            return { nativeFormat: rgba, format, type, channels: 2, channelBytes, expand: true };
        case RED:
            if (type === UNSIGNED_BYTE) {
                return { nativeFormat: E.TEXTURE_FORMAT_R8, format, type, channels: 1, channelBytes, expand: false };
            }
            return { nativeFormat: rgba, format, type, channels: 1, channelBytes, expand: true };
        case RGB:
            return { nativeFormat: rgba, format, type, channels: 3, channelBytes, expand: true };
        case LUMINANCE:
        case ALPHA:
            return { nativeFormat: rgba, format, type, channels: 1, channelBytes, expand: true };
        case LUMINANCE_ALPHA:
            return { nativeFormat: rgba, format, type, channels: 2, channelBytes, expand: true };
        default:
            throw new Error(`lite-gl: ${fn} format 0x${format.toString(16)} is not supported on Babylon Native`);
    }
}

/**
 * Produce the tightly packed bytes Native uploads for `data` in `layout`:
 * strips WebGL `unpackAlignment` row padding, expands RGB / luminance / alpha
 * sources to RGBA, premultiplies 8-bit RGBA when requested, and allocates a
 * zero-filled buffer for `null` data (WebGL's uninitialised allocation reads as
 * zero). Returns `data` itself when no conversion is needed.
 */
export function prepareRawPixels(
    layout: NativeRawLayout,
    data: ArrayBufferView | null,
    width: number,
    height: number,
    unpackAlignment: number,
    premultiplyAlpha: boolean
): ArrayBufferView {
    const outChannels = layout.expand ? 4 : layout.channels;
    if (data === null) {
        return new Uint8Array(width * height * outChannels * layout.channelBytes);
    }
    const rowBytes = width * layout.channels * layout.channelBytes;
    const stride = Math.ceil(rowBytes / unpackAlignment) * unpackAlignment;
    let bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let copied = false;
    if (height > 1 && stride !== rowBytes) {
        const tight = new Uint8Array(rowBytes * height);
        for (let row = 0; row < height; row++) {
            tight.set(bytes.subarray(row * stride, row * stride + rowBytes), row * rowBytes);
        }
        bytes = tight;
        copied = true;
    }
    if (layout.expand) {
        return expandToRgba(layout, bytes, width * height, premultiplyAlpha);
    }
    if (premultiplyAlpha && layout.format === RGBA && layout.type === UNSIGNED_BYTE) {
        const out = copied ? bytes : bytes.slice();
        premultiplyRgba8(out);
        return out;
    }
    return copied ? bytes : data;
}

/** Expand a 1/2/3-channel source to RGBA in the same channel type. */
function expandToRgba(layout: NativeRawLayout, bytes: Uint8Array, texels: number, premultiplyAlpha: boolean): ArrayBufferView {
    const aligned = bytes.byteOffset % layout.channelBytes === 0 ? bytes : bytes.slice();
    const n = texels * layout.channels;
    const src =
        layout.type === FLOAT
            ? new Float32Array(aligned.buffer, aligned.byteOffset, n)
            : layout.type === HALF_FLOAT
              ? new Uint16Array(aligned.buffer, aligned.byteOffset, n)
              : new Uint8Array(aligned.buffer, aligned.byteOffset, n);
    const out = layout.type === FLOAT ? new Float32Array(texels * 4) : layout.type === HALF_FLOAT ? new Uint16Array(texels * 4) : new Uint8Array(texels * 4);
    const one = layout.type === FLOAT ? 1 : layout.type === HALF_FLOAT ? 0x3c00 : 255;
    const c = layout.channels;
    for (let i = 0; i < texels; i++) {
        const s = i * c;
        const d = i * 4;
        switch (layout.format) {
            case RGB:
                out[d] = src[s]!;
                out[d + 1] = src[s + 1]!;
                out[d + 2] = src[s + 2]!;
                out[d + 3] = one;
                break;
            case RG:
                out[d] = src[s]!;
                out[d + 1] = src[s + 1]!;
                out[d + 3] = one;
                break;
            case RED:
                out[d] = src[s]!;
                out[d + 3] = one;
                break;
            case LUMINANCE:
                out[d] = out[d + 1] = out[d + 2] = src[s]!;
                out[d + 3] = one;
                break;
            case LUMINANCE_ALPHA:
                out[d] = out[d + 1] = out[d + 2] = src[s]!;
                out[d + 3] = src[s + 1]!;
                break;
            default: // ALPHA
                out[d + 3] = src[s]!;
                break;
        }
    }
    if (premultiplyAlpha && layout.type === UNSIGNED_BYTE && (layout.format === LUMINANCE_ALPHA || layout.format === ALPHA)) {
        premultiplyRgba8(out as Uint8Array);
    }
    return out;
}

/** Multiply RGB by A in place for tightly packed 8-bit RGBA pixels. */
export function premultiplyRgba8(px: Uint8Array): void {
    for (let i = 0; i + 3 < px.length; i += 4) {
        const a = px[i + 3]!;
        if (a !== 255) {
            px[i] = Math.round((px[i]! * a) / 255);
            px[i + 1] = Math.round((px[i + 1]! * a) / 255);
            px[i + 2] = Math.round((px[i + 2]! * a) / 255);
        }
    }
}
