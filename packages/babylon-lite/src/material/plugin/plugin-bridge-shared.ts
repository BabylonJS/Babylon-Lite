/**
 * Shared material-plugin bridge logic (dynamically imported — never part of the
 * core/runtime graph). Converts a list of {@link MaterialPlugin}s into a single
 * {@link ShaderFragment} plus a stable signature so the pipeline cache rebuilds
 * whenever a plugin's name / enabled-state / defines / code / uniforms change.
 *
 * The same fragment shape feeds both PBR (uboFields → material UBO) and Standard
 * (uboFields → mesh UBO); only the host material routes the fields differently.
 */

import type { BindingDecl, FragmentSlot, ShaderFragment, UboField, UboSpec, VertexSlot, WgslScalarType } from "../../shader/fragment-types.js";
import { computeUboLayout } from "../../shader/ubo-layout.js";
import type { MaterialPlugin, MaterialPluginPoint, PluginTextureBinding } from "./material-plugin.js";

const STAGE_FRAGMENT = 0x2;

/** WGSL variable name of the Standard self-managed plugin uniform buffer. Plugin
 *  custom code reads its uniforms as `pluginUbo.<field>` (Standard); PBR plugin
 *  uniforms ride the material UBO and are read as `material.<field>`. */
const STD_PLUGIN_UBO = "pluginUbo";

// Plain object literals are side-effect-free (unlike `new Map()`), so they are
// safe at module scope and stay tree-shakable. See GUIDANCE §4.
const FRAG_POINT_TO_SLOTS: Partial<Record<MaterialPluginPoint, readonly FragmentSlot[]>> = {
    CUSTOM_FRAGMENT_MAIN_BEGIN: ["SV"],
    CUSTOM_FRAGMENT_UPDATE_ALPHA: ["AT"],
    CUSTOM_FRAGMENT_UPDATE_DIFFUSE: ["AC"],
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: ["MF"],
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: ["AI", "NI"],
    CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: ["BC"],
};

const VERT_POINT_TO_SLOT: Partial<Record<MaterialPluginPoint, VertexSlot>> = {
    CUSTOM_VERTEX_MAIN_BEGIN: "VR",
    CUSTOM_VERTEX_UPDATE_WORLDPOS: "VW",
    CUSTOM_VERTEX_MAIN_END: "VB",
};

/** Enabled plugins, lowest-priority-first (priority default 500). */
export function enabledPlugins(plugins: readonly MaterialPlugin[]): MaterialPlugin[] {
    return plugins.filter((p) => p.isEnabled !== false).sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
}

/** Stable signature of a plugin list. Includes disabled plugins (so a toggle
 *  still changes the key) plus every cache-affecting input of the enabled ones. */
export function pluginSignature(plugins: readonly MaterialPlugin[]): string {
    const parts: string[] = [];
    for (const p of plugins) {
        const on = p.isEnabled !== false;
        parts.push(`${p.name}${on ? "+" : "-"}${p.priority ?? 500}:${JSON.stringify(p.defines ?? null)}`);
        if (on) {
            parts.push(JSON.stringify(p.getCustomCode?.("fragment") ?? null));
            parts.push(JSON.stringify(p.getCustomCode?.("vertex") ?? null));
            parts.push(JSON.stringify(p.getUniforms?.() ?? null));
            parts.push(JSON.stringify(p.getSamplers?.() ?? null));
        }
    }
    return parts.join("|");
}

/** Result of {@link buildPluginFragment}: the composed fragment plus (Standard
 *  only) the self-managed plugin uniform-buffer layout. */
export interface BuiltPluginFragment {
    /** @internal Composed ShaderFragment, ready to drop into the host material's fragment list. */
    readonly _fragment: ShaderFragment;
    /** @internal Standard self-managed plugin UBO layout (offsets + total bytes), or null
     *  when the host is PBR (uniforms ride the material UBO) or there are no
     *  plugin uniforms at all. */
    readonly _stdUboSpec: UboSpec | null;
}

/** Build a single composed ShaderFragment from the enabled plugins of a material.
 *
 *  @param plugins - The material's attached plugins.
 *  @param index - Per-signature index folded into the fragment id / cache key.
 *  @param forStandard - When true, plugin uniforms are delivered through a dedicated
 *      self-managed uniform buffer (`pluginUbo`) declared as a fragment binding —
 *      this keeps ALL shared standard code untouched (the engine routes it through
 *      the pre-existing `_bind` loop). When false (PBR), uniforms are appended to
 *      the host material UBO via `_uboFields` and written by the pre-existing PBR
 *      `writeUbo` loop. */
