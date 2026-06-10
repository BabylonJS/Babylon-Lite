/**
 * PBR Template Extensions
 *
 * Feature-specific strings for UV transforms, UV2, vertex colors, etc.
 * Lazy-loaded only when these features are detected. This keeps the base
 * pbr-template.ts clean for simple scenes like scene1.
 */

import type { UboField, VertexAttribute, Varying, BindingDecl } from "../../shader/fragment-types.js";

const STAGE_FRAGMENT = 0x2;

/**
 * Optional extensions config for PbrTemplateConfig.
 * Each field provides WGSL strings and UBO/attribute/varying lists
 * that are only needed for advanced features.
 */
export interface PbrTemplateExt {
    /** Extra vertex attributes (e.g., uv2, color). */
    readonly extraVertexAttributes: readonly VertexAttribute[];
    /** Extra varyings (e.g., uv2, vColor). */
    readonly extraVaryings: readonly Varying[];
    /** Extra material UBO fields (e.g., per-texture UV transforms). */
    readonly extraMaterialUboFields: readonly UboField[];
    /** Extra bindings (e.g., occlusion texture on UV2). */
    readonly extraBindings: readonly BindingDecl[];
    /** Vertex body extra code (e.g., `out.uv2 = uv2;`). */
    readonly vertexBodyExtra: string;
    /** Fragment helper functions (e.g., txfUV). */
    readonly fragmentHelpers: string;
    /** Fragment prelude (per-texture UV local vars). */
    readonly fragmentPrelude: string;
    /** UV expression for baseColorTexture (e.g., "baseColorUV"). */
    readonly uvForBaseColor: string;
    /** UV expression for normalTexture (e.g., "normalUV"). */
    readonly uvForNormal: string;
    /** UV expression for ormTexture (e.g., "ormUV"). */
    readonly uvForOrm: string;
    /** UV expression for emissiveTexture (e.g., "emissiveUV"). */
    readonly uvForEmissive: string;
    /** UV expression for specGlossTexture (e.g., "specGlossUV"). */
    readonly uvForSpecGloss: string;
    /** Base color modifier WGSL (e.g., vertex color multiply). */
    readonly baseColorMod: string;
    /** Normal scale modifier WGSL (empty or inline scaling). */
    readonly normalScaleMod: string;
    /** Occlusion sampling override (null = use default). */
    readonly occlusionOverride: string | null;
}

/**
 * Create a PbrTemplateExt from the given feature flags.
 * Each flag corresponds to a detected feature in the scene.
 */
