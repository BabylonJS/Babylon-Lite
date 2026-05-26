/** Ground plane renderable — lazy-loaded only when a scene includes a ground.
 *  Contains the ground material, mesh buffers, texture loading, and UBO creation.
 *  Tree-shaken away from scenes that use `skipGround: true`. */

import type { Mat4 } from "../../math/types.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { Renderable } from "../../render/renderable.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { getBilinearSampler } from "../../resource/samplers.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import groundVertSrc from "../../../shaders/background.vertex.wgsl?raw";
import groundFragSrc from "../../../shaders/background.ground.fragment.wgsl?raw";
import { createMappedBuffer } from "../../resource/gpu-buffers.js";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import { WGSL_DITHER, WGSL_NO_DITHER } from "../../shader/wgsl-helpers.js";

// ── Ground-frag-only WGSL helpers (kept here so scenes that don't load the ground
//    don't pay for the image-processing helper in the shared wgsl-helpers chunk). ──

/** Image processing: exposure → Reinhard tonemap → gamma → contrast. */
const WGSL_IMAGE_PROCESSING = `
fn applyImageProcessing(result: vec4<f32>) -> vec4<f32> {
var rgb = result.rgb;
rgb *= scene.vImageInfos.x;
const tonemappingCalibration: f32 = 1.590579;
rgb = 1.0 - exp2(-tonemappingCalibration * rgb);
rgb = pow(rgb, vec3<f32>(1.0 / 2.2));
rgb = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
let highContrast = rgb * rgb * (3.0 - 2.0 * rgb);
if (scene.vImageInfos.y < 1.0) {
rgb = mix(vec3<f32>(0.5), rgb, scene.vImageInfos.y);
} else {
rgb = mix(rgb, highContrast, scene.vImageInfos.y - 1.0);
}
rgb = max(rgb, vec3<f32>(0.0));
return vec4<f32>(rgb, result.a);
}
`;

const BG_MESH_UNIFORM_SIZE = 96; // mat4x4 + primaryColor vec3 + alpha + backgroundCenter vec3 + pad

/** Build the ground renderable for a PBR environment scene. */
export async function buildGroundRenderable(
    engine: EngineContextInternal,
    groundSize: number,
    rootPosition: [number, number, number],
    primaryColor: [number, number, number],
    groundTextureUrl?: string,
    groundImagePromise?: Promise<ImageBitmap>,
    enableNoise = true
): Promise<Renderable> {
    const fragCode = SCENE_UBO_WGSL + WGSL_IMAGE_PROCESSING + (enableNoise ? WGSL_DITHER : WGSL_NO_DITHER) + groundFragSrc;
    const gndMat = createGroundMaterial(enableNoise, fragCode);

    // Ground world: rotated 90° X (XY→XZ), translated to rootPosition
    // Column-major for WGSL: ground quad in XY plane, normal +Z → world +Y
    // Offset Y by -0.01 to prevent z-fighting with scene floor geometry.
    const eps = 2.220446049250313e-16;
    const groundWorld = new Float32Array(16) as Mat4;
    groundWorld[0] = 1;
    groundWorld[5] = eps;
    groundWorld[6] = -1;
    groundWorld[9] = 1;
    groundWorld[10] = eps;
    groundWorld[12] = rootPosition[0];
    groundWorld[13] = rootPosition[1];
    groundWorld[14] = rootPosition[2];
    groundWorld[15] = 1;

    const gndBufs = createGroundBuffers(engine, groundSize);
    const gndUBO = createBgMeshUBO(engine, groundWorld, primaryColor);

    const groundTex = await loadGroundTexture(engine, groundTextureUrl, groundImagePromise);
    const groundTexView = groundTex.createView();
    const groundSamp = getBilinearSampler(engine);
    const gndBG = gndMat.createBindGroup(engine, gndUBO, groundTexView, groundSamp);

    const r: Renderable = {
        order: 200, // ground renders last (transparent)
        isTransparent: true,
        bind(eng, sig) {
            return {
                renderable: r,
                pipeline: gndMat.getPipeline(eng as EngineContextInternal, sig),
                draw(pass) {
                    pass.setBindGroup(1, gndBG);
                    pass.setVertexBuffer(0, gndBufs.posBuffer);
                    pass.setVertexBuffer(1, gndBufs.normBuffer);
                    pass.setVertexBuffer(2, gndBufs.uvBuffer);
                    pass.setIndexBuffer(gndBufs.idxBuffer, "uint16");
                    pass.drawIndexed(gndBufs.idxCount);
                    return 1;
                },
            };
        },
    };
    return r;
}

// ─── Ground Material ────────────────────────────────────────────────────────

interface GroundMaterial {
    getPipeline(engine: EngineContextInternal, sig: RenderTargetSignature): GPURenderPipeline;
    createBindGroup(engine: EngineContextInternal, meshUBO: GPUBuffer, groundTextureView: GPUTextureView, groundSampler: GPUSampler): GPUBindGroup;
}

/** Module-global pipeline cache — keyed by noise mode + full target signature (color/depth/samples/flipY).
 *  All ground renderables share this cache. */
const _gndPipelines = new Map<string, GPURenderPipeline>();
let _gndLayout: GPUBindGroupLayout | null = null;
let _gndCachedDevice: GPUDevice | null = null;

