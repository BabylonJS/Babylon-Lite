/** PBR geometry-output shader composer.
 *
 *  Builds the WGSL for a {@link createPbrGeometryMaterialView}-wrapped PBR
 *  material that targets the geometry-renderer MRT pass.
 *
 *  Design — *zero bundle impact* on PBR scenes that never load the
 *  geometry-renderer task:
 *
 *  1. Reuse the per-scene {@link composePbr} captured on the scene context.
 *     The composer already wires every PBR feature (IBL, shadows, lights,
 *     clearcoat, sheen, iridescence, anisotropy, subsurface, alpha-test,
 *     emissive, tonemap, …); none of it needs re-implementing for the
 *     real-colour attachment.
 *  2. Register a PBR extension that, only when `PBR2_GEOMETRY_OUTPUT` is on,
 *     contributes a small `geometry-params` ShaderFragment carrying the
 *     `gp` UBO + per-attachment varyings (vCurrentClip / vPreviousClip /
 *     vLocalPos). Off otherwise — no impact on regular PBR composes.
 *  3. Post-process the composed fragment WGSL: change the entry signature
 *     to return a `FragmentOutput` MRT struct, inject the struct
 *     declaration, and replace the alpha-block `return …` with code that
 *     writes each requested geometry attachment from the in-scope PBR
 *     intermediates (`N`, `surfaceAlbedo`, `colorF0`, `roughness`,
 *     `microSurface`, `finalIrradiance`, `input.worldPos`, …).
 *
 *  The lighting / tonemap / gamma pipeline still runs in full, producing
 *  the lit `color` written to the optional real-colour attachment. */

import type { ComposedShader, ShaderFragment, Varying } from "../../shader/fragment-types.js";
import { GeometryTextureType } from "../../frame-graph/geometry-types.js";
import { PBR_HAS_ALPHA_BLEND, PBR_HAS_ENV, PBR2_GEOMETRY_OUTPUT, _registerPbrExt, type _PbrBindCtx, type _PbrFragCtx, type PbrExt } from "./pbr-flags.js";
import type { createPbrComposer, PbrLightMode } from "./pbr-compose.js";
import type { MeshVbLayout } from "../../mesh/mesh.js";

const STAGE_FRAGMENT = 0x2;
const STAGE_VERTEX = 0x1;

// ─── PBR extension contributing the geometry-params fragment ──────────

function needsGpUbo(attachments: readonly GeometryTextureType[]): boolean {
    for (const t of attachments) {
        if (t === GeometryTextureType.NORMALIZED_VIEW_DEPTH || t === GeometryTextureType.LINEAR_VELOCITY) {
            return true;
        }
    }
    return false;
}

function needsVelocity(attachments: readonly GeometryTextureType[]): boolean {
    return attachments.includes(GeometryTextureType.LINEAR_VELOCITY);
}

function needsLocalPos(attachments: readonly GeometryTextureType[]): boolean {
    return attachments.includes(GeometryTextureType.LOCAL_POSITION);
}

/** ShaderFragment contributing the `gp` UBO + (optionally) velocity / local-pos varyings.
 *  PBR-specific: world-position varying is `out.worldPos`. */
function createPbrGeometryParamsFragment(needsParamsUbo: boolean, needsVelocityVaryings: boolean, needsLocalPosVarying: boolean): ShaderFragment {
    const bindings = needsParamsUbo ? [{ _name: "gp", _type: { _kind: "uniform-buffer" as const }, _visibility: STAGE_FRAGMENT | STAGE_VERTEX }] : [];
    const helpers = needsParamsUbo ? `struct gpUniforms { previousViewProjection: mat4x4<f32>, cameraNearFar: vec4<f32>, };` : "";
    const varyings: Varying[] = [];
    if (needsVelocityVaryings) {
        varyings.push({ _name: "vCurrentClip", _type: "vec4<f32>" }, { _name: "vPreviousClip", _type: "vec4<f32>" });
    }
    if (needsLocalPosVarying) {
        varyings.push({ _name: "vLocalPos", _type: "vec3<f32>" });
    }
    const vbParts: string[] = [];
    if (needsVelocityVaryings) {
        vbParts.push(`out.vCurrentClip = scene.viewProjection * vec4<f32>(out.worldPos, 1.0);`);
        vbParts.push(`out.vPreviousClip = gp.previousViewProjection * vec4<f32>(out.worldPos, 1.0);`);
    }
    if (needsLocalPosVarying) {
        vbParts.push(`out.vLocalPos = position;`);
    }
    const slots: ShaderFragment["_vertexSlots"] = vbParts.length > 0 ? { VB: vbParts.join("\n") } : {};
    return {
        _id: "pbr-geometry-params",
        _bindings: bindings,
        _helperFunctions: helpers,
        _vertexHelperFunctions: helpers,
        _varyings: varyings,
        _vertexSlots: slots,
    };
}

