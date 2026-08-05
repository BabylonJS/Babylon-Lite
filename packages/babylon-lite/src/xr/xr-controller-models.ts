/**
 * Controller model visuals — a simple mesh rendered at each input source's grip
 * pose, ported in spirit from Babylon.js `WebXRControllerModelLoader` but without
 * the online GLB motion-controller assets (which are not lite-compatible). By
 * default it renders a generic handle box per controller; supply a `meshFactory`
 * to draw your own model.
 *
 * Structure mirrors {@link XrPointer}: a per-DOM-source unit map, meshes created on
 * connect and disposed on disconnect, hidden while the grip is untracked. Pure data
 * + free functions (pillar 4b); nothing runs unless the app imports and drives it.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene.js";
import type { XrHandedness } from "./xr-support.js";
import type { XrInputManager } from "./xr-input.js";
import type { XrFeatureSpec } from "./xr-feature.js";
import { mat4Decompose } from "../math/mat4-decompose.js";
import { createBox } from "../mesh/mesh-factories.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";

// `@types/webxr` names the DOM source interface `XRInputSource`; alias it so the
// unit map can key on the stable DOM object rather than our per-frame wrapper.
type DomXrInputSource = XRInputSource;

/** Builds the mesh drawn for one controller. The mesh should be pre-scaled to its
 *  real-world size (metres); the feature only positions/orients it at the grip pose. */
export type XrControllerMeshFactory = (engine: EngineContext, scene: SceneContext, handedness: XrHandedness) => Mesh;

/** Options for {@link controllerModels} / {@link createXrControllerModels}. */
export interface XrControllerModelOptions {
    /** Custom per-controller mesh builder. Defaults to a generic handle box tinted by handedness. */
    meshFactory?: XrControllerMeshFactory;
}

/** @internal Per-input-source controller mesh. */
interface ControllerUnit {
    mesh: Mesh;
}

/** A controller-model manager. Create with {@link createXrControllerModels}, drive
 *  with {@link updateXrControllerModels} each XR frame, release with
 *  {@link disposeXrControllerModels}. */
export interface XrControllerModels {
    /** @internal */
    _engine: EngineContext;
    /** @internal */
    _scene: SceneContext;
    /** @internal */
    _factory: XrControllerMeshFactory;
    /** @internal Visuals per DOM input source. */
    _units: Map<DomXrInputSource, ControllerUnit>;
}

/** @internal Handedness → generic-handle diffuse tint (left cool, right warm). */
function handleColor(handedness: XrHandedness): [number, number, number] {
    if (handedness === "left") {
        return [0.3, 0.5, 0.9];
    }
    if (handedness === "right") {
        return [0.9, 0.5, 0.3];
    }
    return [0.6, 0.6, 0.6];
}

/** @internal Default generic controller: a small handle box elongated along the
 *  grip's −Z (the barrel), lit so it reads as a physical object. */
function defaultMeshFactory(engine: EngineContext, _scene: SceneContext, handedness: XrHandedness): Mesh {
    const mesh = createBox(engine, 1);
    mesh.name = `xr-controller-${handedness}`;
    const mat = createStandardMaterial();
    mat.diffuseColor = handleColor(handedness);
    mesh.material = mat as unknown as Mesh["material"];
    mesh.pickable = false;
    mesh.receiveShadows = false;
    // Handle: ~4 cm cross-section, ~12 cm along the barrel.
    mesh.scaling.set(0.04, 0.04, 0.12);
    mesh.visible = false;
    return mesh;
}

/** Create a controller-model manager bound to a scene. */
export function createXrControllerModels(engine: EngineContext, scene: SceneContext, options: XrControllerModelOptions = {}): XrControllerModels {
    return {
        _engine: engine,
        _scene: scene,
        _factory: options.meshFactory ?? defaultMeshFactory,
        _units: new Map(),
    };
}

/** @internal Lazily create the mesh for one input source. */
function ensureUnit(models: XrControllerModels, source: DomXrInputSource, handedness: XrHandedness): ControllerUnit {
    const existing = models._units.get(source);
    if (existing) {
        return existing;
    }
    const mesh = models._factory(models._engine, models._scene, handedness);
    addToScene(models._scene, mesh);
    const unit: ControllerUnit = { mesh };
    models._units.set(source, unit);
    return unit;
}

/** @internal Dispose one unit's mesh and remove it from the scene. */
function disposeUnit(models: XrControllerModels, unit: ControllerUnit): void {
    removeFromScene(models._scene, unit.mesh);
    disposeMeshGpu(unit.mesh);
}

/**
 * Place every controller model at its source's grip pose for the current frame,
 * hiding it while the grip is untracked or the source has no grip space. Call once
 * per XR frame after {@link updateXrInputPoses}. The mesh's authored scaling is
 * preserved (only position + orientation are updated), so a `meshFactory` fully
 * controls the model's size.
 */
export function updateXrControllerModels(models: XrControllerModels, input: XrInputManager): void {
    const seen = new Set<DomXrInputSource>();

    for (const src of input.inputSources) {
        seen.add(src.source);
        const unit = ensureUnit(models, src.source, src.handedness);

        if (!src.gripTracked) {
            unit.mesh.visible = false;
            continue;
        }

        const m = src.gripMatrix as unknown as Mat4;
        const rot = mat4Decompose(m).rotation;
        unit.mesh.position.set(m[12]!, m[13]!, m[14]!);
        unit.mesh.rotationQuaternion.set(rot.x, rot.y, rot.z, rot.w);
        unit.mesh.visible = true;
    }

    // Retire meshes for sources that disconnected since the last frame.
    for (const [source, unit] of models._units) {
        if (!seen.has(source)) {
            disposeUnit(models, unit);
            models._units.delete(source);
        }
    }
}

/** Dispose all controller models and detach them from the scene. */
export function disposeXrControllerModels(models: XrControllerModels): void {
    for (const unit of models._units.values()) {
        disposeUnit(models, unit);
    }
    models._units.clear();
}

/**
 * Controller model visuals as an opt-in {@link XrFeatureSpec} (Babylon.js
 * `CONTROLLER_MODEL_LOADING`). Pass it to
 * `enterXr({ features: [controllerModels(...)] })` and the session renders a mesh
 * at each controller's grip pose, tracking connect/disconnect and disposing on
 * exit — no manual `onFrame`/`onEnd` wiring.
 *
 * Requires input tracking (do not pass `input: false` to {@link enterXr}); it needs
 * no native WebXR session feature.
 *
 * @param options - Optional custom {@link XrControllerMeshFactory}.
 */
export function controllerModels(options: XrControllerModelOptions = {}): XrFeatureSpec {
    return {
        create(ctx) {
            if (!ctx.input) {
                throw new Error("controllerModels requires XR input tracking; do not pass input:false to enterXr.");
            }
            const input = ctx.input;
            const models = createXrControllerModels(ctx.engine, ctx.scene, options);
            return {
                update(): void {
                    updateXrControllerModels(models, input);
                },
                dispose(): void {
                    disposeXrControllerModels(models);
                },
            };
        },
    };
}
