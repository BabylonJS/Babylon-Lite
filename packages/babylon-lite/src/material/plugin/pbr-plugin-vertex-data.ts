import type { BindingDecl, ComposedShader, FragmentSlot, ShaderFragment, UboField, Varying, VertexSlot, WgslScalarType } from "../../shader/fragment-types.js";
import { wgsl, type WgslSource } from "../../shader/wgsl.js";
import type { MaterialPlugin, MaterialPluginPoint } from "./material-plugin.js";
import { enabledPlugins, pluginSignature } from "./plugin-bridge-shared.js";

const STAGE_VERTEX = 0x1;
const STAGE_FRAGMENT = 0x2;

const FRAG_POINT_TO_SLOT: Partial<Record<MaterialPluginPoint, FragmentSlot>> = {
    CUSTOM_FRAGMENT_MAIN_BEGIN: "SV",
    CUSTOM_FRAGMENT_UPDATE_ALPHA: "AT",
    CUSTOM_FRAGMENT_UPDATE_DIFFUSE: "AC",
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: "MF",
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: "NI",
    CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: "BC",
};

const VERT_POINT_TO_SLOT: Partial<Record<MaterialPluginPoint, VertexSlot>> = {
    CUSTOM_VERTEX_MAIN_BEGIN: "VR",
    CUSTOM_VERTEX_UPDATE_WORLDPOS: "VW",
    CUSTOM_VERTEX_MAIN_END: "VB",
};

/** @internal Stable signature including vertex-stage declarations. */
export function pbrVertexPluginSignature(plugins: readonly MaterialPlugin[]): string {
    const parts = [pluginSignature(plugins)];
    for (const plugin of plugins) {
        if (plugin.isEnabled !== false) {
            parts.push(JSON.stringify(plugin.getVaryings?.() ?? null));
        }
    }
    return parts.join("|");
}

/** @internal Build a PBR plugin fragment with custom vertex-stage resources. */
export function buildPbrVertexPluginFragment(plugins: readonly MaterialPlugin[], index: number): ShaderFragment {
    const enabled = enabledPlugins(plugins);
    if (enabled.length === 0) {
        return { _id: `plugin-${index}` };
    }

    let helpers: WgslSource = wgsl``;
    const fragmentSlots: Partial<Record<FragmentSlot, WgslSource>> = {};
    const vertexSlots: Partial<Record<VertexSlot, WgslSource>> = {};
    const uboFields: UboField[] = [];
    const varyings: Varying[] = [];
    const bindings: BindingDecl[] = [];
    let materialUboVertexVisible = false;

    const append = (bucket: Partial<Record<string, WgslSource>>, key: string, code: string): void => {
        bucket[key] = wgsl`${bucket[key] ?? ""}\n${code}`;
    };

    for (const plugin of enabled) {
        const fragmentCode = plugin.getCustomCode?.("fragment");
        if (fragmentCode) {
            for (const point of Object.keys(fragmentCode) as MaterialPluginPoint[]) {
                const code = fragmentCode[point];
                if (!code) {
                    continue;
                }
                if (point === "CUSTOM_FRAGMENT_DEFINITIONS") {
                    helpers = wgsl`${helpers}\n${code}`;
                    continue;
                }
                const slot = FRAG_POINT_TO_SLOT[point];
                if (slot) {
                    append(fragmentSlots, slot, code);
                }
            }
        }
        const vertexCode = plugin.getCustomCode?.("vertex");
        if (vertexCode) {
            for (const point of Object.keys(vertexCode) as MaterialPluginPoint[]) {
                const code = vertexCode[point];
                const slot = VERT_POINT_TO_SLOT[point];
                if (code && slot) {
                    append(vertexSlots, slot, code);
                }
            }
        }
        for (const field of plugin.getUniforms?.()?.ubo ?? []) {
            uboFields.push({ _name: field.name, _type: field.type as WgslScalarType });
            materialUboVertexVisible ||= field.visibility === "vertex" || field.visibility === "vertex-fragment";
        }
        for (const varying of plugin.getVaryings?.() ?? []) {
            assertFloatVaryingType(varying.type);
            varyings.push({ _name: varying.name, _type: varying.type });
        }
        for (const sampler of plugin.getSamplers?.() ?? []) {
            const visibility = sampler.visibility === "vertex" ? STAGE_VERTEX : sampler.visibility === "vertex-fragment" ? STAGE_VERTEX | STAGE_FRAGMENT : STAGE_FRAGMENT;
            bindings.push(
                { _name: sampler.texture, _type: { _kind: "texture", _textureType: sampler.textureType ?? "texture_2d<f32>" }, _visibility: visibility },
                { _name: sampler.sampler, _type: { _kind: "sampler", _samplerType: sampler.samplerType ?? "sampler" }, _visibility: visibility }
            );
        }
    }

    return {
        _id: `plugin-${index}`,
        _helperFunctions: helpers || undefined,
        _fragmentSlots: Object.keys(fragmentSlots).length ? fragmentSlots : undefined,
        _vertexSlots: Object.keys(vertexSlots).length ? vertexSlots : undefined,
        _varyings: varyings.length ? varyings : undefined,
        _uboFields: uboFields.length ? uboFields : undefined,
        _bindings: bindings.length ? bindings : undefined,
        _pc: materialUboVertexVisible ? exposeMaterialUboToVertex : undefined,
    };
}

function exposeMaterialUboToVertex(composed: ComposedShader): ComposedShader {
    const spec = composed._materialUboSpec;
    if (!spec) {
        throw new Error("PBR material plugin vertex uniforms require a material UBO.");
    }
    const declaration = wgsl`struct MaterialUniforms{\n${spec._structBody}\n}\n@group(1)@binding(1) var<uniform> material:MaterialUniforms;\n`;
    const entries = (composed._meshBGLDescriptor.entries as GPUBindGroupLayoutEntry[]).map((entry) =>
        entry.binding === 1 ? { ...entry, visibility: entry.visibility | STAGE_VERTEX } : entry
    );
    return {
        ...composed,
        _vertexWGSL: wgsl`${declaration}${composed._vertexWGSL}`,
        _meshBGLDescriptor: { ...composed._meshBGLDescriptor, entries },
    };
}

function assertFloatVaryingType(type: string): void {
    if (type !== "f32" && type !== "vec2f" && type !== "vec3f" && type !== "vec4f" && type !== "vec2<f32>" && type !== "vec3<f32>" && type !== "vec4<f32>") {
        throw new Error(`Material plugin varying type "${type}" is unsupported; use a floating-point scalar or vector.`);
    }
}
