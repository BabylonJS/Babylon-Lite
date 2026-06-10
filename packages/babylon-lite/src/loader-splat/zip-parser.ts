import { U8, DV } from "../engine/typed-arrays.js";
/** Minimal ZIP central-directory parser.
 *
 *  Designed for the small ZIP archive shape produced by the BJS SOG export
 *  (`meta.json` + a handful of `.webp` files). Only supports:
 *    • Method 0 (stored — raw slice)
 *    • Method 8 (deflate — decompressed via `DecompressionStream("deflate-raw")`)
 *  and rejects anything else (encrypted entries, ZIP64, multi-disk, …) with a
 *  descriptive error so callers can surface a meaningful message instead of
 *  silently producing wrong data.
 *
 *  Reads sizes / offsets from the central directory record (not the local
 *  file header) so it tolerates entries written with bit-3 of the general
 *  purpose flag set (data-descriptor mode), which BJS uses on some platforms. */

const SIG_EOCD = 0x06054b50;
const SIG_CDIR = 0x02014b50;
const SIG_LFH = 0x04034b50;

const utf8 = new TextDecoder("utf-8");

export interface ZipEntry {
    /** Filename as stored in the archive. */
    name: string;
    /** Decompressed bytes. */
    bytes: Uint8Array;
}

/** Locate the End-Of-Central-Directory record by scanning backwards from the
 *  end of the buffer. The EOCD lives within the last 22 + 64 KB of the file.
 *  Returns the byte offset of the EOCD signature, or -1 if not found. */
function findEocd(view: DataView): number {
    const maxBack = Math.min(view.byteLength, 22 + 65535);
    const start = view.byteLength - maxBack;
    for (let i = view.byteLength - 22; i >= start; i--) {
        if (view.getUint32(i, true) === SIG_EOCD) {
            return i;
        }
    }
    return -1;
}

/** Parse the archive and return all decoded entries. */
export async function unzipBuffer(buffer: ArrayBuffer): Promise<ZipEntry[]> {
    const view = new DV(buffer);
    const eocd = findEocd(view);
    if (eocd < 0) {
        throw new Error("zip: EOCD record not found");
    }
    const totalEntries = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new Error("zip: ZIP64 archives are not supported");
    }

    const entries: ZipEntry[] = [];
    let p = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
        if (view.getUint32(p, true) !== SIG_CDIR) {
            throw new Error(`zip: bad central directory signature at offset ${p}`);
        }
        const gpFlag = view.getUint16(p + 8, true);
        const method = view.getUint16(p + 10, true);
        const compressedSize = view.getUint32(p + 20, true);
        const uncompressedSize = view.getUint32(p + 24, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const localOffset = view.getUint32(p + 42, true);
        if (gpFlag & 0x0001) {
            throw new Error(`zip: encrypted entries are not supported`);
        }
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw new Error("zip: ZIP64 archives are not supported");
        }
        const name = utf8.decode(new U8(buffer, p + 46, nameLen));
        p += 46 + nameLen + extraLen + commentLen;

        // Re-read filename/extra lengths from the local file header since the
        // central-directory extra-field length doesn't have to match.
        if (view.getUint32(localOffset, true) !== SIG_LFH) {
            throw new Error(`zip: bad local file header signature at offset ${localOffset}`);
        }
        const lfhNameLen = view.getUint16(localOffset + 26, true);
        const lfhExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;

        const compressed = new U8(buffer, dataStart, compressedSize);

        let bytes: Uint8Array;
        if (method === 0) {
            bytes = new U8(compressed); // copy out so consumers can transfer.
        } else if (method === 8) {
            const stream = new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw")));
            const ab = await stream.arrayBuffer();
            bytes = new U8(ab);
        } else {
            throw new Error(`zip: unsupported compression method ${method} for entry '${name}'`);
        }

        if (bytes.byteLength !== uncompressedSize) {
            throw new Error(`zip: entry '${name}' decompressed size mismatch (got ${bytes.byteLength}, expected ${uncompressedSize})`);
        }

        entries.push({ name, bytes });
    }
    return entries;
}
