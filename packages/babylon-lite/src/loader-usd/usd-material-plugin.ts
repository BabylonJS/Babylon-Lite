import type { MaterialPlugin, MaterialPluginPoint, PluginTextureBinding, PluginUboField } from "../material/plugin/material-plugin.js";
import { wgsl, type WgslSource } from "../shader/wgsl.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { UsdTextureSource } from "./usd-textures.js";

/** @internal One authored UsdPreviewSurface texture connection. */
export interface UsdTextureBinding {
    readonly source: UsdTextureSource;
    readonly channel: number;
}

/** @internal Texture slots in protocol order, excluding the native normal-map path. */
export interface UsdMaterialBindings {
    readonly base?: UsdTextureBinding;
    readonly opacity?: UsdTextureBinding;
    readonly normal?: UsdTextureBinding;
    readonly metallic?: UsdTextureBinding;
    readonly roughness?: UsdTextureBinding;
    readonly occlusion?: UsdTextureBinding;
    readonly emissive?: UsdTextureBinding;
}

const roles = ["base", "opacity", "normal", "metallic", "roughness", "occlusion", "emissive"] as const;
type Role = (typeof roles)[number];

function cap(role: Role): string {
    return role[0]!.toUpperCase() + role.slice(1);
}

function textureName(role: Role): string {
    return `usd${cap(role)}Texture`;
}

function samplerName(role: Role): string {
    return `usd${cap(role)}Sampler`;
}

function prefix(role: Role): string {
    return `usd${cap(role)}`;
}

function uvExpression(role: Role): WgslSource {
    const p = prefix(role);
    return wgsl`vec2<f32>(dot(material.${p}UVm.xy,input.uv),dot(material.${p}UVm.zw,input.uv))+material.${p}UVt.xy`;
}

function sampleExpression(role: Role): WgslSource {
    return wgsl`textureSample(${textureName(role)},${samplerName(role)},${uvExpression(role)})`;
}

function scalarExpression(role: Role, channel: number): WgslSource {
    return wgsl`${sampleExpression(role)}.${"rgba"[channel]!}`;
}

function materialCode(bindings: UsdMaterialBindings): WgslSource {
    let code = wgsl``;
    if (bindings.base) {
        code = wgsl`${code}{let s=${sampleExpression("base")};baseColor=s.rgb*material.usdBaseScale.rgb+material.usdBaseBias.rgb;}`;
    }
    if (bindings.opacity) {
        code = wgsl`${code}{let s=${scalarExpression("opacity", bindings.opacity.channel)};alpha=s*material.usdOpacityScale.x+material.usdOpacityBias.x;}`;
    }
    if (bindings.metallic) {
        code = wgsl`${code}{let s=${scalarExpression("metallic", bindings.metallic.channel)};metallic=clamp(s*material.usdMetallicScale.x+material.usdMetallicBias.x,0.0,1.0);}`;
    }
    if (bindings.roughness) {
        code = wgsl`${code}{let s=${scalarExpression("roughness", bindings.roughness.channel)};roughness=clamp(s*material.usdRoughnessScale.x+material.usdRoughnessBias.x,0.0,1.0);}`;
    }
    if (bindings.occlusion) {
        code = wgsl`${code}{let s=${scalarExpression("occlusion", bindings.occlusion.channel)};occlusion=clamp(s*material.usdOcclusionScale.x+material.usdOcclusionBias.x,0.0,1.0);}`;
    }
    if (bindings.emissive) {
        code = wgsl`${code}{let s=${sampleExpression("emissive")};emissive=s.rgb*material.usdEmissiveScale.rgb+material.usdEmissiveBias.rgb;}`;
    }
    return code;
}

