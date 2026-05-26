/**
 * Exponential Shadow Map (ESM) generator resource setup.
 *
 * This module creates the directional shadow resources and owns the internal
 * task hooks used by frame-graph/shadow-task.ts.
 */

import type { Camera } from "../camera/camera.js";
import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { DirectionalLight } from "../light/directional-light.js";
import type { Material, MaterialView } from "../material/material.js";
import type { Mesh } from "../mesh/mesh.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import { getBilinearSampler } from "../resource/samplers.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import { createRenderTask, type RenderTask } from "../frame-graph/render-task.js";
import {
    buildLightViewMatrix,
    casterVersionSum,
    createSharedShadowUBO,
    createShadowCamera,
    createShadowParamsUBO,
    createShadowRenderTarget,
    multiply4x4,
    updateShadowCameraBase,
    writeShadowUboFields,
} from "./shadow-base.js";
import type { ShadowGenerator, ShadowTaskInternalState } from "./shadow-generator.js";
import blurVertSrc from "../../shaders/shadow-blur.vertex.wgsl?raw";

export interface EsmLightMatrix {
    _view: Float32Array;
    _viewProj: Float32Array;
    _near: number;
    _far: number;
}

export interface EsmShadowTaskResources {
    _esmTexture: GPUTexture;
    _depthBuffer: GPUTexture;
    _blurTexH: GPUTexture;
    _blurPipeline: GPURenderPipeline;
    _blurHBG: GPUBindGroup;
    _blurVBG: GPUBindGroup;
    _shadowUboData: Float32Array;
}

export interface EsmDirectionalShadowGeneratorConfig {
    mapSize?: number;
    depthScale?: number;
    bias?: number;
    /** Kernel blur sample region in pixels. Matches Babylon.js ShadowGenerator.blurKernel. Default 1. */
    blurKernel?: number;
    blurScale?: number;
    darkness?: number;
    frustumEdgeFalloff?: number;
    /** Ortho projection min Z — typically camera.nearPlane. Default 1. */
    orthoMinZ?: number;
    /** Ortho projection max Z — typically camera.farPlane. Default 10000. */
    orthoMaxZ?: number;
    /** Force the shadow map to be regenerated every frame. Default false. */
    forceRefreshEveryFrame?: boolean;
}

interface EsmTaskState extends ShadowTaskInternalState {
    _task: RenderTask;
    _camera: Camera;
    _cameraVersion: number;
    _lastCasterVersion: number;
    _lastLightVersion: number;
    _casterMeshes: readonly Mesh[];
}

type StandardEsmFactory = typeof import("../material/standard/esm-shadow-view.js").createStandardEsmShadowMaterialView;
type PbrEsmFactory = typeof import("../material/pbr/esm-shadow-view.js").createPbrEsmShadowMaterialView;
type NodeEsmFactory = typeof import("../material/node/esm-shadow-view.js").createNodeEsmShadowMaterialView;

let esmShadowTaskResources: WeakMap<ShadowGenerator, EsmShadowTaskResources> | null = null;
let createStandardEsmShadowMaterialView: StandardEsmFactory;
let createPbrEsmShadowMaterialView: PbrEsmFactory;
let createNodeEsmShadowMaterialView: NodeEsmFactory;

function getEsmShadowTaskResourceMap(): WeakMap<ShadowGenerator, EsmShadowTaskResources> {
    esmShadowTaskResources ??= new WeakMap<ShadowGenerator, EsmShadowTaskResources>();
    return esmShadowTaskResources;
}

function setEsmShadowTaskResources(sg: ShadowGenerator, resources: EsmShadowTaskResources): void {
    getEsmShadowTaskResourceMap().set(sg, resources);
}

function getEsmShadowTaskResources(sg: ShadowGenerator): EsmShadowTaskResources | null {
    return esmShadowTaskResources?.get(sg) ?? null;
}

