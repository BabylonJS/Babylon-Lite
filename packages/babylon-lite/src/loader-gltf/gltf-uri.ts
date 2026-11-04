const BASELESS_URI_ERROR = "loadGltf: baseless input can't resolve relative URI; use self-contained GLB or URL with base.";

/** Resolve a glTF external `uri` to a fetchable URL. With a base URL (the source was a URL string),
 *  relative paths resolve against it. Without one (ArrayBuffer/Blob/blob:/data: source), only
 *  self-contained `data:`/absolute URIs are resolvable; relative paths throw a clear error.
 *  @internal */
export function resolveBufferUri(uri: string, baseUrl: string): string {
    if (baseUrl) {
        return new URL(uri, baseUrl + "x").href;
    }
    try {
        return new URL(uri) + "";
    } catch {
        throw new Error(BASELESS_URI_ERROR);
    }
}
