/**
 * Standard Base Template
 *
 * Provides the base Standard (Blinn-Phong) shader structure with slot markers.
 * Parameterized by feature configuration (textures, UV, shadow, reflection, fog).
 *
 * The Standard material uses 3 separate UBOs in group 1:
 *   binding 0: mesh UBO (world matrix)
 *   binding 1: lights UBO (array of light entries)
 *   binding 2: material UBO (colors, levels)
 * Plus optional texture/sampler bindings at fixed slots.
 */

import type { ShaderTemplate, UboField, VertexAttribute, Varying, BindingDecl } from "../../shader/fragment-types.js";
import { WGSL_FOG } from "../../shader/wgsl-helpers.js";
import { MAX_LIGHTS } from "../../light/types.js";

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
    /** Which optional textures are present */
    readonly textures: {
        readonly diffuse?: boolean;
        readonly emissive?: boolean;
        readonly bump?: boolean;
        readonly specular?: boolean;
        readonly ambient?: boolean;
        readonly lightmap?: boolean;
        readonly opacity?: boolean;
        readonly reflection?: boolean;
    };
    /** UV coordinate channels used */
    readonly needsUV: boolean;
    readonly needsUV2: boolean;
    /** UV2 usage per texture */
    readonly lightmapUsesUV2?: boolean;
    readonly ambientUsesUV2?: boolean;
    readonly diffuseUsesUV2?: boolean;
    readonly specularUsesUV2?: boolean;
    /** Shadow mode */
    readonly hasShadow: boolean;
    readonly hasPcfShadow?: boolean;
    /** Opacity from RGB rather than alpha */
    readonly opacityFromRGB?: boolean;
    /** Disable lighting (unlit material) */
    readonly disableLighting?: boolean;
}

/**
 * Create a Standard material ShaderTemplate from configuration.
 * The template contains slot markers that the composer fills.
 */
