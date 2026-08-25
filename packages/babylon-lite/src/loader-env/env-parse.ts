import { F32, U8 } from "../engine/typed-arrays.js";
import { mipLevelCount } from "../texture/mip-count.js";

/** Decoded contents of a Babylon.js `.env` file. */
export interface ParsedEnv {
    faceBlobs: Blob[];
    irradianceSH: Float32Array;
    width: number;
    mipCount: number;
}

const ENV_MAGIC = new U8([0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36]);

/**
 * Parse a Babylon.js `.env` file into its irradiance SH and per-face image blobs.
 *
 * Shared by the initial load and by device-lost recovery, which re-reads the same file: a second
 * copy would be free to drift from this one, and the recovery path asserts a pixel-identical image.
 */
export function parseEnvFile(buffer: ArrayBuffer): ParsedEnv {
    const bytes = new U8(buffer);

    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== ENV_MAGIC[i]) {
            throw new Error("Invalid .env file: bad magic");
        }
    }

    // JSON manifest: UTF-8 from byte 8 until null terminator
    let pos = 8;
    while (pos < bytes.length && bytes[pos] !== 0) {
        pos++;
    }
    const jsonStr = new TextDecoder().decode(bytes.subarray(8, pos));
    pos++; // skip null
    const binaryStart = pos;

    const manifest = JSON.parse(jsonStr);
    const width: number = manifest.width;
    const mipCount = mipLevelCount(width, width);

    // Irradiance spherical harmonics (9 vec3 coefficients = 27 floats)
    const irr = manifest.irradiance;
    const irradianceSH = new F32(27);
    const shKeys = ["x", "y", "z", "xx", "yy", "zz", "yz", "zx", "xy"];
    for (let i = 0; i < 9; i++) {
        const coeff = irr[shKeys[i]!];
        irradianceSH[i * 3] = coeff[0];
        irradianceSH[i * 3 + 1] = coeff[1];
        irradianceSH[i * 3 + 2] = coeff[2];
    }

    // Extract face image blobs (flat: mip0_face0..5, mip1_face0..5, ...)
    const mipmaps: { position: number; length: number }[] = manifest.specular.mipmaps;
    const imageType: string = manifest.imageType || "image/png";
    const faceBlobs: Blob[] = [];

    for (const entry of mipmaps) {
        const start = binaryStart + entry.position;
        const slice = buffer.slice(start, start + entry.length);
        faceBlobs.push(new Blob([slice], { type: imageType }));
    }

    return { faceBlobs, irradianceSH, width, mipCount };
}
