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
    /** @internal Per-channel UV1 selection bitmask (see pbr-material.ts). Decoded locally. */
    _uv2Mask: number;
    /** @internal features2 bitfield — read locally for orm-unpack (occlusion split) without
     *  adding a flag branch to the shared composer. */
    _features2?: number;
    /** @internal */
    _hasAnyNormal: boolean;
    /** @internal */
    _hasEmissiveTexture: boolean;
    /** @internal */
    _hasSpecGloss: boolean;
}): PbrTemplateExt {
    const { _hasUvTransform, _hasVertexColor, _hasUv2, _hasAnyNormal, _hasEmissiveTexture, _hasSpecGloss } = flags;
    // Per-channel UV1 (TEXCOORD_1) selection. Bit literals mirror the gltf slow-path encode:
    // baseColor=1, orm=2, normal=4, emissive=8, specGloss=16, occlusion=32. Only honoured when the
    // uv2 vertex attribute is actually present (_hasUv2); otherwise every channel falls back to
    // input.uv so the shader never references a missing uv2 varying.
    const uv2Mask = _hasUv2 ? flags._uv2Mask : 0;
    const baseUvFor = (bit: number): string => (uv2Mask & bit ? "input.uv2" : "input.uv");
    const _hasOcclusionUv2 = !!(uv2Mask & 32);
    // orm-unpack: occlusion sampled from the ORM texture with its own UV transform.
    // PBR2_OCCL_UV_SPLIT is defined locally (not in shared pbr-flag-bits.ts) per GUIDANCE
    // §4c′ — it is set in uv-transform-fragment.detect and read only here, both lazy.
    const PBR2_OCCL_UV_SPLIT = 1 << 28;
    const _hasOcclusionSplit = ((flags._features2 ?? 0) & PBR2_OCCL_UV_SPLIT) !== 0;

    // ── UV transform helpers ────────────────────────────────────
    const uvTransformUboFields = (name: string): UboField[] => [
        { _name: `${name}UVm`, _type: "vec4<f32>" },
        { _name: `${name}UVt`, _type: "vec4<f32>" },
    ];
    // Each channel's sampled UV: with a UV transform it becomes a `${name}UV` local (built from
    // the channel's base UV set); without a transform it is the base UV set (input.uv / input.uv2).
    const uvVarName = (name: string, bit: number) => (_hasUvTransform ? `${name}UV` : baseUvFor(bit));
    const uvTransformDecl = (name: string, bit: number) => (_hasUvTransform ? `let ${name}UV = txfUV(${baseUvFor(bit)}, material.${name}UVm, material.${name}UVt.xy);\n` : "");
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
        extraVertexAttributes.push({ _name: "color", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 16 });
    }

    // ── Extra varyings ──────────────────────────────────────────
    const extraVaryings: Varying[] = [];
    if (_hasUv2) {
        extraVaryings.push({ _name: "uv2", _type: "vec2<f32>" });
    }
    if (_hasVertexColor) {
        extraVaryings.push({ _name: "vColor", _type: "vec4<f32>" });
    }

    // ── Extra material UBO fields ────────────────────────────────
    const extraMaterialUboFields: UboField[] = [];
    if (_hasUvTransform) {
        extraMaterialUboFields.push(...uvTransformUboFields("baseColor"));
        if (_hasAnyNormal) {
            extraMaterialUboFields.push(...uvTransformUboFields("normal"));
        }
        extraMaterialUboFields.push(...uvTransformUboFields("orm"));
        if (_hasOcclusionSplit) {
            extraMaterialUboFields.push(...uvTransformUboFields("occl"));
        }
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
    // Bit literal per channel (1/2/4/8/16) selects its base UV set inside the transform.
    const fragmentPrelude = _hasUvTransform
        ? uvTransformDecl("baseColor", 1) +
          (_hasAnyNormal ? uvTransformDecl("normal", 4) : "") +
          uvTransformDecl("orm", 2) +
          (_hasOcclusionSplit ? uvTransformDecl("occl", 0) : "") +
          (_hasEmissiveTexture ? uvTransformDecl("emissive", 8) : "") +
          (_hasSpecGloss ? uvTransformDecl("specGloss", 16) : "")
        : "";

    // ── UV expressions ──────────────────────────────────────────
    const uvForBaseColor = uvVarName("baseColor", 1);
    const uvForNormal = uvVarName("normal", 4);
    const uvForOrm = uvVarName("orm", 2);
    const uvForEmissive = uvVarName("emissive", 8);
    const uvForSpecGloss = uvVarName("specGloss", 16);

    // ── Base color modifier ─────────────────────────────────────
    // NOTE: backtick (not double-quote) so the bundle's WGSL identifier mangler
    // rewrites `baseColor` here to match the mangled `var bc=` declaration in
    // pbr-template.ts. A plain string is skipped by the mangler and produces
    // `unresolved value 'baseColor'` in the bundled shader. See thin-instance-fragment.ts.
    const baseColorMod = _hasVertexColor ? `\nbaseColor *= input.vColor.rgb;\nalpha *= input.vColor.a;` : "";

    // ── Normal scale modifier ───────────────────────────────────
    // When ext is active, emit the scaledNormal line (replaces default normalMapRaw).
    // Scenes without ext get the master-style direct normalize(normalMapRaw).
    const normalScaleMod = "let scaledNormal = vec3<f32>(normalMapRaw.xy * material.normalScale, normalMapRaw.z);\n";

    // ── Occlusion override ──────────────────────────────────────
    // When hasReflectanceExt=false AND _hasOcclusionUv2=true, override occlusion sampling.
    // When hasReflectanceExt=true, the reflectance fragment handles occlusion.
    // orm-unpack: when occlusion has its own UV transform (split), sample the ORM texture
    // a second time at occlUV so occlusion's animated transform stays independent of MR's.
    const occlusionOverride = _hasOcclusionUv2
        ? "let occlusion = textureSample(occlusionTexture, occlusionSampler_, input.uv2).r;"
        : _hasOcclusionSplit
          ? "let occlusion = textureSample(ormTexture, ormSampler, occlUV).r;"
          : null;

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
