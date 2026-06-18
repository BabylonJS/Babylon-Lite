/**
 * Babylon.js-compatible gizmos over Babylon Lite's gizmo suite.
 *
 * Babylon.js gizmos take a `UtilityLayerRenderer` and attach to a node via
 * `attachedMesh`/`attachedNode`. Babylon Lite mirrors this with
 * `createUtilityLayer` + `create*Gizmo(engine, layer)` + `attach*ToNode`. These
 * wrappers reproduce the Babylon.js class shape and the `attachedMesh` setter.
 */

import {
    createUtilityLayer,
    registerUtilityLayer,
    disposeUtilityLayer,
    createPositionGizmo,
    attachPositionGizmoToNode,
    disposePositionGizmo,
    setPositionGizmoLocalCoordinates,
    createRotationGizmo,
    attachRotationGizmoToNode,
    disposeRotationGizmo,
    setRotationGizmoLocalCoordinates,
    createScaleGizmo,
    attachScaleGizmoToNode,
    disposeScaleGizmo,
    setScaleGizmoLocalCoordinates,
    createBoundingBoxGizmo,
    attachBoundingBoxGizmoToNode,
    disposeBoundingBoxGizmo,
    createLightGizmo,
    attachLightGizmoToLight,
    disposeLightGizmo,
    createCameraGizmo,
    attachCameraGizmoToCamera,
    disposeCameraGizmo,
    createAxisDragGizmo,
    attachAxisDragGizmoToNode,
    disposeAxisDragGizmo,
    createPlaneRotationGizmo,
    attachPlaneRotationGizmoToNode,
    disposePlaneRotationGizmo,
    createPlaneDragGizmo,
    attachPlaneDragGizmoToNode,
    disposePlaneDragGizmo,
    createAxisScaleGizmo,
    attachAxisScaleGizmoToNode,
    disposeAxisScaleGizmo,
} from "babylon-lite";
import type {
    UtilityLayer as LiteUtilityLayer,
    PositionGizmo as LitePositionGizmo,
    RotationGizmo as LiteRotationGizmo,
    ScaleGizmo as LiteScaleGizmo,
    BoundingBoxGizmo as LiteBoundingBoxGizmo,
    LightGizmo as LiteLightGizmo,
    CameraGizmo as LiteCameraGizmo,
    AxisDragGizmo as LiteAxisDragGizmo,
    PlaneRotationGizmo as LitePlaneRotationGizmo,
    PlaneDragGizmo as LitePlaneDragGizmo,
    AxisScaleGizmo as LiteAxisScaleGizmo,
    EngineContext,
    SceneNode,
} from "babylon-lite";

import type { Scene } from "../scene/scene.js";
import type { AbstractMesh, Mesh } from "../meshes/meshes.js";
import type { Node } from "../node/node.js";
import type { Light } from "../lights/lights.js";
import type { Camera } from "../cameras/cameras.js";
import type { Vector3 } from "../math/vector.js";
import type { Color3 } from "../math/color.js";

/** Babylon.js `UtilityLayerRenderer` — the overlay scene gizmos render into. */
export class UtilityLayerRenderer {
    /** @internal Underlying Babylon Lite utility layer. */
    public readonly _lite: LiteUtilityLayer;
    /** @internal Lite engine backing the layer (gizmo factories need it explicitly). */
    public readonly _engine: EngineContext;
    private _registered = false;

    public constructor(scene: Scene) {
        this._engine = scene.getEngine()._lite;
        this._lite = createUtilityLayer(this._engine, scene._lite);
        // Babylon Lite registers a utility layer *after* its gizmos are created and
        // after the main scene is registered. Gizmo creation is synchronous (all
        // gizmos exist by the time the engine starts), so defer registration to the
        // engine's late-work phase to capture every gizmo.
        scene.getEngine()._registerLateWork(() => this._ensureRegistered());
    }

    /** @internal Ensure the layer is registered with the engine (idempotent). */
    public _ensureRegistered(): Promise<void> {
        if (this._registered) {
            return Promise.resolve();
        }
        this._registered = true;
        return registerUtilityLayer(this._lite);
    }

