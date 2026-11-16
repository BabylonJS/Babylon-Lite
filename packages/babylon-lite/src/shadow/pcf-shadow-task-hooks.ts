/** Internal PCF shadow task hooks owned by PCF shadow generators. */

import { F32 } from "../engine/typed-arrays.js";
import type { Camera } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { Material, MaterialView } from "../material/material.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { SpotLight } from "../light/spot-light.js";
import { _enableTaskMeshPopulation, createRenderTask, type RenderTask } from "../frame-graph/render-task.js";
import { casterVersionSum, createShadowCamera, createShadowRenderTarget, updateShadowCameraBase, writeShadowUboFields } from "./shadow-base.js";
import type { ShadowGenerator, ShadowTaskInternalState } from "./shadow-generator.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { resolveMeshRebuild } from "../material/resolve-mesh-rebuild.js";
import { _getShadowTaskCasterMeshes, setShadowTaskCasterMeshes } from "../frame-graph/shadow-inputs.js";
import { _dropTaskMeshes } from "./shadow-task-meshes.js";

export interface PcfLightMatrix {
    /** @internal */
    _view: Float32Array;
    /** @internal */
    _viewProj: Float32Array;
    /** @internal */
    _near: number;
    /** @internal */
    _far: number;
}

interface PcfCasterSnapshot {
    /** @internal */
    _material: Material;
    /** @internal */
    _terminal: Material;
    /** @internal */
    _renderableGen: number | undefined;
}

interface PcfMaterialSnapshot {
    /** @internal The depth view of this terminal material, shared by every receive-material override chain. */
    _view: MaterialView | undefined;
    /** @internal */
    _generation: number | undefined;
    /** @internal Features captured by the cached view; dropped features do not replace this snapshot. */
    _features: unknown;
}

export interface PcfTaskState extends ShadowTaskInternalState {
    /** @internal */
    _task: RenderTask;
    /** @internal */
    _camera: Camera;
    /** @internal */
    _lastCasterVersion: number;
    /** @internal */
    _lastLightVersion: number;
    /** @internal Floating-origin offset version (active camera worldMatrixVersion) at last shadow-map render; -1 when never rendered. */
    _lastFoVersion: number;
    /** @internal Floating-origin camera at last shadow-map render. A replacement camera can report the same version. */
    _lastFoCamera?: Camera | null;
    /** @internal */
    _shadowUboData: Float32Array;
    /** @internal */
    _casterMeshes: readonly Mesh[];
    /** @internal Actual task meshes, independent of deformable wrappers' source arrays. Null means held or materialless. */
    _casterSnapshots: Map<Mesh, PcfCasterSnapshot | null>;
    /** @internal Cached depth views and their generation/features, keyed only by terminal caster material. */
    _materialSnapshots: Map<Material, PcfMaterialSnapshot>;
    /** @internal Owning scene — used to read the live floating-origin offset (camera world position). */
    _scene: SceneContext;
}

type StandardNoColorFactory = typeof import("../material/standard/no-color-view.js").createStandardNoColorMaterialView;
type PbrNoColorFactory = typeof import("../material/pbr/no-color-view.js").createPbrNoColorMaterialView;
type NodeNoColorFactory = typeof import("../material/node/no-color-view.js").createNodeNoColorMaterialView;
type ShaderNoColorFactory = typeof import("../material/shader/no-color-view.js").createShaderNoColorMaterialView;

let createStandardNoColorMaterialView: StandardNoColorFactory;
let createPbrNoColorMaterialView: PbrNoColorFactory;
let createNodeNoColorMaterialView: NodeNoColorFactory;
let createShaderNoColorMaterialView: ShaderNoColorFactory;

