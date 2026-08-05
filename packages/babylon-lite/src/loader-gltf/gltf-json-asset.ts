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

/** Fetch and decode an image referenced by an external glTF URI. */
export async function resolveExternalImage(uri: string, baseUrl: string): Promise<ImageBitmap> {
    const response = await fetch(resolveBufferUri(uri, baseUrl));
    if (!response.ok) {
        throw new Error(`Failed to load image: ${response.status} ${response.statusText}`);
    }
    return createImageBitmap(await response.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}

/** Resolve a glTF buffer `uri` to a fetchable URL. Kept local to JSON glTF chunks so GLB scenes do
 *  not fetch a shared helper just because feature modules have their own URI resolver.
 *  @internal */
export function resolveBufferUri(uri: string, baseUrl: string): string {
    if (baseUrl) {
        return new URL(uri, baseUrl + "x").href;
    }
    try {
        return new URL(uri) + "";
    } catch {
        throw new Error("loadGltf: baseless input can't resolve relative URI; use self-contained GLB or URL with base.");
    }
}