    public dispose(): void {
        disposeUtilityLayer(this._lite);
    }
}

/** Shared base for compat gizmos (Babylon.js `Gizmo`). */
abstract class GizmoBase {
    /** @internal The utility layer this gizmo renders into. */
    public readonly _layer: UtilityLayerRenderer;

    protected constructor(layer: UtilityLayerRenderer) {
        this._layer = layer;
        // The utility layer registers itself with the engine during the engine's
        // late-work phase (after all gizmos are created), so no eager registration
        // is needed here.
    }

    public abstract get attachedMesh(): AbstractMesh | null;
    public abstract set attachedMesh(value: AbstractMesh | null);

    public abstract dispose(): void;
}

export class PositionGizmo extends GizmoBase {
    /** @internal */
    public readonly _lite: LitePositionGizmo;
    private _attached: AbstractMesh | null = null;

    public constructor(layer: UtilityLayerRenderer) {
        super(layer);
        this._lite = createPositionGizmo(layer._engine, layer._lite);
        // Babylon.js `Gizmo.updateGizmoRotationToMatchAttachedMesh` defaults to true.
        setPositionGizmoLocalCoordinates(this._lite, true);
    }

    /** Babylon.js `Gizmo.updateGizmoRotationToMatchAttachedMesh` — orient widgets to the node's local axes. */
    public set updateGizmoRotationToMatchAttachedMesh(value: boolean) {
        setPositionGizmoLocalCoordinates(this._lite, value);
    }

    public get attachedMesh(): AbstractMesh | null {
        return this._attached;
    }
    public set attachedMesh(value: AbstractMesh | null) {
        this._attached = value;
        attachPositionGizmoToNode(this._lite, (value?._lite as SceneNode | undefined) ?? null);
    }

    public get attachedNode(): AbstractMesh | null {
        return this._attached;
    }
    public set attachedNode(value: AbstractMesh | null) {
        this.attachedMesh = value;
    }

    public override dispose(): void {
        disposePositionGizmo(this._lite, this._layer._lite);
    }
}

export class RotationGizmo extends GizmoBase {
    /** @internal */
    public readonly _lite: LiteRotationGizmo;
    private _attached: AbstractMesh | null = null;

    public constructor(layer: UtilityLayerRenderer) {
        super(layer);
        this._lite = createRotationGizmo(layer._engine, layer._lite);
        // Babylon.js `Gizmo.updateGizmoRotationToMatchAttachedMesh` defaults to true.
        setRotationGizmoLocalCoordinates(this._lite, true);
    }

    /** Babylon.js `Gizmo.updateGizmoRotationToMatchAttachedMesh` — orient widgets to the node's local axes. */
    public set updateGizmoRotationToMatchAttachedMesh(value: boolean) {
        setRotationGizmoLocalCoordinates(this._lite, value);
    }

    public get attachedMesh(): AbstractMesh | null {
        return this._attached;
    }
    public set attachedMesh(value: AbstractMesh | null) {
        this._attached = value;
        attachRotationGizmoToNode(this._lite, (value?._lite as SceneNode | undefined) ?? null);
    }

    public get attachedNode(): AbstractMesh | null {
        return this._attached;
    }
    public set attachedNode(value: AbstractMesh | null) {
        this.attachedMesh = value;
    }

    public override dispose(): void {
        disposeRotationGizmo(this._lite, this._layer._lite);
    }
}

export class ScaleGizmo extends GizmoBase {
    /** @internal */
    public readonly _lite: LiteScaleGizmo;
    private _attached: AbstractMesh | null = null;

    public constructor(layer: UtilityLayerRenderer) {
        super(layer);
        this._lite = createScaleGizmo(layer._engine, layer._lite);
        // Babylon.js `Gizmo.updateGizmoRotationToMatchAttachedMesh` defaults to true.
        setScaleGizmoLocalCoordinates(this._lite, true);
    }

    /** Babylon.js `Gizmo.updateGizmoRotationToMatchAttachedMesh` — orient widgets to the node's local axes. */
    public set updateGizmoRotationToMatchAttachedMesh(value: boolean) {
        setScaleGizmoLocalCoordinates(this._lite, value);
    }

