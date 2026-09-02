import type { ShaderFragment, Varying } from "../../../shader/fragment-types.js";
import { createUniformBuffer } from "../../../resource/gpu-buffers.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StandardMaterialProps } from "../standard-material.js";
import {
    AMBIENT_USES_UV2,
    DIFFUSE_USES_UV2,
    HAS_AMBIENT_TEXTURE,
    HAS_BUMP_TEXTURE,
    HAS_DIFFUSE_TEXTURE,
    HAS_EMISSIVE_TEXTURE,
    HAS_LIGHTMAP_TEXTURE,
    HAS_OPACITY_TEXTURE,
    HAS_SPECULAR_TEXTURE,
    LIGHTMAP_USES_UV2,
    SPECULAR_USES_UV2,
} from "../standard-flags.js";
import { _registerStdExt, type StdExt } from "../standard-flags.js";
import { wgsl } from "../../../shader/wgsl.js";

const STAGE_VERTEX = 0x1;
// Reserved Standard feature bit 23. Kept in this lazy fragment so scenes that
// never opt into UV transforms do not retain a shared exported constant.
const STD_HAS_UV_TRANSFORM = 1 << 23;
const FLOATS_PER_CHANNEL = 8;
const CHANNEL_COUNT = 7;

const CHANNELS = [
    ["d", HAS_DIFFUSE_TEXTURE, DIFFUSE_USES_UV2, "diffuseTexture", "diffuseCoordIndex"],
    ["e", HAS_EMISSIVE_TEXTURE, 0, "_emissiveTexture", null],
    ["b", HAS_BUMP_TEXTURE, 0, "_bumpTexture", null],
    ["s", HAS_SPECULAR_TEXTURE, SPECULAR_USES_UV2, "_specularTexture", "specularCoordIndex"],
    ["a", HAS_AMBIENT_TEXTURE, AMBIENT_USES_UV2, "_ambientTexture", "ambientCoordIndex"],
    ["l", HAS_LIGHTMAP_TEXTURE, LIGHTMAP_USES_UV2, "_lightmapTexture", "lightmapCoordIndex"],
    ["o", HAS_OPACITY_TEXTURE, 0, "_opacityTexture", null],
] as const;

function writeChannel(
    data: Float32Array,
    channel: number,
    texture: Texture2D | null | undefined,
    material: StandardMaterialProps,
    materialOffsetX: number,
    materialOffsetY: number,
    usesUv2: boolean,
    legacyFlipV: boolean
): void {
    const offset = channel * FLOATS_PER_CHANNEL;
    const sx = texture?.uScale ?? 1;
    const sy = texture?.vScale ?? 1;
    const angle = legacyFlipV ? 0 : (texture?.uAng ?? 0);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const m00 = c * sx;
    const m01 = s * sy;
    const m10 = -s * sx;
    const m11 = c * sy;

    const baseScaleX = usesUv2 ? 1 : material.uvScale[0];
    const baseScaleY = usesUv2 ? 1 : material.uvScale[1];
    const baseOffsetX = usesUv2 ? 0 : materialOffsetX;
    const baseOffsetY = usesUv2 ? 0 : materialOffsetY;

    data[offset] = m00 * baseScaleX;
    data[offset + 1] = m01 * baseScaleY;
    data[offset + 2] = m10 * baseScaleX;
    data[offset + 3] = m11 * baseScaleY;
    data[offset + 4] = m00 * baseOffsetX + m01 * baseOffsetY + (texture?.uOffset ?? 0);
    data[offset + 5] = m10 * baseOffsetX + m11 * baseOffsetY + (texture?.vOffset ?? 0);
    if (!!texture?.invertY !== legacyFlipV) {
        data[offset + 2] = -data[offset + 2]!;
        data[offset + 3] = -data[offset + 3]!;
        data[offset + 5] = 1 - data[offset + 5]!;
    }
    data[offset + 6] = 0;
    data[offset + 7] = 0;
}

function writeUvTransformData(data: Float32Array, material: StandardMaterialProps): void {
    const materialOffsetX = material.uvOffset?.[0] ?? 0;
    const materialOffsetY = material.uvOffset?.[1] ?? 0;
    for (let i = 0; i < CHANNELS.length; i++) {
        const [, , , textureKey, coordIndexKey] = CHANNELS[i]!;
        const texture = material[textureKey];
        writeChannel(
            data,
            i,
            texture,
            material,
            materialOffsetX,
            materialOffsetY,
            coordIndexKey !== null && material[coordIndexKey] === 1,
            textureKey === "_lightmapTexture" && texture?.uAng === Math.PI
        );
    }
}

