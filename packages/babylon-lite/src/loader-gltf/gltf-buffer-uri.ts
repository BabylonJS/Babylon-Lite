/** Resolve a glTF buffer `uri` to a fetchable URL. Imported only by the JSON-glTF modules (gltf-json-asset.ts and the lazily
 *  loaded gltf-multi-buffer.ts), so GLB scenes never fetch it.
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
