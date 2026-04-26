/**
 * PBR Base Template
 *
 * Provides the base PBR shader structure with slot markers where
 * fragments inject their code. This is the PBR equivalent of
 * what composePbrVertex/composePbrFragment produce today.
 *
 * The template is parameterized by light type and feature flags
 * because these fundamentally change the shader structure.
 */

import type { ShaderTemplate, UboField, VertexAttribute, Varying, BindingDecl } from "../../shader/fragment-types.js";
import type { PbrTemplateExt } from "./pbr-template-ext.js";

const STAGE_FRAGMENT = 0x2;

// ── BRDF functions (always present in PBR) ──────────────────────

const BRDF_FUNCTIONS = `
const PI: f32 = 3.14159265358979323846;
fn distributionGGX(NdotH: f32, alphaG: f32) -> f32 {
let a2 = alphaG * alphaG;
let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
return a2 / (PI * d * d);
}
fn geometrySmithGGX(NdotL: f32, NdotV: f32, alphaG: f32) -> f32 {
let a2 = alphaG * alphaG;
let gl = NdotL * sqrt(NdotV * (NdotV - a2 * NdotV) + a2);
let gv = NdotV * sqrt(NdotL * (NdotL - a2 * NdotL) + a2);
return 0.5 / (gl + gv);
}
fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>, F90: vec3<f32>) -> vec3<f32> {
let t = 1.0 - cosTheta;
let t2 = t * t;
return F0 + (F90 - F0) * (t2 * t2 * t);
}
`;

export interface PbrLightConfig {
    /** Scene UBO fields for light data */
    readonly sceneUboFields: readonly UboField[];
    /** WGSL: compute L, NdotL, lightAtten from N + scene data */
    readonly lightVectorCode: string;
    /** WGSL: compute directDiffuse from surfaceAlbedo, NdotL, lightColor, etc. */
    readonly directDiffuseCode: string;
    /** WGSL: geometric AA for specular (empty string if not needed) */
    readonly geometricAACode: string;
}

export interface PbrTemplateConfig {
    /** Light configuration (null = no direct light). Used for single-light path
     *  (scenes without shadows, e.g. clearcoat/sheen scenes). */
    readonly light?: PbrLightConfig | null;
    /** When true, generates a multi-light loop + lights UBO binding.
     *  Overrides `light`. Used for scenes with shadow generators. */
    readonly hasMultiLight?: boolean;
    /** Pre-built WGSL for multi-light (structs + computePbrLight). Passed from
     *  dynamically imported fragments/multilight-wgsl.ts to keep it out of non-shadow bundles. */
    readonly multiLightWGSL?: string;
    /** Pre-built WGSL for the multi-light direct lighting loop body. */
    readonly multiLightLoop?: string;
    /** Normal map mode (default: "none") */
    readonly normalMode?: "tangent" | "cotangent" | "none";
    /** Has emissive texture */
    readonly hasEmissiveTexture?: boolean;
    /** Has specular-glossiness workflow */
    readonly hasSpecGloss?: boolean;
    /** Has double-sided rendering */
    readonly hasDoubleSided?: boolean;
    /** Has tonemap */
    readonly hasTonemap?: boolean;
    /** ACES WGSL: tonemap helper functions (dynamically imported). Empty string = standard exponential tonemap. */
    readonly acesHelpers?: string;
    /** ACES WGSL: tonemap call block replacing the default exponential one. */
    readonly acesTonemapCall?: string;
    /** Has alpha blending */
    readonly hasAlphaBlend?: boolean;
    /** Has specular AA */
    readonly hasSpecularAA?: boolean;
    /** Has gamma albedo (sRGB base color decode) */
    readonly hasGammaAlbedo?: boolean;
    /** Has morph targets (changes position/normal variable names in vertex shader) */
    readonly hasMorph?: boolean;
    /** Has occlusion in ORM texture (simple path, no reflectance ext) */
    readonly hasOcclusion?: boolean;
    /** Has emissive color UBO field (fragment handles emissive computation) */
    readonly hasEmissiveColor?: boolean;
    /** When true, the reflectance fragment handles F0 + occlusion computation */
    readonly hasReflectanceExt?: boolean;
    /** When true, include IBL SH coefficients in scene UBO */
    readonly hasIbl?: boolean;
    /** Has anisotropy layer */
    readonly hasAnisotropy?: boolean;
    /** Anisotropy WGSL: BRDF helper functions (dynamically imported). */
    readonly anisoBrdfFunctions?: string;
    /** Anisotropy WGSL: T/B computation block (dynamically imported). */
    readonly anisoTBBlock?: string;
    /** Anisotropy WGSL: direct lighting D/G replacement (dynamically imported). */
    readonly anisoDirectDG?: string;
    /** Optional extension config for advanced features (UV transforms, UV2, vertex colors).
     *  When undefined, base template defaults to master-like behavior (no feature strings). */
    readonly ext?: PbrTemplateExt;
}

