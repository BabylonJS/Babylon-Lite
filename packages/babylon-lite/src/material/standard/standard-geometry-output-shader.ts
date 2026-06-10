/** Standard geometry-output shader composer.
 *
 *  Builds the WGSL for a {@link createStandardGeometryMaterialView}-wrapped
 *  Standard material that targets the geometry-renderer MRT pass.
 *
 *  Design — *zero bundle impact* on scenes that never load the
 *  geometry-renderer task:
 *
 *  1. Reuse `composeStandardShader` verbatim. The standard composer already
 *     emits the bump perturbation (`normalW = perturbNormal(...)` via the AC
 *     slot), opacity-texture alpha modulation, alpha-cutout discard,
 *     instancing, thin-instance colour, etc. None of that needs to be
 *     re-implemented.
 *  2. Post-process the resulting fragment WGSL: change the entry signature
 *     to return a `FragmentOutput` MRT struct, prepend the struct
 *     declaration, and replace `return color;` with code that writes each
 *     requested geometry attachment from the already-in-scope intermediate
 *     variables (`normalW`, `baseColor`, `specularColor`, `alpha`,
 *     `input.vp`, …).
 *  3. Add a small `geometryParams` ShaderFragment that contributes a `gp`
 *     UBO binding (camera near/far + previous viewProjection) only when the
 *     requested attachment list needs it (NORMALIZED_VIEW_DEPTH /
 *     LINEAR_VELOCITY).
 *
 *  The lighting / fog block still runs and produces a dead `color` value
 *  the WGSL compiler folds away. Acceptable cost for the architectural
 *  reuse — matches the user's directive: "inject some shader code at the
 *  end of the fragment to output the data for the geometry textures".
 */

import { GeometryTextureType } from "../../frame-graph/geometry-types.js";
import type { ComposedShader, ShaderFragment, Varying } from "../../shader/fragment-types.js";
import { composeStandardShader } from "./standard-pipeline.js";
import { HAS_SPECULAR_TEXTURE, MATERIAL_ALPHA_BLEND, SPECULAR_USES_UV2 } from "./standard-flags.js";

const STAGE_FRAGMENT = 0x2;
const STAGE_VERTEX = 0x1;

/** Tags whether the geometry pass needs the per-task `gp` UBO. */
function needsGpUbo(attachments: readonly GeometryTextureType[]): boolean {
    for (const t of attachments) {
        if (t === GeometryTextureType.NORMALIZED_VIEW_DEPTH || t === GeometryTextureType.LINEAR_VELOCITY) {
            return true;
        }
    }
    return false;
}

/** Tags whether the geometry pass needs the previous-clip varying (velocity). */
function needsVelocity(attachments: readonly GeometryTextureType[]): boolean {
    return attachments.includes(GeometryTextureType.LINEAR_VELOCITY);
}

/** Tags whether the geometry pass needs the local-position varying. */
function needsLocalPos(attachments: readonly GeometryTextureType[]): boolean {
    return attachments.includes(GeometryTextureType.LOCAL_POSITION);
}

/** Per-attachment WGSL output expression. `alpha` is the in-scope standard
 *  fragment alpha (mat.dc.a × opacityTex × …). `wg` is `writeGeomInfo` — a
 *  binary 0/1 gate matching BJS `default.fragment.fx` PREPASS
 *  (`color.a > 0.4 ? 1.0 : 0.0`). Combined with the per-attachment
 *  ALPHA_COMBINE blend state, low-opacity samples preserve the destination
 *  (background) while high-opacity samples overwrite it.
 *
 *  All variable references resolve to symbols already declared by
 *  `standard-template.ts` / the standard fragment registry:
 *    - `normalW`  — normalized world normal (post-bump if HAS_BUMP_TEXTURE).
 *    - `input.vp` — world position.
 *    - `baseColor`/`mat.tl` — diffuse texture sample (rgb) × diffuseLevel.
 *    - `specularColor`/`mat.sc` — specular colour, replaced by the std-specular
 *       fragment's `textureSample(sT, sS, uv).rgb` when HAS_SPECULAR_TEXTURE.
 *    - `scene.view` — view matrix from the canonical SceneUniforms.
 *    - `gp.cameraNearFar` / `gp.previousViewProjection` — from the geometry
 *       params UBO (added only when `needsGpUbo`).
 *    - `input.vCurrentClip` / `input.vPreviousClip` — added by the velocity
 *       fragment when LINEAR_VELOCITY is requested. */
