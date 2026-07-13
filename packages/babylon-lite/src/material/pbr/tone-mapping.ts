/**
 * Pluggable tone mapping for PBR materials.
 *
 * A tone mapping is just the pair of WGSL fragments the PBR shader composer injects
 * into the fragment shader: optional module-scope `helpersWGSL` (function
 * definitions) plus the per-fragment `callWGSL` that transforms the working
 * `color` in place. Modelling it as a value (rather than a closed
 * `"standard" | "aces"` union) lets new algorithms — e.g. Khronos PBR Neutral —
 * be added without a breaking change, and keeps them tree-shakeable: a bundle
 * only carries the WGSL of the tone mapping it actually references.
 *
 * `id` identifies the algorithm for cache keys and for the cheap "did the tone
 * mapping change?" check in `setSceneImageProcessing`. Two tone mappings with the
 * same `id` are treated as equivalent.
 */
export interface ToneMapping {
    /** Stable identifier for this algorithm (e.g. "standard", "aces"). Used for change detection. */
    readonly id: string;
    /** Module-scope WGSL (function/const definitions) injected once. Empty when the algorithm is inline. */
    readonly helpersWGSL: string;
    /**
     * Per-fragment WGSL that transforms the working `color` (linear RGB) in place. May reference
     * `helpersWGSL`.
     *
     * IMPORTANT: `callWGSL` is responsible for applying exposure — the PBR template omits the exposure
     * multiply when tone mapping is enabled and delegates it here. Start the fragment with
     * `color *= scene.vImageInfos.x;` (the exposure factor) before the tone-mapping curve, or exposure
     * will be silently dropped. See the built-ins (`StandardToneMapping`, `AcesToneMapping`,
     * `NeutralToneMapping`) for the exact form.
     */
    readonly callWGSL: string;
}

/**
 * Default tone mapping: Babylon.js `TONEMAPPING_STANDARD` (exponential). The call
 * is inline (no helpers), so it is the cheapest option and matches the result
 * produced when `imageProcessing.toneMapping` is left undefined.
 */
export const StandardToneMapping: ToneMapping = {
    id: "standard",
    helpersWGSL: "",
    callWGSL: `color*=scene.vImageInfos.x;
color=1.0-exp2(-1.590579*color);`,
};
