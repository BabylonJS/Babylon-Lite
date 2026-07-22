/** Private IBL assembly helpers for the EXT_lights_image_based feature.
 *
 *  ⚠️  DELIBERATE DUPLICATION — user-approved exception to the max-reuse mandate.
 *
 *  The functions below are byte-for-byte copies of shared environment/HDR IBL
 *  helpers whose canonical homes are:
 *    - sampler descriptors (bilinear/trilinear)  → ../resource/samplers.ts
 *    - polynomialToPreScaledHarmonics            → ../loader-env/load-env.ts
 *    - assembleEnvironmentTextures               → ../loader-env/env-helpers.ts
 *    - generateBrdfLut                           → ../loader-hdr/hdr-ibl-pipeline.ts
 *    - resolveImage                              → ./gltf-parser.ts
 *    - registerEnvSceneUniforms (+ its writer)   → ../scene/scene-ubo-extras.ts
 *
 *  WHY the copy exists: those canonical modules are each SINGLE-consumer on
 *  master (env-helpers ← load-env, generateBrdfLut ← load-hdr, samplers ←
 *  generate-mipmaps), so rollup INLINES them into every glTF scene's main chunk.
 *  If the (lazily-imported) EXT_lights_image_based feature imported them directly
 *  it would become a SECOND consumer, forcing rollup to hoist each into a shared
 *  chunk that all 44 glTF scenes then fetch separately (~0.5–1.0 KB of chunk
 *  boilerplate per scene, ~32 KB total across the suite). By duplicating them
 *  here — reachable only from this lazy feature chunk — the 43 non-IBL glTF
 *  scenes keep their original inlined copies untouched (zero bundle delta) and
 *  the feature's cost is isolated to the single scene that uses it
 *  (EnvironmentTest / scene264), whose ceiling absorbs the ~few KB.
 *
 *  If the canonical helpers change, update these copies to match (they exist
 *  purely to keep the feature self-contained, not to diverge in behaviour).
 */

import { F32 } from "../engine/typed-arrays.js";
import { TU } from "../engine/gpu-flags.js";
import brdfLutWGSL from "../../shaders/hdr-brdf-lut.compute.wgsl?raw";
import type { EngineContext } from "../engine/engine.js";
import type { EnvironmentTextures } from "../loader-env/load-env.js";
import type { SceneContext } from "../scene/scene-core.js";

