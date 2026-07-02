/**
 * Lazy EXT_meshopt_compression decoder.
 *
 * The meshoptimizer decoder (JS glue + embedded WASM) is loaded from
 * `/meshopt_decoder.js` on first use via a `<script>` injection — exactly like
 * the Draco decoder. This keeps bundle size at zero bytes for scenes that do
 * not load meshopt-compressed glTF assets: the entire module (including this
 * file) is dynamic-imported from the meshopt feature only when an asset's
 * `extensionsUsed` lists EXT_meshopt_compression.
 */

// Public base URL where meshopt_decoder.js is hosted.
//
// Resolution order (highest precedence first):
//   1. An explicit setMeshoptBaseUrl() override.
//   2. The global `__babylonLiteDecoderBase__`, which lets a host that serves
//      the decoder script off a non-root path (e.g. the parity lab under a
//      per-build base path) point the decoder at the right URL *without*
//      statically importing this module.
//   3. The site root ("/").
//
// The global is read lazily at point of use rather than baked in via an eager
// import, so this module stays at zero bytes for scenes that never load
// meshopt-compressed assets.
const DECODER_BASE_GLOBAL = "__babylonLiteDecoderBase__";
let explicitBaseUrl: string | null = null;

function normalizeBase(url: string): string {
    return url.endsWith("/") ? url : url + "/";
}

function meshoptBaseUrl(): string {
    if (explicitBaseUrl !== null) {
        return explicitBaseUrl;
    }
    const fromGlobal = (globalThis as Record<string, unknown>)[DECODER_BASE_GLOBAL];
    return normalizeBase(typeof fromGlobal === "string" && fromGlobal.length > 0 ? fromGlobal : "/");
}

/** Override the base URL where meshopt_decoder.js is hosted. */
export function setMeshoptBaseUrl(url: string): void {
    explicitBaseUrl = normalizeBase(url);
}

/** Minimal surface of the global `MeshoptDecoder` object we rely on. */
interface MeshoptDecoderModule {
    ready: Promise<void>;
    decodeGltfBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array, mode: string, filter?: string): void;
}

let scriptLoadPromise: Promise<MeshoptDecoderModule> | null = null;

function loadMeshoptScript(): Promise<MeshoptDecoderModule> {
    if (scriptLoadPromise) {
        return scriptLoadPromise;
    }
    scriptLoadPromise = new Promise<MeshoptDecoderModule>((resolve, reject) => {
        const existing = (globalThis as { MeshoptDecoder?: MeshoptDecoderModule }).MeshoptDecoder;
        if (existing) {
            resolve(existing);
            return;
        }
        const script = document.createElement("script");
        script.src = meshoptBaseUrl() + "meshopt_decoder.js";
        script.onload = () => {
            const mod = (globalThis as { MeshoptDecoder?: MeshoptDecoderModule }).MeshoptDecoder;
            if (!mod) {
                reject(new Error("meshopt_decoder.js loaded but MeshoptDecoder is undefined"));
            } else {
                resolve(mod);
            }
        };
        script.onerror = () => reject(new Error("Failed to load meshopt_decoder.js from " + script.src));
        document.head.appendChild(script);
    });
    return scriptLoadPromise;
}

/** Resolve the ready meshopt decoder module (WASM instantiated). */
export async function getMeshoptDecoder(): Promise<MeshoptDecoderModule> {
    const mod = await loadMeshoptScript();
    await mod.ready;
    return mod;
}
