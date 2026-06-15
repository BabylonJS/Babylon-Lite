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
import type { MeshVbLayout } from "../../mesh/mesh.js";
import { appendMeshLightUboFields, meshLightIndexWGSL } from "../../render/lights-ubo.js";

const STAGE_FRAGMENT = 0x2;

// ── BRDF functions (always present in PBR) ──────────────────────

const BRDF_FUNCTIONS = `
const PI:f32=3.14159265358979323846;
fn distributionGGX(NdotH:f32,alphaG:f32)->f32{
let a2=alphaG*alphaG;
let d=NdotH*NdotH*(a2-1.0)+1.0;
return a2/(PI*d*d);
}
fn geometrySmithGGX(NdotL:f32,NdotV:f32,alphaG:f32)->f32{
let a2=alphaG*alphaG;
let gl=NdotL*sqrt(NdotV*(NdotV-a2*NdotV)+a2);
let gv=NdotV*sqrt(NdotL*(NdotL-a2*NdotL)+a2);
return 0.5/(gl+gv);
}
fn fresnelSchlick(cosTheta:f32,F0:vec3<f32>,F90:vec3<f32>)->vec3<f32>{
let t=1.0-cosTheta;
let t2=t*t;
return F0+(F90-F0)*(t2*t2*t);
}
`;

export interface PbrTemplateConfig {
    /** When true, generates a non-looping single-light direct block + lights UBO binding. */
    /** @internal */
    readonly _hasSingleLight?: boolean;
    /** When true, generates a multi-light loop + lights UBO binding.
     *  Used for multiple lights or shadow receivers. */
    /** @internal */
    readonly _hasMultiLight?: boolean;
    /** Pre-built WGSL for the single-light UBO structs. */
    /** @internal */
    readonly _singleLightWGSL?: string;
    /** Pre-built WGSL for the single-light direct lighting block. */
    /** @internal */
    readonly _singleLightBlock?: string;
    /** Pre-built WGSL for multi-light (structs + computePbrLight). Passed from
     *  dynamically imported fragments/multilight-wgsl.ts to keep it out of non-shadow bundles. */
    /** @internal */
    readonly _multiLightWGSL?: string;
    /** Pre-built WGSL for the multi-light direct lighting loop body. */
    /** @internal */
    readonly _multiLightLoop?: string;
    /** Normal map mode (default: "none") */
    /** @internal */
    readonly _normalMode?: "tangent" | "cotangent" | "none";
    /** Has emissive texture */
    /** @internal */
    readonly _hasEmissiveTexture?: boolean;
    /** Has specular-glossiness workflow */
    /** @internal */
    readonly _hasSpecGloss?: boolean;
    /** Has double-sided rendering */
    /** @internal */
    readonly _hasDoubleSided?: boolean;
    /** Has tonemap */
    /** @internal */
    readonly _hasTonemap?: boolean;
    /** Scene has fog (scene.fog != null). `calcFogFactor` helper WGSL, supplied by the dynamic
     *  pbr-fog-wgsl import only for fog scenes; "" otherwise (zero bytes for non-fog scenes). */
    /** @internal */
    readonly _fogHelper?: string;
    /** Fog blend WGSL, emitted just before the tonemap block; "" for non-fog scenes. */
    /** @internal */
    readonly _fogBlock?: string;
    /** ACES WGSL: tonemap helper functions (dynamically imported). Empty string = standard exponential tonemap. */
    /** @internal */
    readonly _acesHelpers?: string;
    /** ACES WGSL: tonemap call block replacing the default exponential one. */
    /** @internal */
    readonly _acesTonemapCall?: string;
    /** Has alpha blending */
    /** @internal */
    readonly _hasAlphaBlend?: boolean;
    /** Has specular AA */
    /** @internal */
    readonly _hasSpecularAA?: boolean;
    /** Has gamma albedo (sRGB base color decode) */
    /** @internal */
    readonly _hasGammaAlbedo?: boolean;
    /** Has a non-default base-color factor multiplied over the base-color texture. */
    /** @internal */
    readonly _hasBaseColorFactor?: boolean;
    /** Has morph targets (changes position/normal variable names in vertex shader) */
    /** @internal */
    readonly _hasMorph?: boolean;
    /** Has occlusion in ORM texture (simple path, no reflectance ext) */
    /** @internal */
    readonly _hasOcclusion?: boolean;
    /** Has emissive color UBO field (fragment handles emissive computation) */
    /** @internal */
    readonly _hasEmissiveColor?: boolean;
    /** When true, the reflectance fragment handles F0 + occlusion computation */
    /** @internal */
    readonly _hasReflectanceExt?: boolean;
    /** When true, include IBL SH coefficients in scene UBO */
    /** @internal */
    readonly _hasIbl?: boolean;
    /** Has anisotropy layer */
    /** @internal */
    readonly _hasAnisotropy?: boolean;
    /** Anisotropy WGSL: BRDF helper functions (dynamically imported). */
    /** @internal */
    readonly _anisoBrdfFunctions?: string;
    /** Anisotropy WGSL: T/B computation block (dynamically imported). */
    /** @internal */
    readonly _anisoTBBlock?: string;
    /** Optional extension config for advanced features (UV transforms, UV2, vertex colors).
     *  When undefined, base template defaults to master-like behavior (no feature strings). */
    /** @internal */
    readonly _ext?: PbrTemplateExt;
    /** Generate a fragment stage that runs discard/alpha-test logic and writes no color. */
    /** @internal */
    readonly _noColorOutput?: boolean;
    /** Generate a fragment stage that runs discard/alpha-test logic and writes ESM shadow color. */
    /** @internal */
    readonly _esmShadowOutput?: boolean;
    /** ESM shadow depth output code. Supplied by the ESM material view so normal PBR bundles don't retain it. */
    /** @internal */
    readonly _esmShadowDepthCode?: string;
    /** @internal Per-attribute vertex-buffer interleave layout. Undefined (or per-attribute
     *  undefined) → canonical tight strides (12/12/16/8). Only set for meshes
     *  sourcing attributes from a strided bufferView. */
    readonly _vbStrides?: MeshVbLayout;
}

