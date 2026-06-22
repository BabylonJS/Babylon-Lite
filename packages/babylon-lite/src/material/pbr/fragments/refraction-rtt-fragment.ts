import type { ShaderFragment, UboField } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps, SubSurfaceProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { getTrilinearAnisotropicSampler } from "../../../resource/trilinear-anisotropic-sampler.js";
import {
    PBR_HAS_THICKNESS_MAP,
    PBR2_HAS_DISPERSION,
    PBR2_HAS_REFRACTION,
    PBR2_HAS_REFRACTION_MAP,
    PBR2_HAS_THICKNESS_GLTF_CHANNEL,
    PBR2_HAS_VOLUME,
    PBR2_LINEAR_IMAGE_PROCESSING,
} from "../pbr-flag-bits.js";

type TransmissionMat = PbrMaterialProps & { _linearImageProcessing?: boolean };
const LINEAR_IMAGE_PROCESSING_SLOTS = { NI: `if(scene.vImageInfos.w>=0.0){`, BC: `}` };

function makeRefractionMod(
    hasVolume: boolean,
    hasMap: boolean,
    hasThicknessMap: boolean,
    useGltfThicknessChannel: boolean,
    hasDispersion: boolean,
    dispersionSampleWgsl: string | undefined
): string {
    const thicknessScaleLine = hasVolume || hasThicknessMap ? `let ts=max(length(mesh.world[0].xyz),max(length(mesh.world[1].xyz),length(mesh.world[2].xyz)));` : ``;
    const mapUvDecl = hasMap
        ? `let refractionMapUV=vec2<f32>(dot(material.refractionMapUVm.xy,input.uv),dot(material.refractionMapUVm.zw,input.uv))+material.refractionMapUVt.xy;\n`
        : ``;
    const thickUvDecl = hasThicknessMap
        ? `let thicknessUV=vec2<f32>(dot(material.thicknessUVm.xy,input.uv),dot(material.thicknessUVm.zw,input.uv))+material.thicknessUVt.xy;\n`
        : ``;
    const thicknessLine = hasThicknessMap
        ? `let ths=textureSample(thicknessTexture_,thicknessSampler_,thicknessUV).${useGltfThicknessChannel ? "g" : "r"};
let th=(material.thicknessParams.x+ths*material.thicknessParams.y)*ts;`
        : hasVolume
          ? `let th=material.refractionParams.z*ts;`
          : `let th=material.refractionParams.z;`;
    const textureLine = hasMap
        ? `let ri=material.refractionParams.x*textureSample(refractionMapTexture,refractionMapSampler,refractionMapUV).r;`
        : `let ri=material.refractionParams.x;`;
    const absorptionLine = hasVolume ? `let ab=exp(material.volumeParams.rgb*th);` : ``;
    const refractionLine = hasVolume
        ? `let fr=er*surfaceAlbedo*(ri*ab)*(vec3<f32>(1.0)-colorSpecularEnvReflectance.rgb);`
        : `let fr=er*surfaceAlbedo*ri*(vec3<f32>(1.0)-colorSpecularEnvReflectance.rgb);`;

    // Refracted environment sample. Dispersion splits the refracted ray into
    // per-RGB index-of-refraction offsets (chromatic aberration); that 3-ray WGSL
    // is injected from a dynamically-imported module (see refraction-dispersion-wgsl.ts)
    // so non-dispersion transmission scenes keep the lean single-ray path below.
    const sampleLines =
        hasDispersion && dispersionSampleWgsl
            ? dispersionSampleWgsl
            : `let rd=refract(-V,N,material.refractionParams.y);
let cp=scene.viewProjection*vec4<f32>(input.worldPos+rd*th,1.0);
let ruv=(cp.xy/cp.w)*vec2<f32>(0.5,-0.5)+vec2<f32>(0.5,0.5);
let er=textureSampleLevel(refractionTexture,refractionSampler_,ruv,lv).rgb*material.environmentIntensity;`;

    return `{
${thicknessScaleLine}
${mapUvDecl}${thickUvDecl}${textureLine}
${thicknessLine}
let ro=1.0-ri;
let ra=mix(alphaG,0.0,clamp(material.refractionParams.w*3.0-2.0,0.0,1.0));
let lv=clamp(log2(f32(textureDimensions(refractionTexture).x)*ra)-4.0,0.0,f32(textureNumLevels(refractionTexture)-1));
${sampleLines}
${absorptionLine}
${refractionLine}
color=finalIrradiance*ro*ro+finalRadianceScaled+finalSpecularScaled+directDiffuse*ro*ro+fr+emissive;
}`;
}