function attachmentExpr(type: GeometryTextureType, wg: string, hasSpecular: boolean, specularUv: string): string {
    switch (type) {
        case GeometryTextureType.IRRADIANCE:
            // BJS Standard material can't split irradiance — outputs (0, 0, 0).
            return `vec4<f32>(0.0, 0.0, 0.0, ${wg})`;
        case GeometryTextureType.WORLD_POSITION:
            return `vec4<f32>(input.vp, ${wg})`;
        case GeometryTextureType.LOCAL_POSITION:
            // `vLocalPos` is contributed by the geometry-params fragment (added
            // only when LOCAL_POSITION is requested).
            return `vec4<f32>(input.vLocalPos, ${wg})`;
        case GeometryTextureType.REFLECTIVITY:
            // BJS: vec4(toLinearSpace(specularMapColor)) * writeGeometryInfo
            // (.a is glossiness when a specular texture is present). The std
            // pipeline drops the texture .a inside `specularColor`, so the
            // geometry path re-samples the specular texture here to recover it.
            return hasSpecular
                ? `(vec4<f32>(pow(textureSample(sT, sS, ${specularUv}).rgb, vec3<f32>(2.2)), textureSample(sT, sS, ${specularUv}).a) * ${wg})`
                : `vec4<f32>(pow(mat.sc.rgb, vec3<f32>(2.2)), 1.0) * ${wg}`;
        case GeometryTextureType.VIEW_DEPTH:
            return `vec4<f32>((scene.view * vec4<f32>(input.vp, 1.0)).z, 0.0, 0.0, ${wg})`;
        case GeometryTextureType.NORMALIZED_VIEW_DEPTH:
            return `vec4<f32>(((scene.view * vec4<f32>(input.vp, 1.0)).z - gp.cameraNearFar.x) / (gp.cameraNearFar.y - gp.cameraNearFar.x), 0.0, 0.0, ${wg})`;
        case GeometryTextureType.SCREENSPACE_DEPTH:
            // `clipPos` is the @builtin(position) fragment input declared by
            // shader-composer (fragment input struct).
            return `vec4<f32>(input.clipPos.z, 0.0, 0.0, ${wg})`;
        case GeometryTextureType.VIEW_NORMAL:
            return `vec4<f32>(normalize((scene.view * vec4<f32>(normalW, 0.0)).xyz), ${wg})`;
        case GeometryTextureType.WORLD_NORMAL:
            return `vec4<f32>(normalW * 0.5 + vec3<f32>(0.5), ${wg})`;
        case GeometryTextureType.ALBEDO:
            // BJS: vec4(baseColor.rgb, writeGeometryInfo). The standard
            // fragment already multiplied the diffuse sample by `mat.tl`
            // (texture level) when building `baseColor`.
            return `vec4<f32>(baseColor, ${wg})`;
        case GeometryTextureType.LINEAR_VELOCITY: {
            const cur = `(input.vCurrentClip.xy / input.vCurrentClip.w)`;
            const prev = `(input.vPreviousClip.xy / input.vPreviousClip.w)`;
            return `vec4<f32>(0.5 * (${prev} - ${cur}), 0.0, ${wg})`;
        }
    }
}

/** ShaderFragment contributing the `gp` UBO + (optionally) velocity / local-position varyings.
 *
 *  Only included in the fragment list when an attachment actually needs it,
 *  so opaque-only / WORLD_POSITION-only configs add zero bytes vs the bare
 *  standard shader. */
function createGeometryParamsFragment(needsParamsUbo: boolean, needsVelocityVaryings: boolean, needsLocalPosVarying: boolean): ShaderFragment {
    const bindings = needsParamsUbo ? [{ _name: "gp", _type: { _kind: "uniform-buffer" as const }, _visibility: STAGE_FRAGMENT | STAGE_VERTEX }] : [];
    const helpers = needsParamsUbo ? `struct gpUniforms { previousViewProjection: mat4x4<f32>, cameraNearFar: vec4<f32>, };` : "";
    const varyings: Varying[] = [];
    if (needsVelocityVaryings) {
        varyings.push({ _name: "vCurrentClip", _type: "vec4<f32>" }, { _name: "vPreviousClip", _type: "vec4<f32>" });
    }
    if (needsLocalPosVarying) {
        varyings.push({ _name: "vLocalPos", _type: "vec3<f32>" });
    }
    // Velocity needs the previous-world matrix on the mesh UBO too — but that
    // is out of scope of this fragment (the standard mesh UBO does not have
    // it). LINEAR_VELOCITY is therefore deferred behind a TODO; HillValley /
    // scene 145 does not request it.
    const vbParts: string[] = [];
    if (needsVelocityVaryings) {
        vbParts.push(`out.vCurrentClip = scene.viewProjection * vec4<f32>(out.vp, 1.0);`);
        vbParts.push(`out.vPreviousClip = gp.previousViewProjection * vec4<f32>(out.vp, 1.0);`);
    }
    if (needsLocalPosVarying) {
        vbParts.push(`out.vLocalPos = position;`);
    }
    const slots: ShaderFragment["_vertexSlots"] = vbParts.length > 0 ? { VB: vbParts.join("\n") } : {};
    return {
        _id: "~geometry-params",
        _bindings: bindings,
        _helperFunctions: helpers,
        // gp UBO is also visible to the vertex stage when present, so the
        // struct declaration must be available there too.
        _vertexHelperFunctions: helpers,
        _varyings: varyings,
        _vertexSlots: slots,
    };
}

