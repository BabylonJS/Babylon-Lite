import { F32 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import { targetSignatureKey } from "../engine/render-target.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Material } from "../material/material.js";
import type { MeshGroupBuildResult, MeshGroupBuilder, Renderable } from "../render/renderable.js";
import type { SceneContext } from "../scene/scene-core.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
import { SS } from "../engine/gpu-flags.js";

interface PhysicsDebugLineMaterial extends Material {
    color: [number, number, number, number];
}

const LINE_WGSL = `
struct SceneUniforms { viewProjection: mat4x4<f32>, };
struct MeshUniforms { world: mat4x4<f32>, };
struct MaterialUniforms { color: vec4<f32>, };
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
@group(1) @binding(1) var<uniform> mat: MaterialUniforms;
struct VertexOutput { @builtin(position) clipPos: vec4<f32>, };
@vertex fn vsMain(@location(0) position: vec3<f32>) -> VertexOutput {
var out: VertexOutput;
out.clipPos = scene.viewProjection * mesh.world * vec4<f32>(position, 1.0);
return out;
}
@fragment fn fsMain() -> @location(0) vec4<f32> {
return mat.color;
}`;

let _cachedDevice: GPUDevice | null = null;
let _meshBGL: GPUBindGroupLayout | null = null;
let _pipelineCache: Map<string, GPURenderPipeline> | null = null;

function ensureDevice(engine: EngineContext): void {
    if (_cachedDevice !== engine._device) {
        _cachedDevice = engine._device;
        _meshBGL = null;
        _pipelineCache = null;
    }
}

function getMeshBindGroupLayout(engine: EngineContext): GPUBindGroupLayout {
    ensureDevice(engine);
    if (!_meshBGL) {
        _meshBGL = engine._device.createBindGroupLayout({
            label: "physics-debug-line-mesh",
            entries: [
                { binding: 0, visibility: SS.VERTEX, buffer: { type: "uniform" } },
                { binding: 1, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
    }
    return _meshBGL;
}

function getPipelineCache(): Map<string, GPURenderPipeline> {
    if (!_pipelineCache) {
        _pipelineCache = new Map();
    }
    return _pipelineCache;
}

function getOrCreateLinePipeline(engine: EngineContext, sig: RenderTargetSignature): GPURenderPipeline {
    ensureDevice(engine);
    const key = targetSignatureKey(sig);
    const cache = getPipelineCache();
    const cached = cache.get(key);
    if (cached) {
        return cached;
    }
    if (!sig._colorFormat) {
        throw new Error("Physics debug lines require a color render target.");
    }

    const device = engine._device;
    const module = device.createShaderModule({ code: LINE_WGSL });
    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), getMeshBindGroupLayout(engine)] }),
        vertex: {
            module,
            entryPoint: "vsMain",
            buffers: [
                {
                    arrayStride: 12,
                    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
                },
            ],
        },
        fragment: {
            module,
            entryPoint: "fsMain",
            targets: [{ format: sig._colorFormat }],
        },
        depthStencil: sig._depthStencilFormat
            ? {
                  format: sig._depthStencilFormat,
                  depthCompare: "always",
                  depthWriteEnabled: false,
              }
            : undefined,
        multisample: { count: sig._sampleCount },
        primitive: { topology: "line-list" },
    });
    cache.set(key, pipeline);
    return pipeline;
}

function clearPhysicsDebugLinePipelineCache(): void {
    _pipelineCache = null;
    _meshBGL = null;
    _cachedDevice = null;
}

function buildLineRenderable(scene: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable {
    const engine = scene.surface.engine;
    const material = (materialOverride ?? mesh.material) as PhysicsDebugLineMaterial;
    const meshData = new F32(16);
    packMat4IntoF32(meshData, mesh.worldMatrix);
    const meshUBO = createUniformBuffer(engine, meshData);
    const materialData = new F32(4);
    materialData.set(material.color);
    const materialUBO = createUniformBuffer(engine, materialData);
    const bindGroup = engine._device.createBindGroup({
        layout: getMeshBindGroupLayout(engine),
        entries: [
            { binding: 0, resource: { buffer: meshUBO } },
            { binding: 1, resource: { buffer: materialUBO } },
        ],
    });

    let lastWorldVersion = mesh.worldMatrixVersion;
    const update = (): void => {
        if (mesh.worldMatrixVersion !== lastWorldVersion) {
            packMat4IntoF32(meshData, mesh.worldMatrix);
            engine._device.queue.writeBuffer(meshUBO, 0, meshData);
            lastWorldVersion = mesh.worldMatrixVersion;
        }
    };

    const renderable: Renderable = {
        order: mesh.renderOrder ?? 1000,
        isTransparent: false,
        _direct: true,
        mesh,
        bind(eng, sig) {
            return {
                renderable,
                pipeline: getOrCreateLinePipeline(eng as EngineContext, sig),
                update,
                draw(pass) {
                    const gpu = mesh._gpu;
                    pass.setVertexBuffer(0, gpu.positionBuffer);
                    pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
                    pass.setBindGroup(1, bindGroup);
                    pass.drawIndexed(gpu.indexCount);
                    return 1;
                },
            };
        },
    };
    renderable._worldCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!];
    return renderable;
}

export const physicsDebugLineGroupBuilder: MeshGroupBuilder = async (scene, meshes): Promise<MeshGroupBuildResult> => {
    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => buildLineRenderable(s, mesh, materialOverride);
    physicsDebugLineGroupBuilder._rebuildSingle = rebuildSingle;
    scene._disposables.push(clearPhysicsDebugLinePipelineCache);
    return {
        renderables: meshes.map((mesh) => rebuildSingle(scene, mesh)),
        rebuildSingle,
    };
};

export function createPhysicsDebugLineMaterial(color: readonly [number, number, number, number]): PhysicsDebugLineMaterial {
    return {
        _buildGroup: physicsDebugLineGroupBuilder,
        _uboVersion: 0,
        color: [color[0], color[1], color[2], color[3]],
    };
}