    public get attachedMesh(): AbstractMesh | null {
        return this._attached;
    }
    public set attachedMesh(value: AbstractMesh | null) {
        this._attached = value;
        attachScaleGizmoToNode(this._lite, (value?._lite as SceneNode | undefined) ?? null);
    }

    public get attachedNode(): AbstractMesh | null {
        return this._attached;
    }
    public set attachedNode(value: AbstractMesh | null) {
        this.attachedMesh = value;
    }

    public override dispose(): void {
        disposeScaleGizmo(this._lite, this._layer._lite);
    }
}

export class BoundingBoxGizmo extends GizmoBase {
    /** @internal */
    public readonly _lite: LiteBoundingBoxGizmo;
    private _attached: AbstractMesh | null = null;

    /**
     * Babylon.js `BoundingBoxGizmo(color?, utilityLayer?)`. The first argument may
     * be the gizmo colour (when a layer is also supplied) or the utility layer.
     */
    public constructor(colorOrLayer: Color3 | UtilityLayerRenderer, layer?: UtilityLayerRenderer) {
        const resolvedLayer = layer ?? (colorOrLayer as UtilityLayerRenderer);
        const color = layer ? (colorOrLayer as Color3) : undefined;
        super(resolvedLayer);
        this._lite = createBoundingBoxGizmo(resolvedLayer._engine, resolvedLayer._lite, color ? { color: [color.r, color.g, color.b] } : {});
    }

    public get attachedMesh(): AbstractMesh | null {
        return this._attached;
    }
    public set attachedMesh(value: AbstractMesh | null) {
        this._attached = value;
        attachBoundingBoxGizmoToNode(this._lite, nodeLite(value));
    }

    public get attachedNode(): AbstractMesh | null {
        return this._attached;
    }
    public set attachedNode(value: AbstractMesh | null) {
        this.attachedMesh = value;
    }

    /** Babylon.js `BoundingBoxGizmo.enableDragBehavior()` — enables body-drag (Lite enables it by default). */
    public enableDragBehavior(): void {
        // Babylon Lite's bounding-box gizmo wires body-drag through its own pointer
        // behaviour; no explicit opt-in is required.
    }

    public override dispose(): void {
        disposeBoundingBoxGizmo(this._lite, this._layer._lite);
    }
}

export class LightGizmo {
    /** @internal */
    public readonly _lite: LiteLightGizmo;
    /** @internal */
    public readonly _layer: UtilityLayerRenderer;
    private _attached: Light | null = null;

    public constructor(layer: UtilityLayerRenderer) {
        this._layer = layer;
        this._lite = createLightGizmo(layer._engine, layer._lite);
    }

    public get light(): Light | null {
        return this._attached;
    }
    public set light(value: Light | null) {
        this._attached = value;
        attachLightGizmoToLight(this._lite, value?._lite ?? null);
    }

    /**
     * Babylon.js `LightGizmo.attachedMesh` — the gizmo's visual root. Babylon.js
     * code reads this to reposition the gizmo for lights without a position (e.g.
     * hemispheric). Returns a thin proxy over the Lite gizmo's `root` node whose
     * `position` writes through to it.
     */
    public get attachedMesh(): { position: Vector3 } {
        const root = this._lite.root;
        return {
            get position(): Vector3 {
                return root.position as unknown as Vector3;
            },
            set position(v: Vector3) {
                root.position.set(v.x, v.y, v.z);
            },
        };
    }

    public dispose(): void {
        disposeLightGizmo(this._lite, this._layer._lite);
    }
}

export class CameraGizmo {
    /** @internal */
    public readonly _lite: LiteCameraGizmo;
    /** @internal */
    public readonly _layer: UtilityLayerRenderer;
    private _attached: Camera | null = null;

    public constructor(layer: UtilityLayerRenderer) {
        this._layer = layer;
        this._lite = createCameraGizmo(layer._engine, layer._lite);
    }

    public get camera(): Camera | null {
        return this._attached;
    }
    public set camera(value: Camera | null) {
        this._attached = value;
        attachCameraGizmoToCamera(this._lite, value?._lite ?? null);
    }