function normalCode(binding: UsdTextureBinding | undefined): WgslSource {
    if (!binding) {
        return wgsl``;
    }
    return wgsl`{
let usdNormalSample=${sampleExpression("normal")}.rgb*material.usdNormalScale.rgb+material.usdNormalBias.rgb;
let usdDp1=dpdx(input.worldPos);
let usdDp2=dpdy(input.worldPos);
let usdDuv1=dpdx(${uvExpression("normal")});
let usdDuv2=dpdy(${uvExpression("normal")});
let usdDp2Perp=cross(usdDp2,N_geom);
let usdDp1Perp=cross(N_geom,usdDp1);
let usdTangent=usdDp2Perp*usdDuv1.x+usdDp1Perp*usdDuv2.x;
let usdBitangent=-(usdDp2Perp*usdDuv1.y+usdDp1Perp*usdDuv2.y);
let usdDet=max(dot(usdTangent,usdTangent),dot(usdBitangent,usdBitangent));
let usdInvMax=select(inverseSqrt(usdDet),0.0,usdDet==0.0);
let usdCotangentFrame=mat3x3<f32>(usdTangent*usdInvMax,usdBitangent*usdInvMax,N_geom);
N=normalize(usdCotangentFrame*normalize(vec3<f32>(usdNormalSample.xy*material.normalScale,usdNormalSample.z)));
}`;
}

function writeBinding(data: Float32Array, offsets: ReadonlyMap<string, number>, role: Role, binding: UsdTextureBinding): void {
    const p = prefix(role);
    const matrixOffset = offsets.get(`${p}UVm`);
    const translationOffset = offsets.get(`${p}UVt`);
    const scaleOffset = offsets.get(`${p}Scale`);
    const biasOffset = offsets.get(`${p}Bias`);
    if (matrixOffset === undefined || translationOffset === undefined || scaleOffset === undefined || biasOffset === undefined) {
        throw new Error(`Missing USD material uniform layout for ${role}`);
    }
    const texture = binding.source.texture;
    const sx = texture.uScale ?? 1;
    const sy = texture.vScale ?? 1;
    const angle = texture.uAng ?? 0;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    data.set([cosine * sx, sine * sy, -sine * sx, cosine * sy], matrixOffset / 4);
    data.set([texture.uOffset ?? 0, texture.vOffset ?? 0, 0, 0], translationOffset / 4);
    if (role === "opacity" || role === "metallic" || role === "roughness" || role === "occlusion") {
        const channel = binding.channel;
        data.set([binding.source.scale[channel]!, 0, 0, 0], scaleOffset / 4);
        data.set([binding.source.bias[channel]!, 0, 0, 0], biasOffset / 4);
    } else {
        data.set(binding.source.scale, scaleOffset / 4);
        data.set(binding.source.bias, biasOffset / 4);
    }
}

/** @internal Create a per-material plugin that preserves independent USD texture semantics. */
export function createUsdMaterialPlugin(bindings: UsdMaterialBindings): MaterialPlugin {
    const active = roles.filter((role) => bindings[role]);
    const fields: PluginUboField[] = active.flatMap((role) => {
        const p = prefix(role);
        return [
            { name: `${p}UVm`, type: "vec4<f32>" },
            { name: `${p}UVt`, type: "vec4<f32>" },
            { name: `${p}Scale`, type: "vec4<f32>" },
            { name: `${p}Bias`, type: "vec4<f32>" },
        ];
    });
    const code = materialCode(bindings);
    const normal = normalCode(bindings.normal);
    return {
        name: "usd-preview-surface",
        getCustomCode(shaderType: "vertex" | "fragment"): Partial<Record<MaterialPluginPoint, string>> | null {
            return shaderType === "fragment"
                ? {
                      CUSTOM_FRAGMENT_UPDATE_ALPHA: code,
                      ...(normal ? { CUSTOM_FRAGMENT_UPDATE_DIFFUSE: normal } : undefined),
                  }
                : null;
        },
        getUniforms: () => ({ ubo: fields }),
        getSamplers: () => active.map((role) => ({ texture: textureName(role), sampler: samplerName(role) })),
        writeUbo(data: Float32Array, offsets: ReadonlyMap<string, number>): void {
            for (const role of active) {
                writeBinding(data, offsets, role, bindings[role]!);
            }
        },
        bindTextures(out: PluginTextureBinding[]): void {
            for (const role of active) {
                out.push({ texture: bindings[role]!.source.texture });
            }
        },
        getActiveTextures(out: Texture2D[]): void {
            for (const role of active) {
                out.push(bindings[role]!.source.texture);
            }
        },
    };
}
