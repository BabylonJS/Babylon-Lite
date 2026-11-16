/**
 * GL internal format → WebGPU compressed texture format mapping.
 *
 * Maps KTX1 `glInternalFormat` values to the corresponding WebGPU
 * GPUTextureFormat, required device feature, and block dimensions.
 *
 * Only includes formats supported by WebGPU (PVRTC is excluded).
 *
 * Uses lazy-init to avoid module-level side effects (GUIDANCE.md §4).
 */

export interface CompressedFormatInfo {
    /** WebGPU texture format string (e.g. 'bc3-rgba-unorm'). */
    gpuFormat: GPUTextureFormat;
    /** Device feature required (e.g. 'texture-compression-bc'). */
    feature: string;
    /** Block width in texels. */
    blockW: number;
    /** Block height in texels. */
    blockH: number;
    /** Bytes per compressed block. */
    blockBytes: number;
}

// Lazy-initialized lookup table (no module-level side effects).
let _table: Map<number, CompressedFormatInfo> | null = null;
let _copyTable: Map<string, Pick<CompressedFormatInfo, "blockW" | "blockH" | "blockBytes">> | null = null;

function getTable(): Map<number, CompressedFormatInfo> {
    if (_table) {
        return _table;
    }
    const t = new Map<number, CompressedFormatInfo>();
    _table = t;

    function add(gl: number, gpuFormat: GPUTextureFormat, feature: string, blockW: number, blockH: number, blockBytes: number): void {
        t.set(gl, { gpuFormat, feature, blockW, blockH, blockBytes });
    }

    const BC = "texture-compression-bc";
    const ETC = "texture-compression-etc2";
    const ASTC = "texture-compression-astc";

    // ── BC / S3TC / DXT ─────────────────────────────────────────────
    add(0x83f0, "bc1-rgba-unorm", BC, 4, 4, 8); // COMPRESSED_RGB_S3TC_DXT1_EXT
    add(0x83f1, "bc1-rgba-unorm", BC, 4, 4, 8); // COMPRESSED_RGBA_S3TC_DXT1_EXT
    add(0x83f2, "bc2-rgba-unorm", BC, 4, 4, 16); // COMPRESSED_RGBA_S3TC_DXT3_EXT
    add(0x83f3, "bc3-rgba-unorm", BC, 4, 4, 16); // COMPRESSED_RGBA_S3TC_DXT5_EXT
    add(0x8dbb, "bc4-r-unorm", BC, 4, 4, 8); // COMPRESSED_RED_RGTC1
    add(0x8dbc, "bc4-r-snorm", BC, 4, 4, 8); // COMPRESSED_SIGNED_RED_RGTC1
    add(0x8dbd, "bc5-rg-unorm", BC, 4, 4, 16); // COMPRESSED_RG_RGTC2
    add(0x8dbe, "bc5-rg-snorm", BC, 4, 4, 16); // COMPRESSED_SIGNED_RG_RGTC2
    add(0x8e8f, "bc6h-rgb-ufloat", BC, 4, 4, 16); // COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT
    add(0x8e8e, "bc6h-rgb-float", BC, 4, 4, 16); // COMPRESSED_RGB_BPTC_SIGNED_FLOAT
    add(0x8e8c, "bc7-rgba-unorm", BC, 4, 4, 16); // COMPRESSED_RGBA_BPTC_UNORM
    add(0x8e8d, "bc7-rgba-unorm-srgb", BC, 4, 4, 16); // COMPRESSED_SRGB_ALPHA_BPTC_UNORM

    // ── ETC2 / EAC ──────────────────────────────────────────────────
    add(0x9270, "eac-r11unorm", ETC, 4, 4, 8); // COMPRESSED_R11_EAC
    add(0x9271, "eac-r11snorm", ETC, 4, 4, 8); // COMPRESSED_SIGNED_R11_EAC
    add(0x9272, "eac-rg11unorm", ETC, 4, 4, 16); // COMPRESSED_RG11_EAC
    add(0x9273, "eac-rg11snorm", ETC, 4, 4, 16); // COMPRESSED_SIGNED_RG11_EAC
    add(0x9274, "etc2-rgb8unorm", ETC, 4, 4, 8); // COMPRESSED_RGB8_ETC2
    add(0x9275, "etc2-rgb8unorm-srgb", ETC, 4, 4, 8); // COMPRESSED_SRGB8_ETC2
    add(0x9276, "etc2-rgb8a1unorm", ETC, 4, 4, 8); // COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2
    add(0x9277, "etc2-rgb8a1unorm-srgb", ETC, 4, 4, 8); // COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2
    add(0x9278, "etc2-rgba8unorm", ETC, 4, 4, 16); // COMPRESSED_RGBA8_ETC2_EAC
    add(0x9279, "etc2-rgba8unorm-srgb", ETC, 4, 4, 16); // COMPRESSED_SRGB8_ALPHA8_ETC2_EAC

    // ── ASTC (all block sizes are 16 bytes) ─────────────────────────
    const ASTC_BLOCKS: [number, number][] = [
        [4, 4],
        [5, 4],
        [5, 5],
        [6, 5],
        [6, 6],
        [8, 5],
        [8, 6],
        [8, 8],
        [10, 5],
        [10, 6],
        [10, 8],
        [10, 10],
        [12, 10],
        [12, 12],
    ];
    for (let i = 0; i < ASTC_BLOCKS.length; i++) {
        const [w, h] = ASTC_BLOCKS[i]!;
        const tag = `${w}x${h}`;
        add(0x93b0 + i, `astc-${tag}-unorm` as GPUTextureFormat, ASTC, w, h, 16);
        add(0x93d0 + i, `astc-${tag}-unorm-srgb` as GPUTextureFormat, ASTC, w, h, 16);
    }

    return t;
}

