import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { AssetContainer } from "../../../asset-container.js";
import type { PbrMaterialProps, SubSurfaceProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR2_HAS_REFRACTION, PBR2_HAS_VOLUME, PBR2_LINEAR_IMAGE_PROCESSING } from "../pbr-flag-bits.js";

let opaqueSceneTexture: Texture2D | null = null;
type OpaqueRefractionMat = PbrMaterialProps & { _opaqueRefractionIntensity?: number; _linearImageProcessing?: boolean };
const LINEAR_IMAGE_PROCESSING_SLOTS = { NI: `if(scene.vImageInfos.w>=0.0){`, BC: `}` };

export function setOpaqueSceneRefractionTexture(texture: Texture2D): void {
    opaqueSceneTexture = texture;
}

export function useOpaqueSceneRefraction(container: AssetContainer): void {
    for (const entity of container.entities) {
        visitMaterialNode(entity);
    }
}

function visitMaterialNode(entity: unknown): void {
    const node = entity as { material?: unknown; children?: readonly unknown[] };
    const mat = node.material as OpaqueRefractionMat | undefined;
    const refr = mat?.subsurface?.refraction;
    const intensity = refr?.intensity ?? 0;
    if (mat) {
        mat._linearImageProcessing = true;
    }
    if (mat && intensity > 0) {
        mat._opaqueRefractionIntensity = intensity;
        refr!.intensity = 0;
    }
    for (const child of node.children ?? []) {
        visitMaterialNode(child);
    }
}

function makeRefractionMod(hasVolume: boolean): string {
    const absorptionLine = hasVolume ? `let absorption = exp(material.volumeParams.rgb * material.refractionParams.z);` : `let absorption = vec3<f32>(1.0);`;

    return `{
let refrIntensity = material.refractionParams.x;
let refrOpacity = 1.0 - refrIntensity;
let volumeIor = material.refractionParams.y;
let surfaceIor = material.refractionParams.w;
let refrDir_raw = refract(-V, N, volumeIor);
let refrAlphaG = mix(alphaG, 0.0, clamp(surfaceIor * 3.0 - 2.0, 0.0, 1.0));
let refrMaxLod = f32(textureNumLevels(refractionTexture) - 1);
let refrDim = f32(textureDimensions(refractionTexture).x);
let refrSpecLod = log2(refrDim * refrAlphaG) - 4.0;
let refrLodClamped = clamp(refrSpecLod, 0.0, refrMaxLod);
let refrClip = scene.viewProjection * vec4<f32>(input.worldPos + refrDir_raw * material.refractionParams.z, 1.0);
let refrUv = clamp((refrClip.xy / refrClip.w) * vec2<f32>(0.5, 0.5) + vec2<f32>(0.5, 0.5), vec2<f32>(0.0), vec2<f32>(1.0));
let envRefraction = textureSampleLevel(refractionTexture, refractionSampler_, refrUv, refrLodClamped).rgb * material.environmentIntensity;
${absorptionLine}
let refractionTransmittance = refrIntensity * absorption;
let refractionReflectance = max(colorSpecularEnvReflectance.r, max(colorSpecularEnvReflectance.g, colorSpecularEnvReflectance.b));
let finalRefraction = envRefraction * surfaceAlbedo * refractionTransmittance * (vec3<f32>(1.0) - vec3<f32>(refractionReflectance));
color = finalIrradiance * refrOpacity
      + finalRadianceScaled
      + finalSpecularScaled
      + directDiffuse * refrOpacity
      + finalRefraction
      + emissive;
}`;
}

function createLinearImageProcessingFragment(): ShaderFragment {
    return {
        id: "opaque-linear",
        fragmentSlots: LINEAR_IMAGE_PROCESSING_SLOTS,
    };
}