// Sampler descriptors copied from resource/samplers.ts. Created directly here
// (device.createSampler) rather than via gpu-pool.getOrCreateSampler so this
// feature does not add getOrCreateSampler to gpu-pool's retained export set in
// every glTF scene. The only cost is two extra (immutable, stateless) sampler
// objects on the single IBL load — negligible and side-effect-free.
const _bilinearDesc: GPUSamplerDescriptor = { magFilter: "linear", minFilter: "linear" };
const _trilinearDesc: GPUSamplerDescriptor = { magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" };

/** Copy of loader-env/load-env.ts `polynomialToPreScaledHarmonics`. */
function polynomialToPreScaledHarmonics(poly: Float32Array): Float32Array {
    const C00xy = 0.3333338747897695;
    const C00z = 0.33333298856284405;
    const C1 = 1.4999984284682104;
    const C2 = 3.999982863580422;
    const C20zz = 1.3333326611423701;
    const C20xy = 0.6666653397393608;
    const C22 = 1.999991431790211;

    const out = new F32(36);
    for (let i = 0; i < 3; i++) {
        const x = poly[i]!;
        const y = poly[3 + i]!;
        const z = poly[6 + i]!;
        const xx = poly[9 + i]!;
        const yy = poly[12 + i]!;
        const zz = poly[15 + i]!;
        const yz = poly[18 + i]!;
        const zx = poly[21 + i]!;
        const xy = poly[24 + i]!;
        out[i] = (xx + yy) * C00xy + zz * C00z; // L00
        out[4 + i] = y * C1; // L1_1
        out[8 + i] = z * C1; // L10
        out[12 + i] = x * C1; // L11
        out[16 + i] = xy * C2; // L2_2
        out[20 + i] = yz * C2; // L2_1
        out[24 + i] = zz * C20zz - (xx + yy) * C20xy; // L20
        out[28 + i] = zx * C2; // L21
        out[32 + i] = (xx - yy) * C22; // L22
    }
    return out;
}

/** Copy of loader-env/env-helpers.ts `assembleEnvironmentTextures`. */
export function assembleEnvironmentTextures(
    specularCube: GPUTexture,
    brdfLut: GPUTexture,
    irradianceSH: Float32Array,
    lodGenerationScale: number,
    engine: EngineContext
): EnvironmentTextures {
    return {
        specularCube,
        specularCubeView: specularCube.createView({ dimension: "cube" }),
        brdfLut,
        brdfLutView: brdfLut.createView(),
        cubeSampler: engine._device.createSampler(_trilinearDesc),
        brdfSampler: engine._device.createSampler(_bilinearDesc),
        irradianceSH,
        sphericalHarmonics: polynomialToPreScaledHarmonics(irradianceSH),
        lodGenerationScale,
    };
}

// Copy of loader-hdr/hdr-ibl-pipeline.ts `generateBrdfLut` (split-sum BRDF LUT).
let _brdfPipeline: GPUComputePipeline | null = null;
let _brdfPipelineDevice: GPUDevice | null = null;

/** Copy of loader-hdr/hdr-ibl-pipeline.ts `generateBrdfLut`. */
export function generateBrdfLut(engine: EngineContext): GPUTexture {
    const device = engine._device;
    if (!_brdfPipeline || _brdfPipelineDevice !== device) {
        _brdfPipeline = device.createComputePipeline({
            layout: "auto",
            compute: { module: device.createShaderModule({ code: brdfLutWGSL }), entryPoint: "main" },
        });
        _brdfPipelineDevice = device;
    }
    const size = 256;
    const texture = device.createTexture({
        size: { width: size, height: size },
        format: "rgba16float",
        usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
    });
    const bindGroup = device.createBindGroup({
        layout: _brdfPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(_brdfPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
    return texture;
}

/** Copy of gltf-parser.ts `resolveImage` — resolves a glTF image (GLB bufferView
 *  or external URI) to an ImageBitmap. Kept private so this feature does not pin
 *  gltf-parser's export surface into every glTF scene's main chunk. */
export async function resolveImage(json: any, binChunk: DataView, imageIdx: number, baseUrl: string): Promise<ImageBitmap> {
    const image = json.images[imageIdx];

    if (image.bufferView !== undefined) {
        const bv = json.bufferViews[image.bufferView];
        const offset = binChunk.byteOffset + (bv.byteOffset ?? 0);
        const slice = binChunk.buffer.slice(offset, offset + bv.byteLength);
        const blob = new Blob([slice as ArrayBuffer], { type: image.mimeType ?? "image/png" });
        return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    }

    if (image.uri) {
        const imageUrl = new URL(image.uri, baseUrl + "x").href;
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to load image: ${response.status} ${response.statusText}`);
        }
        const blob = await response.blob();
        return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    }

    throw new Error("Image has neither bufferView nor uri");
}

/** Copy of scene-ubo-extras.ts `writeEnvShUbo` — writes the environment
 *  spherical-harmonics slice (float offsets 40–75) of the SceneUniforms struct. */
function writeEnvShUbo(data: Float32Array, scene: SceneContext): void {
    const sh = scene._envTextures?.sphericalHarmonics;
    if (sh) {
        data.set(sh, 40);
    }
}

/** Copy of scene-ubo-extras.ts `registerEnvSceneUniforms` (+ its dedup helper) —
 *  registers the env-SH scene-UBO contributor. The render task invokes whatever
 *  contributors are on `scene._sceneUboContributors`, so a private copy of the
 *  writer is functionally identical to the shared one. Kept private so this
 *  feature does not pin scene-ubo-extras into every glTF scene's main chunk. */
export function registerEnvSceneUniforms(scene: SceneContext): void {
    const list = (scene._sceneUboContributors ??= []);
    if (!list.includes(writeEnvShUbo)) {
        list.push(writeEnvShUbo);
    }
}