/** Compose a Standard geometry-output shader.
 *
 *  Reuses {@link composeStandardShader} verbatim — every standard-material
 *  feature (bump perturbation, alpha discard, instancing, …) flows through
 *  the same code path. The fragment WGSL is then string-patched to switch
 *  the entry-point return type to a multi-attachment `FragmentOutput`.
 *
 *  @param emitColor - When true, an extra `@location(N) color: vec4<f32>`
 *      attachment is appended to `FragmentOutput` (N = `attachments.length`)
 *      and populated with the standard lit `color` value. Used when the
 *      task's `targetTexture` is set — that target receives the real (lit)
 *      material color alongside the geometry-data attachments. */
export function composeStandardGeometryShader(
    features: number,
    meshFeatures: number,
    extFragments: ShaderFragment[],
    attachments: readonly GeometryTextureType[],
    esmShadowDepthCode = "",
    emitColor = false
): ComposedShader {
    const wantsGp = needsGpUbo(attachments);
    const wantsVelocity = needsVelocity(attachments);
    const wantsLocalPos = needsLocalPos(attachments);
    const fragments = wantsGp || wantsVelocity || wantsLocalPos ? [...extFragments, createGeometryParamsFragment(wantsGp, wantsVelocity, wantsLocalPos)] : extFragments;

    // Strip MATERIAL_ALPHA_BLEND so the standard fragment does NOT emit
    // ALPHA_COMBINE blend in its color output — we drive blending per
    // attachment in the geometry pipeline state instead.
    const stdFeatures = features & ~MATERIAL_ALPHA_BLEND;
    const base = composeStandardShader(stdFeatures, meshFeatures, fragments, esmShadowDepthCode);

    const hasSpecular = (features & HAS_SPECULAR_TEXTURE) !== 0;
    const specularUv = (features & SPECULAR_USES_UV2) !== 0 ? "input.vv" : "input.vu";

    // ── Post-process the fragment WGSL ────────────────────────────────────

    // 1) Replace the return type. `composeStandardShader` always emits
    //    `-> @location(0) vec4<f32>` for the color path (no _noColorOutput
    //    in our flow).
    const fragmentSignatureFrom = "-> @location(0) vec4<f32>";
    const fragmentSignatureTo = "-> FragmentOutput";
    if (!base._fragmentWGSL.includes(fragmentSignatureFrom)) {
        throw new Error("composeStandardGeometryShader: standard fragment signature mismatch — bypass active?");
    }
    let frag = base._fragmentWGSL.replace(fragmentSignatureFrom, fragmentSignatureTo);

    // 2) Inject FragmentOutput struct right before `@fragment fn main`. When
    //    `emitColor` is set, append an extra slot at @location(N) for the
    //    standard `color` output (the "real" lit material color), with
    //    N = attachments.length.
    const colorSlot = attachments.length;
    const extraColorLine = emitColor ? `\n@location(${colorSlot}) color: vec4<f32>,` : "";
    const outputStruct = `struct FragmentOutput {
${attachments.map((_, i) => `@location(${i}) f${i}: vec4<f32>,`).join("\n")}${extraColorLine}
};
`;
    frag = frag.replace("@fragment fn main", `${outputStruct}@fragment fn main`);

    // 3) Replace `return color;` with MRT writes + `return out;`. We use
    //    `alpha` (the standard fragment's running alpha) for the
    //    writeGeometryInfo gate so opacity-texture and material-alpha
    //    materials get a correct binary mask under the per-attachment
    //    ALPHA_COMBINE blend pipeline state.
    const wg = `select(0.0, 1.0, alpha > 0.4)`;
    const writes = attachments.map((type, i) => `out.f${i} = ${attachmentExpr(type, wg, hasSpecular, specularUv)};`).join("\n");
    const extraColorWrite = emitColor ? `\nout.color = color;` : "";
    const replacement = `var out: FragmentOutput;
${writes}${extraColorWrite}
return out;`;
    if (!frag.includes("return color;")) {
        throw new Error("composeStandardGeometryShader: 'return color;' not found in composed fragment — template changed?");
    }
    frag = frag.replace("return color;", replacement);

    return { ...base, _fragmentWGSL: frag };
}
