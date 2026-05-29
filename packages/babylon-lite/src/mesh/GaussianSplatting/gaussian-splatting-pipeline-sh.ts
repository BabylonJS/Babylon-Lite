/** Gaussian-Splatting SH render pipeline + Renderable.
 *
 *  Variant of `gaussian-splatting-pipeline.ts` that adds view-dependent SH
 *  shading. Loaded *only* by `loadSplat` (and the SOG / SPZ loaders) via a
 *  dynamic `import(...)` when the parsed splat asset includes SH coefficients
 *  (`mesh.shDegree > 0`), so plain `.ply` / `.splat` scenes (e.g. scene 120)
 *  never pull this module's WGSL or runtime cost into their bundle.
 *
 *  WGSL source is generated per-shDegree by `buildShShaderSource`: SH textures,
 *  byte-to-vec3 unpacking, and the polynomial evaluation in
 *  `computeColorFromSHDegree` all expand to the right size — mirrors the
 *  `#if SH_DEGREE > N` blocks in BJS `gaussianSplatting.fx`. Pipeline cache is
 *  keyed by `(targetSignatureKey, shDegree)`.
 *
 *  The UBO grows by 16 bytes vs the base pipeline to carry `eyePosition`
 *  (world-space camera position; see `computeSH(dir)` below).
 *
 *  ── Why the Y-flip on the SH direction? ─────────────────────────────────
 *  BJS sets `mesh.scaling.y *= -1` to fix coordinate-system handedness; Lite
 *  pre-flips Y in `splat-data.ts` at parse time so the runtime mesh transform
 *  is identity. World-space splat positions agree across both engines, but
 *  the BJS world rotation absorbs an extra `diag(1,-1,1)` factor — i.e.
 *      worldRot_bjs = worldRot_user · diag(1,-1,1)
 *  which means
 *      inverse(worldRot_bjs) · v = diag(1,-1,1) · inverse(worldRot_user) · v
 *  so Lite reproduces the BJS SH direction by computing
 *  `inverseMat3(worldRot) · (worldPos − eye)` and then negating `.y`. */

