/**
 * Iridescence Fragment
 *
 * Native PBR thin-film iridescence (BJS PBRMaterial.iridescence and
 * KHR_materials_iridescence). Modifies the already-computed base-layer colorF0
 * before direct and IBL lighting consume it.
 */

import type { BindingDecl, ShaderFragment, UboField } from "../../../shader/fragment-types.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { PbrExt } from "../pbr-flags.js";
import type { IridescenceProps, PbrMaterialProps } from "../pbr-material.js";
import {
    PBR_HAS_METALLIC_REFLECTANCE_MAP,
    PBR_HAS_REFLECTANCE_MAP,
    PBR2_HAS_IRIDESCENCE,
    PBR2_HAS_IRIDESCENCE_MAP,
    PBR2_HAS_IRIDESCENCE_THICKNESS_MAP,
    PBR2_HAS_REFLECTANCE_FACTORS,
} from "../pbr-flag-bits.js";

const STAGE_FRAGMENT = 0x2;
const PBR2_HAS_IRIDESCENCE_UV_TX = 1 << 20;
const PBR2_HAS_IRIDESCENCE_THICKNESS_UV_TX = 1 << 21;
const PBR2_HAS_IRIDESCENCE_UV2 = 1 << 22;
const PBR2_HAS_IRIDESCENCE_THICKNESS_UV2 = 1 << 23;
const IRI_MSH_HAS_UV2 = 1 << 7;

const IRIDESCENCE_HELPERS = `const IRI_XYZ_TO_REC709:mat3x3<f32>=mat3x3<f32>(
3.2404542,-0.9692660,0.0556434,
-1.5371385,1.8760108,-0.2040259,
-0.4985314,0.0415560,1.0572252);
fn iri_square3(x:vec3<f32>)->vec3<f32>{return x*x;}
fn iri_iorFromAirF0(f0:vec3<f32>)->vec3<f32>{
let s=sqrt(clamp(f0,vec3<f32>(0.0),vec3<f32>(0.9999)));
return (vec3<f32>(1.0)+s)/(vec3<f32>(1.0)-s);
}
fn iri_r0FromIor3(iorT:vec3<f32>,iorI:f32)->vec3<f32>{return iri_square3((iorT-vec3<f32>(iorI))/(iorT+vec3<f32>(iorI)));}
fn iri_r0FromIor(iorT:f32,iorI:f32)->f32{let r=(iorT-iorI)/(iorT+iorI);return r*r;}
fn iri_fresSchlick(c:f32,F0:vec3<f32>,F90:vec3<f32>)->vec3<f32>{
let t=1.0-c;
let t2=t*t;
return F0+(F90-F0)*(t2*t2*t);
}
fn iri_evalSensitivity(opd:f32,shift:vec3<f32>)->vec3<f32>{
let phase=6.283185307179586*opd*1.0e-9;
let val=vec3<f32>(5.4856e-13,4.4201e-13,5.2481e-13);
let pos=vec3<f32>(1.6810e+06,1.7953e+06,2.2084e+06);
let vr=vec3<f32>(4.3278e+09,9.3046e+09,6.6121e+09);
var xyz=val*sqrt(6.283185307179586*vr)*cos(pos*phase+shift)*exp(-(phase*phase)*vr);
xyz.x=xyz.x+9.7470e-14*sqrt(6.283185307179586*4.5282e+09)*cos(2.2399e+06*phase+shift.x)*exp(-4.5282e+09*phase*phase);
xyz=xyz/1.0685e-7;
return IRI_XYZ_TO_REC709*xyz;
}
fn iri_eval(outsideIor:f32,eta2:f32,cosTheta1:f32,thickness:f32,baseF0:vec3<f32>)->vec3<f32>{
let iridescenceIor=mix(outsideIor,eta2,smoothstep(0.0,0.03,thickness));
let eta=outsideIor/iridescenceIor;
let sinTheta2Sq=eta*eta*(1.0-cosTheta1*cosTheta1);
let cosTheta2Sq=1.0-sinTheta2Sq;
if(cosTheta2Sq<0.0){return vec3<f32>(1.0);}
let cosTheta2=sqrt(cosTheta2Sq);
let r0=iri_r0FromIor(iridescenceIor,outsideIor);
let r12=iri_fresSchlick(cosTheta1,vec3<f32>(r0),vec3<f32>(1.0)).x;
let t121=1.0-r12;
var phi12=0.0;
if(iridescenceIor<outsideIor){phi12=3.141592653589793;}
let phi21=3.141592653589793-phi12;
let baseIor=iri_iorFromAirF0(baseF0);
let r1=iri_r0FromIor3(baseIor,iridescenceIor);
let r23=iri_fresSchlick(cosTheta2,r1,vec3<f32>(1.0));
var phi23=vec3<f32>(0.0);
if(baseIor.x<iridescenceIor){phi23.x=3.141592653589793;}
if(baseIor.y<iridescenceIor){phi23.y=3.141592653589793;}
if(baseIor.z<iridescenceIor){phi23.z=3.141592653589793;}
let opd=2.0*iridescenceIor*thickness*cosTheta2;
let phi=vec3<f32>(phi21)+phi23;
let r123=clamp(vec3<f32>(r12)*r23,vec3<f32>(1e-5),vec3<f32>(0.9999));
let smallR123=sqrt(r123);
let rs=(t121*t121)*r23/(vec3<f32>(1.0)-r123);
var outI=vec3<f32>(r12)+rs;
var cm=rs-vec3<f32>(t121);
for(var m:i32=1;m<=2;m=m+1){
cm=cm*smallR123;
outI=outI+cm*(2.0*iri_evalSensitivity(f32(m)*opd,f32(m)*phi));
}
return max(outI,vec3<f32>(0.0));
}`;

