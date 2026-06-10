/**
 * VAT (Vertex Animation Texture) Fragment
 *
 * Vertex-stage skinning whose bone matrices come from a BAKED texture instead of the live per-frame
 * bone texture: the skeletal animation was pre-evaluated and stacked one frame per texture ROW
 * (vat/vat-baker.ts). Each vertex still uses its `joints`/`weights` attributes, but the bone matrix is
 * read from row = the current animation frame, so the whole skeleton update is gone from the CPU and the
 * mesh becomes GPU thin-instanceable (each instance can sit at its own frame).
 *
 * Same texture layout as the live skeleton (rgba32float, 4 texels per bone, one mat4 column each — see
 * skeleton/create-skeleton.ts), just with `height = frameCount` rows. Strictly opt-in behind MSH_VAT;
 * a scene with no VAT mesh never imports this module (dynamic-import gated by `hasSomeVat`).
 */

import type { ShaderFragment, VertexAttribute } from "../../../shader/fragment-types.js";

// WebGPU shader stage constants
const STAGE_VERTEX = 0x1;

// `vat.params` = (fromRow, toRow, frameOffset, fps); `vat.clock.x` = elapsed seconds. The current row is
// fromRow + ((frameOffset + clock*fps) wrapped into [0, toRow-fromRow+1)). readMatrixFromVat reads bone
// `index`'s 4 column-texels from that row.
const VAT_HELPERS = `struct vatUniforms {
params: vec4<f32>,
clock: vec4<f32>,
}
fn readMatrixFromVat(smp: texture_2d<f32>, index: f32, row: i32) -> mat4x4<f32> {
let o = i32(index) * 4;
let m0 = textureLoad(smp, vec2<i32>(o + 0, row), 0);
let m1 = textureLoad(smp, vec2<i32>(o + 1, row), 0);
let m2 = textureLoad(smp, vec2<i32>(o + 2, row), 0);
let m3 = textureLoad(smp, vec2<i32>(o + 3, row), 0);
return mat4x4f(m0, m1, m2, m3);
}
fn vatFrameRow(p: vec4<f32>, t: f32) -> i32 {
let span = max(1.0, p.y - p.x + 1.0);
let raw = p.z + t * p.w;
let wrapped = raw - floor(raw / span) * span;
return i32(p.x + wrapped);
}`;

/** WGSL summing the 4- (or 8-) bone skin matrix for one frame `row` into a new matrix var `dest`. */
function vatSkinSum(dest: string, row: string, has8Bones: boolean): string {
    let s = `var ${dest}: mat4x4<f32> = readMatrixFromVat(vatSampler, f32(joints[0]), ${row}) * weights[0];
${dest} = ${dest} + readMatrixFromVat(vatSampler, f32(joints[1]), ${row}) * weights[1];
${dest} = ${dest} + readMatrixFromVat(vatSampler, f32(joints[2]), ${row}) * weights[2];
${dest} = ${dest} + readMatrixFromVat(vatSampler, f32(joints[3]), ${row}) * weights[3];`;
    if (has8Bones) {
        s += `
${dest} = ${dest} + readMatrixFromVat(vatSampler, f32(joints1[0]), ${row}) * weights1[0];
${dest} = ${dest} + readMatrixFromVat(vatSampler, f32(joints1[1]), ${row}) * weights1[1];
${dest} = ${dest} + readMatrixFromVat(vatSampler, f32(joints1[2]), ${row}) * weights1[2];
${dest} = ${dest} + readMatrixFromVat(vatSampler, f32(joints1[3]), ${row}) * weights1[3];`;
    }
    return s;
}

// Place the fully-posed prototype (mesh.world * skin) into the world by the per-instance matrix
// (world0-3) applied OUTERMOST, so grid/herd offsets are world-space and not scaled by the prototype's
// own transform.
const VAT_INSTANCE_PLACEMENT = `let vatInstWorld = mat4x4<f32>(world0, world1, world2, world3);
finalWorld = vatInstWorld * mesh.world * influence;`;

function makeVatSkinningCode(has8Bones: boolean, instanced: boolean): string {
    if (!instanced) {
        // Non-instanced: shared settings UBO, single clip (Stage 1).
        return `let vatRow = vatFrameRow(vat.params, vat.clock.x);
${vatSkinSum("influence", "vatRow", has8Bones)}
finalWorld = mesh.world * influence;`;
    }
    // Per-instance: ALWAYS the dual-clip path — two texels per instance: A=(fromRow,toRow,offset,fps),
    // B=(fromRow,toRow,blend,fps) sharing A's offset. Linearly blend the two clips' skin matrices by B.z,
    // reproducing a weighted gait cross-fade. A single-clip instance just sets B==A with blend=0, so this
    // ONE variant covers both — no extra mesh-feature bit, so mesh-features.ts (a shared chunk) stays
    // byte-identical for non-VAT scenes. The 2x bone reads are negligible vs the one-draw-call win.
    return `let vatIdx = i32(vatInstanceIndex) * 2;
let vatA = textureLoad(vatInstanceTex, vec2<i32>(vatIdx, 0), 0);
let vatB = textureLoad(vatInstanceTex, vec2<i32>(vatIdx + 1, 0), 0);
let vatRowA = vatFrameRow(vatA, vat.clock.x);
let vatRowB = vatFrameRow(vec4<f32>(vatB.x, vatB.y, vatA.z, vatB.w), vat.clock.x);
${vatSkinSum("vatInfA", "vatRowA", has8Bones)}
${vatSkinSum("vatInfB", "vatRowB", has8Bones)}
let vatBlend = vatB.z;
var influence: mat4x4<f32> = vatInfA * (1.0 - vatBlend) + vatInfB * vatBlend;
${VAT_INSTANCE_PLACEMENT}`;
}