function createRefractionRttFragment(
    hasVolume: boolean,
    hasMap: boolean,
    hasThicknessMap: boolean,
    useGltfThicknessChannel: boolean,
    linearImageProcessing: boolean,
    hasDispersion: boolean,
    dispersionSampleWgsl: string | undefined
): ShaderFragment {
    const uboFields: UboField[] = [{ _name: "refractionParams", _type: "vec4<f32>" as const }];
    if (hasVolume) {
        uboFields.push({ _name: "volumeParams", _type: "vec4<f32>" as const });
    }
    if (hasThicknessMap) {
        uboFields.push({ _name: "thicknessParams", _type: "vec4<f32>" as const });
    }
    // Per-texture UV transforms (KHR_texture_transform on transmissionTexture / thicknessTexture),
    // animatable via KHR_animation_pointer. Emitted whenever the map is present; identity when the
    // texture carries no transform (sample at input.uv), so non-transformed scenes are unchanged.
    if (hasMap) {
        uboFields.push({ _name: "refractionMapUVm", _type: "vec4<f32>" as const }, { _name: "refractionMapUVt", _type: "vec4<f32>" as const });
    }
    if (hasThicknessMap) {
        uboFields.push({ _name: "thicknessUVm", _type: "vec4<f32>" as const }, { _name: "thicknessUVt", _type: "vec4<f32>" as const });
    }
    const bindings = [
        { _name: "refractionTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" } as const, _visibility: 2 },
        { _name: "refractionSampler_", _type: { _kind: "sampler", _samplerType: "sampler" } as const, _visibility: 2 },
    ];
    if (hasMap) {
        bindings.push(
            { _name: "refractionMapTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" } as const, _visibility: 2 },
            { _name: "refractionMapSampler", _type: { _kind: "sampler", _samplerType: "sampler" } as const, _visibility: 2 }
        );
    }
    if (hasThicknessMap) {
        bindings.push(
            { _name: "thicknessTexture_", _type: { _kind: "texture", _textureType: "texture_2d<f32>" } as const, _visibility: 2 },
            { _name: "thicknessSampler_", _type: { _kind: "sampler", _samplerType: "sampler" } as const, _visibility: 2 }
        );
    }
    return {
        _id: "refraction",
        _dependencies: ["ibl"],
        _uboFields: uboFields,
        _bindings: bindings,
        _fragmentSlots: linearImageProcessing
            ? { AI: makeRefractionMod(hasVolume, hasMap, hasThicknessMap, useGltfThicknessChannel, hasDispersion, dispersionSampleWgsl), ...LINEAR_IMAGE_PROCESSING_SLOTS }
            : { AI: makeRefractionMod(hasVolume, hasMap, hasThicknessMap, useGltfThicknessChannel, hasDispersion, dispersionSampleWgsl) },
    };
}

function writeRefractionUvTransform(
    data: Float32Array,
    offsets: ReadonlyMap<string, number>,
    name: string,
    tex: { uScale?: number; vScale?: number; uAng?: number; uOffset?: number; vOffset?: number } | undefined
): void {
    const mOff = offsets.get(`${name}m`);
    const tOff = offsets.get(`${name}t`);
    if (mOff === undefined || tOff === undefined) {
        return;
    }
    const mi = mOff / 4;
    const ti = tOff / 4;
    const sx = tex?.uScale ?? 1;
    const sy = tex?.vScale ?? 1;
    const ang = tex?.uAng ?? 0;
    if (ang === 0) {
        data[mi] = sx;
        data[mi + 1] = 0;
        data[mi + 2] = 0;
        data[mi + 3] = sy;
    } else {
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        data[mi] = c * sx;
        data[mi + 1] = s * sy;
        data[mi + 2] = -s * sx;
        data[mi + 3] = c * sy;
    }
    data[ti] = tex?.uOffset ?? 0;
    data[ti + 1] = tex?.vOffset ?? 0;
    data[ti + 2] = 0;
    data[ti + 3] = 0;
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
    data[o] = refr.intensity ?? 0;
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
        // w carries the chromatic dispersion strength (0 when no KHR_materials_dispersion).
        data[vo + 3] = refr.dispersion ?? 0;
    }

    const tOff = offsets.get("thicknessParams");
    if (tOff !== undefined) {
        const to = tOff / 4;
        const min = thick?.min ?? 0;
        const max = thick?.max ?? 1;
        data[to] = min;
        data[to + 1] = max - min;
    }

    writeRefractionUvTransform(data, offsets, "refractionMapUV", refr.texture);
    writeRefractionUvTransform(data, offsets, "thicknessUV", thick?.texture);
}