    public dispose(): void {
        disposeCameraGizmo(this._lite, this._layer._lite);
    }
}

/**
 * Babylon.js single-axis / single-plane gizmos. Babylon.js constructs these with
 * `(axis, color, utilityLayer)` and attaches to a node via `attachedNode`. Each
 * maps to a Babylon Lite single-axis gizmo factory.
 *
 * @internal Resolve the Lite scene node for a compat node (mesh `_lite` or
 * transform `_node`).
 */
function nodeLite(value: Node | null): SceneNode | null {
    if (!value) {
        return null;
    }
    const n = value as { _lite?: SceneNode; _node?: SceneNode };
    return n._lite ?? n._node ?? null;
}

/** Babylon.js `AxisDragGizmo` — drags the attached node along a single world axis. */
export class AxisDragGizmo extends GizmoBase {
    /** @internal */
    public readonly _lite: LiteAxisDragGizmo;
    private _attached: Node | null = null;

    public constructor(dragAxis: Vector3, color: Color3, layer: UtilityLayerRenderer) {
        super(layer);
        this._lite = createAxisDragGizmo(layer._engine, layer._lite, {
            dragAxis: { x: dragAxis.x, y: dragAxis.y, z: dragAxis.z },
            color: [color.r, color.g, color.b],
        });
    }

    public get attachedMesh(): AbstractMesh | null {
        return this._attached as AbstractMesh | null;
    }
    public set attachedMesh(value: AbstractMesh | null) {
        this.attachedNode = value;
    }

    public get attachedNode(): Node | null {
        return this._attached;
    }
    public set attachedNode(value: Node | null) {
        this._attached = value;
        attachAxisDragGizmoToNode(this._lite, nodeLite(value));
    }

    public override dispose(): void {
        disposeAxisDragGizmo(this._lite, this._layer._lite);
    }
}

/** Babylon.js `PlaneRotationGizmo` — rotates the attached node about a plane normal. */
export class PlaneRotationGizmo extends GizmoBase {
    /** @internal */
    public readonly _lite: LitePlaneRotationGizmo;
    private _attached: Node | null = null;

    public constructor(planeNormal: Vector3, color: Color3, layer: UtilityLayerRenderer) {
        super(layer);
        this._lite = createPlaneRotationGizmo(layer._engine, layer._lite, {
            planeNormal: { x: planeNormal.x, y: planeNormal.y, z: planeNormal.z },
            color: [color.r, color.g, color.b],
        });
    }

    public get attachedMesh(): AbstractMesh | null {
        return this._attached as AbstractMesh | null;
    }
    public set attachedMesh(value: AbstractMesh | null) {
        this.attachedNode = value;
    }

    public get attachedNode(): Node | null {
        return this._attached;
    }
    public set attachedNode(value: Node | null) {
        this._attached = value;
        attachPlaneRotationGizmoToNode(this._lite, nodeLite(value));
    }

    public override dispose(): void {
        disposePlaneRotationGizmo(this._lite, this._layer._lite);
    }
}

/** Babylon.js `PlaneDragGizmo` — drags the attached node within a plane. */
export class PlaneDragGizmo extends GizmoBase {
    /** @internal */
    public readonly _lite: LitePlaneDragGizmo;
    private _attached: Node | null = null;

    public constructor(dragPlaneNormal: Vector3, color: Color3, layer: UtilityLayerRenderer) {
        super(layer);
        this._lite = createPlaneDragGizmo(layer._engine, layer._lite, {
            dragPlaneNormal: { x: dragPlaneNormal.x, y: dragPlaneNormal.y, z: dragPlaneNormal.z },
            color: [color.r, color.g, color.b],
        });
    }

    public get attachedMesh(): AbstractMesh | null {
        return this._attached as AbstractMesh | null;
    }
    public set attachedMesh(value: AbstractMesh | null) {
        this.attachedNode = value;
    }

    public get attachedNode(): Node | null {
        return this._attached;
    }
    public set attachedNode(value: Node | null) {
        this._attached = value;
        attachPlaneDragGizmoToNode(this._lite, nodeLite(value));
    }

    public override dispose(): void {
        disposePlaneDragGizmo(this._lite, this._layer._lite);
    }
}

