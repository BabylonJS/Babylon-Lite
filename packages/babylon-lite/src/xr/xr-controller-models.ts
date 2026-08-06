/**
 * Controller model visuals — a mesh rendered at each input source's grip pose,
 * ported in spirit from Babylon.js `WebXRControllerModelLoader`. By default it
 * renders a generic handle box per controller (offline, zero network); supply a
 * `meshFactory` to draw your own model, or set `profiles` to load the real
 * per-hand GLB motion-controller models from the WebXR Input Profiles registry
 * (Babylon.js parity) and animate their buttons / triggers / thumbsticks from
 * live gamepad state.
 *
 * The profile-loading path carries a network dependency + the glTF loader, so it
 * is dynamic-imported only when `profiles` is set — box-only controller models
 * (and every non-XR scene) never bundle any of it.
 *
 * Structure mirrors {@link XrPointer}: a per-DOM-source unit map, meshes created on
 * connect and disposed on disconnect, hidden while the grip is untracked. Pure data
 * + free functions (pillar 4b); nothing runs unless the app imports and drives it.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { MotionController, XrMotionControllerProfileOptions } from "./xr-motion-controller.js";
import type { XrHandedness } from "./xr-support.js";
import type { XrInputManager } from "./xr-input.js";
import type { XrFeatureSpec } from "./xr-feature.js";
import { mat4Decompose } from "../math/mat4-decompose.js";
import { createBox } from "../mesh/mesh-factories.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { getContainerMeshes } from "../asset-container.js";
import { setSubtreeVisible } from "../scene/visibility.js";

// `@types/webxr` names the DOM source interface `XRInputSource`; alias it so the
// unit map can key on the stable DOM object rather than our per-frame wrapper.
type DomXrInputSource = XRInputSource;

/** @internal The lazily dynamic-imported motion-controller module surface. */
type MotionModule = typeof import("./xr-motion-controller.js");

/** Builds the mesh drawn for one controller. The mesh should be pre-scaled to its
 *  real-world size (metres); the feature only positions/orients it at the grip pose. */
export type XrControllerMeshFactory = (engine: EngineContext, scene: SceneContext, handedness: XrHandedness) => Mesh;

/** Options for {@link controllerModels} / {@link createXrControllerModels}. */
export interface XrControllerModelOptions {
    /** Custom per-controller mesh builder. Defaults to a generic handle box tinted by
     *  handedness. Also used as the placeholder while a {@link profiles} model loads. */
    meshFactory?: XrControllerMeshFactory;
    /** Load real per-hand GLB motion-controller models from the WebXR Input Profiles
     *  registry (Babylon.js `CONTROLLER_MODEL_LOADING`) and animate buttons / trigger /
     *  thumbstick from live gamepad state. `true` uses the default jsDelivr CDN; pass an
     *  object to override the base URL. The handle box shows as a placeholder until a
     *  source's model resolves. Adds a network dependency + the glTF loader to the bundle
     *  (dynamic-imported on demand), so it stays fully opt-in. */
    profiles?: boolean | XrMotionControllerProfileOptions;
}

/** @internal Per-input-source controller visual: a placeholder box, optionally
 *  swapped for the real profile model once it loads. */