async function preloadEsmShadowTaskState(casterMeshes: readonly Mesh[]): Promise<void> {
    const loads: Promise<void>[] = [];
    let needsStandard = false;
    let needsPbr = false;
    let needsNode = false;
    for (const mesh of casterMeshes) {
        const family = mesh.material?._buildGroup._materialFamily;
        needsStandard ||= family === "standard";
        needsPbr ||= family === "pbr";
        needsNode ||= family === "node";
    }
    if (needsStandard && !createStandardEsmShadowMaterialView) {
        loads.push(
            import("../material/standard/esm-shadow-view.js").then((module) => {
                createStandardEsmShadowMaterialView = module.createStandardEsmShadowMaterialView;
            })
        );
    }
    if (needsPbr && !createPbrEsmShadowMaterialView) {
        loads.push(
            import("../material/pbr/esm-shadow-view.js").then((module) => {
                createPbrEsmShadowMaterialView = module.createPbrEsmShadowMaterialView;
            })
        );
    }
    if (needsNode && !createNodeEsmShadowMaterialView) {
        loads.push(
            import("../material/node/esm-shadow-view.js").then((module) => {
                createNodeEsmShadowMaterialView = module.createNodeEsmShadowMaterialView;
            })
        );
    }
    await Promise.all(loads);
}

/** @internal Compute the ESM directional light view/projection matrix for ShadowTask. */
function _computeDirectionalLightMatrix(light: DirectionalLight, casterMeshes: readonly Mesh[], orthoMinZ: number, orthoMaxZ: number): EsmLightMatrix {
    const view = buildLightViewMatrix(light.direction.x, light.direction.y, light.direction.z, light.position.x, light.position.y, light.position.z);
    let lMinX = Infinity;
    let lMaxX = -Infinity;
    let lMinY = Infinity;
    let lMaxY = -Infinity;
    for (const mesh of casterMeshes) {
        const world = mesh.worldMatrix;
        const bmin = mesh.boundMin ?? [-0.5, -0.5, -0.5];
        const bmax = mesh.boundMax ?? [0.5, 0.5, 0.5];
        for (let ci = 0; ci < 8; ci++) {
            const lx = ci & 1 ? bmax[0]! : bmin[0]!;
            const ly = ci & 2 ? bmax[1]! : bmin[1]!;
            const lz = ci & 4 ? bmax[2]! : bmin[2]!;
            const wx = world[0]! * lx + world[4]! * ly + world[8]! * lz + world[12]!;
            const wy = world[1]! * lx + world[5]! * ly + world[9]! * lz + world[13]!;
            const wz = world[2]! * lx + world[6]! * ly + world[10]! * lz + world[14]!;
            const vx = view[0]! * wx + view[4]! * wy + view[8]! * wz + view[12]!;
            const vy = view[1]! * wx + view[5]! * wy + view[9]! * wz + view[13]!;
            lMinX = Math.min(lMinX, vx);
            lMaxX = Math.max(lMaxX, vx);
            lMinY = Math.min(lMinY, vy);
            lMaxY = Math.max(lMaxY, vy);
        }
    }
    if (!Number.isFinite(lMinX)) {
        lMinX = -1;
        lMaxX = 1;
        lMinY = -1;
        lMaxY = 1;
    }
    const sx = (lMaxX - lMinX) * 0.1;
    const sy = (lMaxY - lMinY) * 0.1;
    lMinX -= sx;
    lMaxX += sx;
    lMinY -= sy;
    lMaxY += sy;

    const near = orthoMinZ;
    const far = orthoMaxZ;
    const proj = new Float32Array(16);
    proj[0] = 2 / (lMaxX - lMinX);
    proj[5] = 2 / (lMaxY - lMinY);
    proj[10] = 1 / (far - near);
    proj[12] = -(lMaxX + lMinX) / (lMaxX - lMinX);
    proj[13] = -(lMaxY + lMinY) / (lMaxY - lMinY);
    proj[14] = -near / (far - near);
    proj[15] = 1;
    return { _view: view, _viewProj: multiply4x4(proj, view), _near: near, _far: far };
}

function nearestBestKernel(idealKernel: number): number {
    const v = Math.round(Math.max(idealKernel, 1));
    for (const k of [v, v - 1, v + 1, v - 2, v + 2]) {
        if (k % 2 !== 0 && Math.floor(k / 2) % 2 === 0 && k > 0) {
            return Math.max(k, 3);
        }
    }
    return Math.max(v, 3);
}

