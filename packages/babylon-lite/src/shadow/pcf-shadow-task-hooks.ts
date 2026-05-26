/** Internal PCF shadow task hooks owned by PCF shadow generators. */

import type { Camera } from "../camera/camera.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { Material, MaterialView } from "../material/material.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import type { SpotLight } from "../light/spot-light.js";
import { createRenderTask, type RenderTask } from "../frame-graph/render-task.js";
import { casterVersionSum, createShadowCamera, createShadowRenderTarget, updateShadowCameraBase, writeShadowUboFields } from "./shadow-base.js";
import type { ShadowGenerator, ShadowTaskInternalState } from "./shadow-generator.js";

export interface PcfLightMatrix {
    _view: Float32Array;
    _viewProj: Float32Array;
    _near: number;
    _far: number;
}

export interface PcfTaskState extends ShadowTaskInternalState {
    _task: RenderTask;
    _camera: Camera;
    _cameraVersion: number;
    _lastCasterVersion: number;
    _lastLightVersion: number;
    _shadowUboData: Float32Array;
    _casterMeshes: readonly Mesh[];
}

type StandardNoColorFactory = typeof import("../material/standard/no-color-view.js").createStandardNoColorMaterialView;
type PbrNoColorFactory = typeof import("../material/pbr/no-color-view.js").createPbrNoColorMaterialView;
type NodeNoColorFactory = typeof import("../material/node/no-color-view.js").createNodeNoColorMaterialView;

let createStandardNoColorMaterialView: StandardNoColorFactory;
let createPbrNoColorMaterialView: PbrNoColorFactory;
let createNodeNoColorMaterialView: NodeNoColorFactory;

export async function preloadPcfShadowTaskState(casterMeshes: readonly Mesh[]): Promise<void> {
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
    if (needsStandard && !createStandardNoColorMaterialView) {
        loads.push(
            import("../material/standard/no-color-view.js").then((module) => {
                createStandardNoColorMaterialView = module.createStandardNoColorMaterialView;
            })
        );
    }
    if (needsPbr && !createPbrNoColorMaterialView) {
        loads.push(
            import("../material/pbr/no-color-view.js").then((module) => {
                createPbrNoColorMaterialView = module.createPbrNoColorMaterialView;
            })
        );
    }
    if (needsNode && !createNodeNoColorMaterialView) {
        loads.push(
            import("../material/node/no-color-view.js").then((module) => {
                createNodeNoColorMaterialView = module.createNodeNoColorMaterialView;
            })
        );
    }
    await Promise.all(loads);
}

export function ensurePcfShadowTaskState(
    engine: EngineContextInternal,
    scene: SceneContextInternal,
    sg: ShadowGenerator,
    casterMeshes: readonly Mesh[],
    existingState: ShadowTaskInternalState | null
): PcfTaskState {
    const existing = existingState as PcfTaskState | null;
    if (existing) {
        if (existing._casterMeshes === casterMeshes) {
            return existing;
        }
        existing._task.dispose();
    }

    const materialViews = new Map<Material, MaterialView>();
    const camera = createShadowCamera(sg);
    const rt = createShadowRenderTarget(sg);
    const state: PcfTaskState = {
        _task: createRenderTask(
            {
                name: "pcf",
                rt,
                clr: true,
                cam: camera,
            },
            engine,
            scene
        ),
        _camera: camera,
        _cameraVersion: 0,
        _lastCasterVersion: -1,
        _lastLightVersion: -1,
        _shadowUboData: new Float32Array(24),
        _casterMeshes: casterMeshes,
    };

    for (const mesh of casterMeshes) {
        const material = mesh.material;
        if (material) {
            state._task.addMesh(mesh, { material: getNoColorView(material, materialViews) });
        }
    }

    return state;
}

export function renderPcfShadowMap(
    engine: EngineContextInternal,
    sg: ShadowGenerator,
    state: PcfTaskState,
    computeLightMatrix: (casterMeshes: readonly Mesh[]) => PcfLightMatrix
): number {
    const casterMeshes = state._casterMeshes;
    const casterVersion = casterVersionSum(casterMeshes);
    const lightVersion = sg._light.worldMatrixVersion;
    if (!sg._config._forceRefreshEveryFrame && casterVersion === state._lastCasterVersion && lightVersion === state._lastLightVersion) {
        return 0;
    }

    const matrix = computeLightMatrix(casterMeshes);
    const matrixChanged = sg._light.lightType === "directional" || lightVersion !== state._lastLightVersion;
    if (matrixChanged) {
        sg._lightMatrix.set(matrix._viewProj);
        sg._version++;
        writeShadowUboFields(state._shadowUboData, sg);
        engine.device.queue.writeBuffer(sg._shadowUBO, 0, state._shadowUboData as Float32Array<ArrayBuffer>);
    }
    updateShadowCamera(state, sg, matrix);

    state._lastCasterVersion = casterVersion;
    state._lastLightVersion = lightVersion;
    return state._task.execute?.() ?? 0;
}

function updateShadowCamera(state: PcfTaskState, sg: ShadowGenerator, matrix: PcfLightMatrix): void {
    state._cameraVersion++;
    state._camera.fov = sg._light.lightType === "spot" ? (sg._light as SpotLight).angle : 1;
    updateShadowCameraBase(state._camera, state._cameraVersion, matrix._near, matrix._far, matrix._view, biasViewProjection(matrix._viewProj, sg._config._bias));
}

function biasViewProjection(viewProj: Float32Array, bias: number): Float32Array {
    const biased = new Float32Array(viewProj);
    const b = bias * 0.5;
    for (let col = 0; col < 4; col++) {
        const z = 2 + col * 4;
        const w = 3 + col * 4;
        biased[z] = biased[z]! + b * biased[w]!;
    }
    return biased;
}

function getNoColorView(material: Material, cache: Map<Material, MaterialView>): MaterialView {
    const cached = cache.get(material);
    if (cached) {
        return cached;
    }
    const family = material._buildGroup._materialFamily;
    let view: MaterialView;
    if (family === "standard") {
        view = createStandardNoColorMaterialView(material as Parameters<StandardNoColorFactory>[0]);
    } else if (family === "pbr") {
        view = createPbrNoColorMaterialView(material as Parameters<PbrNoColorFactory>[0]);
    } else if (family === "node") {
        view = createNodeNoColorMaterialView(material as Parameters<NodeNoColorFactory>[0]);
    }
    cache.set(material, view!);
    return view!;
}