export function buildPluginFragment(plugins: readonly MaterialPlugin[], index: number, forStandard: boolean): BuiltPluginFragment {
    const enabled = enabledPlugins(plugins);
    if (enabled.length === 0) {
        // Disabled-only: still emit an (empty) fragment so the cache key differs
        // from a plugin-free material; the BC slot stays untouched.
        return { _fragment: { _id: `plugin-${index}` }, _stdUboSpec: null };
    }

    let helpers = "";
    const fragmentSlots: Partial<Record<FragmentSlot, string>> = {};
    const vertexSlots: Partial<Record<VertexSlot, string>> = {};
    const uboFields: UboField[] = [];
    const bindings: BindingDecl[] = [];

    const append = (bucket: Record<string, string>, key: string, code: string): void => {
        bucket[key] = (bucket[key] ?? "") + "\n" + code;
    };

    for (const p of enabled) {
        const frag = p.getCustomCode?.("fragment");
        if (frag) {
            for (const point of Object.keys(frag) as MaterialPluginPoint[]) {
                const code = frag[point];
                if (!code) {
                    continue;
                }
                if (point === "CUSTOM_FRAGMENT_DEFINITIONS") {
                    helpers += "\n" + code;
                    continue;
                }
                const slots = FRAG_POINT_TO_SLOTS[point];
                if (slots) {
                    for (const s of slots) {
                        append(fragmentSlots, s, code);
                    }
                }
            }
        }
        const vert = p.getCustomCode?.("vertex");
        if (vert) {
            for (const point of Object.keys(vert) as MaterialPluginPoint[]) {
                const code = vert[point];
                const slot = VERT_POINT_TO_SLOT[point];
                if (code && slot) {
                    append(vertexSlots, slot, code);
                }
            }
        }
        const ubo = p.getUniforms?.()?.ubo;
        if (ubo) {
            for (const f of ubo) {
                uboFields.push({ _name: f.name, _type: f.type as WgslScalarType });
            }
        }
        const samplers = p.getSamplers?.();
        if (samplers) {
            for (const s of samplers) {
                bindings.push(
                    { _name: s.texture, _type: { _kind: "texture", _textureType: s.textureType ?? "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
                    { _name: s.sampler, _type: { _kind: "sampler", _samplerType: s.samplerType ?? "sampler" }, _visibility: STAGE_FRAGMENT }
                );
            }
        }
    }

    // Standard host: deliver plugin uniforms via a dedicated self-managed UBO
    // (`pluginUbo`) declared as a fragment binding, so NO shared standard code
    // changes. PBR keeps `_uboFields` (uniforms ride the material UBO).
    let stdUboSpec: UboSpec | null = null;
    let stdUboFields: readonly UboField[] | undefined = uboFields.length ? uboFields : undefined;
    if (forStandard && uboFields.length) {
        stdUboSpec = computeUboLayout(uboFields);
        // Declare the UBO struct (referenced by the generated `var<uniform>
        // pluginUbo:pluginUboUniforms;`). Module-scope WGSL allows forward refs.
        helpers = `struct ${STD_PLUGIN_UBO}Uniforms{\n${stdUboSpec._structBody}\n}\n` + helpers;
        // The UBO binding must be declared (and bound) BEFORE the texture entries
        // so it matches the order `StdExt._bind` pushes resources.
        bindings.unshift({ _name: STD_PLUGIN_UBO, _type: { _kind: "uniform-buffer" }, _group: "mesh", _visibility: STAGE_FRAGMENT });
        stdUboFields = undefined; // not routed through the host UBO
    }

    return {
        _fragment: {
            _id: `plugin-${index}`,
            _helperFunctions: helpers || undefined,
            _fragmentSlots: Object.keys(fragmentSlots).length ? fragmentSlots : undefined,
            _vertexSlots: Object.keys(vertexSlots).length ? vertexSlots : undefined,
            _uboFields: stdUboFields,
            _bindings: bindings.length ? bindings : undefined,
        },
        _stdUboSpec: stdUboSpec,
    };
}

/** Write the enabled plugins' UBO slices into `data` using `offsets`. */
export function writePluginUbo(plugins: readonly MaterialPlugin[], data: Float32Array, offsets: ReadonlyMap<string, number>): void {
    for (const p of enabledPlugins(plugins)) {
        p.writeUbo?.(data, offsets);
    }
}

/** Push the enabled plugins' texture+sampler bind entries starting at `b`. */
export function bindPluginTextures(plugins: readonly MaterialPlugin[], entries: GPUBindGroupEntry[], b: number): number {
    for (const p of enabledPlugins(plugins)) {
        if (!p.bindTextures) {
            continue;
        }
        const out: PluginTextureBinding[] = [];
        p.bindTextures(out);
        for (const binding of out) {
            entries.push({ binding: b++, resource: binding.texture.view });
            entries.push({ binding: b++, resource: binding.texture.sampler });
        }
    }
    return b;
}
