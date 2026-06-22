/**
 * Audio network + decode helpers.
 *
 * Babylon Lite fetches audio with the same plain `fetch()` path every other Lite
 * loader uses (texture, glTF, env, splat). The AudioV2 `WebRequest` custom
 * header / URL-modifier layer is intentionally dropped — Lite has no such layer.
 */

let fileExtensionRegex: RegExp | null = null;

/**
 * Extracts the 3–4 char file extension (before any query string), exactly as
 * written in the URL — not lowercased, matching AudioV2 `_FileExtensionRegex`.
 * @internal
 */
export function getFileExtension(url: string): string | undefined {
    fileExtensionRegex ??= new RegExp("\\.(\\w{3,4})($|\\?)");
    return url.match(fileExtensionRegex)?.[1];
}

/** Escapes `#` so URLs with fragments load correctly. @internal */
export function cleanAudioUrl(url: string): string {
    return url.replace(/#/gm, "%23");
}

/**
 * Loads an `ArrayBuffer` from a URL via plain `fetch()`.
 * @internal
 */
export async function loadAudioArrayBuffer(url: string): Promise<ArrayBuffer> {
    const response = await fetch(cleanAudioUrl(url));
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading '${url}': ${response.statusText}`);
    }
    return await response.arrayBuffer();
}
