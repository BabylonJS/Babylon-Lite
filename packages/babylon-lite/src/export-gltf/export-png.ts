/** Dependency-free PNG encoder for the glTF exporter (RGBA8, no canvas, worker-safe). */

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[n] = c >>> 0;
        }
    }
    return crcTable;
}

/** @internal CRC-32 (polynomial 0xEDB88320) over `bytes[start, end)`. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
    const table = getCrcTable();
    let c = 0xffffffff;
    for (let i = start; i < end; i++) {
        c = table[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/** @internal Encode tight RGBA8 pixels (row 0 first) as a PNG file: signature, `IHDR` (8-bit RGBA,
 *  no interlace), one `IDAT` holding the zlib stream of every scanline with filter byte 0, and `IEND`.
 *  The zlib stream comes from `CompressionStream("deflate")`, whose "deflate" format is the RFC 1950
 *  wrapper PNG requires. */
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        // Filter byte 0 (None) is already zero.
        raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
    }
    const idat = await deflate(raw);

    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, width);
    ihdrView.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    // compression 0, filter 0, interlace 0

    const size = 8 + (12 + 13) + (12 + idat.byteLength) + 12;
    const out = new Uint8Array(size);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    let offset = writeChunk(out, 8, "IHDR", ihdr);
    offset = writeChunk(out, offset, "IDAT", idat);
    writeChunk(out, offset, "IEND", new Uint8Array(0));
    return out;
}

function writeChunk(out: Uint8Array, offset: number, type: string, data: Uint8Array): number {
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(offset, data.byteLength);
    for (let i = 0; i < 4; i++) {
        out[offset + 4 + i] = type.charCodeAt(i);
    }
    out.set(data, offset + 8);
    const crcEnd = offset + 8 + data.byteLength;
    view.setUint32(crcEnd, crc32(out, offset + 4, crcEnd));
    return crcEnd + 4;
}

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const stream = new CompressionStream("deflate");
    const writer = stream.writable.getWriter();
    const writing = writer.write(data).then(() => writer.close());
    // Surface a write failure through the read side (or the final await) instead of as an unhandled rejection.
    writing.catch(() => undefined);
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        length += value.byteLength;
    }
    await writing;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
