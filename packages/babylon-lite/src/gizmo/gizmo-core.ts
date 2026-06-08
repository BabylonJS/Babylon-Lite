/** Gizmo core helpers: material triplet (colored / hover / disabled),
 *  per-frame follow-target helper, and a light-weight observable. */

import type { Mesh } from "../mesh/mesh.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Mat4 } from "../math/types.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { onBeforeRender } from "../scene/scene-core.js";

export interface GizmoMaterialSet {
    colored: StandardMaterialProps;
    hover: StandardMaterialProps;
    disabled: StandardMaterialProps;
}

/** Build the three materials used by every gizmo: solid colored, yellow hover,
 *  grey/translucent disabled.  Materials are LIT (no `disableLighting`) so the
 *  utility layer's hemispheric light (intensity 2, gray ground — matching BJS
 *  `UtilityLayerRenderer._getSharedGizmoLight`) shades the arrow / ring / box
 *  surfaces, exactly like the BJS reference gizmos.  The specular is dimmed to
 *  `color − 0.1` (BJS's gizmo specular) to avoid an over-bright highlight. */
export function createGizmoMaterials(
    color: [number, number, number],
    hoverColor: [number, number, number] = [1, 1, 0],
    disableColor: [number, number, number] = [0.5, 0.5, 0.5]
): GizmoMaterialSet {
    const colored = createStandardMaterial();
    colored.diffuseColor = color;
    // BJS gizmo specular = diffuse − 0.1 (not the StandardMaterial default white,
    // which produces a bright "shiny" highlight BJS doesn't have).  No emissive —
    // the utility layer's hemispheric light keeps the colour readable.
    colored.specularColor = [Math.max(0, color[0] - 0.1), Math.max(0, color[1] - 0.1), Math.max(0, color[2] - 0.1)];

    const hover = createStandardMaterial();
    hover.diffuseColor = hoverColor;
    hover.specularColor = [Math.max(0, hoverColor[0] - 0.1), Math.max(0, hoverColor[1] - 0.1), Math.max(0, hoverColor[2] - 0.1)];

    const disabled = createStandardMaterial();
    disabled.diffuseColor = disableColor;
    disabled.specularColor = [Math.max(0, disableColor[0] - 0.1), Math.max(0, disableColor[1] - 0.1), Math.max(0, disableColor[2] - 0.1)];
    disabled.alpha = 0.4;

    return { colored, hover, disabled };
}

/** Replace the material on each of `meshes`. */
export function setMeshesMaterial(meshes: Mesh[], material: StandardMaterialProps): void {
    for (const m of meshes) {
        m.material = material;
    }
}

/** Per-frame: copy targetNode's world translation into gizmoRoot.position. The
 *  gizmo is a top-level node (no parent), so this keeps it co-located with the
 *  attached node every frame.  Optionally also scales the gizmo root by
 *  `distance(camera, gizmo) * scaleRatio` so it keeps a constant on-screen
 *  size regardless of camera distance (mirrors BJS `Gizmo._update`).
 *
 *  When `onAfterFollow` is supplied, it runs after position/scale have been
 *  applied and receives the target node + its world matrix — used by sub-gizmos
 *  to refresh their drag axis / root rotation when in local-coordinate mode. */
export function attachFollowTarget(
    scene: SceneContext,
    gizmoRoot: SceneNode,
    getTarget: () => SceneNode | null,
    scaleRatio: number | null = null,
    onAfterFollow?: (target: SceneNode, worldMatrix: Mat4) => void
): () => void {
    let stopped = false;
    onBeforeRender(scene, () => {
        if (stopped) {
            return;
        }
        const t = getTarget();
        if (!t) {
            return;
        }
        const wm = t.worldMatrix;
        const tx = wm[12]!,
            ty = wm[13]!,
            tz = wm[14]!;
        gizmoRoot.position.set(tx, ty, tz);
        if (scaleRatio !== null && scene.camera) {
            const cw = scene.camera.worldMatrix;
            // BJS Gizmo._update scales the gizmo by the PROJECTED depth of the
            // gizmo along the camera's forward axis (not the Euclidean distance),
            // so off-centre gizmos stay the same on-screen size as centred ones:
            //   scale = scaleRatio · dot(gizmoPos − cameraPos, cameraForward)
            // The camera world matrix's column 2 (cw[8..10]) is its forward
            // direction (local +Z mapped to world).  Using Euclidean distance
            // instead over-scales side objects, pushing arrow cones / scale
            // boxes too far from the origin.
            const ox = tx - cw[12]!;
            const oy = ty - cw[13]!;
            const oz = tz - cw[14]!;
            const fx = cw[8]!,
                fy = cw[9]!,
                fz = cw[10]!;
            const dist = (ox * fx + oy * fy + oz * fz) * scaleRatio;
            gizmoRoot.scaling.set(dist, dist, dist);
        }
        if (onAfterFollow) {
            onAfterFollow(t, wm);
        }
    });
    return () => {
        stopped = true;
    };
}

/** Tiny single-event observable used by gizmos/pointer-drag (no dependency on
 *  BJS's Observable, no module-level allocations). */
export class GizmoObservable<T> {
    private _subs: ((arg: T) => void)[] = [];

    add(cb: (arg: T) => void): () => void {
        this._subs.push(cb);
        return () => {
            const i = this._subs.indexOf(cb);
            if (i >= 0) {
                this._subs.splice(i, 1);
            }
        };
    }

    notify(arg: T): void {
        for (const s of this._subs) {
            s(arg);
        }
    }

    clear(): void {
        this._subs.length = 0;
    }
}