const IRI_TEX: ReadonlyArray<readonly [number, "texture" | "thicknessTexture"]> = [
    [PBR2_HAS_IRIDESCENCE_MAP, "texture"],
    [PBR2_HAS_IRIDESCENCE_THICKNESS_MAP, "thicknessTexture"],
];

function uvBaseExpr(features2: number, meshFeatures: number, uv2Flag: number): string {
    return (features2 & uv2Flag) !== 0 && (meshFeatures & IRI_MSH_HAS_UV2) !== 0 ? "input.uv2" : "input.uv";
}

function uvDecl(name: string, baseUv: string, hasTx: boolean): string {
    return hasTx ? `let ${name}=vec2<f32>(dot(material.${name}m.xy,${baseUv}),dot(material.${name}m.zw,${baseUv}))+material.${name}t.xy;` : `let ${name}=${baseUv};`;
}

function uvTransformUboFields(name: string): UboField[] {
    return [
        { _name: `${name}m`, _type: "vec4<f32>" },
        { _name: `${name}t`, _type: "vec4<f32>" },
    ];
}

function writeUvTransform(data: Float32Array, offsets: ReadonlyMap<string, number>, name: string, tex: Texture2D | undefined): void {
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
    const ox = tex?.uOffset ?? 0;
    const oy = tex?.vOffset ?? 0;
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
    data[ti] = ox;
    data[ti + 1] = oy;
    data[ti + 2] = 0;
    data[ti + 3] = 0;
}