function gaussianWeight(x: number): number {
    const sigma = 1 / 3;
    return Math.exp(-((x * x) / (2 * sigma * sigma))) / (Math.sqrt(2 * Math.PI) * sigma);
}

function createKernelBlurSamples(idealKernel: number): { offsets: number[]; weights: number[] } {
    const n = nearestBestKernel(idealKernel);
    const centerIndex = (n - 1) / 2;
    const offsets: number[] = [];
    const weights: number[] = [];
    let totalWeight = 0;

    for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const weight = gaussianWeight(u * 2.0 - 1);
        offsets[i] = i - centerIndex;
        weights[i] = weight;
        totalWeight += weight;
    }

    for (let i = 0; i < weights.length; i++) {
        weights[i] = weights[i]! / totalWeight;
    }

    const linearOffsets: number[] = [];
    const linearWeights: number[] = [];
    for (let i = 0; i <= centerIndex; i += 2) {
        const j = Math.min(i + 1, Math.floor(centerIndex));
        if (i === j) {
            linearOffsets.push(offsets[i]!);
            linearWeights.push(weights[i]!);
            continue;
        }

        const sharedCell = j === centerIndex;
        const weightLinear = weights[i]! + weights[j]! * (sharedCell ? 0.5 : 1);
        const offsetLinear = offsets[i]! + 1 / (1 + weights[i]! / weights[j]!);
        if (offsetLinear === 0) {
            linearOffsets.push(offsets[i]!, offsets[i + 1]!);
            linearWeights.push(weights[i]!, weights[i + 1]!);
        } else {
            linearOffsets.push(offsetLinear, -offsetLinear);
            linearWeights.push(weightLinear, weightLinear);
        }
    }

    return { offsets: linearOffsets, weights: linearWeights };
}

function wgslFloat(value: number): string {
    const n = Object.is(value, -0) ? 0 : value;
    let s = n.toPrecision(10);
    if (!/[.eE]/.test(s)) {
        s += ".0";
    }
    return s;
}

function createShadowBlurFragmentWGSL(blurKernel: number): string {
    const { offsets, weights } = createKernelBlurSamples(blurKernel);
    const count = offsets.length;
    return `struct BlurParams{delta:vec2<f32>,_pad:vec2<f32>,};@group(0) @binding(0) var<uniform> params:BlurParams;@group(0) @binding(1) var srcTex:texture_2d<f32>;@group(0) @binding(2) var srcSampler:sampler;const OFFSETS=array<f32,${count}>(${offsets.map(wgslFloat).join(",")});const WEIGHTS=array<f32,${count}>(${weights.map(wgslFloat).join(",")});@fragment fn main(@location(0) sampleCenter:vec2<f32>)->@location(0) vec4<f32>{var blend=vec4<f32>(0.0);for(var i=0u;i<${count}u;i=i+1u){blend+=textureSample(srcTex,srcSampler,sampleCenter+params.delta*OFFSETS[i])*WEIGHTS[i];}return blend;}`;
}

function ensureEsmShadowTaskState(
    engine: EngineContextInternal,
    scene: SceneContextInternal,
    sg: ShadowGenerator,
    casterMeshes: readonly Mesh[],
    existingState: ShadowTaskInternalState | null
): EsmTaskState {
    const existing = existingState as EsmTaskState | null;
    if (existing) {
        if (existing._casterMeshes === casterMeshes) {
            return existing;
        }
        existing._task.dispose();
    }
    const resources = getEsmShadowTaskResources(sg);
    if (!resources) {
        throw new Error("ShadowTask: missing ESM metadata.");
    }
    const materialViews = new Map<Material, MaterialView>();
    const camera = createShadowCamera(sg);
    const taskState: EsmTaskState = {
        _task: createRenderTask(
            {
                name: "esm",
                rt: createShadowRenderTarget(sg, resources._esmTexture, resources._depthBuffer),
                clr: true,
                clrColor: { r: 0, g: 0, b: 0, a: 0 },
                cam: camera,
            },
            engine,
            scene
        ),
        _camera: camera,
        _cameraVersion: 0,
        _lastCasterVersion: -1,
        _lastLightVersion: -1,
        _casterMeshes: casterMeshes,
    };

    for (const mesh of casterMeshes) {
        const material = mesh.material;
        if (material) {
            taskState._task.addMesh(mesh, { material: getEsmShadowView(material, materialViews, sg._shadowParamsUBO) });
        }
    }

    return taskState;
}

