/**
 * Standard Base Template
 *
 * Provides the base Standard (Blinn-Phong) shader structure with slot markers.
 * Parameterized by feature configuration (textures, UV, shadow, reflection, fog).
 *
 * The Standard material uses 3 separate UBOs in group 1:
 *   binding 0: mesh UBO (world matrix)
 *   binding 1: material UBO (colors, levels)
 * Plus optional texture/sampler bindings at fixed slots.
 */

import type { ShaderTemplate, UboField, VertexAttribute, Varying, BindingDecl } from "../../shader/fragment-types.js";
import { WGSL_FOG } from "../../shader/wgsl-helpers.js";
import { MAX_LIGHTS } from "../../light/types.js";
import { appendMeshLightUboFields, meshLightIndexWGSL } from "../../render/lights-ubo.js";

const STAGE_VERTEX = 0x1;
const STAGE_FRAGMENT = 0x2;

// ── Lighting function (always present unless disableLighting) ───

const LIGHTING_FN = `
fn computeLighting(viewDir: vec3<f32>, N: vec3<f32>, L: LightEntry, g: f32, P: vec3<f32>) -> array<vec3<f32>, 2> {
var lv: vec3<f32>;
var a: f32 = 1.0;
let t = u32(L.vLightData.w);
if (t == 3u) {
let nl = 0.5 + 0.5 * dot(N, normalize(L.vLightData.xyz));
let diff = mix(L.vLightDirection.xyz, L.vLightDiffuse.rgb, nl);
let h = normalize(viewDir + normalize(L.vLightData.xyz));
var s = pow(max(0.0, dot(N, h)), max(1.0, g));
return array<vec3<f32>, 2>(diff, s * L.vLightSpecular.rgb);
}
if (t == 1u) {
lv = normalize(-L.vLightData.xyz);
} else {
let d = L.vLightData.xyz - P;
a = max(0.0, 1.0 - length(d) / L.vLightDiffuse.a);
lv = normalize(d);
if (t == 2u) {
let c = max(0.0, dot(L.vLightDirection.xyz, -lv));
if (c >= L.vLightDirection.w) { a *= max(0.0, pow(c, L.vLightSpecular.a)); } else { a = 0.0; }
}
}
let nl = max(0.0, dot(N, lv));
let diff = nl * L.vLightDiffuse.rgb * a;
let h = normalize(viewDir + lv);
var s = max(0.0, dot(N, h));
s = pow(s, max(1.0, g));
return array<vec3<f32>, 2>(diff, s * L.vLightSpecular.rgb * a);
}
`;

export interface StandardTemplateConfig {
    /** @internal */
    readonly _diffuse?: boolean;
    /** @internal UV coordinate channels used */
    readonly _needsUV: boolean;
    /** @internal */
    readonly _needsUV2: boolean;
    /** @internal */
    readonly _diffuseUsesUV2?: boolean;
    /** @internal Disable lighting (unlit material) */
    readonly _disableLighting?: boolean;
    /** @internal Generate a fragment stage that runs discard/alpha-test logic and writes no color. */
    readonly _noColorOutput?: boolean;
    /** @internal Generate a fragment stage that runs discard/alpha-test logic and writes ESM shadow color. */
    readonly _esmShadowOutput?: boolean;
}

/**
 * Create a Standard material ShaderTemplate from configuration.
 * The template contains slot markers that the composer fills.
 */