export async function preloadPcfShadowTaskState(casterMeshes: readonly Mesh[]): Promise<void> {
    const loads: Promise<void>[] = [];
    let needsStandard = false;
    let needsPbr = false;
    let needsNode = false;
    let needsShader = false;
    for (const mesh of casterMeshes) {
        // Resolve the SAME material `getNoColorView` will end up building a view for: an explicit
        // `_shadowCasterMaterial` override casts through an alternate material, whose family can differ
        // from the receive material's. Scanning only `mesh.material` would leave that family's factory
        // unimported and the shadow pass would then call an undefined factory.
        const material = mesh.material ? resolveShadowCasterMaterial(mesh.material) : undefined;
        const family = material?._buildGroup._materialFamily;
        needsStandard ||= family === "standard";
        needsPbr ||= family === "pbr";
        needsNode ||= family === "node";
        needsShader ||= family === "shader";
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
    if (needsShader && !createShaderNoColorMaterialView) {
        loads.push(
            import("../material/shader/no-color-view.js").then((module) => {
                createShaderNoColorMaterialView = module.createShaderNoColorMaterialView;
            })
        );
    }
    await Promise.all(loads);
}

export function ensurePcfShadowTaskState(
    engine: EngineContext,
    scene: SceneContext,
    sg: ShadowGenerator,
    casterMeshes: readonly Mesh[],
    existingState: ShadowTaskInternalState | null
): PcfTaskState {
    const existing = existingState as PcfTaskState | null;
    if (existing) {
        const rt = existing._task._config.rt;
        if (rt._depthTexture === sg._depthTexture && rt._width === sg._config._mapSize) {
            reconcilePcfCasters(scene, sg, existing, casterMeshes);
            return existing;
        }
        // The task captured a different target. Its buffers may still be referenced by this frame.
        retireGpuResources(engine, existing._task.dispose);
    }

    const camera = createShadowCamera(sg);
    const rt = createShadowRenderTarget(sg);
    const state: PcfTaskState = {
        _task: createRenderTask(
            {
                name: "pcf",
                rt,
                clr: true,
                cam: camera,
                // The render list is the caster set only: an empty set must not mirror the scene into the map
                // (the receivers sample this depth texture — see the CSM hooks).
                autoMirror: false,
                _skipClusteredLights: true,
            },
            engine,
            scene
        ),
        _camera: camera,
        _lastCasterVersion: -1,
        _lastLightVersion: -1,
        _lastFoVersion: -1,
        _shadowUboData: new F32(24),
        _casterMeshes: [],
        _casterSnapshots: new Map(),
        _materialSnapshots: new Map(),
        _scene: scene,
    };

    reconcilePcfCasters(scene, sg, state, casterMeshes);
    return state;
}

/** Reconcile only changed packets; the scheduler resolves the queue in one recording transaction. */
function reconcilePcfCasters(scene: SceneContext, sg: ShadowGenerator, state: PcfTaskState, casterMeshes: readonly Mesh[]): void {
    const casters = state._casterSnapshots;
    const materials = state._materialSnapshots;
    let drop: Set<Mesh> | undefined;
    let queued: Set<Mesh> | undefined;
    for (const mesh of casterMeshes) {
        const material = mesh.material;
        const terminal = material ? resolveShadowCasterMaterial(material) : null;
        const previous = casters.get(mesh);
        const snapshot = terminal ? materials.get(terminal) : undefined;
        const materialChanged =
            terminal && (!snapshot || snapshot._generation !== terminal._csmGen || (!!terminal._renderFeatures && snapshot._features !== terminal._renderFeatures));
        const changed = materialChanged || !previous || previous._material !== material || previous._terminal !== terminal || previous._renderableGen !== mesh._renderableGen;
        if (!material || (changed && holdShadowCaster(scene, sg, material))) {
            if (previous) {
                (drop ??= new Set()).add(mesh);
            }
            casters.set(mesh, null);
            continue;
        }
        if (changed) {
            if (materialChanged) {
                // Every view is created after this scan: later casters of this terminal also see the invalidation.
                materials.delete(terminal!);
            }
            if (previous) {
                (drop ??= new Set()).add(mesh);
            }
            (queued ??= new Set()).add(mesh);
            casters.delete(mesh);
        }
    }
    if (!drop && !queued && state._casterMeshes === casterMeshes && casters.size === casterMeshes.length) {
        return;
    }
    const next = new Set(casterMeshes);
    for (const [mesh, snapshot] of casters) {
        if (!next.has(mesh)) {
            casters.delete(mesh);
            if (snapshot) {
                (drop ??= new Set()).add(mesh);
            }
        }
    }
    const task = state._task;
    if (drop) {
        _dropTaskMeshes(task, drop);
    }
    if (drop || queued) {
        task._lastVersion = -1;
        task._ob.length = 0;
        state._lastCasterVersion = -1;
    }
    if (queued) {
        state._recordedVersion = -1;
        _enableTaskMeshPopulation(task);
        for (const mesh of queued) {
            const material = mesh.material;
            const terminal = resolveShadowCasterMaterial(material);
            let snapshot = materials.get(terminal);
            if (!snapshot) {
                snapshot = { _view: createNoColorView(terminal), _generation: terminal._csmGen, _features: terminal._renderFeatures };
                materials.set(terminal, snapshot);
            }
            task._pendingMeshes!.push({ mesh, material: snapshot._view ?? material });
            casters.set(mesh, { _material: material, _terminal: terminal, _renderableGen: mesh._renderableGen });
        }
    }
    const used = new Set<Material>();
    for (const snapshot of casters.values()) {
        if (snapshot) {
            used.add(snapshot._terminal);
        }
    }
    for (const material of materials.keys()) {
        if (!used.has(material)) {
            materials.delete(material);
        }
    }
    state._casterMeshes = casterMeshes;
}

/** @internal Whether the no-colour view of a caster material cannot be built yet, so the caster has to stay out of the
 *  shadow task for now. When the view factory of the family the caster casts through is not imported, building the view
 *  would call an undefined factory: this re-supplies the generator's registered caster set through
 *  `setShadowTaskCasterMeshes`, which parks the generator while the factory imports, as any re-supplied set does. A caster
 *  casting through its own material also waits while that material's group is not built in this scene, or recording the
 *  view would throw inside the frame: the mesh's swap drain or runtime build builds it. A build that fails reports its own
 *  error, and the hold lasts until the caster's material is reassigned or the caster leaves the set. A
 *  `setShadowCasterMaterial` override does not wait for its group, since nothing in the caster's lifecycle builds it:
 *  recording it throws as before, naming the problem. Shared by the PCF and CSM hooks. */
export function holdShadowCaster(scene: SceneContext, sg: ShadowGenerator, material: Material): boolean {
    const terminal = resolveShadowCasterMaterial(material);
    if (!hasNoColorViewFactory(terminal)) {
        // The registered set, not the hooks' argument: a deformable-caster wrapper hands the hooks substitute meshes. One
        // preload covers every family of the set, and it parks the generator synchronously, so later casters skip it.
        const registered = _getShadowTaskCasterMeshes(sg);
        if (registered && !sg._preloadPending) {
            setShadowTaskCasterMeshes(sg, registered);
        }
        return true;
    }
    return terminal === material && !resolveMeshRebuild(scene, terminal._buildGroup);
}

/** @internal Resolve the terminal material used by the shadow caster view. */
export function resolveShadowCasterMaterial(material: Material): Material {
    let terminal = material;
    while (terminal._shadowCasterMaterial) {
        terminal = terminal._shadowCasterMaterial;
    }
    return terminal;
}

/** @internal Record the terminal caster identity, generation and render features for invalidation checks. */
export function snapshotShadowCasterMaterial(
    material: Material,
    terminals: Map<Material, Material>,
    generations: Map<Material, number | undefined>,
    features: Map<Material, unknown>
): void {
    const terminal = resolveShadowCasterMaterial(material);
    terminals.set(material, terminal);
    generations.set(material, terminal._csmGen);
    features.set(material, terminal._renderFeatures);
}

/** @internal Whether an override changed, was cleared, or its terminal material was rebuilt (`_csmGen`) or has
 *  recomputed render features: a no-colour view copies the features it was built from, and some changes (material
 *  plugins) only drop `_renderFeatures` and rebuild the material's meshes one by one. Dropped features that are not
 *  recomputed yet do not count: a view built now would read none of them, so the current one stays until the rebuild
 *  recomputes them. A material missing from the snapshot counts as changed too: the snapshot cannot vouch for a view
 *  that was never built for it. */
export function shadowCasterMaterialChanged(
    material: Material,
    terminals: Map<Material, Material>,
    generations: Map<Material, number | undefined>,
    features: Map<Material, unknown>
): boolean {
    const terminal = resolveShadowCasterMaterial(material);
    const current = terminal._renderFeatures;
    return terminals.get(material) !== terminal || generations.get(material) !== terminal._csmGen || (!!current && features.get(material) !== current);
}

/** Whether `getNoColorView` can build the view of a terminal caster material now: the no-colour view factory of its family
 *  has been imported. A family without a factory builds no view, so it needs none. */
function hasNoColorViewFactory(terminal: Material): boolean {
    const family = terminal._buildGroup._materialFamily;
    return !!(family === "standard"
        ? createStandardNoColorMaterialView
        : family === "pbr"
          ? createPbrNoColorMaterialView
          : family === "node"
            ? createNodeNoColorMaterialView
            : family !== "shader" || createShaderNoColorMaterialView);
}

export function renderPcfShadowMap(
    engine: EngineContext,
    sg: ShadowGenerator,
    state: PcfTaskState,
    computeLightMatrix: (casterMeshes: readonly Mesh[], offX: number, offY: number, offZ: number) => PcfLightMatrix
): number {
    const casterMeshes = state._casterMeshes;
    const casterVersion = casterVersionSum(casterMeshes);
    const lightVersion = sg._light._lightVersion;
    // Floating-origin offset = active camera world position (mirrors the mesh-world packer
    // and lights UBO). When the camera moves the offset changes, so every eye-relative GPU
    // matrix shifts even if light/casters are static — fold its version into the dirty check.
    const foCam = engine.useFloatingOrigin ? state._scene.camera : null;
    const foVersion = foCam ? foCam.worldMatrixVersion : 0;
    const offX = foCam ? foCam.worldMatrix[12]! : 0;
    const offY = foCam ? foCam.worldMatrix[13]! : 0;
    const offZ = foCam ? foCam.worldMatrix[14]! : 0;
    const foChanged = foVersion !== state._lastFoVersion || foCam !== state._lastFoCamera;
    if (!sg._config._forceRefreshEveryFrame && casterVersion === state._lastCasterVersion && lightVersion === state._lastLightVersion && !foChanged) {
        return 0;
    }

    const matrix = computeLightMatrix(casterMeshes, offX, offY, offZ);
    const matrixChanged = sg._light.lightType === "directional" || lightVersion !== state._lastLightVersion || foChanged;
    if (matrixChanged) {
        packMat4IntoF32(sg._lightMatrix, matrix._viewProj, 0);
        sg._version++;
        writeShadowUboFields(state._shadowUboData, sg);
        engine._device.queue.writeBuffer(sg._shadowUBO, 0, state._shadowUboData as Float32Array<ArrayBuffer>);
    }
    updateShadowCamera(state, sg, matrix);

    state._lastCasterVersion = casterVersion;
    state._lastLightVersion = lightVersion;
    state._lastFoVersion = foVersion;
    state._lastFoCamera = foCam;
    return state._task.execute?.() ?? 0;
}

function updateShadowCamera(state: PcfTaskState, sg: ShadowGenerator, matrix: PcfLightMatrix): void {
    const camera = state._camera;
    camera.fov = sg._light.lightType === "spot" ? (sg._light as SpotLight).angle : 1;
    updateShadowCameraBase(camera, camera.worldMatrixVersion + 1, matrix._near, matrix._far, matrix._view, biasViewProjection(matrix._viewProj, sg._config._bias));
}

function biasViewProjection(viewProj: Float32Array, bias: number): Float32Array {
    const biased = new F32(viewProj);
    const b = bias * 0.5;
    for (let col = 0; col < 4; col++) {
        const z = 2 + col * 4;
        const w = 3 + col * 4;
        biased[z] = biased[z]! + b * biased[w]!;
    }
    return biased;
}

export function getNoColorView(material: Material, cache: Map<Material, MaterialView>): MaterialView {
    const cached = cache.get(material);
    if (cached) {
        return cached;
    }
    // Explicit caster override: this (receive) material casts its shadow through an ALTERNATE material (see
    // Material._shadowCasterMaterial). Take the override's OWN no-colour view (recurse) so the same mesh casts
    // with a sampler-free / alpha-clip caster instead of this material's shadow-map-aliasing view. Cache under
    // THIS material so the lookup at the call site (keyed by the receive material) hits.
    const override = material._shadowCasterMaterial;
    const view = override ? getNoColorView(override, cache) : createNoColorView(material);
    cache.set(material, view);
    return view;
}

function createNoColorView(material: Material): MaterialView {
    const family = material._buildGroup._materialFamily;
    let view: MaterialView;
    if (family === "standard") {
        view = createStandardNoColorMaterialView(material as Parameters<StandardNoColorFactory>[0]);
    } else if (family === "pbr") {
        view = createPbrNoColorMaterialView(material as Parameters<PbrNoColorFactory>[0]);
    } else if (family === "node") {
        view = createNodeNoColorMaterialView(material as Parameters<NodeNoColorFactory>[0]);
    } else if (family === "shader") {
        // Custom ShaderMaterial caster: the shader pipeline drops its fragment stage for the depth-only
        // shadow target on its own, so the view just hands it a private system UBO (shadow-camera VP).
        view = createShaderNoColorMaterialView(material as Parameters<typeof createShaderNoColorMaterialView>[0]);
    }
    return view!;
}
