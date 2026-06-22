/** Multi-buffer glTF support.
 *
 *  Dynamic-imported by load-gltf.ts ONLY when an asset declares more than one
 *  buffer (separate geometry / animation / skin `.bin` files — e.g. Khronos
 *  AnimatedTriangle, SimpleSkin). Single-buffer glTF and GLB assets never load
 *  this module, so they pay zero bytes for it.
 *
 *  Lite reads every accessor through one `binChunk` DataView and ignores
 *  `bufferView.buffer`. To keep that fast single-chunk reader unchanged, this
 *  fetches all buffers, concatenates them (each 4-byte aligned so float
 *  accessors stay aligned), and rewrites every `bufferView.byteOffset` to its
 *  global position in the concatenated chunk (and resets `buffer` to 0). */

export async function loadMultiBuffer(json: any, baseUrl: string): Promise<DataView> {
    const buffers: any[] = json.buffers ?? [];
    const arrays = await Promise.all(buffers.map((b) => (b?.uri ? fetch(resolveBufferUri(b.uri, baseUrl)).then((r) => r.arrayBuffer()) : Promise.resolve(new ArrayBuffer(0)))));

    // Place each buffer at a 4-byte-aligned offset; record starts for the rewrite.
    const offsets: number[] = [];
    let total = 0;
    for (const a of arrays) {
        offsets.push(total);
        total += a.byteLength;
        total = (total + 3) & ~3;
    }

    const out = new Uint8Array(total);
    for (let i = 0; i < arrays.length; i++) {
        out.set(new Uint8Array(arrays[i]!), offsets[i]!);
    }

    for (const bv of json.bufferViews ?? []) {
        bv.byteOffset = (bv.byteOffset ?? 0) + offsets[bv.buffer ?? 0]!;
        bv.buffer = 0;
    }

    return new DataView(out.buffer);
}

function resolveBufferUri(uri: string, baseUrl: string): string {
    if (baseUrl) {
        return new URL(uri, baseUrl + "x").href;
    }
    try {
        return new URL(uri).href;
    } catch {
        throw new Error("loadGltf: relative buffer URI needs a base URL.");
    }
}
