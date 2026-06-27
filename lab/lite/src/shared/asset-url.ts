// Runtime asset-URL rebasing for the parity lab.
//
// The parity lab is built and deployed under a per-build base path
// (e.g. /lite/<build>/parity-lab/) via `vite build --base <path>`. The
// build-time rewriter in scripts/build-lab-site.ts only rebases root-absolute
// URLs that appear as visible quoted string literals. URLs that are embedded
// inside compressed NME data blobs, or constructed at runtime (such as the
// Draco/meshopt decoder paths), are invisible to that rewriter and therefore
// resolve against the site root — where the files do not exist — and 404 in CI.
//
// These helpers rebase such URLs onto the deployed asset root at runtime. We
// derive that root from `document.baseURI` (always defined in a browser) rather
// than `import.meta.env.BASE_URL`, because the per-scene bundle build and the
// published demos do not statically define the latter. This mirrors the
// existing precedent in lab/lite/src/lite/scene211.ts.

/**
 * The deployed asset root. Parity scene HTML lives at `<root>/lite/<scene>.html`,
 * so the asset root (where `/textures`, decoder scripts, etc. are deployed) is
 * one directory up from the document. Under the default base path this resolves
 * to the site root, so non-parity builds (bundle measurement, demos) are
 * unaffected.
 */
function assetRoot(): URL {
    return new URL("../", document.baseURI);
}

/**
 * Rebase a root-absolute URL (e.g. "/textures/nme/<hash>.png") onto the deployed
 * asset root. Absolute URLs (with a scheme or protocol-relative), data:/blob:
 * URLs, and already-relative URLs are returned unchanged.
 */
export function rebaseRootUrl(url: string): string {
    if (typeof url !== "string" || url.length === 0) return url;
    // Absolute URL with a scheme (http:, https:, data:, blob:, …) or protocol-relative.
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return url;
    // Only root-absolute paths need rebasing; relative paths already resolve correctly.
    if (!url.startsWith("/")) return url;
    return new URL(url.replace(/^\/+/, ""), assetRoot()).href;
}

/**
 * Point the glTF Draco + meshopt decoders at the deployed asset root so their
 * decoder scripts/wasm load from the per-build site instead of the site root.
 * Mirrors lab/lite/src/demos/demo-asset-url.ts for the parity scenes.
 */
export async function configureParityDecoderBases(): Promise<void> {
    const base = assetRoot().href;
    const [{ setDracoBaseUrl }, { setMeshoptBaseUrl }] = await Promise.all([
        import("babylon-lite/loader-gltf/draco-decode.js"),
        import("babylon-lite/loader-gltf/meshopt-decode.js"),
    ]);
    setDracoBaseUrl(base);
    setMeshoptBaseUrl(base);
}