interface ControllerUnit {
    /** Handedness, retained for the async profile load. */
    handedness: XrHandedness;
    /** Placeholder handle box (null once disposed after the real model attaches). */
    mesh: Mesh | null;
    /** Loaded profile model, once resolved. */
    model: MotionController | null;
    /** Placeholder material, when the loading-styled factory is used (for pulsing). */
    placeholderMat: StandardMaterialProps | null;
    /** The node positioned at the grip each frame — the model root if present, else the box. */
    active: SceneNode;
    /** True once a profile load has been kicked off for this source (success or failure). */
    loadStarted: boolean;
    /** True if the source disconnected before its async load resolved. */
    retired: boolean;
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
    /** @internal True when the placeholder is the loading-styled ghost (pulsed each
     *  frame while the real model loads). False for a custom or box-only factory. */
    _loadingStyle: boolean;
    /** @internal Profile-loading options, or null when disabled. */
    _profiles: XrMotionControllerProfileOptions | null;
    /** @internal Dynamic-imported motion-controller module, once loaded. */
    _mod: MotionModule | null;
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

/** @internal Soft blue-white glow colour for the loading placeholder. */
const LOADING_GLOW: [number, number, number] = [0.55, 0.72, 1];

/** @internal Loading-state placeholder used while a real profile model streams in:
 *  a small translucent, unlit ghost box that gently pulses (see the update loop) so
 *  it reads as "loading" rather than a final controller. */
function loadingMeshFactory(engine: EngineContext, _scene: SceneContext, handedness: XrHandedness): Mesh {
    const mesh = createBox(engine, 1);
    mesh.name = `xr-controller-loading-${handedness}`;
    const mat = createStandardMaterial();
    // Diffuse must stay white: with `disableLighting` the shader multiplies
    // emissive by diffuse, so a zero diffuse would render the ghost black.
    mat.diffuseColor = [1, 1, 1];
    mat.emissiveColor = [LOADING_GLOW[0], LOADING_GLOW[1], LOADING_GLOW[2]];
    mat.disableLighting = true;
    mat.alpha = 0.45;
    mesh.material = mat as unknown as Mesh["material"];
    mesh.pickable = false;
    mesh.receiveShadows = false;
    // Slightly smaller than the solid handle so it reads as an insubstantial ghost.
    mesh.scaling.set(0.035, 0.035, 0.11);
    mesh.visible = false;
    return mesh;
}

/** Create a controller-model manager bound to a scene. */
export function createXrControllerModels(engine: EngineContext, scene: SceneContext, options: XrControllerModelOptions = {}): XrControllerModels {
    const profiles = options.profiles ? (options.profiles === true ? {} : options.profiles) : null;
    // With profiles on and no custom factory, use the loading-styled ghost placeholder
    // (it's replaced by the real model once loaded); otherwise the solid handle box.
    const loadingStyle = !options.meshFactory && profiles !== null;
    return {
        _engine: engine,
        _scene: scene,
        _factory: options.meshFactory ?? (loadingStyle ? loadingMeshFactory : defaultMeshFactory),
        _loadingStyle: loadingStyle,
        _profiles: profiles,
        _mod: null,
        _units: new Map(),
    };
}

/** @internal Kick off the one-time dynamic import of the profile loader. */
function ensureModule(models: XrControllerModels): void {
    if (models._mod || !models._profiles) {
        return;
    }
    void import("./xr-motion-controller.js")
        .then((m) => {
            models._mod = m;
        })
        .catch(() => {
            // Import failed (e.g. offline) — fall back to box-only for the session.
            models._profiles = null;
        });
}

/** @internal Detach + free a loaded profile model's GPU resources. */
function disposeModel(models: XrControllerModels, model: MotionController): void {
    removeFromScene(models._scene, model.container);
    for (const mesh of getContainerMeshes(model.container)) {
        disposeMeshGpu(mesh);
    }
}

/** @internal Begin loading a source's real profile model (once). On success the
 *  placeholder box is disposed and the model becomes the active visual. */
function startProfileLoad(models: XrControllerModels, source: DomXrInputSource, unit: ControllerUnit): void {
    const mod = models._mod;
    const opts = models._profiles;
    if (!mod || !opts || unit.loadStarted) {
        return;
    }
    unit.loadStarted = true;
    void (async () => {
        try {
            const model = await mod.loadMotionController(models._engine, source, unit.handedness, opts);
            if (!model) {
                return;
            }
            if (unit.retired) {
                disposeModel(models, model);
                return;
            }
            // The glTF loader mirrors imported models with a `-1` X scale on the synthetic
            // `__root__` (its right-handed→left-handed conversion). The XR camera feeds WebXR's
            // right-handed pose/projection through verbatim, so that mirror reads as a flipped
            // controller in-headset. Neutralise it here (un-mirror the root) so the model matches
            // the box placeholder's orientation, then enable mirrored-mesh winding so the now
            // positive-determinant model keeps its front faces (rather than rendering inside-out).
            const root = model.root;
            root.scaling.set(-root.scaling.x, root.scaling.y, root.scaling.z);
            // Loaded glTF meshes are pickable by default. The pointer ray would then hit the
            // controller model at ~0 m and collapse the laser "inside" the controller; exclude the
            // model from picking so the ray passes through to the scene.
            for (const mesh of getContainerMeshes(model.container)) {
                mesh.pickable = false;
            }
            const { enableMirroredMeshes } = await import("../mesh/enable-mirrored-meshes.js");
            await enableMirroredMeshes(models._scene);
            addToScene(models._scene, model.container);
            setSubtreeVisible(model.root, false);
            unit.model = model;
            unit.active = model.root;
            // Retire the placeholder box now that the real model is in.
            if (unit.mesh) {
                removeFromScene(models._scene, unit.mesh);
                disposeMeshGpu(unit.mesh);
                unit.mesh = null;
            }
        } catch {
            // Keep the placeholder box on any failure.
        }
    })();
}

/** @internal Lazily create the unit (placeholder box) for one input source. */
function ensureUnit(models: XrControllerModels, source: DomXrInputSource, handedness: XrHandedness): ControllerUnit {
    const existing = models._units.get(source);
    if (existing) {
        return existing;
    }
    const mesh = models._factory(models._engine, models._scene, handedness);
    addToScene(models._scene, mesh);
    const placeholderMat = models._loadingStyle ? (mesh.material as unknown as StandardMaterialProps) : null;
    const unit: ControllerUnit = { handedness, mesh, model: null, placeholderMat, active: mesh, loadStarted: false, retired: false };
    models._units.set(source, unit);
    return unit;
}

/** @internal Dispose one unit's visuals and remove them from the scene. */
function disposeUnit(models: XrControllerModels, unit: ControllerUnit): void {
    unit.retired = true;
    if (unit.mesh) {
        removeFromScene(models._scene, unit.mesh);
        disposeMeshGpu(unit.mesh);
        unit.mesh = null;
    }
    if (unit.model) {
        disposeModel(models, unit.model);
        unit.model = null;
    }
}

/** @internal Show/hide the active visual (cascading through a model subtree). */
function setUnitVisible(unit: ControllerUnit, visible: boolean): void {
    if (unit.model) {
        setSubtreeVisible(unit.active, visible);
    } else if (unit.mesh) {
        unit.mesh.visible = visible;
    }
}

/**
 * Place every controller model at its source's grip pose for the current frame,
 * hiding it while the grip is untracked or the source has no grip space. Call once
 * per XR frame after {@link updateXrInputPoses}. The mesh's authored scaling is
 * preserved (only position + orientation are updated), so a `meshFactory` fully
 * controls the model's size. When `profiles` is enabled, real models are loaded in
 * the background and their buttons/trigger/thumbstick animate from gamepad state.
 */
export function updateXrControllerModels(models: XrControllerModels, input: XrInputManager): void {
    const seen = new Set<DomXrInputSource>();
    ensureModule(models);

    for (const src of input.inputSources) {
        seen.add(src.source);
        const unit = ensureUnit(models, src.source, src.handedness);
        startProfileLoad(models, src.source, unit);

        if (!src.gripTracked) {
            setUnitVisible(unit, false);
            continue;
        }

        const m = src.gripMatrix as unknown as Mat4;
        const rot = mat4Decompose(m).rotation;
        unit.active.position.set(m[12]!, m[13]!, m[14]!);
        unit.active.rotationQuaternion.set(rot.x, rot.y, rot.z, rot.w);
        setUnitVisible(unit, true);

        // Pulse the loading ghost while the real model is still streaming in.
        if (unit.placeholderMat && unit.mesh && !unit.model) {
            const p = 0.5 + 0.5 * Math.sin(performance.now() * 0.004);
            unit.placeholderMat.alpha = 0.25 + 0.35 * p;
            const k = 0.6 + 0.4 * p;
            unit.placeholderMat.emissiveColor = [LOADING_GLOW[0] * k, LOADING_GLOW[1] * k, LOADING_GLOW[2] * k];
        }

        if (unit.model && models._mod) {
            models._mod.updateMotionController(unit.model, src.source.gamepad ?? null);
        }
    }

    // Retire visuals for sources that disconnected since the last frame.
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
 * @param options - Optional custom {@link XrControllerMeshFactory} and/or `profiles`
 *   to load real WebXR Input Profiles models.
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