function renderEsmShadowMap(engine: EngineContextInternal, sg: ShadowGenerator, state: EsmTaskState): number {
    const resources = getEsmShadowTaskResources(sg);
    if (!resources) {
        return 0;
    }
    const casterMeshes = state._casterMeshes;
    const casterVersion = casterVersionSum(casterMeshes);
    const lightVersion = sg._light.worldMatrixVersion;
    if (!sg._config._forceRefreshEveryFrame && casterVersion === state._lastCasterVersion && lightVersion === state._lastLightVersion) {
        return 0;
    }

    const matrix = _computeDirectionalLightMatrix(sg._light as DirectionalLight, casterMeshes, sg._config._orthoMinZ!, sg._config._orthoMaxZ!);
    if (shadowMatrixChanged(sg._lightMatrix, matrix._viewProj)) {
        sg._lightMatrix.set(matrix._viewProj);
        sg._version++;
        writeShadowUboFields(resources._shadowUboData, sg);
        engine.device.queue.writeBuffer(sg._shadowUBO, 0, resources._shadowUboData as Float32Array<ArrayBuffer>);
    }
    updateShadowCamera(state, matrix);
    state._lastCasterVersion = casterVersion;
    state._lastLightVersion = lightVersion;

    let draws = state._task.execute?.() ?? 0;
    const encoder = engine._currentEncoder;
    const bh = encoder.beginRenderPass({
        colorAttachments: [
            {
                view: resources._blurTexH.createView(),
                loadOp: "clear",
                storeOp: "store",
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
            },
        ],
    });
    bh.setPipeline(resources._blurPipeline);
    bh.setBindGroup(0, resources._blurHBG);
    bh.draw(3);
    bh.end();

    const bv = encoder.beginRenderPass({
        colorAttachments: [
            {
                view: sg._depthTexture.createView(),
                loadOp: "clear",
                storeOp: "store",
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
            },
        ],
    });
    bv.setPipeline(resources._blurPipeline);
    bv.setBindGroup(0, resources._blurVBG);
    bv.draw(3);
    bv.end();
    draws += 2;
    return draws;
}

function updateShadowCamera(state: EsmTaskState, matrix: EsmLightMatrix): void {
    state._cameraVersion++;
    updateShadowCameraBase(state._camera, state._cameraVersion, matrix._near, matrix._far, matrix._view, matrix._viewProj);
}

function getEsmShadowView(material: Material, cache: Map<Material, MaterialView>, shadowParamsUBO: GPUBuffer): MaterialView {
    const cached = cache.get(material);
    if (cached) {
        return cached;
    }
    const family = material._buildGroup._materialFamily;
    let view: MaterialView;
    if (family === "standard") {
        view = createStandardEsmShadowMaterialView(material as Parameters<StandardEsmFactory>[0], shadowParamsUBO);
    } else if (family === "pbr") {
        view = createPbrEsmShadowMaterialView(material as Parameters<PbrEsmFactory>[0], shadowParamsUBO);
    } else if (family === "node") {
        view = createNodeEsmShadowMaterialView(material as Parameters<NodeEsmFactory>[0], shadowParamsUBO);
    }
    cache.set(material, view!);
    return view!;
}

function shadowMatrixChanged(a: Float32Array, b: Float32Array): boolean {
    for (let i = 0; i < 16; i++) {
        if (a[i] !== b[i]) {
            return true;
        }
    }
    return false;
}