/** Build the PBR refraction/transmission extension. When the scene contains a
 *  dispersive material, `dispersionSampleWgsl` carries the per-RGB 3-ray sample
 *  WGSL (dynamically imported, scene-isolated); otherwise it is undefined and the
 *  lean single-ray refraction path is emitted. */
export function makeRefractionRttExt(dispersionSampleWgsl?: string): PbrExt {
    return {
        id: "refraction",
        phase: "fragment",
        detect(mat) {
            const m = mat as TransmissionMat;
            const ss = m.subsurface as SubSurfaceProps | undefined;
            const refr = ss?.refraction;
            const linearImageProcessing = m._linearImageProcessing ? PBR2_LINEAR_IMAGE_PROCESSING : 0;
            const intensity = m.transmissive ? (refr?.intensity ?? 0) : 0;
            if (intensity <= 0) {
                return { f: 0, f2: linearImageProcessing };
            }
            let f = 0;
            let f2 = linearImageProcessing | PBR2_HAS_REFRACTION;
            if (refr?.texture) {
                f2 |= PBR2_HAS_REFRACTION_MAP;
            }
            if (ss?.thickness?.texture) {
                f |= PBR_HAS_THICKNESS_MAP;
            }
            if (ss?.thickness?.useGlTFChannel) {
                f2 |= PBR2_HAS_THICKNESS_GLTF_CHANNEL;
            }
            if (ss?.tint?.atDistance !== undefined) {
                f2 |= PBR2_HAS_VOLUME;
                // Dispersion requires the volume path (per-channel etas + volumeParams.w storage).
                if (refr?.dispersion) {
                    f2 |= PBR2_HAS_DISPERSION;
                }
            }
            return { f, f2 };
        },
        frag(ctx) {
            const linearImageProcessing = (ctx._features2 & PBR2_LINEAR_IMAGE_PROCESSING) !== 0;
            if (!(ctx._features2 & PBR2_HAS_REFRACTION)) {
                return linearImageProcessing ? { _id: "linear", _fragmentSlots: LINEAR_IMAGE_PROCESSING_SLOTS } : null;
            }
            return createRefractionRttFragment(
                (ctx._features2 & PBR2_HAS_VOLUME) !== 0,
                (ctx._features2 & PBR2_HAS_REFRACTION_MAP) !== 0,
                (ctx._features & PBR_HAS_THICKNESS_MAP) !== 0,
                (ctx._features2 & PBR2_HAS_THICKNESS_GLTF_CHANNEL) !== 0,
                linearImageProcessing,
                (ctx._features2 & PBR2_HAS_DISPERSION) !== 0,
                dispersionSampleWgsl
            );
        },
        writeUbo(data, mat, offsets) {
            writeRefractionUBO(data, mat as PbrMaterialProps, offsets);
        },
        bind(ctx, entries, b) {
            if (!(ctx._features2 & PBR2_HAS_REFRACTION)) {
                return b;
            }
            const texture = ctx._refractionTexture;
            if (!texture) {
                throw new Error("PBR transmission requires a frame-graph refraction texture.");
            }
            entries.push({ binding: b++, resource: texture.view });
            entries.push({ binding: b++, resource: texture.sampler });
            if ((ctx._features2 & PBR2_HAS_REFRACTION_MAP) !== 0) {
                const map = ((ctx._material as PbrMaterialProps).subsurface?.refraction as SubSurfaceProps["refraction"] | undefined)?.texture!;
                entries.push({ binding: b++, resource: map.view });
                entries.push({ binding: b++, resource: getTrilinearAnisotropicSampler(ctx._engine) });
            }
            if ((ctx._features & PBR_HAS_THICKNESS_MAP) !== 0) {
                const thickness = (ctx._material as PbrMaterialProps).subsurface?.thickness?.texture!;
                entries.push({ binding: b++, resource: thickness.view });
                entries.push({ binding: b++, resource: thickness.sampler });
            }
            return b;
        },
        textures(mat, out) {
            const tex = (mat as PbrMaterialProps).subsurface?.refraction?.texture;
            if (tex) {
                out.push(tex);
            }
            const thickness = (mat as PbrMaterialProps).subsurface?.thickness?.texture;
            if (thickness) {
                out.push(thickness);
            }
        },
    };
}
