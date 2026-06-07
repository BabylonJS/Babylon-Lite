/**
 * Public Material Plugin API (opt-in).
 *
 * A `MaterialPlugin` is a plain-data object (Lite idiom, GUIDANCE §4b′ — no
 * attached behaviour beyond optional function members) that injects custom
 * WGSL, uniforms, and samplers into an existing PBR or Standard material while
 * keeping the full built-in lighting / IBL / shadow pipeline intact.
 *
 * This is the Babylon-Lite equivalent of BJS `MaterialPluginBase`. Attach via
 * `material.plugins = [plugin]`. Nothing in the engine statically imports the
 * plugin bridge — it is dynamically loaded only when a scene's material list
 * actually carries plugins, so plugin-free scenes pay zero bytes.
 *
 * BJS injection-point → Lite slot mapping (see {@link MaterialPluginPoint}):
 *   CUSTOM_FRAGMENT_DEFINITIONS                 → HF (helper functions)
 *   CUSTOM_FRAGMENT_MAIN_BEGIN                  → SV (scope vars, fragment begin)
 *   CUSTOM_FRAGMENT_UPDATE_ALPHA               → AT (alpha-test region)
 *   CUSTOM_FRAGMENT_UPDATE_DIFFUSE (std)        → AC (after normal, before V)
 *   CUSTOM_FRAGMENT_BEFORE_LIGHTS               → MF (after f0, before lights)
 *   CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION→ AI + NI (ibl / non-ibl color)
 *   CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR            → BC (after tonemap+gamma)
 *   CUSTOM_VERTEX_MAIN_BEGIN                    → VR
 *   CUSTOM_VERTEX_UPDATE_WORLDPOS               → VW
 *   CUSTOM_VERTEX_MAIN_END                      → VB
 */

import type { Texture2D } from "../../texture/texture-2d.js";

/** BJS-compatible injection-point names accepted by {@link MaterialPlugin.getCustomCode}. */
export type MaterialPluginPoint =
    | "CUSTOM_FRAGMENT_DEFINITIONS"
    | "CUSTOM_FRAGMENT_MAIN_BEGIN"
    | "CUSTOM_FRAGMENT_UPDATE_ALPHA"
    | "CUSTOM_FRAGMENT_UPDATE_DIFFUSE"
    | "CUSTOM_FRAGMENT_BEFORE_LIGHTS"
    | "CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION"
    | "CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR"
    | "CUSTOM_VERTEX_MAIN_BEGIN"
    | "CUSTOM_VERTEX_UPDATE_WORLDPOS"
    | "CUSTOM_VERTEX_MAIN_END";

/** A custom uniform contributed by a plugin. The WGSL `type` is used verbatim
 *  (e.g. "vec4<f32>", "f32", "mat4x4<f32>") inside the host material's UBO. */
export interface PluginUboField {
    readonly name: string;
    readonly type: string;
}

/** A texture + sampler pair contributed by a plugin. `texture`/`sampler` are the
 *  WGSL variable names used by the plugin's custom code; the engine wires up the
 *  GPU bindings in declaration order from {@link MaterialPlugin.bindTextures}. */
export interface PluginSamplerDecl {
    readonly texture: string;
    readonly sampler: string;
    /** Defaults to "texture_2d<f32>". */
    readonly textureType?: "texture_2d<f32>";
    /** Defaults to "sampler". */
    readonly samplerType?: "sampler" | "sampler_non_filtering";
}

/** A texture binding emitted by {@link MaterialPlugin.bindTextures}. Public types
 *  only — no raw GPU handles (GUIDANCE §4d). The engine reads `texture.view` /
 *  `texture.sampler` internally. */
export interface PluginTextureBinding {
    readonly texture: Texture2D;
}

/** Plain-data material plugin. All behaviour is via optional function members. */
export interface MaterialPlugin {
    /** Stable identifier. Factored into the pipeline cache key. */
    readonly name: string;
    /** Lower runs first. Default 500. */
    priority?: number;
    /** Default true when attached. A disabled plugin contributes no shader code
     *  but still changes the pipeline cache key (so toggling forces a rebuild). */
    isEnabled?: boolean;
    /** Static defines folded into the pipeline cache key (and available to the
     *  plugin when it builds its custom code). */
    defines?: Record<string, boolean | number>;
    /** Return WGSL snippets keyed by injection point, or null. */
    getCustomCode?(shaderType: "vertex" | "fragment"): Partial<Record<MaterialPluginPoint, string>> | null;
    /** Declare custom UBO fields appended to the host material's uniform buffer. */
    getUniforms?(): { ubo?: PluginUboField[] };
    /** Declare custom texture/sampler bindings. */
    getSamplers?(): PluginSamplerDecl[];
    /** Write this plugin's UBO slice. `offsets` maps field name → byte offset. */
    writeUbo?(data: Float32Array, offsets: ReadonlyMap<string, number>): void;
    /** Emit texture bindings in the same order as {@link getSamplers}. */
    bindTextures?(out: PluginTextureBinding[]): void;
    /** Enumerate textures for acquire/release bookkeeping. */
    getActiveTextures?(out: Texture2D[]): void;
}