/** Babylon.js `AxisScaleGizmo` — scales the attached node along a single axis. */
export class AxisScaleGizmo extends GizmoBase {
    /** @internal */
    public readonly _lite: LiteAxisScaleGizmo;
    private _attached: Node | null = null;

    public constructor(dragAxis: Vector3, color: Color3, layer: UtilityLayerRenderer) {
        super(layer);
        this._lite = createAxisScaleGizmo(layer._engine, layer._lite, {
            dragAxis: { x: dragAxis.x, y: dragAxis.y, z: dragAxis.z },
            color: [color.r, color.g, color.b],
        });
    }

    public get attachedMesh(): AbstractMesh | null {
        return this._attached as AbstractMesh | null;
    }
    public set attachedMesh(value: AbstractMesh | null) {
        this.attachedNode = value;
    }

    public get attachedNode(): Node | null {
        return this._attached;
    }
    public set attachedNode(value: Node | null) {
        this._attached = value;
        attachAxisScaleGizmoToNode(this._lite, nodeLite(value));
    }

    public override dispose(): void {
        disposeAxisScaleGizmo(this._lite, this._layer._lite);
    }
}

/**
 * Babylon.js `GizmoManager` — coordinates the position/rotation/scale/bounding-box
 * gizmos over a shared utility layer and a single attached mesh.
 */
export class GizmoManager {
    public readonly gizmos: {
        positionGizmo: PositionGizmo | null;
        rotationGizmo: RotationGizmo | null;
        scaleGizmo: ScaleGizmo | null;
        boundingBoxGizmo: BoundingBoxGizmo | null;
    } = { positionGizmo: null, rotationGizmo: null, scaleGizmo: null, boundingBoxGizmo: null };

    private readonly _layer: UtilityLayerRenderer;
    private _attached: AbstractMesh | null = null;

    public constructor(scene: Scene) {
        this._layer = new UtilityLayerRenderer(scene);
    }

    public set positionGizmoEnabled(enabled: boolean) {
        this._toggle("positionGizmo", enabled, () => new PositionGizmo(this._layer));
    }
    public set rotationGizmoEnabled(enabled: boolean) {
        this._toggle("rotationGizmo", enabled, () => new RotationGizmo(this._layer));
    }
    public set scaleGizmoEnabled(enabled: boolean) {
        this._toggle("scaleGizmo", enabled, () => new ScaleGizmo(this._layer));
    }
    public set boundingBoxGizmoEnabled(enabled: boolean) {
        this._toggle("boundingBoxGizmo", enabled, () => new BoundingBoxGizmo(this._layer));
    }

    public attachToMesh(mesh: Mesh | null): void {
        this._attached = mesh;
        if (this.gizmos.positionGizmo) {
            this.gizmos.positionGizmo.attachedMesh = mesh;
        }
        if (this.gizmos.rotationGizmo) {
            this.gizmos.rotationGizmo.attachedMesh = mesh;
        }
        if (this.gizmos.scaleGizmo) {
            this.gizmos.scaleGizmo.attachedMesh = mesh;
        }
        if (this.gizmos.boundingBoxGizmo) {
            this.gizmos.boundingBoxGizmo.attachedMesh = mesh;
        }
    }

    public dispose(): void {
        this.gizmos.positionGizmo?.dispose();
        this.gizmos.rotationGizmo?.dispose();
        this.gizmos.scaleGizmo?.dispose();
        this.gizmos.boundingBoxGizmo?.dispose();
        this._layer.dispose();
    }

    private _toggle<K extends "positionGizmo" | "rotationGizmo" | "scaleGizmo" | "boundingBoxGizmo">(
        key: K,
        enabled: boolean,
        make: () => PositionGizmo | RotationGizmo | ScaleGizmo | BoundingBoxGizmo
    ): void {
        if (enabled && !this.gizmos[key]) {
            const gizmo = make() as never;
            this.gizmos[key] = gizmo;
            this.gizmos[key]!.attachedMesh = this._attached;
        } else if (!enabled && this.gizmos[key]) {
            this.gizmos[key]!.dispose();
            this.gizmos[key] = null;
        }
    }
}