function createGroundMaterial(enableNoise: boolean, fragCode: string): GroundMaterial {
    function getLayout(engine: EngineContextInternal): GPUBindGroupLayout {
        const device = engine.device;
        if (_gndLayout && _gndCachedDevice === device) {
            return _gndLayout;
        }
        _gndLayout = device.createBindGroupLayout({
            label: "ground-material",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });
        _gndCachedDevice = device;
        return _gndLayout;
    }

    return {
        getPipeline(engine, sig) {
            const device = engine.device;
            if (_gndCachedDevice !== device) {
                _gndPipelines.clear();
                _gndLayout = null;
                _gndCachedDevice = device;
            }
            const key = `${+enableNoise}|${targetSignatureKey(sig)}`;
            const cached = _gndPipelines.get(key);
            if (cached) {
                return cached;
            }
            const vertModule = device.createShaderModule({ code: SCENE_UBO_WGSL + groundVertSrc, label: "ground-vert" });
            const fragModule = device.createShaderModule({ code: fragCode, label: "ground-frag" });

            // Matches BJS rp_8: premultiplied alpha blend, depthWrite=false
            const pipeline = device.createRenderPipeline({
                label: "ground-pipeline",
                layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), getLayout(engine)] }),
                vertex: {
                    module: vertModule,
                    entryPoint: "main",
                    buffers: [
                        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] },
                        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" as GPUVertexFormat }] },
                        { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" as GPUVertexFormat }] },
                    ],
                },
                fragment: {
                    module: fragModule,
                    entryPoint: "main",
                    targets: [
                        {
                            format: sig.colorFormat!,
                            blend: {
                                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                            },
                        },
                    ],
                },
                depthStencil: {
                    format: sig.depthStencilFormat ?? "depth24plus-stencil8",
                    depthCompare: "less-equal",
                    depthWriteEnabled: false,
                },
                multisample: { count: sig.sampleCount },
                primitive: { topology: "triangle-list", cullMode: "back", frontFace: sig.flipY ? "cw" : "ccw" },
            });
            _gndPipelines.set(key, pipeline);
            return pipeline;
        },

        createBindGroup(engine, meshUBO, groundTextureView, groundSampler) {
            const device = engine.device;
            return device.createBindGroup({
                layout: getLayout(engine),
                entries: [
                    { binding: 0, resource: { buffer: meshUBO } },
                    { binding: 1, resource: groundTextureView },
                    { binding: 2, resource: groundSampler },
                ],
            });
        },
    };
}

// ─── Ground Mesh Data ───────────────────────────────────────────────────────

/** Ground quad (4 verts, 6 indices — matches BJS CreatePlane with BACKSIDE).
 *  XY plane, normals +Z (become +Y after world rotation). */
function createGroundBuffers(
    engine: EngineContextInternal,
    groundSize: number
): {
    posBuffer: GPUBuffer;
    normBuffer: GPUBuffer;
    uvBuffer: GPUBuffer;
    idxBuffer: GPUBuffer;
    idxCount: number;
} {
    const h = groundSize / 2;
    // prettier-ignore
    const positions = new Float32Array([
    -h, -h, 0,
     h, -h, 0,
     h,  h, 0,
    -h,  h, 0,
  ]);
    // prettier-ignore
    const normals = new Float32Array([
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
  ]);
    // prettier-ignore
    const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
    // BACKSIDE winding
    // prettier-ignore
    const indices = new Uint16Array([0, 2, 1, 0, 3, 2]);

    return {
        posBuffer: createMappedBuffer(engine, positions, GPUBufferUsage.VERTEX),
        normBuffer: createMappedBuffer(engine, normals, GPUBufferUsage.VERTEX),
        uvBuffer: createMappedBuffer(engine, uvs, GPUBufferUsage.VERTEX),
        idxBuffer: createMappedBuffer(engine, indices, GPUBufferUsage.INDEX),
        idxCount: 6,
    };
}

// ─── Ground UBO ─────────────────────────────────────────────────────────────

function createBgMeshUBO(engine: EngineContextInternal, world: Mat4, primaryColor: [number, number, number]): GPUBuffer {
    const data = new Float32Array(BG_MESH_UNIFORM_SIZE / 4);
    data.set(world, 0); // offset 0: world mat4x4
    data[16] = primaryColor[0]; // offset 64: primaryColor.r
    data[17] = primaryColor[1]; // offset 68: primaryColor.g
    data[18] = primaryColor[2]; // offset 72: primaryColor.b
    data[19] = 0.9; // offset 76: alpha (BJS default groundOpacity)
    data[20] = 0;
    data[21] = 0;
    data[22] = 0; // offset 80: backgroundCenter
    return createUniformBuffer(engine, data);
}

// ─── Ground Texture ─────────────────────────────────────────────────────────

/** Load a ground diffuse texture from URL and upload to GPU.
 *  Falls back to a 1×1 white pixel if no URL provided. */
async function loadGroundTexture(engine: EngineContextInternal, url?: string, preloadedImage?: Promise<ImageBitmap>): Promise<GPUTexture> {
    const device = engine.device;
    if (!url) {
        const tex = device.createTexture({
            size: [1, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: tex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
        return tex;
    }
    // Use pre-fetched image if available (started early in loadEnvironment)
    const bmp = preloadedImage
        ? await preloadedImage
        : await fetch(url)
              .then((r) => r.blob())
              .then((b) => createImageBitmap(b, { premultiplyAlpha: "none" }));
    const tex = device.createTexture({
        size: [bmp.width, bmp.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
    bmp.close();
    return tex;
}