/** PBR extension that wires the geometry-params fragment + gp UBO bind entry.
 *  Off-path for any scene that doesn't request `PBR2_GEOMETRY_OUTPUT`. */
let _pbrGeomExtRegistered = false;

/** @internal Registers (idempotent) the PBR extension that wires up the
 *  geometry-output `gp` UBO and varyings. Called by the geometry view at
 *  first use so non-geometry PBR scenes pay zero bytes. */
export function _ensurePbrGeometryExt(getAttachments: () => readonly GeometryTextureType[] | undefined): void {
    if (_pbrGeomExtRegistered) {
        return;
    }
    _pbrGeomExtRegistered = true;
    const ext: PbrExt = {
        id: "pbr-geometry-params",
        // Fragment-phase so bind entry is appended after all other PBR exts.
        phase: "fragment",
        frag(ctx: _PbrFragCtx): ShaderFragment | null {
            if ((ctx._features2 & PBR2_GEOMETRY_OUTPUT) === 0) {
                return null;
            }
            const att = getAttachments() ?? [];
            const wantsGp = needsGpUbo(att);
            const wantsVelocity = needsVelocity(att);
            const wantsLocalPos = needsLocalPos(att);
            if (!wantsGp && !wantsVelocity && !wantsLocalPos) {
                return null;
            }
            return createPbrGeometryParamsFragment(wantsGp, wantsVelocity, wantsLocalPos);
        },
        bind(ctx: _PbrBindCtx, entries: GPUBindGroupEntry[], b: number): number {
            if ((ctx._features2 & PBR2_GEOMETRY_OUTPUT) === 0) {
                return b;
            }
            const view = ctx._material as { _gpUBO?: GPUBuffer | null };
            if (view._gpUBO) {
                entries.push({ binding: b++, resource: { buffer: view._gpUBO } });
            }
            return b;
        },
    };
    _registerPbrExt(ext);
}

// ─── Per-attachment WGSL expressions ──────────────────────────────────

/** Per-attachment WGSL output expression. Symbols are resolved against the
 *  in-scope PBR fragment vars at the BC slot location (after tonemap +
 *  gamma + contrast; same scope as the alpha-block).
 *  @internal */
function attachmentExpr(type: GeometryTextureType, wg: string, hasIbl: boolean): string {
    switch (type) {
        case GeometryTextureType.IRRADIANCE:
            // BJS PREPASS_IRRADIANCE (pbrBlockPrePass.fx): `finalDiffuse + finalIrradiance`
            // — direct-light diffuse plus the IBL diffuse contribution (already multiplied
            // by surfaceAlbedo / occlusion), NOT the raw SH irradiance. Lite's equivalents
            // are `directDiffuse` (direct) and `finalIrradiance` (= environmentIrradiance *
            // surfaceAlbedo * occlusion, ibl-fragment.ts). Both are pre-tonemap, matching BJS.
            return hasIbl ? `vec4<f32>(directDiffuse + finalIrradiance, ${wg})` : `vec4<f32>(directDiffuse, ${wg})`;
        case GeometryTextureType.WORLD_POSITION:
            return `vec4<f32>(input.worldPos, ${wg})`;
        case GeometryTextureType.LOCAL_POSITION:
            return `vec4<f32>(input.vLocalPos, ${wg})`;
        case GeometryTextureType.REFLECTIVITY:
            // BJS PREPASS_REFLECTIVITY (pbrBlockPrePass.fx): `vec4(specularEnvironmentR0, microSurface)`
            // — LINEAR F0 reflectance (no gamma) in RGB, microSurface (= 1 - roughness) in A,
            // the whole vec4 masked by writeGeometryInfo. Lite's `colorF0` is the F0 reflectance.
            return `vec4<f32>(colorF0, 1.0 - roughness) * ${wg}`;
        case GeometryTextureType.VIEW_DEPTH:
            return `vec4<f32>((scene.view * vec4<f32>(input.worldPos, 1.0)).z, 0.0, 0.0, ${wg})`;
        case GeometryTextureType.NORMALIZED_VIEW_DEPTH:
            return `vec4<f32>(((scene.view * vec4<f32>(input.worldPos, 1.0)).z - gp.cameraNearFar.x) / (gp.cameraNearFar.y - gp.cameraNearFar.x), 0.0, 0.0, ${wg})`;
        case GeometryTextureType.SCREENSPACE_DEPTH:
            return `vec4<f32>(input.clipPos.z, 0.0, 0.0, ${wg})`;
        case GeometryTextureType.VIEW_NORMAL:
            return `vec4<f32>(normalize((scene.view * vec4<f32>(N, 0.0)).xyz), ${wg})`;
        case GeometryTextureType.WORLD_NORMAL:
            return `vec4<f32>(N * 0.5 + vec3<f32>(0.5), ${wg})`;
        case GeometryTextureType.ALBEDO:
            // BJS uses `surfaceAlbedo` for PBR (post diffuse / metallic split).
            return `vec4<f32>(surfaceAlbedo, ${wg})`;
        case GeometryTextureType.LINEAR_VELOCITY: {
            const cur = `(input.vCurrentClip.xy / input.vCurrentClip.w)`;
            const prev = `(input.vPreviousClip.xy / input.vPreviousClip.w)`;
            return `vec4<f32>(0.5 * (${prev} - ${cur}), 0.0, ${wg})`;
        }
    }
}

