/** Parse a JSON glTF asset and resolve its buffer data. GLB scenes never load this module. */
export async function parseGltfJsonAsset(buffer: ArrayBuffer, baseUrl: string): Promise<{ json: any; binChunk: DataView; baseUrl: string }> {
    const json = JSON.parse(new TextDecoder().decode(buffer));
    const buffers = json.buffers ?? [];
    let binChunk: DataView;
    if (buffers.length > 1) {
        const multiBuffer = await import("./gltf-multi-buffer.js");
        binChunk = await multiBuffer.loadMultiBuffer(json, baseUrl);
    } else if (buffers[0]?.uri) {
        binChunk = new DataView(await fetch(resolveBufferUri(buffers[0].uri, baseUrl)).then((r) => r.arrayBuffer()));
    } else {
        binChunk = new DataView(new ArrayBuffer(0));
    }
    return { json, binChunk, baseUrl };
}

/** Resolve a glTF buffer `uri` to a fetchable URL. With a base URL (the source was a URL string), relative
 *  `.bin` paths resolve against it. Without one (ArrayBuffer/Blob source), only self-contained `data:`/
 *  absolute URIs are resolvable — a bare relative path has no base and throws a clear error.
 *  @internal */
function resolveBufferUri(uri: string, baseUrl: string): string {
    if (baseUrl) {
        return new URL(uri, baseUrl + "x").href;
    }
    try {
        // No base: succeeds for data:/absolute URIs, throws for a relative path (which `new URL` rejects).
        return new URL(uri).href;
    } catch {
        throw new Error("loadGltf: relative buffer URI needs a base URL.");
    }
}
