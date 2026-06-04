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

// Public base URL where meshopt_decoder.js is hosted. Defaults to site root.
let meshoptBaseUrl = "/";

/** Override the base URL where meshopt_decoder.js is hosted. */
export function setMeshoptBaseUrl(url: string): void {
    meshoptBaseUrl = url.endsWith("/") ? url : url + "/";
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
        script.src = meshoptBaseUrl + "meshopt_decoder.js";
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