/**
 * Return the scene UBO field list used by the PBR base template.
 * Cheap list-building only — no WGSL assembly. Exposed so callers that only
 * need the UBO layout (e.g. scene UBO spec computation) can avoid paying the
 * full createPbrTemplate cost.
 */
export function getPbrBaseSceneUboFields(light: PbrLightConfig | null, hasMultiLight: boolean, hasIbl: boolean): readonly UboField[] {
    // When hasMultiLight, light data comes from the lights UBO — scene UBO fields
    // are kept as reserved padding for layout compatibility with background shaders.
    const lightUboFields: readonly UboField[] =
        hasMultiLight || !light
            ? [
                  { name: "lightDirection", type: "vec3<f32>" },
                  { name: "lightIntensity", type: "f32" },
                  { name: "lightDiffuseColor", type: "vec3<f32>" },
                  { name: "_pad1", type: "f32" },
                  { name: "lightGroundColor", type: "vec3<f32>" },
              ]
            : light.sceneUboFields;

    // SH coefficients are included in the base template (not the IBL fragment)
    // because the scene UBO writer uses fixed offsets for SH data.
    const SH_NAMES = ["L00", "L1_1", "L10", "L11", "L2_2", "L2_1", "L20", "L21", "L22"] as const;
    const shFields: UboField[] = hasIbl
        ? SH_NAMES.flatMap((n, i) => [
              { name: `vSpherical${n}`, type: "vec3<f32>" as const },
              { name: `_shPad${i}`, type: "f32" as const },
          ])
        : [];

    return [
        { name: "viewProj", type: "mat4x4<f32>" },
        { name: "cameraPosition", type: "vec3<f32>" },
        { name: "_pad0", type: "f32" },
        ...lightUboFields,
        { name: "envRotationY", type: "f32" },
        ...shFields,
        { name: "exposureLinear", type: "f32" },
        { name: "contrast", type: "f32" },
        { name: "lodGenerationScale", type: "f32" },
        { name: "_imgPad1", type: "f32" },
    ];
}

/**
 * Create a PBR ShaderTemplate from the given configuration.
 * The template contains slot markers that the composer fills with fragment code.
 */