/**
 * Create a VAT fragment.
 * @param has8Bones - Whether to use 8-bone skinning (joints1/weights1).
 * @param instanced - Whether the mesh is thin-instanced; if so each instance reads its own frame(s) from
 *                    instanceTexture by instance_index (always the dual-clip path, single-clip = blend 0).
 */
export function createVatFragment(has8Bones: boolean, instanced: boolean): ShaderFragment {
    return {
        _id: "vat",

        // Instanced VAT places the skinned mesh by world0-3 (declared by the thin-instance fragment), so it
        // must compose AFTER thin-instance in the shared VW slot — otherwise thin-instance's finalWorld write
        // would clobber the skinned+instanced transform.
        _dependencies: instanced ? ["thin-instance"] : undefined,

        _vertexAttributes: [
            { _name: "joints", _type: "vec4<u32>", _gpuFormat: "uint32x4" as GPUVertexFormat, _arrayStride: 16 },
            { _name: "weights", _type: "vec4<f32>", _gpuFormat: "float32x4" as GPUVertexFormat, _arrayStride: 16 },
            ...(has8Bones
                ? [
                      { _name: "joints1", _type: "vec4<u32>", _gpuFormat: "uint32x4" as GPUVertexFormat, _arrayStride: 16 },
                      { _name: "weights1", _type: "vec4<f32>", _gpuFormat: "float32x4" as GPUVertexFormat, _arrayStride: 16 },
                  ]
                : []),
        ] as VertexAttribute[],

        _vertexBindings: [
            { _name: "vatSampler", _type: { _kind: "texture", _textureType: "texture_2d<f32>" as const, _sampleType: "unfilterable-float" as const }, _visibility: STAGE_VERTEX },
            { _name: "vat", _type: { _kind: "uniform-buffer" as const }, _visibility: STAGE_VERTEX },
            ...(instanced
                ? [
                      {
                          _name: "vatInstanceTex",
                          _type: { _kind: "texture" as const, _textureType: "texture_2d<f32>" as const, _sampleType: "unfilterable-float" as const },
                          _visibility: STAGE_VERTEX,
                      },
                  ]
                : []),
        ],

        _vertexBuiltins: instanced ? [{ _name: "vatInstanceIndex", _builtin: "instance_index", _type: "u32" }] : undefined,

        _vertexHelperFunctions: VAT_HELPERS,

        _vertexSlots: {
            VW: makeVatSkinningCode(has8Bones, instanced),
        },
    };
}

import type { PbrExt } from "../pbr-flags.js";
import { MSH_VAT, MSH_HAS_SKELETON_8, MSH_HAS_THIN_INSTANCES } from "../../mesh-features.js";

export const pbrExt: PbrExt = {
    id: "vat",
    phase: "vertex",
    frag(ctx) {
        if (!(ctx._meshFeatures & MSH_VAT)) {
            return null;
        }
        // "Instanced" needs no dedicated mesh-feature bit: a VAT mesh that is thin-instanced takes the
        // per-instance path. Deriving it from the existing MSH_HAS_THIN_INSTANCES keeps mesh-features.ts
        // (a shared chunk fetched by every scene) byte-identical for non-VAT scenes — zero bundle movement.
        return createVatFragment((ctx._meshFeatures & MSH_HAS_SKELETON_8) !== 0, (ctx._meshFeatures & MSH_HAS_THIN_INSTANCES) !== 0);
    },
    bind(ctx, entries, b) {
        const mesh = ctx._mesh as { vat?: { texture: GPUTexture; settingsBuffer: GPUBuffer; instanceTexture?: GPUTexture | null } } | undefined;
        if (!(ctx._meshFeatures & MSH_VAT) || !mesh?.vat) {
            return b;
        }
        entries.push({ binding: b++, resource: mesh.vat.texture.createView() });
        entries.push({ binding: b++, resource: { buffer: mesh.vat.settingsBuffer } });
        if (ctx._meshFeatures & MSH_HAS_THIN_INSTANCES && mesh.vat.instanceTexture) {
            // Same declaration order as _vertexBindings above (vatSampler, vat, vatInstanceTex).
            entries.push({ binding: b++, resource: mesh.vat.instanceTexture.createView() });
        }
        return b;
    },
};