/**
 * Create a PBR ShaderTemplate from the given configuration.
 * The template contains slot markers that the composer fills with fragment code.
 */
export function createPbrTemplate(config: PbrTemplateConfig): ShaderTemplate {
    const {
        _hasSingleLight = false,
        _hasMultiLight = false,
        _singleLightWGSL = "",
        _singleLightBlock = "",
        _multiLightWGSL = "",
        _multiLightLoop = "",
        _normalMode = "none",
        _hasEmissiveTexture = false,
        _hasSpecGloss = false,
        _hasDoubleSided = false,
        _hasTonemap = false,
        _fogHelper = "",
        _fogBlock = "",
        _acesHelpers = "",
        _acesTonemapCall = "",
        _hasAlphaBlend = false,
        _hasSpecularAA = false,
        _hasGammaAlbedo = false,
        _hasBaseColorFactor = false,
        _hasMorph = false,
        _hasOcclusion = false,
        _hasEmissiveColor = false,
        _hasReflectanceExt = false,
        _hasIbl = false,
        _hasAnisotropy = false,
        _anisoBrdfFunctions = "",
        _anisoTBBlock = "",
        _ext,
        _noColorOutput = false,
        _esmShadowOutput = false,
        _esmShadowDepthCode = "",
        _vbStrides,
    } = config;
    const hasNormal = _normalMode === "tangent";
    const hasCotangentNormal = _normalMode === "cotangent";
    const hasAnyNormal = hasNormal || hasCotangentNormal;

    // ── Base vertex attributes ──────────────────────────────────
    // arrayStride defaults to the canonical tight element size; interleaved meshes
    // override it (e.g. 24 for POSITION+NORMAL sharing one stride-24 bufferView).
    const _baseVertexAttributes: VertexAttribute[] = [
        { _name: "position", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: _vbStrides?._p?._stride ?? 12 },
        { _name: "normal", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: _vbStrides?._n?._stride ?? 12 },
    ];
    if (hasNormal) {
        _baseVertexAttributes.push({ _name: "tangent", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: _vbStrides?._t?._stride ?? 16 });
    }
    _baseVertexAttributes.push({ _name: "uv", _type: "vec2<f32>", _gpuFormat: "float32x2", _arrayStride: _vbStrides?._u?._stride ?? 8 });
    if (_ext) {
        _baseVertexAttributes.push(..._ext.extraVertexAttributes);
    }

    // ── Base varyings ───────────────────────────────────────────
    const _baseVaryings: Varying[] = [
        { _name: "worldPos", _type: "vec3<f32>" },
        { _name: "worldNormal", _type: "vec3<f32>" },
    ];
    if (hasNormal) {
        _baseVaryings.push({ _name: "worldTangent", _type: "vec3<f32>" }, { _name: "worldBitangent", _type: "vec3<f32>" });
    }
    _baseVaryings.push({ _name: "uv", _type: "vec2<f32>" });
    if (_ext) {
        _baseVaryings.push(..._ext.extraVaryings);
    }

    // ── Base mesh UBO fields (world matrix + affected light indices — UV transforms are
    // per-texture now, emitted on the material UBO when hasUvTransform). ─
    const _baseMeshUboFields: UboField[] = [{ _name: "world", _type: "mat4x4<f32>" }];
    appendMeshLightUboFields(_baseMeshUboFields);

    // ── Base material UBO fields ────────────────────────────────────
    const _baseMaterialUboFields: UboField[] = [
        { _name: "environmentIntensity", _type: "f32" },
        { _name: "directIntensity", _type: "f32" },
        { _name: "reflectance", _type: "f32" },
        { _name: "materialAlpha", _type: "f32" },
        ...(_hasBaseColorFactor ? [{ _name: "baseColorFactor", _type: "vec4<f32>" as const }] : []),
        // glTF metallicFactor / roughnessFactor (default 1.0) — applied over MR texture channels.
        { _name: "metallicFactor", _type: "f32" },
        { _name: "roughnessFactor", _type: "f32" },
        { _name: "normalScale", _type: "f32" },
        { _name: "lightFalloffMode", _type: "f32" },
        // Anisotropy UBO field stays on the base template because anisotropy is
        // template-only (no ShaderFragment) — the anisotropyExt just writes its
        // slice through the unified ext.writeUbo hook.
        ...(_hasAnisotropy ? [{ _name: "anisotropyParams", _type: "vec4<f32>" as const }] : []),
        // ── Extension fields (per-texture UV transforms, etc.) ─
        ...(_ext ? _ext.extraMaterialUboFields : []),
    ];

    // ── Helper: texture + sampler binding pair ────────────────────
    const tex2d = (name: string, sampler: string): BindingDecl[] => [
        { _name: name, _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
        { _name: sampler, _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
    ];

    // ── Base bindings (always-present textures) ─────────────────
    const _baseBindings: BindingDecl[] = tex2d("baseColorTexture", "baseColorSampler");
    if (hasAnyNormal) {
        _baseBindings.push(...tex2d("normalTexture", "normalSampler_"));
    }
    _baseBindings.push(...tex2d("ormTexture", "ormSampler"));
    if (_ext) {
        _baseBindings.push(..._ext.extraBindings);
    }
    if (_hasEmissiveTexture) {
        _baseBindings.push(...tex2d("emissiveTexture", "emissiveSampler"));
    }
    if (_hasSpecGloss) {
        _baseBindings.push(...tex2d("specGlossTexture", "specGlossSampler"));
    }
    if (_esmShadowOutput) {
        _baseBindings.push({ _name: "shadowParams", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_FRAGMENT });
    }
    // ── Vertex template ─────────────────────────────────────────
    // When morph targets are active, the morph fragment's VR
    // defines morphedPos/morphedNorm. The base template uses those instead
    // of the raw vertex attributes.
    const posVar = _hasMorph ? "morphedPos" : "position";
    const normVar = _hasMorph ? "morphedNorm" : "normal";

    // The vertex template uses morphedPos/morphedNorm when morph fragment is present,
    // falling back to position/normal. The morph fragment's VR defines these vars.
    const tangentBlock = hasNormal
        ? `let N_local=normalize(${normVar});
let T_local=normalize(tangent.xyz);
let B_local=cross(N_local,T_local)*tangent.w;
out.worldTangent=(finalWorld*vec4<f32>(T_local,0.0)).xyz;
out.worldBitangent=(finalWorld*vec4<f32>(B_local,0.0)).xyz;`
        : "";

    const _vertexTemplate = `/*SU*/
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
out.clipPos = scene.viewProjection * worldPos4;
out.worldNormal = (finalWorld * vec4<f32>(normalize(${normVar}), 0.0)).xyz;
${tangentBlock}
out.uv = uv;
    ${_ext ? _ext.vertexBodyExtra : ""}/*VB*/
return out;
}`;

    // ── Fragment template ────────────────────────────────────────

    // Normal handling block
    const normalUV = _ext?.uvForNormal ?? "input.uv";
    const normalScaleMod = _ext?.normalScaleMod ?? "";
    const normalRef = _ext?.normalScaleMod ? "scaledNormal" : "normalMapRaw";
    const normalRefCt = _ext?.normalScaleMod ? "scaledNormalCT" : "normalMapSample";
    let normalBlock: string;
    if (hasNormal) {
        normalBlock = `let normalMapRaw=textureSample(normalTexture,normalSampler_,${normalUV}).rgb*2.0-1.0;
${normalScaleMod}let normalMapNorm=normalize(${normalRef});
let N_geom=normalize(input.worldNormal);
let TBN=mat3x3<f32>(input.worldTangent,input.worldBitangent,input.worldNormal);
var N=normalize(TBN*normalMapNorm);`;
    } else if (hasCotangentNormal) {
        normalBlock = `let normalMapSample=textureSample(normalTexture,normalSampler_,${normalUV}).rgb*2.0-1.0;
${normalScaleMod.replace(/normalMapRaw/g, "normalMapSample").replace(/scaledNormal/g, "scaledNormalCT")}let N_geom=normalize(input.worldNormal);
let dp1=dpdx(input.worldPos);
let dp2=dpdy(input.worldPos);
let duv1=dpdx(${normalUV});
let duv2=dpdy(${normalUV});
let dp2perp=cross(dp2,N_geom);
let dp1perp=cross(N_geom,dp1);
let tangent_ct=dp2perp*duv1.x+dp1perp*duv2.x;
let bitangent_ct=-(dp2perp*duv1.y+dp1perp*duv2.y);
let det=max(dot(tangent_ct,tangent_ct),dot(bitangent_ct,bitangent_ct));
let invmax=select(inverseSqrt(det),0.0,det==0.0);
let cotangentFrame=mat3x3<f32>(tangent_ct*invmax,bitangent_ct*invmax,N_geom);
var N=normalize(cotangentFrame*normalize(${normalRefCt}));`;
    } else {
        normalBlock = `let N_geom=normalize(input.worldNormal);
var N=N_geom;`;
    }

    // Anisotropy: tangent/bitangent frame (passed in from dynamic import, empty if not used)
    const anisotropyTBBlock = _hasAnisotropy ? _anisoTBBlock : "";

    // Base color decoding
    const vertexColorMod = _ext?.baseColorMod ?? "";
    const baseColorFactorRgb = _hasBaseColorFactor ? "*material.baseColorFactor.rgb" : "";
    const baseColorFactorAlpha = _hasBaseColorFactor ? "*material.baseColorFactor.a" : "";
    const baseColorDecode = _hasGammaAlbedo
        ? `var baseColor=pow(baseColorSample.rgb,vec3<f32>(2.2))${baseColorFactorRgb};
var alpha=baseColorSample.a${baseColorFactorAlpha};${vertexColorMod}`
        : `var baseColor=baseColorSample.rgb${baseColorFactorRgb};
var alpha=baseColorSample.a${baseColorFactorAlpha};${vertexColorMod}`;

    // Roughness / metallic
    const specGlossUV = _ext?.uvForSpecGloss ?? "input.uv";
    const roughnessMetallic = _hasSpecGloss
        ? `let specGloss=textureSample(specGlossTexture,specGlossSampler,${specGlossUV});
let roughness=clamp(1.0-specGloss.a,0.0,1.0);
let metallic=0.0;`
        : `let roughness=clamp(orm.g*material.roughnessFactor,0.0,1.0);
let metallic=orm.b*material.metallicFactor;`;

    // Material-view / pass variants can skip extension slots while still compiling the colour path.
    const emissiveUV = _ext?.uvForEmissive ?? "input.uv";
    const emissiveDefault = _hasEmissiveColor || !_hasEmissiveTexture ? `var emissive:vec3f;` : `let emissive=textureSample(emissiveTexture,emissiveSampler,${emissiveUV}).rgb;`;

    // Occlusion default (overridden by reflectance fragment's AT slot or ext occlusion override)
    const occlusionDefault = _hasReflectanceExt ? `` : _ext?.occlusionOverride ? _ext.occlusionOverride : _hasOcclusion ? `let occlusion=orm.r;` : `let occlusion=1.0;`;
    // F0 computation (overridden by reflectance fragment's MF slot)
    const f0Default = _hasReflectanceExt
        ? ``
        : _hasSpecGloss
          ? `var colorF0=specGloss.rgb;
let colorF90=vec3<f32>(1.0);
let maxSpecular=max(colorF0.r,max(colorF0.g,colorF0.b));
let surfaceAlbedo=baseColor*(1.0-maxSpecular);`
          : `let dielectricF0=material.reflectance;
var colorF0=mix(vec3<f32>(dielectricF0),baseColor,metallic);
let colorF90=vec3<f32>(1.0);
let surfaceAlbedo=baseColor*(1.0-dielectricF0)*(1.0-metallic);`;

    // Specular AA + geometric-curvature roughness factors (BJS getAARoughnessFactors).
    // AA_factor_x is the direct-light roughness floor (matches BJS `computeSheenLighting`
    // which clamps info.roughness upward). AA_factor_y is the IBL/alphaG additive bump.
    // Emitted unconditionally as var so sheen/other fragments can reference them
    // without needing a define; zero on the no-curvature path makes them a no-op.
    const specularAABlock =
        _hasSpecularAA || hasAnyNormal
            ? `var AA_factor_x=0.0;
var AA_factor_y=0.0;
{let nDfdx_AA=dpdx(N);
let nDfdy_AA=dpdy(N);
let slopeSquare_AA=max(dot(nDfdx_AA,nDfdx_AA),dot(nDfdy_AA,nDfdy_AA));
AA_factor_x=pow(saturate(slopeSquare_AA),0.333);
AA_factor_y=sqrt(slopeSquare_AA)*0.75;
alphaG+=AA_factor_y;}`
            : `var AA_factor_x=0.0;
var AA_factor_y=0.0;`;

    // Direct lighting block — use the compact non-looping shader for one non-shadow light,
    // and the generic multi-light loop for multiple lights or shadow receivers.
    const directLightBlock: string = _hasMultiLight
        ? _multiLightLoop
        : _hasSingleLight
          ? _singleLightBlock
          : `var directDiffuse=vec3<f32>(0.0);
var directSpecular=vec3<f32>(0.0);
/*BL*/`;

    // Tonemap: BJS TONEMAPPING_STANDARD (exponential) by default; caller-supplied
    // ACES WGSL (from pbr-aces-wgsl.ts) is used when provided.
    const useAces = _hasTonemap && _acesTonemapCall !== "";
    const acesBlock = useAces ? _acesHelpers : "";
    const tonemapBlock = _hasTonemap
        ? useAces
            ? _acesTonemapCall
            : `color*=scene.vImageInfos.x;
color=1.0-exp2(-1.590579*color);`
        : `color*=scene.vImageInfos.x;`;

    // Fog (opt-in via scene.fog). The fog WGSL — `_fogHelper` (calcFogFactor) and `_fogBlock`
    // (the blend, emitted just before the tonemap block) — is supplied by pbr-renderable, which
    // dynamically imports pbr-fog-wgsl.ts only when scene.fog is set. Both are "" for non-fog
    // scenes, so those bundles carry zero fog bytes (see pbr-fog-wgsl.ts for the parity details).
    const fogHelper = _fogHelper;
    const fogBlock = _fogBlock;

    // Alpha output
    const alphaBlock = _noColorOutput
        ? ""
        : _hasAlphaBlend
          ? `var finalAlpha=alpha*material.materialAlpha;
var luminanceOverAlpha=0.0;
/*BA*/
luminanceOverAlpha+=dot(${_hasIbl ? `finalSpecularScaled` : `directSpecular`},vec3<f32>(0.2126,0.7152,0.0722));
finalAlpha=saturate(finalAlpha+luminanceOverAlpha*luminanceOverAlpha);
return vec4<f32>(color,finalAlpha);`
          : `return vec4<f32>(color,alpha*material.materialAlpha);`;

    const doubleSidedEntry = _hasDoubleSided
        ? `@fragment fn main(input: FragmentInput, @builtin(front_facing) frontFacing: bool)${_noColorOutput ? "" : " -> @location(0) vec4<f32>"} {`
        : `@fragment fn main(input: FragmentInput)${_noColorOutput ? "" : " -> @location(0) vec4<f32>"} {`;
    const doubleSidedFlip = _hasDoubleSided ? `if (!frontFacing) { N = -N; }` : "";

    const lightDecls = _hasMultiLight ? _multiLightWGSL : _hasSingleLight ? _singleLightWGSL : "";
    const lightBindingDecl = _hasSingleLight || _hasMultiLight ? `@group(0) @binding(1) var<uniform> lights: lightsUniforms;` : "";
    const meshLightIndexHelper = _hasSingleLight || _hasMultiLight ? meshLightIndexWGSL("mesh") : "";

    const anisoBrdfBlock = _hasAnisotropy ? _anisoBrdfFunctions : "";

    const fragmentHelpers = _ext?.fragmentHelpers ?? "";
    const fragmentPrelude = _ext?.fragmentPrelude ?? "";
    const baseColorUV = _ext?.uvForBaseColor ?? "input.uv";
    const ormUV = _ext?.uvForOrm ?? "input.uv";

    const _fragmentTemplate = `/*SU*/
${_esmShadowOutput ? "struct shadowParamsUniforms { biasAndScale: vec4<f32>, depthValues: vec4<f32>, }" : ""}
/*MU*/
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
/*HF*/
/*FB*/
/*FI*/
${BRDF_FUNCTIONS}
${acesBlock}
${fogHelper}
${anisoBrdfBlock}
${lightDecls}
${lightBindingDecl}
${meshLightIndexHelper}
${fragmentHelpers}
${doubleSidedEntry}
${fragmentPrelude}/*SV*/
let baseColorSample=textureSample(baseColorTexture,baseColorSampler,${baseColorUV});
${baseColorDecode}
let orm=textureSample(ormTexture,ormSampler,${ormUV}).rgb;
${occlusionDefault}
${roughnessMetallic}
${emissiveDefault}
/*AT*/
${
    // When the fragment terminates early (no color output, or ESM shadow
    // depth output), emit only the terminating return. Appending the
    // color-path body after the return would make it unreachable and
    // trigger a "code is unreachable" shader compilation warning.
    _noColorOutput
        ? "return;"
        : _esmShadowOutput
          ? _esmShadowDepthCode
          : `${normalBlock}
${doubleSidedFlip}
${anisotropyTBBlock}
/*AC*/
let V=normalize(scene.vEyePosition.xyz-input.worldPos);
let NdotVUnclamped=dot(N,V);
let NdotV=abs(NdotVUnclamped)+0.0000001;
${f0Default}
/*MF*/
var alphaG=roughness*roughness+0.0005;
${specularAABlock}
${directLightBlock}
var color=directDiffuse+directSpecular+emissive;
/*AI*/
/*NI*/
${fogBlock}
${tonemapBlock}
color=pow(color,vec3<f32>(1.0/2.2));
color=clamp(color,vec3<f32>(0.0),vec3<f32>(1.0));
let highContrast=color*color*(3.0-2.0*color);
if(scene.vImageInfos.y<1.0){color=mix(vec3<f32>(0.5),color,scene.vImageInfos.y);}
else{color=mix(color,highContrast,scene.vImageInfos.y-1.0);}
color=max(color,vec3<f32>(0.0));
/*BC*/
${alphaBlock}`
}
}`;

    return {
        _vertexTemplate,
        _fragmentTemplate,
        _baseMeshUboFields,
        _baseMaterialUboFields,
        _baseVertexAttributes,
        _baseVaryings,
        _baseBindings,
    };
}