export function createStandardTemplate(config: StandardTemplateConfig): ShaderTemplate {
    const { textures, needsUV, needsUV2, hasShadow, disableLighting } = config;

    // ── Base vertex attributes ──────────────────────────────────
    const baseVertexAttributes: VertexAttribute[] = [
        { name: "position", type: "vec3<f32>", gpuFormat: "float32x3", arrayStride: 12 },
        { name: "normal", type: "vec3<f32>", gpuFormat: "float32x3", arrayStride: 12 },
    ];
    if (needsUV) {
        baseVertexAttributes.push({ name: "uv", type: "vec2<f32>", gpuFormat: "float32x2", arrayStride: 8 });
    }
    if (needsUV2) {
        baseVertexAttributes.push({ name: "uv2", type: "vec2<f32>", gpuFormat: "float32x2", arrayStride: 8 });
    }

    // ── Base varyings ───────────────────────────────────────────
    const baseVaryings: Varying[] = [
        { name: "vPositionW", type: "vec3<f32>" },
        { name: "vNormalW", type: "vec3<f32>" },
        { name: "vFogDistance", type: "vec3<f32>" },
    ];
    if (needsUV) {
        baseVaryings.push({ name: "vUV", type: "vec2<f32>" });
    }
    if (needsUV2) {
        baseVaryings.push({ name: "vUV2", type: "vec2<f32>" });
    }
    // shadow varyings (vPositionFromLight, vDepthMetric) are provided by std-shadow-fragment

    // ── Base UBO fields (mesh = world matrix only) ──────────────
    const baseMeshUboFields: UboField[] = [{ name: "world", type: "mat4x4<f32>" }];

    // ── Scene UBO fields ────────────────────────────────────────
    const baseSceneUboFields: UboField[] = [
        { name: "viewProjection", type: "mat4x4<f32>" },
        { name: "view", type: "mat4x4<f32>" },
        { name: "vEyePosition", type: "vec4<f32>" },
        { name: "vFogInfos", type: "vec4<f32>" },
        { name: "vFogColor", type: "vec4<f32>" },
    ];

    // ── Base bindings (group 1, starting after mesh UBO at 0) ───
    // Order: lights, material, diffuse*, shadow/UV*, emissive*, bump*, specular*, ambient*, lightmap*, opacity*, reflection*
    // The shadow/UV UBO is placed AFTER diffuse so its auto-assigned binding index
    // matches the conventional slot 5 when diffuse is present (bindings 3,4).
    const baseBindings: BindingDecl[] = [
        { name: "lights", type: { kind: "uniform-buffer" }, visibility: STAGE_FRAGMENT },
        { name: "mat", type: { kind: "uniform-buffer" }, visibility: STAGE_FRAGMENT },
    ];

    if (textures.diffuse) {
        baseBindings.push(
            { name: "diffuseTexture", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "diffuseSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT }
        );
    }
    // UV params UBO — always when UV is needed (shadow or texture)
    if (hasShadow || needsUV) {
        baseBindings.push({ name: "uvParams", type: { kind: "uniform-buffer" }, visibility: STAGE_VERTEX });
    }
    // bump bindings are provided by the normal-map fragment (not baseBindings)
    // emissive, specular, ambient, lightmap, opacity, reflection bindings
    // are provided by their respective fragments (not baseBindings)

    // Shadow map bindings (group 2) are provided by std-shadow-fragment

    // No separate vertex bindings — shadow/UV is in baseBindings above
    const baseVertexBindings: BindingDecl[] = [];

    // ── Vertex template ─────────────────────────────────────────

    const uvPassthrough = hasShadow || needsUV ? `out.vUV = uv * uvParams.uvScaleOffset.xy + uvParams.uvScaleOffset.zw;` : "";

    const uv2Passthrough = needsUV2 ? `out.vUV2 = uv2;` : "";

    // Vertex UBO struct definitions (must be before binding declarations)
    const vertexUboStructs = hasShadow || needsUV ? `struct uvParamsUniforms { uvScaleOffset: vec4<f32>, }` : "";

    const vertexTemplate = `/*SU*/
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
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
out.vPositionW = worldPos4.xyz;
let normalWorld = mat3x3<f32>(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz);
out.vNormalW = normalize(normalWorld * normal);
out.clipPos = scene.viewProjection * worldPos4;
out.vFogDistance = (scene.view * worldPos4).xyz;
${uvPassthrough}
${uv2Passthrough}
/*VB*/
return out;
}`;

    // ── Fragment template ────────────────────────────────────────

    const lightsStructs = `
struct LightEntry { vLightData: vec4<f32>, vLightDiffuse: vec4<f32>, vLightSpecular: vec4<f32>, vLightDirection: vec4<f32> };
struct lightsUniforms { count: u32, _p0: u32, _p1: u32, _p2: u32, lights: array<LightEntry, ${MAX_LIGHTS}> };
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

    const helpers = [WGSL_FOG];
    if (!disableLighting) {
        helpers.push(LIGHTING_FN);
    }
    // reflection, shadow, bump helpers are provided by their respective fragments

    // Main fragment body — mirrors old composeFragmentShader exactly
    const uvSelect = (useUV2: boolean | undefined) => (useUV2 ? "input.vUV2" : "input.vUV");

    const doubleSidedEntry = `@fragment fn main(input: FragmentInput) -> @location(0) vec4<f32> {`;

    // View direction
    const viewDirCode = !disableLighting ? `let viewDirectionW = normalize(scene.vEyePosition.xyz - input.vPositionW);` : "";

    // Normal computation — fragment can override via AC slot
    let normalCode: string;
    if (!disableLighting) {
        normalCode = `var normalW = normalize(input.vNormalW);`;
    } else {
        normalCode = "";
    }

    // Opacity — default from material alpha, fragment can modify via AT
    const opacityCode = `var alpha = mat.dc.a;`;

    // Base color + alpha test. Texture alpha used for discard only (not blended into output alpha),
    // matching BJS ALPHATEST without ALPHAFROMDIFFUSE.
    const baseColorCode = textures.diffuse
        ? `let _ds = textureSample(diffuseTexture, diffuseSampler, ${uvSelect(config.diffuseUsesUV2)});
if (_ds.a < mat.aCut) { discard; }
var baseColor = _ds.rgb * mat.tl;`
        : `var baseColor = vec3<f32>(1.0, 1.0, 1.0);`;

    // Diffuse color + emissive + specular — defaults, fragments can override via AT
    const diffuseColorCode = `let diffuseColor = mat.dc.rgb;`;
    const emissiveCode = `var emissiveContrib = mat.ec;`;
    const specularColorCode = !disableLighting ? `var specularColor = mat.sc.rgb;` : "";

    // Lighting block (only when lighting enabled)
    let lightingBlock: string;
    if (!disableLighting) {
        // Shadow — default to 1.0, fragment overrides via AD slot
        // shadowFactors array is populated by std-shadow-fragment (one per light index)
        lightingBlock = `var glossiness = mat.sc.a;
var diffuseBase = vec3<f32>(0.0);
var specularBase = vec3<f32>(0.0);
var shadowFactors = array<f32, ${MAX_LIGHTS}>(${new Array(MAX_LIGHTS).fill("1.0").join(", ")});
var baseAmbientColor = vec3<f32>(1.0, 1.0, 1.0);
var reflectionColor = vec3<f32>(0.0);
let lc = min(lights.count, ${MAX_LIGHTS}u);
/*AD*/
for (var li = 0u; li < lc; li++) {
let r = computeLighting(viewDirectionW, normalW, lights.lights[li], glossiness, input.vPositionW);
let sf = shadowFactors[li];
diffuseBase += r[0] * sf;
specularBase += r[1] * sf;
}
let finalDiffuse = clamp(diffuseBase * diffuseColor + emissiveContrib + mat.ac, vec3<f32>(0.0), vec3<f32>(1.0)) * baseColor;
let finalSpecular = specularBase * specularColor;
var color = vec4<f32>(finalDiffuse * baseAmbientColor + finalSpecular + reflectionColor, alpha);`;
    } else {
        lightingBlock = `var color = vec4<f32>(clamp(emissiveContrib * diffuseColor, vec3<f32>(0.0), vec3<f32>(1.0)) * baseColor, alpha);`;
    }

    const fragmentTemplate = `/*SU*/
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
${lightsStructs}
${materialStruct}
/*MU*/
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
${helpers.join("\n")}
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
${lightingBlock}
/*BC*/
color = vec4<f32>(max(color.rgb, vec3<f32>(0.0)), color.a);
if (scene.vFogInfos.x > 0.0) {
let fog = calcFogFactor(input.vFogDistance);
color = vec4<f32>(mix(scene.vFogColor.rgb, color.rgb, fog), color.a);
}
/*BA*/
return color;
}`;

    return {
        vertexTemplate,
        fragmentTemplate,
        baseMeshUboFields,
        baseSceneUboFields,
        baseVertexAttributes,
        baseVaryings,
        baseBindings,
        baseVertexBindings,
    };
}