// ── Public lookup ───────────────────────────────────────────────────

/** Look up compressed format info from a KTX1 glInternalFormat value. Returns undefined if unknown/unsupported. */
export function getCompressedFormat(glInternalFormat: number): CompressedFormatInfo | undefined {
    return getTable().get(glInternalFormat);
}

/** Copy footprints by GPU format; opaque, CPU-unwritable, and combined depth/stencil formats have no entry. */
export function getTextureFormatBlockInfo(format: GPUTextureFormat): Pick<CompressedFormatInfo, "blockW" | "blockH" | "blockBytes"> | undefined {
    if (!_copyTable) {
        const table = new Map<string, Pick<CompressedFormatInfo, "blockW" | "blockH" | "blockBytes">>();
        for (const info of getTable().values()) {
            table.set(info.gpuFormat, info);
            if (info.gpuFormat === "bc1-rgba-unorm" || info.gpuFormat === "bc2-rgba-unorm" || info.gpuFormat === "bc3-rgba-unorm") {
                table.set(`${info.gpuFormat}-srgb`, info);
            }
        }
        const add = (blockBytes: number, formats: string): void => {
            const info = { blockW: 1, blockH: 1, blockBytes };
            for (const name of formats.split(" ")) {
                table.set(name, info);
            }
        };
        add(1, "r8unorm r8snorm r8uint r8sint stencil8");
        add(2, "r16unorm r16snorm r16uint r16sint r16float rg8unorm rg8snorm rg8uint rg8sint depth16unorm");
        add(
            4,
            "r32uint r32sint r32float rg16unorm rg16snorm rg16uint rg16sint rg16float " +
                "rgba8unorm rgba8unorm-srgb rgba8snorm rgba8uint rgba8sint bgra8unorm bgra8unorm-srgb rgb9e5ufloat rgb10a2uint rgb10a2unorm rg11b10ufloat"
        );
        add(8, "rg32uint rg32sint rg32float rgba16unorm rgba16snorm rgba16uint rgba16sint rgba16float");
        add(16, "rgba32uint rgba32sint rgba32float");
        _copyTable = table;
    }
    return _copyTable.get(format);
}

/** Map a KTX suffix string to the required WebGPU device feature. Returns undefined for unsupported (e.g. PVRTC). */
export function suffixToFeature(suffix: string): string | undefined {
    const s = suffix.toLowerCase();
    if (s.includes("astc")) {
        return "texture-compression-astc";
    }
    if (s.includes("dxt") || s.includes("s3tc") || s.includes("bc")) {
        return "texture-compression-bc";
    }
    if (s.includes("etc")) {
        return "texture-compression-etc2";
    }
    return undefined;
}