import type { EngineContextInternal, EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { Renderable, DrawBinding } from "../../render/renderable.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import { getViewMatrix, getProjectionMatrix, getCameraPosition } from "../../camera/camera.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { getRenderTargetSize } from "../../engine/engine.js";
import { disposeGaussianSplattingMesh, type GaussianSplattingMesh, type GsShaderFragment } from "./gaussian-splatting-mesh.js";
import { applyGsFragments } from "./gaussian-splatting-pipeline.js";

interface PipelineEntry {
    pipeline: GPURenderPipeline;
    meshBindGroupLayout: GPUBindGroupLayout;
    shTextureCount: number;
}

// shDegree → number of rgba32uint SH textures: 1→1, 2→2, 3→3, 4→5.
const SH_TEXTURE_COUNT = [0, 1, 2, 3, 5];

let _cache: { device: GPUDevice; modules: Map<string, GPUShaderModule>; entries: Map<string, PipelineEntry> } | null = null;

/** Build the WGSL source for a given SH degree (1..4). Mirrors the BJS
 *  preprocessor-driven shader structure: declares only the SH textures used
 *  by the degree, emits exactly the byte-stream unpacking for that degree,
 *  and inlines only the SH polynomial terms up to that degree. */
function buildShShaderSource(shDegree: number): string {
    const shVectorCount = (shDegree + 1) * (shDegree + 1) - 1;
    const shCoefficientCount = shVectorCount * 3;
    const textureCount = Math.ceil(shCoefficientCount / 16);

    // ── SH texture bindings (6, 7, …) ───────────────────────────────
    let textureBindings = "";
    for (let i = 0; i < textureCount; i++) {
        textureBindings += `@group(1) @binding(${6 + i}) var shTexture${i}: texture_2d<u32>;\n`;
    }

    // ── textureLoad calls inside readSplat ──────────────────────────
    let textureLoads = "";
    for (let i = 0; i < textureCount; i++) {
        textureLoads += `  let sh${i}_u32 = textureLoad(shTexture${i}, splatUVi32, 0);\n`;
    }

    // ── Unpack the byte stream into sh[1..shVectorCount] vec3 values.
    //
    // Each rgba32uint texel carries 16 bytes (4 u32s × 4 bytes). The bytes
    // are stored in BJS-coefficient order: byte j of splat i is the j-th
    // component of the [R0,G0,B0, R1,G1,B1, …, R(N-1),G(N-1),B(N-1)] sequence.
    // sh[k+1] (k = 0..shVectorCount-1) reads bytes [3k, 3k+1, 3k+2]. `decompose`
    // returns `(byte * 2/255) - 1`, matching BJS exactly.
    let shUnpack = `  var sh: array<vec3<f32>, ${shVectorCount + 1}>;\n  sh[0] = vec3<f32>(0.0);\n`;
    const byteRef = (j: number): string => {
        // texture index, u32 index within texel (0..3), byte index within u32 (0..3 == x/y/z/w).
        const tex = (j / 16) | 0;
        const u32Idx = ((j % 16) / 4) | 0;
        const byteIdx = j % 4;
        const u32Field = ["x", "y", "z", "w"][u32Idx]!;
        const byteField = ["x", "y", "z", "w"][byteIdx]!;
        return `decompose(sh${tex}_u32.${u32Field}).${byteField}`;
    };
    for (let k = 0; k < shVectorCount; k++) {
        const j = k * 3;
        shUnpack += `  sh[${k + 1}] = vec3<f32>(${byteRef(j)}, ${byteRef(j + 1)}, ${byteRef(j + 2)});\n`;
    }

    // ── Polynomial evaluation, conditional on shDegree ──────────────
    let shPoly = "  result = sh[0];\n";
    if (shDegree >= 1) {
        shPoly += `  result += -SH_C1 * y * sh[1] + SH_C1 * z * sh[2] - SH_C1 * x * sh[3];\n`;
    }
    if (shDegree >= 2) {
        shPoly += `  result +=\n    SH_C2[0] * xy * sh[4] +\n    SH_C2[1] * yz * sh[5] +\n    SH_C2[2] * (2.0 * zz - xx - yy) * sh[6] +\n    SH_C2[3] * xz * sh[7] +\n    SH_C2[4] * (xx - yy) * sh[8];\n`;
    }
    if (shDegree >= 3) {
        shPoly += `  result +=\n    SH_C3[0] * y * (3.0 * xx - yy) * sh[9] +\n    SH_C3[1] * xy * z * sh[10] +\n    SH_C3[2] * y * (4.0 * zz - xx - yy) * sh[11] +\n    SH_C3[3] * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * sh[12] +\n    SH_C3[4] * x * (4.0 * zz - xx - yy) * sh[13] +\n    SH_C3[5] * z * (xx - yy) * sh[14] +\n    SH_C3[6] * x * (xx - 3.0 * yy) * sh[15];\n`;
    }
    if (shDegree >= 4) {
        shPoly += `  result +=\n    SH_C4[0] * x * y * (xx - yy) * sh[16] +\n    SH_C4[1] * y * z * (3.0 * xx - yy) * sh[17] +\n    SH_C4[2] * x * y * (7.0 * zz - 1.0) * sh[18] +\n    SH_C4[3] * y * z * (7.0 * zz - 3.0) * sh[19] +\n    SH_C4[4] * (zz * (35.0 * zz - 30.0) + 3.0) * sh[20] +\n    SH_C4[5] * x * z * (7.0 * zz - 3.0) * sh[21] +\n    SH_C4[6] * (xx - yy) * (7.0 * zz - 1.0) * sh[22] +\n    SH_C4[7] * x * z * (xx - 3.0 * yy) * sh[23] +\n    SH_C4[8] * (xx * (xx - 3.0 * yy) - yy * (3.0 * xx - yy)) * sh[24];\n`;
    }

    // SH_C2..SH_C4 constants — only declare what's referenced (silences
    // WGSL "unused array" warnings on lower degrees).
    let constantsBlock = `const SH_C1: f32 = 0.48860251;\n`;
    if (shDegree >= 2) {
        constantsBlock += `const SH_C2: array<f32, 5> = array<f32, 5>(1.092548430, -1.09254843, 0.315391565, -1.09254843, 0.546274215);\n`;
    }
    if (shDegree >= 3) {
        constantsBlock += `const SH_C3: array<f32, 7> = array<f32, 7>(-0.59004358, 2.890611442, -0.45704579, 0.373176332, -0.45704579, 1.445305721, -0.59004358);\n`;
    }
    if (shDegree >= 4) {
        constantsBlock += `const SH_C4: array<f32, 9> = array<f32, 9>(2.5033429418, -1.7701307698, 0.9461746958, -0.6690465436, 0.1057855469, -0.6690465436, 0.4730873479, -1.7701307698, 0.6258357354);\n`;
    }

    return `// Gaussian Splatting — vertex + fragment WGSL (SH degree ${shDegree}).
// Generated by buildShShaderSource. Mirrors BJS gaussianSplatting.vertex.fx +
// gaussianSplatting.fx (SH_DEGREE = ${shDegree}, no compound parts).
struct U {
  world: mat4x4<f32>,
  view: mat4x4<f32>,
  projection: mat4x4<f32>,
  viewport: vec2<f32>,
  focal: vec2<f32>,
  dataSize: vec2<f32>,
  alpha: f32,
  _pad0: f32,
  eyePosition: vec3<f32>,
  _pad1: f32,
};
@group(1) @binding(0) var<uniform> u: U;
@group(1) @binding(1) var samp: sampler;
@group(1) @binding(2) var centersTex: texture_2d<f32>;
@group(1) @binding(3) var covATex: texture_2d<f32>;
@group(1) @binding(4) var covBTex: texture_2d<f32>;
@group(1) @binding(5) var colorsTex: texture_2d<f32>;
${textureBindings}

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) vColor: vec4<f32>,
  @location(1) vPos: vec2<f32>,
};

${constantsBlock}

fn dataUv(idx: f32) -> vec2<f32> {
  let y = floor(idx / u.dataSize.x);
  let x = idx - y * u.dataSize.x;
  return vec2<f32>((x + 0.5) / u.dataSize.x, (y + 0.5) / u.dataSize.y);
}

fn dataUvI(idx: f32) -> vec2<i32> {
  let y = floor(idx / u.dataSize.x);
  let x = idx - y * u.dataSize.x;
  return vec2<i32>(i32(x), i32(y));
}

// Unpack a u32 of 4 packed bytes into (b0 b1 b2 b3) * 2/255 - 1.
fn decompose(value: u32) -> vec4<f32> {
  let v = vec4<f32>(
    f32((value >> 0u) & 255u),
    f32((value >> 8u) & 255u),
    f32((value >> 16u) & 255u),
    f32((value >> 24u) & 255u));
  return v * vec4<f32>(2.0 / 255.0) - vec4<f32>(1.0);
}

fn inverseMat3(m: mat3x3<f32>) -> mat3x3<f32> {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2];
  let b01 = a22 * a11 - a12 * a21;
  let b11 = -a22 * a10 + a12 * a20;
  let b21 = a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21;
  return mat3x3<f32>(
    vec3<f32>(b01 / det, (-a22 * a01 + a02 * a21) / det, (a12 * a01 - a02 * a11) / det),
    vec3<f32>(b11 / det, (a22 * a00 - a02 * a20) / det, (-a12 * a00 + a02 * a10) / det),
    vec3<f32>(b21 / det, (-a21 * a00 + a01 * a20) / det, (a11 * a00 - a01 * a10) / det));
}

fn computeSH(dir: vec3<f32>, splatUVi32: vec2<i32>) -> vec3<f32> {
${textureLoads}${shUnpack}  let x = dir.x;
  let y = dir.y;
  let z = dir.z;
  let xx = x * x; let yy = y * y; let zz = z * z;
  let xy = x * y; let yz = y * z; let xz = x * z;
  var result: vec3<f32>;
${shPoly}  return result;
}

@vertex
fn vs(@location(0) corner: vec2<f32>, @location(1) splatIndex: f32) -> VOut {
  var out: VOut;
  let uv = dataUv(splatIndex);
  let splatUVi32 = dataUvI(splatIndex);
  let center = textureSampleLevel(centersTex, samp, uv, 0.0).xyz;
  let color  = textureSampleLevel(colorsTex,  samp, uv, 0.0);
  let covA   = textureSampleLevel(covATex,    samp, uv, 0.0).xyz;
  let covB   = textureSampleLevel(covBTex,    samp, uv, 0.0).xyz;

  let worldPos  = u.world * vec4<f32>(center, 1.0);
  let modelView = u.view  * u.world;
  let camspace  = u.view  * worldPos;
  let pos2d     = u.projection * camspace;

  let bounds = 1.2 * pos2d.w;
  if (pos2d.z < 0.0
      || pos2d.x < -bounds || pos2d.x > bounds
      || pos2d.y < -bounds || pos2d.y > bounds) {
    out.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    out.vColor = vec4<f32>(0.0);
    out.vPos = vec2<f32>(0.0);
    return out;
  }

  // ── View-dependent SH evaluation ───────────────────────────────────
  let worldRot = mat3x3<f32>(u.world[0].xyz, u.world[1].xyz, u.world[2].xyz);
  let normWorldRot = inverseMat3(worldRot);
  var dir = normalize(normWorldRot * (worldPos.xyz - u.eyePosition));
  // Lite-side Y-flip: compensates for our data-path Y pre-flip vs BJS's
  // mesh.scaling.y *= -1 (see file header for derivation).
  dir.y = -dir.y;
  let shColor = computeSH(dir, splatUVi32);

  let Vrk = mat3x3<f32>(
    vec3<f32>(covA.x, covA.y, covA.z),
    vec3<f32>(covA.y, covB.x, covB.y),
    vec3<f32>(covA.z, covB.y, covB.z));

  let invZ  = 1.0 / camspace.z;
  let invZ2 = invZ * invZ;
  let J = mat3x3<f32>(
    vec3<f32>(u.focal.x * invZ, 0.0, -u.focal.x * camspace.x * invZ2),
    vec3<f32>(0.0, u.focal.y * invZ, -u.focal.y * camspace.y * invZ2),
    vec3<f32>(0.0, 0.0, 0.0));

  let mv3 = mat3x3<f32>(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz);
  let T = transpose(mv3) * J;
  var cov2d = transpose(T) * Vrk * T;

  let kernelSize: f32 = 0.3;
  cov2d[0][0] += kernelSize;
  cov2d[1][1] += kernelSize;

  let mid = (cov2d[0][0] + cov2d[1][1]) * 0.5;
  let dxy = (cov2d[0][0] - cov2d[1][1]) * 0.5;
  let radius = length(vec2<f32>(dxy, cov2d[0][1]));
  let epsilon: f32 = 0.0001;
  let lambda1 = mid + radius + epsilon;
  let lambda2 = mid - radius + epsilon;
  if (lambda2 < 0.0) {
    out.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    out.vColor = vec4<f32>(0.0);
    out.vPos = vec2<f32>(0.0);
    return out;
  }

  let diag = normalize(vec2<f32>(cov2d[0][1], lambda1 - cov2d[0][0]));
  let majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * diag;
  let minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2<f32>(diag.y, -diag.x);

  let vCenter = pos2d.xy;
  out.pos = vec4<f32>(
    vCenter + (corner.x * majorAxis + corner.y * minorAxis) * pos2d.w / u.viewport,
    pos2d.z, pos2d.w);
  out.vColor = vec4<f32>(color.rgb + shColor, color.a * u.alpha);
  out.vPos = corner;
  return out;
}

/*GS_FRAGMENT_DEFINITIONS*/
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  /*GS_FRAGMENT_MAIN_BEGIN*/
  let A = -dot(in.vPos, in.vPos);
  if (A < -4.0) { discard; }
  let B = exp(A) * in.vColor.a;
  var finalColor = vec4<f32>(in.vColor.rgb, B);
  /*GS_FRAGMENT_BEFORE_FRAGCOLOR*/
  /*GS_FRAGMENT_MAIN_END*/
  return finalColor;
}
`;
}

function getOrCreateShPipeline(engine: EngineContextInternal, sig: RenderTargetSignature, shDegree: number, fragments?: readonly GsShaderFragment[]): PipelineEntry {
    const device = engine.device;
    if (!_cache || _cache.device !== device) {
        _cache = { device, modules: new Map(), entries: new Map() };
    }
    const fragKey = fragments && fragments.length > 0 ? "|" + fragments.map((f) => f.id).join(",") : "";
    let module = _cache.modules.get(shDegree + fragKey);
    if (!module) {
        module = device.createShaderModule({
            code: fragments && fragments.length > 0 ? applyGsFragments(buildShShaderSource(shDegree), fragments) : buildShShaderSource(shDegree),
        });
        _cache.modules.set(shDegree + fragKey, module);
    }
    const key = `${targetSignatureKey(sig)}|sh${shDegree}${fragKey}`;
    let entry = _cache.entries.get(key);
    if (entry) {
        return entry;
    }
    const shTextureCount = SH_TEXTURE_COUNT[shDegree]!;
    const layoutEntries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, sampler: { type: "non-filtering" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
        { binding: 4, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
        { binding: 5, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
    ];
    for (let i = 0; i < shTextureCount; i++) {
        layoutEntries.push({ binding: 6 + i, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } });
    }
    const meshBindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries });
    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), meshBindGroupLayout] }),
        vertex: {
            module,
            entryPoint: "vs",
            buffers: [
                { arrayStride: 8, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
                { arrayStride: 4, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }] },
            ],
        },
        fragment: {
            module,
            entryPoint: "fs",
            targets: [
                {
                    format: sig._colorFormat!,
                    blend: {
                        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                    },
                    writeMask: GPUColorWrite.ALL,
                },
            ],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
            format: sig._depthStencilFormat ?? "depth24plus-stencil8",
            depthCompare: sig._depthCompare ?? "greater-equal",
            depthWriteEnabled: false,
        },
        multisample: { count: sig._sampleCount },
    });
    entry = { pipeline, meshBindGroupLayout, shTextureCount };
    _cache.entries.set(key, entry);
    return entry;
}