// ─── Composer entry ────────────────────────────────────────────────────

/** Compose a PBR geometry-output shader by reusing the per-scene composer
 *  and post-patching the resulting WGSL into MRT form. */
export function composePbrGeometryShader(
    composePbr: ReturnType<typeof createPbrComposer>,
    features: number,
    features2: number,
    meshFeatures: number,
    sceneFeatures: number,
    lightMode: PbrLightMode,
    singleLightType: string,
    esmShadowDepthCode: string,
    vbStrides: MeshVbLayout | undefined,
    vbKey: string,
    attachments: readonly GeometryTextureType[],
    emitColor: boolean
): ComposedShader {
    // Strip PBR_HAS_ALPHA_BLEND: the template's alpha-blend branch returns
    // `finalAlpha = saturate(alpha + luminanceOverAlpha²)` which we don't need
    // — we drive blending per attachment via the geometry pipeline state and
    // gate writes via the `writeGeometryInfo` mask. Stripping yields the
    // simple `return vec4<f32>(color,alpha*material.materialAlpha);` alpha
    // block which is easier to pattern-match for the replacement.
    const geomFeatures = features & ~PBR_HAS_ALPHA_BLEND;
    // Tag the cache key with PBR2_GEOMETRY_OUTPUT so the geometry composed
    // shader doesn't collide with the regular non-geometry one in composePbr's
    // internal cache.
    const geomFeatures2 = features2 | PBR2_GEOMETRY_OUTPUT;

    const base = composePbr(
        geomFeatures,
        geomFeatures2,
        meshFeatures,
        sceneFeatures,
        lightMode,
        singleLightType,
        esmShadowDepthCode,
        vbStrides,
        `${vbKey}:geom:${attachments.join(",")}:${emitColor ? "c" : ""}`
    );

    const hasIbl = (sceneFeatures & PBR_HAS_ENV) !== 0;

    // ── Post-process the fragment WGSL ────────────────────────────────────

    // 1) Swap the entry signature.
    const fragmentSignatureFrom = "-> @location(0) vec4<f32>";
    const fragmentSignatureTo = "-> FragmentOutput";
    if (!base._fragmentWGSL.includes(fragmentSignatureFrom)) {
        throw new Error("composePbrGeometryShader: PBR fragment signature mismatch — _noColorOutput/_esmShadowOutput should be off");
    }
    let frag = base._fragmentWGSL.replace(fragmentSignatureFrom, fragmentSignatureTo);

    // 2) Inject FragmentOutput struct before `@fragment fn main`. When
    //    `emitColor` is true, append an extra slot at @location(N) for the
    //    real lit colour (matches BJS `targetTexture`).
    const colorSlot = attachments.length;
    const extraColorLine = emitColor ? `\n@location(${colorSlot}) color: vec4<f32>,` : "";
    const outputStruct = `struct FragmentOutput {
${attachments.map((_, i) => `@location(${i}) f${i}: vec4<f32>,`).join("\n")}${extraColorLine}
};
`;
    frag = frag.replace("@fragment fn main", `${outputStruct}@fragment fn main`);

    // 3) Replace the alpha-block return with MRT writes. With ALPHA_BLEND
    //    stripped, the template emits the simpler return form.
    const wg = `select(0.0, 1.0, alpha > 0.4)`;
    const writes = attachments.map((type, i) => `out.f${i} = ${attachmentExpr(type, wg, hasIbl)};`).join("\n");
    const extraColorWrite = emitColor ? `\nout.color = vec4<f32>(color, alpha * material.materialAlpha);` : "";
    const replacement = `var out: FragmentOutput;
${writes}${extraColorWrite}
return out;`;
    const returnPattern = "return vec4<f32>(color,alpha*material.materialAlpha);";
    if (!frag.includes(returnPattern)) {
        throw new Error("composePbrGeometryShader: alpha-block return statement not found — template changed?");
    }
    frag = frag.replace(returnPattern, replacement);

    return { ...base, _fragmentWGSL: frag };
}
