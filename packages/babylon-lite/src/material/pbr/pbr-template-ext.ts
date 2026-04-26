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
    hasUvTransform: boolean;
    hasVertexColor: boolean;
    hasUv2: boolean;
    hasOcclusionUv2: boolean;
    hasAnyNormal: boolean;
    hasEmissiveTexture: boolean;
    hasSpecGloss: boolean;
}): PbrTemplateExt {
    const { hasUvTransform, hasVertexColor, hasUv2, hasOcclusionUv2, hasAnyNormal, hasEmissiveTexture, hasSpecGloss } = flags;

    // ── UV transform helpers ────────────────────────────────────
    const uvTransformUboFields = (name: string): UboField[] => [
        { name: `${name}UVm`, type: "vec4<f32>" },
        { name: `${name}UVt`, type: "vec4<f32>" },
    ];
    const uvVarName = (name: string) => (hasUvTransform ? `${name}UV` : "input.uv");
    const uvTransformDecl = (name: string) => (hasUvTransform ? `let ${name}UV = txfUV(input.uv, material.${name}UVm, material.${name}UVt.xy);\n` : "");
    const UV_TRANSFORM_HELPER_WGSL = hasUvTransform
        ? `fn txfUV(uv: vec2<f32>, m: vec4<f32>, t: vec2<f32>) -> vec2<f32> {
return vec2<f32>(dot(m.xy, uv), dot(m.zw, uv)) + t;
}
`
        : "";

    // ── Extra vertex attributes ────────────────────────────────
    const extraVertexAttributes: VertexAttribute[] = [];
    if (hasUv2) {
        extraVertexAttributes.push({ name: "uv2", type: "vec2<f32>", gpuFormat: "float32x2", arrayStride: 8 });
    }
    if (hasVertexColor) {
        extraVertexAttributes.push({ name: "color", type: "vec3<f32>", gpuFormat: "float32x3", arrayStride: 12 });
    }

    // ── Extra varyings ──────────────────────────────────────────
    const extraVaryings: Varying[] = [];
    if (hasUv2) {
        extraVaryings.push({ name: "uv2", type: "vec2<f32>" });
    }
    if (hasVertexColor) {
        extraVaryings.push({ name: "vColor", type: "vec3<f32>" });
    }

    // ── Extra material UBO fields ────────────────────────────────
    const extraMaterialUboFields: UboField[] = [];
    if (hasUvTransform) {
        extraMaterialUboFields.push(...uvTransformUboFields("baseColor"));
        if (hasAnyNormal) {
            extraMaterialUboFields.push(...uvTransformUboFields("normal"));
        }
        extraMaterialUboFields.push(...uvTransformUboFields("orm"));
        if (hasEmissiveTexture) {
            extraMaterialUboFields.push(...uvTransformUboFields("emissive"));
        }
        if (hasSpecGloss) {
            extraMaterialUboFields.push(...uvTransformUboFields("specGloss"));
        }
    }

    // ── Extra bindings ──────────────────────────────────────────
    const extraBindings: BindingDecl[] = [];
    if (hasOcclusionUv2) {
        extraBindings.push(
            { name: "occlusionTexture", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "occlusionSampler_", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT }
        );
    }

    // ── Vertex body extra ───────────────────────────────────────
    let vertexBodyExtra = "";
    if (hasUv2) {
        vertexBodyExtra += "out.uv2 = uv2;\n";
    }
    if (hasVertexColor) {
        vertexBodyExtra += "out.vColor = color;\n";
    }

    // ── Fragment helpers ────────────────────────────────────────
    const fragmentHelpers = UV_TRANSFORM_HELPER_WGSL;

    // ── Fragment prelude ────────────────────────────────────────
    const fragmentPrelude = hasUvTransform
        ? uvTransformDecl("baseColor") +
          (hasAnyNormal ? uvTransformDecl("normal") : "") +
          uvTransformDecl("orm") +
          (hasEmissiveTexture ? uvTransformDecl("emissive") : "") +
          (hasSpecGloss ? uvTransformDecl("specGloss") : "")
        : "";

    // ── UV expressions ──────────────────────────────────────────
    const uvForBaseColor = uvVarName("baseColor");
    const uvForNormal = uvVarName("normal");
    const uvForOrm = uvVarName("orm");
    const uvForEmissive = uvVarName("emissive");
    const uvForSpecGloss = uvVarName("specGloss");

    // ── Base color modifier ─────────────────────────────────────
    const baseColorMod = hasVertexColor ? "\nbaseColor *= input.vColor;" : "";

    // ── Normal scale modifier ───────────────────────────────────
    // When ext is active, emit the scaledNormal line (replaces default normalMapRaw).
    // Scenes without ext get the master-style direct normalize(normalMapRaw).
    const normalScaleMod = "let scaledNormal = vec3<f32>(normalMapRaw.xy * material.normalScale, normalMapRaw.z);\n";

    // ── Occlusion override ──────────────────────────────────────
    // When hasReflectanceExt=false AND hasOcclusionUv2=true, override occlusion sampling.
    // When hasReflectanceExt=true, the reflectance fragment handles occlusion.
    const occlusionOverride = hasOcclusionUv2 ? "let occlusion = textureSample(occlusionTexture, occlusionSampler_, input.uv2).r;" : null;

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