function createStdUvTransformFragment(features: number): ShaderFragment {
    const varyings: Varying[] = [];
    const assignments: string[] = [];
    for (let i = 0; i < CHANNELS.length; i++) {
        const [name, feature, uv2Bit] = CHANNELS[i]!;
        if ((features & feature) === 0) {
            continue;
        }
        const usesUv2 = uv2Bit !== 0 && (features & uv2Bit) !== 0;
        const varying = name === "d" ? (usesUv2 ? "vv" : "vu") : `v${name}`;
        if (name !== "d") {
            varyings.push({ _name: varying, _type: "vec2<f32>" });
        }
        assignments.push(wgsl`out.${varying}=stdTxfUV(${usesUv2 ? "uv2" : "uv"},stdUvTx.${name}m,stdUvTx.${name}t.xy);`);
    }
    return {
        _id: "0-std-uv-transform",
        _varyings: varyings,
        _bindings: [{ _name: "stdUvTx", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_VERTEX }],
        _vertexHelperFunctions: wgsl`struct stdUvTxUniforms {
dm:vec4<f32>,dt:vec4<f32>,
em:vec4<f32>,et:vec4<f32>,
bm:vec4<f32>,bt:vec4<f32>,
sm:vec4<f32>,st:vec4<f32>,
am:vec4<f32>,at:vec4<f32>,
lm:vec4<f32>,lt:vec4<f32>,
om:vec4<f32>,ot:vec4<f32>,
}
fn stdTxfUV(uv:vec2<f32>,m:vec4<f32>,t:vec2<f32>)->vec2<f32>{
return vec2<f32>(dot(m.xy,uv),dot(m.zw,uv))+t;
}`,
        _vertexSlots: { VB: assignments.join("\n") },
        _pc: (composed) => {
            let fragmentWGSL = composed._fragmentWGSL;
            for (const [texture, sampler, varying] of [
                ["eT", "eS", "ve"],
                ["sT", "sS", "vs"],
                ["aT", "aS", "va"],
                ["oT", "oS", "vo"],
            ]) {
                fragmentWGSL = fragmentWGSL.replace(
                    new RegExp(`textureSample\\(${texture},\\s*${sampler},\\s*input\\.v[uv]\\)`, "g"),
                    `textureSample(${texture}, ${sampler}, input.${varying})`
                );
            }
            fragmentWGSL = fragmentWGSL
                .replace(/perturbNormal\(input\.vn,\s*input\.vp,\s*input\.vu,\s*mat\.bs\)/g, "perturbNormal(input.vn, input.vp, input.vb, mat.bs)")
                .replace(/textureSample\(lT,\s*lS,\s*(?:input\.v[uv]|vec2<f32>\(input\.v[uv]\.x,\s*1\.0\s*-\s*input\.v[uv]\.y\))\)/g, "textureSample(lT, lS, input.vl)");
            return { ...composed, _fragmentWGSL: fragmentWGSL };
        },
    };
}

export const stdUvTransformExt: StdExt = {
    _id: "0-std-uv-transform",
    _phase: "mesh",
    _feature: STD_HAS_UV_TRANSFORM,
    _meshFeatures: (_meshFeatures, material) => (material?._hasUvTx ? STD_HAS_UV_TRANSFORM : 0),
    _frag: createStdUvTransformFragment,
    _bind(material, entries, binding, _mesh, scene) {
        if (!scene) {
            throw new Error("Standard UV transform _bind requires the scene argument from the Standard bind-group builder");
        }
        const engine = scene.surface.engine;
        const data = new Float32Array(FLOATS_PER_CHANNEL * CHANNEL_COUNT);
        writeUvTransformData(data, material);
        const buffer = createUniformBuffer(engine, data);
        entries.push({ binding: binding++, resource: { buffer } });
        return binding;
    },
};

/** @internal Register after the lazy enabler import resolves. */
export function registerStdUvTransformExt(): void {
    _registerStdExt(stdUvTransformExt);
}