/** Build the Renderable for a GaussianSplattingMesh with SH coefficients.
 *  Mirrors `buildGaussianSplattingRenderable` but adds eyePosition to the UBO
 *  and binds the SH textures. */
export function buildGaussianSplattingRenderableSH(scene: SceneContext, mesh: GaussianSplattingMesh, fragments?: readonly GsShaderFragment[]): Renderable {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;

    // 3 mat4 + 8 floats (viewport,focal,dataSize,alpha,pad) + 4 floats (eyePosition + pad) = 240 bytes.
    const UBO_BYTES = 16 * 4 * 3 + 8 * 4 + 4 * 4;
    const ubo = device.createBuffer({
        size: UBO_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const cpu = new Float32Array(UBO_BYTES / 4);

    cpu[48 + 4] = mesh.textureWidth;
    cpu[48 + 5] = mesh.textureHeight;
    cpu[48 + 6] = 1; // alpha
    cpu[48 + 7] = 0; // pad

    const bindGroups = new Map<GPURenderPipeline, GPUBindGroup>();

    const getBindGroup = (entry: PipelineEntry): GPUBindGroup => {
        let bg = bindGroups.get(entry.pipeline);
        if (bg) {
            return bg;
        }
        const shViews = mesh._gs._shViews ?? [];
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: ubo } },
            { binding: 1, resource: mesh._gs._sampler },
            { binding: 2, resource: mesh._gs._centersView },
            { binding: 3, resource: mesh._gs._covAView },
            { binding: 4, resource: mesh._gs._covBView },
            { binding: 5, resource: mesh._gs._colorsView },
        ];
        for (let i = 0; i < entry.shTextureCount; i++) {
            entries.push({ binding: 6 + i, resource: shViews[i]! });
        }
        bg = device.createBindGroup({ layout: entry.meshBindGroupLayout, entries });
        bindGroups.set(entry.pipeline, bg);
        return bg;
    };

    const SORT_EPS = 1e-4;

    const update = (): void => {
        const cam = scene.camera;
        if (!cam) {
            return;
        }
        const size = getRenderTargetSize(engine);
        const aspect = size.width / size.height;
        const view = getViewMatrix(cam) as unknown as Float32Array;
        const proj = getProjectionMatrix(cam, aspect) as unknown as Float32Array;
        const world = mesh.worldMatrix as unknown as Float32Array;
        const camPos = getCameraPosition(cam);

        cpu.set(world, 0);
        cpu.set(view, 16);
        cpu.set(proj, 32);
        cpu[48] = size.width;
        cpu[48 + 1] = size.height;
        cpu[48 + 2] = size.width * 0.5 * proj[0]!;
        cpu[48 + 3] = size.height * 0.5 * proj[5]!;
        cpu[56] = camPos.x;
        cpu[57] = camPos.y;
        cpu[58] = camPos.z;
        cpu[59] = 0;
        device.queue.writeBuffer(ubo, 0, cpu.buffer, 0, UBO_BYTES);

        if (!mesh._canPostToWorker) {
            return;
        }

        const cf0 = view[2]!,
            cf1 = view[6]!,
            cf2 = view[10]!;

        let dirty = false;
        const lastW = mesh._sortWorldMatrix;
        for (let i = 0; i < 16; i++) {
            if (Math.abs(lastW[i]! - world[i]!) > SORT_EPS) {
                dirty = true;
                break;
            }
        }
        if (!dirty) {
            const lastCf = mesh._sortCameraForward;
            if (Math.abs(lastCf[0]! - cf0) > SORT_EPS || Math.abs(lastCf[1]! - cf1) > SORT_EPS || Math.abs(lastCf[2]! - cf2) > SORT_EPS) {
                dirty = true;
            }
        }
        if (!dirty) {
            const lastCp = mesh._sortCameraPosition;
            if (Math.abs(lastCp[0]! - camPos.x) > SORT_EPS || Math.abs(lastCp[1]! - camPos.y) > SORT_EPS || Math.abs(lastCp[2]! - camPos.z) > SORT_EPS) {
                dirty = true;
            }
        }
        if (!dirty) {
            return;
        }

        mesh._sortWorldMatrix.set(world);
        mesh._sortCameraForward[0] = cf0;
        mesh._sortCameraForward[1] = cf1;
        mesh._sortCameraForward[2] = cf2;
        mesh._sortCameraPosition[0] = camPos.x;
        mesh._sortCameraPosition[1] = camPos.y;
        mesh._sortCameraPosition[2] = camPos.z;
        mesh._canPostToWorker = false;
        mesh._worker.postMessage(
            {
                m: new Float32Array(world),
                f: new Float32Array([cf0, cf1, cf2]),
                c: new Float32Array([camPos.x, camPos.y, camPos.z]),
                d: mesh._depthMix,
            },
            [mesh._depthMix.buffer]
        );
    };

    const r: Renderable = {
        order: 200,
        isTransparent: true,
        bind(eng: EngineContext, sig: RenderTargetSignature): DrawBinding {
            const entry = getOrCreateShPipeline(eng as EngineContextInternal, sig, mesh.shDegree, fragments);
            const bindGroup = getBindGroup(entry);
            return {
                renderable: r,
                pipeline: entry.pipeline,
                update,
                draw(pass) {
                    pass.setBindGroup(1, bindGroup);
                    pass.setVertexBuffer(0, mesh._gs._quadBuffer);
                    pass.setVertexBuffer(1, mesh._gs._splatIndexBuffer);
                    pass.setIndexBuffer(mesh._gs._indexBuffer, "uint16");
                    pass.drawIndexed(6, mesh.vertexCount);
                    return 1;
                },
            };
        },
    };
    return r;
}