export function createStandardTemplate(config: StandardTemplateConfig, esmShadowDepthCode = ""): ShaderTemplate {
    const { _diffuse, _needsUV, _needsUV2, _diffuseUsesUV2, _disableLighting, _noColorOutput, _esmShadowOutput } = config;

    // ── Base vertex attributes ──────────────────────────────────
    const _baseVertexAttributes: VertexAttribute[] = [
        { _name: "position", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 },
        { _name: "normal", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 },
    ];
    if (_needsUV) {
        _baseVertexAttributes.push({ _name: "uv", _type: "vec2<f32>", _gpuFormat: "float32x2", _arrayStride: 8 });
    }
    if (_needsUV2) {
        _baseVertexAttributes.push({ _name: "uv2", _type: "vec2<f32>", _gpuFormat: "float32x2", _arrayStride: 8 });
    }

    // ── Base varyings ───────────────────────────────────────────
    const _baseVaryings: Varying[] = [
        { _name: "vp", _type: "vec3<f32>" },
        { _name: "vn", _type: "vec3<f32>" },
        { _name: "vf", _type: "vec3<f32>" },
    ];
    if (_needsUV) {
        _baseVaryings.push({ _name: "vu", _type: "vec2<f32>" });
    }
    if (_needsUV2) {
        _baseVaryings.push({ _name: "vv", _type: "vec2<f32>" });
    }
    // shadow varyings (vPositionFromLight, vDepthMetric) are provided by std-shadow-fragment

    // ── Base UBO fields (mesh = world matrix + affected light indices) ──────────────
    const _baseMeshUboFields: UboField[] = [{ _name: "world", _type: "mat4x4<f32>" }];
    appendMeshLightUboFields(_baseMeshUboFields);

    // ── Base bindings (group 1, starting after mesh UBO at 0) ───
    // Order: material, diffuse*, shadow/UV*, emissive*, bump*, specular*, ambient*, lightmap*, opacity*, reflection*
    // The shadow/UV UBO is placed AFTER diffuse so its auto-assigned binding index
    // matches the conventional slot 5 when diffuse is present (bindings 3,4).
    const _baseBindings: BindingDecl[] = [{ _name: "mat", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_FRAGMENT }];

    if (_diffuse) {
        _baseBindings.push(
            { _name: "dT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "dS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
    }
    // UV params UBO — only when UVs are actually emitted.
    if (_needsUV) {
        _baseBindings.push({ _name: "up", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_VERTEX });
    }
    if (_esmShadowOutput) {
        _baseBindings.push({ _name: "shadowParams", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_FRAGMENT });
    }
    // bump bindings are provided by the normal-map fragment (not baseBindings)
    // emissive, specular, ambient, lightmap, opacity, reflection bindings
    // are provided by their respective fragments (not baseBindings)

    // Shadow map bindings (group 2) are provided by std-shadow-fragment

    // ── Vertex template ─────────────────────────────────────────

    const uvPassthrough = _needsUV ? `out.vu = uv * up.u.xy + up.u.zw;` : "";

    const uv2Passthrough = _needsUV2 ? `out.vv = uv2;` : "";

    // Vertex UBO struct definitions (must be before binding declarations)
    const vertexUboStructs = _needsUV ? `struct upUniforms { u: vec4<f32>, }` : "";

    const _vertexTemplate = `/*SU*/
/*MU*/
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
${vertexUboStructs}
/*VH*/
/*VD*/
/*VO*/
@vertex fn main(
/*VP*/
) -> VertexOutput {
var out: VertexOutput;
/*VR*/
var finalWorld = mesh.world;
/*VW*/
let worldPos4 = finalWorld * vec4<f32>(position, 1.0);
out.vp = worldPos4.xyz;
let normalWorld = mat3x3<f32>(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz);
out.vn = normalize(normalWorld * normal);
out.clipPos = scene.viewProjection * worldPos4;
out.vf = (scene.view * worldPos4).xyz;
${uvPassthrough}
${uv2Passthrough}
/*VB*/
return out;
}`;

    // ── Fragment template ────────────────────────────────────────

    const lightsStructs = `
struct LightEntry { vLightData: vec4<f32>, vLightDiffuse: vec4<f32>, vLightSpecular: vec4<f32>, vLightDirection: vec4<f32> };
struct lightsUniforms { count: u32, _p0: u32, _p1: u32, _p2: u32, lights: array<LightEntry, ${MAX_LIGHTS}> };
@group(0) @binding(1) var<uniform> lights: lightsUniforms;
`;

    const materialStruct = `
struct matUniforms {
dc: vec4<f32>,
sc: vec4<f32>,
ec: vec3<f32>,
bs: f32,
ac: vec3<f32>,
tl: f32,
ambTexLvl: f32,
lmLvl: f32,
opLvl: f32,
aCut: f32,
rLvl: f32,
rCm: f32,
_0: f32,
_1: f32,
};
`;

    const helpers = _disableLighting ? WGSL_FOG : WGSL_FOG + LIGHTING_FN;
    // reflection, shadow, bump helpers are provided by their respective fragments

    // Main fragment body — mirrors old composeFragmentShader exactly
    const doubleSidedEntry = `@fragment fn main(input: FragmentInput)${_noColorOutput ? "" : " -> @location(0) vec4<f32>"} {`;

    // View direction
    const viewDirCode = !_disableLighting ? `let viewDirectionW = normalize(scene.vEyePosition.xyz - input.vp);` : "";

    // Normal computation — fragment can override via AC slot
    const normalCode = _disableLighting ? "" : `var normalW = normalize(input.vn);`;

    // Opacity — default from material alpha, fragment can modify via AT
    const opacityCode = `var alpha = mat.dc.a;`;

    // Base color + alpha test. Texture alpha used for discard only (not blended into output alpha),
    // matching BJS ALPHATEST without ALPHAFROMDIFFUSE.
    const baseColorCode = _diffuse
        ? `let _ds = textureSample(dT, dS, ${_diffuseUsesUV2 ? "input.vv" : "input.vu"});
if (_ds.a < mat.aCut) { discard; }
var baseColor = _ds.rgb * mat.tl;`
        : `var baseColor = vec3<f32>(1.0, 1.0, 1.0);`;

    // Diffuse color + emissive + specular — defaults, fragments can override via AT
    const diffuseColorCode = `let diffuseColor = mat.dc.rgb;`;
    const emissiveCode = `var emissiveContrib = mat.ec;`;
    const specularColorCode = !_disableLighting ? `var specularColor = mat.sc.rgb;` : "";
    // Lighting block (only when lighting enabled)
    let lightingBlock: string;
    if (!_disableLighting) {
        // Shadow — default to 1.0, fragment overrides via AD slot
        // shadowFactors array is populated by std-shadow-fragment (one per light index)
        lightingBlock = `var glossiness = mat.sc.a;
var diffuseBase = vec3<f32>(0.0);
var specularBase = vec3<f32>(0.0);
var shadowFactors = array<f32, ${MAX_LIGHTS}>(${new Array(MAX_LIGHTS).fill("1.0").join(", ")});
var baseAmbientColor = vec3<f32>(1.0, 1.0, 1.0);
var reflectionColor = vec3<f32>(0.0);
let lc = min(mesh.lc, ${MAX_LIGHTS}u);
/*AD*/
for (var li = 0u; li < lc; li++) {
let lightIndex = mli(li);
let r = computeLighting(viewDirectionW, normalW, lights.lights[lightIndex], glossiness, input.vp);
let sf = shadowFactors[lightIndex];
diffuseBase += r[0] * sf;
specularBase += r[1] * sf;
}
let finalDiffuse = clamp(diffuseBase * diffuseColor + emissiveContrib + mat.ac, vec3<f32>(0.0), vec3<f32>(1.0)) * baseColor;
let finalSpecular = specularBase * specularColor;
var color = vec4<f32>(finalDiffuse * baseAmbientColor + finalSpecular + reflectionColor, alpha);`;
    } else {
        lightingBlock = `var color = vec4<f32>(clamp(emissiveContrib * diffuseColor, vec3<f32>(0.0), vec3<f32>(1.0)) * baseColor, alpha);`;
    }

    const _fragmentTemplate = `/*SU*/
${lightsStructs}
${materialStruct}
${_esmShadowOutput ? "struct shadowParamsUniforms { biasAndScale: vec4<f32>, depthValues: vec4<f32>, }" : ""}
/*MU*/
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
${!_disableLighting ? meshLightIndexWGSL("mesh") : ""}
${helpers}
/*HF*/
/*FB*/
/*FI*/
${doubleSidedEntry}
/*SV*/
${viewDirCode}
${normalCode}
/*AC*/
${opacityCode}
${baseColorCode}
${diffuseColorCode}
${emissiveCode}
${specularColorCode}
/*AT*/
${_noColorOutput ? "return;" : _esmShadowOutput ? esmShadowDepthCode : ""}
${lightingBlock}
/*BC*/
color = vec4<f32>(max(color.rgb, vec3<f32>(0.0)), color.a);
if (scene.vFogInfos.x > 0.0) {
let fog = calcFogFactor(input.vf);
color = vec4<f32>(mix(scene.vFogColor.rgb, color.rgb, fog), color.a);
}
/*BA*/
${_noColorOutput ? "" : "return color;"}
}`;

    return {
        _vertexTemplate,
        _fragmentTemplate,
        _baseMeshUboFields,
        _baseVertexAttributes,
        _baseVaryings,
        _baseBindings,
    };
}