export function createPbrTemplate(config: PbrTemplateConfig): ShaderTemplate {
    const {
        light = null,
        hasMultiLight = false,
        multiLightWGSL = "",
        multiLightLoop = "",
        normalMode = "none",
        hasEmissiveTexture = false,
        hasSpecGloss = false,
        hasDoubleSided = false,
        hasTonemap = false,
        acesHelpers = "",
        acesTonemapCall = "",
        hasAlphaBlend = false,
        hasSpecularAA = false,
        hasGammaAlbedo = false,
        hasMorph = false,
        hasOcclusion = false,
        hasEmissiveColor = false,
        hasReflectanceExt = false,
        hasIbl = false,
        hasAnisotropy = false,
        anisoBrdfFunctions = "",
        anisoTBBlock = "",
        anisoDirectDG = "",
        ext,
    } = config;
    const hasNormal = normalMode === "tangent";
    const hasCotangentNormal = normalMode === "cotangent";
    const hasAnyNormal = hasNormal || hasCotangentNormal;

    // ── Base vertex attributes ──────────────────────────────────
    const baseVertexAttributes: VertexAttribute[] = [
        { name: "position", type: "vec3<f32>", gpuFormat: "float32x3", arrayStride: 12 },
        { name: "normal", type: "vec3<f32>", gpuFormat: "float32x3", arrayStride: 12 },
    ];
    if (hasNormal) {
        baseVertexAttributes.push({ name: "tangent", type: "vec4<f32>", gpuFormat: "float32x4", arrayStride: 16 });
    }
    baseVertexAttributes.push({ name: "uv", type: "vec2<f32>", gpuFormat: "float32x2", arrayStride: 8 });
    if (ext) {
        baseVertexAttributes.push(...ext.extraVertexAttributes);
    }

    // ── Base varyings ───────────────────────────────────────────
    const baseVaryings: Varying[] = [
        { name: "worldPos", type: "vec3<f32>" },
        { name: "worldNormal", type: "vec3<f32>" },
    ];
    if (hasNormal) {
        baseVaryings.push({ name: "worldTangent", type: "vec3<f32>" }, { name: "worldBitangent", type: "vec3<f32>" });
    }
    baseVaryings.push({ name: "uv", type: "vec2<f32>" });
    if (ext) {
        baseVaryings.push(...ext.extraVaryings);
    }

    // ── Base mesh UBO fields (world matrix only — UV transforms are
    // per-texture now, emitted on the material UBO when hasUvTransform). ─
    const baseMeshUboFields: UboField[] = [{ name: "world", type: "mat4x4<f32>" }];

    // ── Base material UBO fields ────────────────────────────────────
    const baseMaterialUboFields: UboField[] = [
        { name: "environmentIntensity", type: "f32" },
        { name: "directIntensity", type: "f32" },
        { name: "reflectance", type: "f32" },
        { name: "materialAlpha", type: "f32" },
        // glTF metallicFactor / roughnessFactor (default 1.0) — applied over MR texture channels.
        { name: "metallicFactor", type: "f32" },
        { name: "roughnessFactor", type: "f32" },
        { name: "normalScale", type: "f32" },
        { name: "_mrfPad1", type: "f32" },
        // Anisotropy UBO field stays on the base template because anisotropy is
        // template-only (no ShaderFragment) — the anisotropyExt just writes its
        // slice through the unified ext.writeUbo hook.
        ...(hasAnisotropy ? [{ name: "anisotropyParams", type: "vec4<f32>" as const }] : []),
        // ── Extension fields (per-texture UV transforms, etc.) ─
        ...(ext ? ext.extraMaterialUboFields : []),
    ];

    // ── Helper: texture + sampler binding pair ────────────────────
    const tex2d = (name: string, sampler: string): BindingDecl[] => [
        { name, type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
        { name: sampler, type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
    ];

    // ── Base scene UBO fields ───────────────────────────────────
    const baseSceneUboFields: readonly UboField[] = getPbrBaseSceneUboFields(hasMultiLight || !light ? null : light, hasMultiLight, hasIbl);

    // ── Base bindings (always-present textures) ─────────────────
    const baseBindings: BindingDecl[] = [...tex2d("baseColorTexture", "baseColorSampler")];
    if (hasAnyNormal) {
        baseBindings.push(...tex2d("normalTexture", "normalSampler_"));
    }
    baseBindings.push(...tex2d("ormTexture", "ormSampler"));
    if (ext) {
        baseBindings.push(...ext.extraBindings);
    }
    if (hasEmissiveTexture) {
        baseBindings.push(...tex2d("emissiveTexture", "emissiveSampler"));
    }
    if (hasSpecGloss) {
        baseBindings.push(...tex2d("specGlossTexture", "specGlossSampler"));
    }
    if (hasMultiLight) {
        baseBindings.push({ name: "lights", type: { kind: "uniform-buffer" }, visibility: STAGE_FRAGMENT });
    }

    // ── Vertex template ─────────────────────────────────────────
    // When morph targets are active, the morph fragment's VR
    // defines morphedPos/morphedNorm. The base template uses those instead
    // of the raw vertex attributes.
    const posVar = hasMorph ? "morphedPos" : "position";
    const normVar = hasMorph ? "morphedNorm" : "normal";

    // The vertex template uses morphedPos/morphedNorm when morph fragment is present,
    // falling back to position/normal. The morph fragment's VR defines these vars.
    const tangentBlock = hasNormal
        ? `let N_local = normalize(${normVar});
let T_local = normalize(tangent.xyz);
let B_local = cross(N_local, T_local) * tangent.w;
out.worldTangent = (finalWorld * vec4<f32>(T_local, 0.0)).xyz;
out.worldBitangent = (finalWorld * vec4<f32>(B_local, 0.0)).xyz;`
        : "";

    const vertexTemplate = `/*SU*/
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
/*MU*/
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
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
let worldPos4 = finalWorld * vec4<f32>(${posVar}, 1.0);
out.worldPos = worldPos4.xyz;
out.clipPos = scene.viewProj * worldPos4;
out.worldNormal = (finalWorld * vec4<f32>(normalize(${normVar}), 0.0)).xyz;
${tangentBlock}
out.uv = uv;
${ext ? ext.vertexBodyExtra : ""}/*VB*/
return out;
}`;

    // ── Fragment template ────────────────────────────────────────

    // Normal handling block
    const normalUV = ext?.uvForNormal ?? "input.uv";
    const normalScaleMod = ext?.normalScaleMod ?? "";
    const normalRef = ext?.normalScaleMod ? "scaledNormal" : "normalMapRaw";
    const normalRefCt = ext?.normalScaleMod ? "scaledNormalCT" : "normalMapSample";
    let normalBlock: string;
    if (hasNormal) {
        normalBlock = `let normalMapRaw = textureSample(normalTexture, normalSampler_, ${normalUV}).rgb * 2.0 - 1.0;
${normalScaleMod}let normalMapNorm = normalize(${normalRef});
let N_geom = normalize(input.worldNormal);
let TBN = mat3x3<f32>(input.worldTangent, input.worldBitangent, input.worldNormal);
var N = normalize(TBN * normalMapNorm);`;
    } else if (hasCotangentNormal) {
        normalBlock = `let normalMapSample = textureSample(normalTexture, normalSampler_, ${normalUV}).rgb * 2.0 - 1.0;
${normalScaleMod.replace(/normalMapRaw/g, "normalMapSample").replace(/scaledNormal/g, "scaledNormalCT")}let N_geom = normalize(input.worldNormal);
let dp1 = dpdx(input.worldPos);
let dp2 = dpdy(input.worldPos);
let duv1 = dpdx(${normalUV});
let duv2 = dpdy(${normalUV});
let dp2perp = cross(dp2, N_geom);
let dp1perp = cross(N_geom, dp1);
let tangent_ct = dp2perp * duv1.x + dp1perp * duv2.x;
let bitangent_ct = -(dp2perp * duv1.y + dp1perp * duv2.y);
let det = max(dot(tangent_ct, tangent_ct), dot(bitangent_ct, bitangent_ct));
let invmax = select(inverseSqrt(det), 0.0, det == 0.0);
let cotangentFrame = mat3x3<f32>(tangent_ct * invmax, bitangent_ct * invmax, N_geom);
var N = normalize(cotangentFrame * normalize(${normalRefCt}));`;
    } else {
        normalBlock = `let N_geom = normalize(input.worldNormal);
var N = N_geom;`;
    }

    // Anisotropy: tangent/bitangent frame (passed in from dynamic import, empty if not used)
    const anisotropyTBBlock = hasAnisotropy ? anisoTBBlock : "";

    // Base color decoding
    const vertexColorMod = ext?.baseColorMod ?? "";
    const baseColorDecode = hasGammaAlbedo
        ? `var baseColor = pow(baseColorSample.rgb, vec3<f32>(2.2));
var alpha = baseColorSample.a;${vertexColorMod}`
        : `var baseColor = baseColorSample.rgb;
var alpha = baseColorSample.a;${vertexColorMod}`;

    // Roughness / metallic
    const specGlossUV = ext?.uvForSpecGloss ?? "input.uv";
    const roughnessMetallic = hasSpecGloss
        ? `let specGloss = textureSample(specGlossTexture, specGlossSampler, ${specGlossUV});
let roughness = clamp(1.0 - specGloss.a, 0.0, 1.0);
let metallic = 0.0;`
        : `let roughness = clamp(orm.g * material.roughnessFactor, 0.0, 1.0);
let metallic = orm.b * material.metallicFactor;`;

    // Emissive default (overridden by emissive-color fragment's AT slot)
    const emissiveUV = ext?.uvForEmissive ?? "input.uv";
    const emissiveDefault = hasEmissiveColor
        ? ``
        : hasEmissiveTexture
          ? `let emissive = textureSample(emissiveTexture, emissiveSampler, ${emissiveUV}).rgb;`
          : `let emissive = vec3<f32>(0.0);`;

    // Occlusion default (overridden by reflectance fragment's AT slot or ext occlusion override)
    const occlusionDefault = hasReflectanceExt ? `` : ext?.occlusionOverride ? ext.occlusionOverride : hasOcclusion ? `let occlusion = orm.r;` : `let occlusion = 1.0;`;

    // F0 computation (overridden by reflectance fragment's MF slot)
    const f0Default = hasReflectanceExt
        ? ``
        : hasSpecGloss
          ? `var colorF0 = specGloss.rgb;
let colorF90 = vec3<f32>(1.0);
let maxSpecular = max(colorF0.r, max(colorF0.g, colorF0.b));
let surfaceAlbedo = baseColor * (1.0 - maxSpecular);`
          : `let dielectricF0 = material.reflectance;
var colorF0 = mix(vec3<f32>(dielectricF0), baseColor, metallic);
let colorF90 = vec3<f32>(1.0);
let surfaceAlbedo = baseColor * (1.0 - dielectricF0) * (1.0 - metallic);`;

    // Specular AA + geometric-curvature roughness factors (BJS getAARoughnessFactors).
    // AA_factor_x is the direct-light roughness floor (matches BJS `computeSheenLighting`
    // which clamps info.roughness upward). AA_factor_y is the IBL/alphaG additive bump.
    // Emitted unconditionally as var so sheen/other fragments can reference them
    // without needing a define; zero on the no-curvature path makes them a no-op.
    const specularAABlock =
        hasSpecularAA || hasAnyNormal
            ? `var AA_factor_x = 0.0;
var AA_factor_y = 0.0;
{ let nDfdx_AA = dpdx(N);
  let nDfdy_AA = dpdy(N);
  let slopeSquare_AA = max(dot(nDfdx_AA, nDfdx_AA), dot(nDfdy_AA, nDfdy_AA));
  AA_factor_x = pow(saturate(slopeSquare_AA), 0.333);
  AA_factor_y = sqrt(slopeSquare_AA) * 0.75;
  alphaG += AA_factor_y; }`
            : `var AA_factor_x = 0.0;
var AA_factor_y = 0.0;`;

    // Direct lighting block
    let directLightBlock: string;
    if (hasMultiLight) {
        directLightBlock = multiLightLoop;
    } else if (light) {
        const geomAA = hasSpecularAA || hasAnyNormal ? light.geometricAACode : "";
        const dgBlock = hasAnisotropy
            ? anisoDirectDG
            : `let D = distributionGGX(NdotH, directAlphaG);
let G = geometrySmithGGX(NdotL, NdotV, directAlphaG);`;
        directLightBlock = `var directAlphaG = alphaG;
${light.lightVectorCode}
let H = normalize(V + L);
let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
let VdotH = saturate(dot(V, H));
${geomAA}
${dgBlock}
let coloredFresnel = fresnelSchlick(VdotH, colorF0, colorF90);
let lightColor = scene.lightDiffuseColor * scene.lightIntensity;
${light.directDiffuseCode}
var directSpecular = coloredFresnel * D * G * NdotL * lightColor * lightAtten * material.directIntensity;
/*AD*/`;
    } else {
        directLightBlock = `var directDiffuse = vec3<f32>(0.0);
var directSpecular = vec3<f32>(0.0);
/*BL*/`;
    }

    // Tonemap: BJS TONEMAPPING_STANDARD (exponential) by default; caller-supplied
    // ACES WGSL (from pbr-aces-wgsl.ts) is used when provided.
    const useAces = hasTonemap && acesTonemapCall !== "";
    const acesBlock = useAces ? acesHelpers : "";
    const tonemapBlock = hasTonemap
        ? useAces
            ? acesTonemapCall
            : `color *= scene.exposureLinear;
color = 1.0 - exp2(-1.590579 * color);`
        : `color *= scene.exposureLinear;`;

    // Alpha output
    const alphaBlock = hasAlphaBlend
        ? `var finalAlpha = alpha * material.materialAlpha;
var luminanceOverAlpha = 0.0;
/*BA*/
luminanceOverAlpha += dot(finalSpecularScaled, vec3<f32>(0.2126, 0.7152, 0.0722));
finalAlpha = saturate(finalAlpha + luminanceOverAlpha * luminanceOverAlpha);
return vec4<f32>(color, finalAlpha);`
        : `return vec4<f32>(color, alpha * material.materialAlpha);`;

    const doubleSidedEntry = hasDoubleSided
        ? `@fragment fn main(input: FragmentInput, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {`
        : `@fragment fn main(input: FragmentInput) -> @location(0) vec4<f32> {`;
    const doubleSidedFlip = hasDoubleSided ? `if (!frontFacing) { N = -N; }` : "";

    const multiLightDecls = hasMultiLight ? multiLightWGSL : "";

    const anisoBrdfBlock = hasAnisotropy ? anisoBrdfFunctions : "";

    const fragmentHelpers = ext?.fragmentHelpers ?? "";
    const fragmentPrelude = ext?.fragmentPrelude ?? "";
    const baseColorUV = ext?.uvForBaseColor ?? "input.uv";
    const ormUV = ext?.uvForOrm ?? "input.uv";

    const fragmentTemplate = `/*SU*/
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
/*MU*/
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
/*HF*/
/*FB*/
/*FI*/
${BRDF_FUNCTIONS}
${acesBlock}
${anisoBrdfBlock}
${multiLightDecls}
${fragmentHelpers}
${doubleSidedEntry}
${fragmentPrelude}/*SV*/
let baseColorSample = textureSample(baseColorTexture, baseColorSampler, ${baseColorUV});
${baseColorDecode}
let orm = textureSample(ormTexture, ormSampler, ${ormUV}).rgb;
${occlusionDefault}
${roughnessMetallic}
${emissiveDefault}
/*AT*/
${normalBlock}
${doubleSidedFlip}
${anisotropyTBBlock}
/*AC*/
let V = normalize(scene.cameraPosition - input.worldPos);
let NdotVUnclamped = dot(N, V);
let NdotV = abs(NdotVUnclamped) + 0.0000001;
${f0Default}
/*MF*/
var alphaG = roughness * roughness + 0.0005;
${specularAABlock}
${directLightBlock}
var color = directDiffuse + directSpecular + emissive;
/*AI*/
/*NI*/
${tonemapBlock}
color = pow(color, vec3<f32>(1.0 / 2.2));
color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
let highContrast = color * color * (3.0 - 2.0 * color);
if (scene.contrast < 1.0) { color = mix(vec3<f32>(0.5), color, scene.contrast); }
else { color = mix(color, highContrast, scene.contrast - 1.0); }
color = max(color, vec3<f32>(0.0));
/*BC*/
${alphaBlock}
}`;

    return {
        vertexTemplate,
        fragmentTemplate,
        baseMeshUboFields,
        baseMaterialUboFields,
        baseSceneUboFields,
        baseVertexAttributes,
        baseVaryings,
        baseBindings,
    };
}
