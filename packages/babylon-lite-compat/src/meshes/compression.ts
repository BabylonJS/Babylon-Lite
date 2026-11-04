/**
 * Babylon.js `MeshoptCompression` (`@babylonjs/core/Meshes/Compression/meshoptCompression`).
 *
 * In Babylon.js this singleton owns the meshopt decoder used by the glTF
 * `EXT_meshopt_compression` loader extension, and apps configure its decoder URL
 * via the static `Configuration`. Babylon Lite decodes meshopt-compressed buffers
 * itself inside its glTF loader feature (`gltf-feature-meshopt`), so no external
 * decoder needs wiring. This compat shim therefore accepts the `Configuration`
 * assignment ported code performs (a no-op here) so the import resolves and the
 * asset still loads — the actual decode happens in Lite.
 */
export class MeshoptCompression {
    /**
     * Babylon.js `MeshoptCompression.Configuration` — the decoder location. Stored
     * for API parity but unused: Babylon Lite's glTF loader carries its own meshopt
     * decoder, so setting this has no effect on decoding.
     */
    public static Configuration: { decoder: { url: string } } = { decoder: { url: "" } };

    private static _default: MeshoptCompression | null = null;

    /** Babylon.js `MeshoptCompression.Default` — the lazily-created shared instance. */
    public static get Default(): MeshoptCompression {
        if (!MeshoptCompression._default) {
            MeshoptCompression._default = new MeshoptCompression();
        }
        return MeshoptCompression._default;
    }
}