export function createEsmDirectionalShadowGenerator(engine: EngineContext, _light: DirectionalLight, cfg: EsmDirectionalShadowGeneratorConfig = {}): ShadowGenerator {
    const eng = engine as EngineContextInternal;
    const device = eng.device;
    const mapSize = cfg.mapSize ?? 1024;
    const depthScale = cfg.depthScale ?? 50;
    const bias = cfg.bias ?? 0.00005;
    const blurKernel = cfg.blurKernel ?? 1;
    const blurScale = cfg.blurScale ?? 2;
    const darkness = cfg.darkness ?? 0;
    const frustumEdgeFalloff = cfg.frustumEdgeFalloff ?? 0;
    const orthoMinZ = cfg.orthoMinZ ?? 1;
    const orthoMaxZ = cfg.orthoMaxZ ?? 10000;
    const forceRefreshEveryFrame = cfg.forceRefreshEveryFrame ?? false;
    const blurSize = mapSize / blurScale;

    const _config: ShadowGenerator["_config"] = {
        _mapSize: mapSize,
        _bias: bias,
        _orthoMinZ: orthoMinZ,
        _orthoMaxZ: orthoMaxZ,
        _forceRefreshEveryFrame: forceRefreshEveryFrame,
    };

    const _shadowParamsUBO = createShadowParamsUBO(eng, bias, depthScale);

    const esmTexture = device.createTexture({
        size: { width: mapSize, height: mapSize },
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const depthBuf = device.createTexture({
        size: { width: mapSize, height: mapSize },
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const blurTexH = device.createTexture({
        size: { width: blurSize, height: blurSize },
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const blurTexV = device.createTexture({
        size: { width: blurSize, height: blurSize },
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const blurVert = device.createShaderModule({ code: blurVertSrc });
    const blurFrag = device.createShaderModule({ code: createShadowBlurFragmentWGSL(blurKernel) });
    const blurBGL = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
    });
    const blurPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [blurBGL] }),
        vertex: { module: blurVert, entryPoint: "main" },
        fragment: { module: blurFrag, entryPoint: "main", targets: [{ format: "rgba16float" }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
    });

    const blurSampler = getBilinearSampler(eng);
    const blurHData = new Float32Array([1.0 / blurSize, 0, 0, 0]);
    const blurHUBO = createUniformBuffer(eng, blurHData);
    const blurHBG = device.createBindGroup({
        layout: blurBGL,
        entries: [
            { binding: 0, resource: { buffer: blurHUBO } },
            { binding: 1, resource: esmTexture.createView() },
            { binding: 2, resource: blurSampler },
        ],
    });
    const blurVData = new Float32Array([0, 1.0 / blurSize, 0, 0]);
    const blurVUBO = createUniformBuffer(eng, blurVData);
    const blurVBG = device.createBindGroup({
        layout: blurBGL,
        entries: [
            { binding: 0, resource: { buffer: blurVUBO } },
            { binding: 1, resource: blurTexH.createView() },
            { binding: 2, resource: blurSampler },
        ],
    });

    const _lightMatrix = new Float32Array(16);
    const _shadowsInfo = new Float32Array([darkness, 0, depthScale, frustumEdgeFalloff]);
    const _depthValues = new Float32Array([0, 1]);
    const { ubo: _shadowUBO, data: shadowUboData } = createSharedShadowUBO(eng, _lightMatrix, _depthValues, _shadowsInfo);
    const _depthTexture = blurTexV;
    const _depthSampler = blurSampler;

    const sg: ShadowGenerator = {
        _shadowType: "esm",
        _light,
        _depthTexture,
        _depthSampler,
        _lightMatrix,
        _shadowsInfo,
        _depthValues,
        _shadowParamsUBO,
        _shadowUBO,
        _config,
        _version: 0,
    };
    sg._preloadShadowTask = preloadEsmShadowTaskState;
    sg._ensureShadowTaskState = (engine, scene, casterMeshes) => {
        const state = ensureEsmShadowTaskState(engine, scene, sg, casterMeshes, sg._shadowTaskState ?? null);
        sg._shadowTaskState = state;
        return state;
    };
    sg._renderShadowMap = (engine, state) => {
        return renderEsmShadowMap(engine, sg, state as EsmTaskState);
    };
    setEsmShadowTaskResources(sg, {
        _esmTexture: esmTexture,
        _depthBuffer: depthBuf,
        _blurTexH: blurTexH,
        _blurPipeline: blurPipeline,
        _blurHBG: blurHBG,
        _blurVBG: blurVBG,
        _shadowUboData: shadowUboData,
    });
    return sg;
}