export function createPbrTemplateExt(flags: {
    /** @internal */
    _hasUvTransform: boolean;
    /** @internal */
    _hasVertexColor: boolean;
    /** @internal */
    _hasUv2: boolean;
    /** @internal */
    _hasOcclusionUv2: boolean;
    /** @internal */
    _hasAnyNormal: boolean;
    /** @internal */
    _hasEmissiveTexture: boolean;
    /** @internal */
    _hasSpecGloss: boolean;
}): PbrTemplateExt {
    const { _hasUvTransform, _hasVertexColor, _hasUv2, _hasOcclusionUv2, _hasAnyNormal, _hasEmissiveTexture, _hasSpecGloss } = flags;

    // ── UV transform helpers ────────────────────────────────────
    const uvTransformUboFields = (name: string): UboField[] => [
        { _name: `${name}UVm`, _type: "vec4<f32>" },
        { _name: `${name}UVt`, _type: "vec4<f32>" },
    ];
    const uvVarName = (name: string) => (_hasUvTransform ? `${name}UV` : "input.uv");
    const uvTransformDecl = (name: string) => (_hasUvTransform ? `let ${name}UV = txfUV(input.uv, material.${name}UVm, material.${name}UVt.xy);\n` : "");
    const UV_TRANSFORM_HELPER_WGSL = _hasUvTransform
        ? `fn txfUV(uv: vec2<f32>, m: vec4<f32>, t: vec2<f32>) -> vec2<f32> {
return vec2<f32>(dot(m.xy, uv), dot(m.zw, uv)) + t;
}
`
        : "";

    // ── Extra vertex attributes ────────────────────────────────
    const extraVertexAttributes: VertexAttribute[] = [];
    if (_hasUv2) {
        extraVertexAttributes.push({ _name: "uv2", _type: "vec2<f32>", _gpuFormat: "float32x2", _arrayStride: 8 });
    }
    if (_hasVertexColor) {
        extraVertexAttributes.push({ _name: "color", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 });
    }

    // ── Extra varyings ──────────────────────────────────────────
    const extraVaryings: Varying[] = [];
    if (_hasUv2) {
        extraVaryings.push({ _name: "uv2", _type: "vec2<f32>" });
    }
    if (_hasVertexColor) {
        extraVaryings.push({ _name: "vColor", _type: "vec3<f32>" });
    }

    // ── Extra material UBO fields ────────────────────────────────
    const extraMaterialUboFields: UboField[] = [];
    if (_hasUvTransform) {
        extraMaterialUboFields.push(...uvTransformUboFields("baseColor"));
        if (_hasAnyNormal) {
            extraMaterialUboFields.push(...uvTransformUboFields("normal"));
        }
        extraMaterialUboFields.push(...uvTransformUboFields("orm"));
        if (_hasEmissiveTexture) {
            extraMaterialUboFields.push(...uvTransformUboFields("emissive"));
        }
        if (_hasSpecGloss) {
            extraMaterialUboFields.push(...uvTransformUboFields("specGloss"));
        }
    }

    // ── Extra bindings ──────────────────────────────────────────
    const extraBindings: BindingDecl[] = [];
    if (_hasOcclusionUv2) {
        extraBindings.push(
            { _name: "occlusionTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "occlusionSampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
    }

    // ── Vertex body extra ───────────────────────────────────────
    let vertexBodyExtra = "";
    if (_hasUv2) {
        vertexBodyExtra += "out.uv2 = uv2;\n";
    }
    if (_hasVertexColor) {
        vertexBodyExtra += "out.vColor = color;\n";
    }

    // ── Fragment helpers ────────────────────────────────────────
    const fragmentHelpers = UV_TRANSFORM_HELPER_WGSL;

    // ── Fragment prelude ────────────────────────────────────────
    const fragmentPrelude = _hasUvTransform
        ? uvTransformDecl("baseColor") +
          (_hasAnyNormal ? uvTransformDecl("normal") : "") +
          uvTransformDecl("orm") +
          (_hasEmissiveTexture ? uvTransformDecl("emissive") : "") +
          (_hasSpecGloss ? uvTransformDecl("specGloss") : "")
        : "";

    // ── UV expressions ──────────────────────────────────────────
    const uvForBaseColor = uvVarName("baseColor");
    const uvForNormal = uvVarName("normal");
    const uvForOrm = uvVarName("orm");
    const uvForEmissive = uvVarName("emissive");
    const uvForSpecGloss = uvVarName("specGloss");

    // ── Base color modifier ─────────────────────────────────────
    // NOTE: backtick (not double-quote) so the bundle's WGSL identifier mangler
    // rewrites `baseColor` here to match the mangled `var bc=` declaration in
    // pbr-template.ts. A plain string is skipped by the mangler and produces
    // `unresolved value 'baseColor'` in the bundled shader. See thin-instance-fragment.ts.
    const baseColorMod = _hasVertexColor ? `\nbaseColor *= input.vColor;` : "";

    // ── Normal scale modifier ───────────────────────────────────
    // When ext is active, emit the scaledNormal line (replaces default normalMapRaw).
    // Scenes without ext get the master-style direct normalize(normalMapRaw).
    const normalScaleMod = "let scaledNormal = vec3<f32>(normalMapRaw.xy * material.normalScale, normalMapRaw.z);\n";

    // ── Occlusion override ──────────────────────────────────────
    // When hasReflectanceExt=false AND _hasOcclusionUv2=true, override occlusion sampling.
    // When hasReflectanceExt=true, the reflectance fragment handles occlusion.
    const occlusionOverride = _hasOcclusionUv2 ? "let occlusion = textureSample(occlusionTexture, occlusionSampler_, input.uv2).r;" : null;

    return {
        extraVertexAttributes,
        extraVaryings,
        extraMaterialUboFields,
        extraBindings,
        vertexBodyExtra,
        fragmentHelpers,
        fragmentPrelude,
        uvForBaseColor,
        uvForNormal,
        uvForOrm,
        uvForEmissive,
        uvForSpecGloss,
        baseColorMod,
        normalScaleMod,
        occlusionOverride,
    };
}