function createIridescenceFragment(features: number, features2: number, meshFeatures: number): ShaderFragment | null {
    if ((features2 & PBR2_HAS_IRIDESCENCE) === 0) {
        return null;
    }
    const hasIntensityMap = (features2 & PBR2_HAS_IRIDESCENCE_MAP) !== 0;
    const hasThicknessMap = (features2 & PBR2_HAS_IRIDESCENCE_THICKNESS_MAP) !== 0;
    const hasIntensityUvTx = (features2 & PBR2_HAS_IRIDESCENCE_UV_TX) !== 0;
    const hasThicknessUvTx = (features2 & PBR2_HAS_IRIDESCENCE_THICKNESS_UV_TX) !== 0;
    const bindings: BindingDecl[] = [];
    const uboFields: UboField[] = [{ _name: "iridescenceParams", _type: "vec4<f32>" }];
    if (hasIntensityMap) {
        bindings.push(
            { _name: "iridescenceTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "iridescenceSampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
        if (hasIntensityUvTx) {
            uboFields.push(...uvTransformUboFields("iridescenceUV"));
        }
    }
    if (hasThicknessMap) {
        bindings.push(
            { _name: "iridescenceThicknessTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "iridescenceThicknessSampler_", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
        if (hasThicknessUvTx) {
            uboFields.push(...uvTransformUboFields("iridescenceThicknessUV"));
        }
    }

    const scopeVars: string[] = [];
    if (hasIntensityMap) {
        scopeVars.push(uvDecl("iridescenceUV", uvBaseExpr(features2, meshFeatures, PBR2_HAS_IRIDESCENCE_UV2), hasIntensityUvTx));
    }
    if (hasThicknessMap) {
        scopeVars.push(uvDecl("iridescenceThicknessUV", uvBaseExpr(features2, meshFeatures, PBR2_HAS_IRIDESCENCE_THICKNESS_UV2), hasThicknessUvTx));
    }

    const intensity = hasIntensityMap ? "material.iridescenceParams.x*textureSample(iridescenceTexture,iridescenceSampler_,iridescenceUV).r" : "material.iridescenceParams.x";
    const thickness = hasThicknessMap
        ? "mix(material.iridescenceParams.z,material.iridescenceParams.w,textureSample(iridescenceThicknessTexture,iridescenceThicknessSampler_,iridescenceThicknessUV).g)"
        : "material.iridescenceParams.w";
    return {
        _id: "iridescence",
        _dependencies:
            (features & (PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP)) !== 0 || (features2 & PBR2_HAS_REFLECTANCE_FACTORS) !== 0 ? ["reflectance"] : undefined,
        _uboFields: uboFields,
        _bindings: bindings,
        _helperFunctions: IRIDESCENCE_HELPERS,
        _fragmentSlots: {
            ...(scopeVars.length ? { SV: scopeVars.join("\n") } : undefined),
            MF: `{
let iriIntensity=clamp(${intensity},0.0,1.0);
let iriThickness=max(${thickness},0.0);
let iriF0=iri_eval(1.0,max(material.iridescenceParams.y,1.0001),NdotV,iriThickness,colorF0);
colorF0=mix(colorF0,iriF0,iriIntensity);
}`,
        },
    };
}

export function writeIridescenceUBO(data: Float32Array, material: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    const iri = material.iridescence as IridescenceProps | undefined;
    if (!iri?.isEnabled || !offsets.has("iridescenceParams")) {
        return;
    }
    const off = offsets.get("iridescenceParams")! / 4;
    data[off] = iri.intensity ?? 1.0;
    data[off + 1] = iri.indexOfRefraction ?? 1.3;
    data[off + 2] = iri.minimumThickness ?? 100;
    data[off + 3] = iri.maximumThickness ?? 400;
    writeUvTransform(data, offsets, "iridescenceUV", iri.texture);
    writeUvTransform(data, offsets, "iridescenceThicknessUV", iri.thicknessTexture);
}

export const pbrExt: PbrExt = {
    id: "iridescence",
    phase: "base-tex",
    detect(mat) {
        const iri = (mat as PbrMaterialProps).iridescence;
        if (!iri?.isEnabled) {
            return { f: 0, f2: 0 };
        }
        let f2 = PBR2_HAS_IRIDESCENCE;
        if (iri.texture) {
            f2 |= PBR2_HAS_IRIDESCENCE_MAP;
            if ((iri.texture as { _hasTx?: boolean })._hasTx) {
                f2 |= PBR2_HAS_IRIDESCENCE_UV_TX;
            }
            if ((iri.texture as { _texCoord?: number })._texCoord === 1) {
                f2 |= PBR2_HAS_IRIDESCENCE_UV2;
            }
        }
        if (iri.thicknessTexture) {
            f2 |= PBR2_HAS_IRIDESCENCE_THICKNESS_MAP;
            if ((iri.thicknessTexture as { _hasTx?: boolean })._hasTx) {
                f2 |= PBR2_HAS_IRIDESCENCE_THICKNESS_UV_TX;
            }
            if ((iri.thicknessTexture as { _texCoord?: number })._texCoord === 1) {
                f2 |= PBR2_HAS_IRIDESCENCE_THICKNESS_UV2;
            }
        }
        return { f: 0, f2 };
    },
    frag: (ctx) => createIridescenceFragment(ctx._features, ctx._features2, ctx._meshFeatures),
    writeUbo: writeIridescenceUBO as PbrExt["writeUbo"],
    bind(ctx, entries, b) {
        const iri = (ctx._material as PbrMaterialProps).iridescence;
        if (!iri) {
            return b;
        }
        for (const [flag, key] of IRI_TEX) {
            const tex = iri[key];
            if ((ctx._features2 & flag) !== 0 && tex) {
                entries.push({ binding: b++, resource: tex.view });
                entries.push({ binding: b++, resource: tex.sampler });
            }
        }
        return b;
    },
    textures(mat, t) {
        const iri = (mat as PbrMaterialProps).iridescence;
        if (!iri) {
            return;
        }
        for (const [, key] of IRI_TEX) {
            const tex = iri[key];
            if (tex) {
                t.push(tex);
            }
        }
    },
};