function createRefractionRttFragment(hasVolume: boolean, linearImageProcessing: boolean): ShaderFragment {
    const uboFields: { name: string; type: "vec4<f32>" }[] = [{ name: "refractionParams", type: "vec4<f32>" as const }];
    if (hasVolume) {
        uboFields.push({ name: "volumeParams", type: "vec4<f32>" as const });
    }
    return {
        id: "refraction",
        dependencies: ["ibl"],
        uboFields,
        bindings: [
            { name: "refractionTexture", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: 2 },
            { name: "refractionSampler_", type: { kind: "sampler", samplerType: "sampler" }, visibility: 2 },
        ],
        fragmentSlots: linearImageProcessing ? { AI: makeRefractionMod(hasVolume), ...LINEAR_IMAGE_PROCESSING_SLOTS } : { AI: makeRefractionMod(hasVolume) },
    };
}

function writeRefractionUBO(data: Float32Array, mat: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    const ss = mat.subsurface as SubSurfaceProps | undefined;
    const refr = ss?.refraction;
    if (!refr) {
        return;
    }
    const off = offsets.get("refractionParams");
    if (off === undefined) {
        return;
    }
    const o = off / 4;
    data[o] = (mat as OpaqueRefractionMat)._opaqueRefractionIntensity ?? refr.intensity ?? 0;
    const ior = refr.indexOfRefraction ?? 1.5;
    const thick = ss!.thickness;
    data[o + 1] = 1.0 / (refr.useThicknessAsDepth && thick?.max ? ior : 1.0);
    data[o + 2] = refr.useThicknessAsDepth ? (thick?.max ?? 0.0) : 1.0;
    data[o + 3] = 1.0 / ior;

    const vOff = offsets.get("volumeParams");
    if (vOff !== undefined) {
        const vo = vOff / 4;
        const tint = ss!.tint?.color ?? [1, 1, 1];
        const dist = Math.max(ss!.tint?.atDistance ?? 1, 0.0001);
        data[vo] = Math.log(Math.max(tint[0]!, 1e-6)) / dist;
        data[vo + 1] = Math.log(Math.max(tint[1]!, 1e-6)) / dist;
        data[vo + 2] = Math.log(Math.max(tint[2]!, 1e-6)) / dist;
        data[vo + 3] = 0;
    }
}

export const refractionRttExt: PbrExt = {
    id: "refraction",
    phase: "fragment",
    detect(mat) {
        const m = mat as OpaqueRefractionMat;
        const ss = m.subsurface as SubSurfaceProps | undefined;
        const refr = ss?.refraction;
        let f2 = m._linearImageProcessing ? PBR2_LINEAR_IMAGE_PROCESSING : 0;
        if (refr && (m._opaqueRefractionIntensity ?? refr.intensity ?? 0) > 0) {
            f2 |= PBR2_HAS_REFRACTION;
        }
        if ((f2 & PBR2_HAS_REFRACTION) !== 0 && ss!.tint?.atDistance !== undefined) {
            f2 |= PBR2_HAS_VOLUME;
        }
        return { f: 0, f2 };
    },
    frag(ctx) {
        const linearImageProcessing = (ctx.features2 & PBR2_LINEAR_IMAGE_PROCESSING) !== 0;
        if (!(ctx.features2 & PBR2_HAS_REFRACTION)) {
            return linearImageProcessing ? createLinearImageProcessingFragment() : null;
        }
        return createRefractionRttFragment((ctx.features2 & PBR2_HAS_VOLUME) !== 0, linearImageProcessing);
    },
    writeUbo(data, mat, offsets) {
        if (offsets.has("refractionParams")) {
            writeRefractionUBO(data, mat as PbrMaterialProps, offsets);
        }
    },
    bind(ctx, entries, b) {
        if (!(ctx.features2 & PBR2_HAS_REFRACTION)) {
            return b;
        }
        if (!opaqueSceneTexture) {
            throw new Error("PBR refraction requires an opaque scene texture.");
        }
        entries.push({ binding: b++, resource: opaqueSceneTexture.view });
        entries.push({ binding: b++, resource: opaqueSceneTexture.sampler });
        return b;
    },
};