/** SH-aware variant of `attachGaussianSplattingMesh`. Dynamic-imported by
 *  `attachParsedSplat` (in `load-splat.ts`) when the parsed asset carries SH
 *  coefficients. Reads `mesh.shDegree` (set at mesh construction), creates
 *  the `rgba32uint` SH textures (1..5 depending on degree), patches
 *  `mesh._gs` in place, and installs the SH renderable. */
export function attachGaussianSplattingMeshSH(scene: SceneContext, mesh: GaussianSplattingMesh, shFlat: Uint8Array, fragments?: readonly GsShaderFragment[]): void {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
    const shDegree = mesh.shDegree;
    const shVectorCount = (shDegree + 1) * (shDegree + 1) - 1;
    const shCoefficientCount = shVectorCount * 3;
    const textureCount = Math.ceil(shCoefficientCount / 16);
    const width = mesh.textureWidth;
    const height = mesh.textureHeight;

    // Pack the flat SH byte stream into N textures of 16 bytes per splat each.
    // splat i's bytes [i*shCC .. i*shCC + shCC] are split across textures
    // [t=0..textureCount-1], each carrying up to 16 bytes at offset i*16.
    const textures: GPUTexture[] = [];
    const views: GPUTextureView[] = [];
    const vertexCount = mesh.vertexCount;
    for (let t = 0; t < textureCount; t++) {
        const dst = new Uint8Array(width * height * 16);
        const tBase = t * 16;
        const bytesThisTex = Math.min(16, shCoefficientCount - tBase);
        for (let i = 0; i < vertexCount; i++) {
            const srcOff = i * shCoefficientCount + tBase;
            const dstOff = i * 16;
            for (let b = 0; b < bytesThisTex; b++) {
                dst[dstOff + b] = shFlat[srcOff + b]!;
            }
        }
        const tex = device.createTexture({
            size: [width, height],
            format: "rgba32uint",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: tex }, dst.buffer, { bytesPerRow: width * 16 }, { width, height });
        textures.push(tex);
        views.push(tex.createView());
    }
    mesh._gs._shTextures = textures;
    mesh._gs._shViews = views;

    const ctx = scene as unknown as { _renderables: Renderable[]; _disposables: (() => void)[]; _gsMeshes: GaussianSplattingMesh[] };
    ctx._renderables.push(buildGaussianSplattingRenderableSH(scene, mesh, fragments));
    ctx._gsMeshes.push(mesh);
    ctx._disposables.push(() => {
        const i = ctx._gsMeshes.indexOf(mesh);
        if (i >= 0) {
            ctx._gsMeshes.splice(i, 1);
        }
        disposeGaussianSplattingMesh(mesh);
    });
}
