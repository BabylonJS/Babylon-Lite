/** glTF `camera` node property (no extension — core glTF 2.0 spec, §5.20 "camera").
 *  Parses the asset's top-level `cameras` array and instantiates one Lite camera per
 *  referencing node, exposing every imported camera via `AssetContainer.cameras`.
 *
 *  cx20's gltf-test compat matrix (https://github.com/cx20/gltf-test) flags Babylon Lite
 *  with ":warning: embedded camera" for VirtualCity because, before this feature, `loadGltf`
 *  silently dropped `node.camera` and exposed no way to select one of the file's 14 cameras.
 *  This feature closes that gap for both perspective and orthographic glTF cameras.
 *
 *  Two corrections preserve the source hierarchy without mutating the shared source node
 *  (a sibling mesh on the same glTF node, if any, must keep its own winding/scale):
 *
 *  1. Handedness. `load-gltf.ts` builds the node hierarchy under a synthetic `__root__` whose
 *     `scale.x = -1` performs the engine's single RH→LH conversion (`buildNodeHierarchy`).
 *     That mirror is correct for mesh winding but flips a camera's chirality — a camera whose
 *     world matrix has a mirrored (negative-determinant) basis renders an inside-out view.
 *     Babylon.js's own glTF loader hits the same issue and fixes it by setting
 *     `scaling.x = -1` on the camera's hosting TransformNode (`glTFLoader.ts`
 *     `loadNodeAsync`, "Cancelling root node scaling for handedness so the view matrix does
 *     not end up flipped").
 *
 *  2. Inherited uniform scale. The default `getViewMatrix` fast path transposes an orthonormal
 *     basis, so the fixup cancels the camera node's accumulated static uniform scale
 *     (VirtualCity carries ~0.0254). Camera projection parameters remain in their source glTF
 *     units, matching Babylon.js. Zero/non-uniform scale is rejected explicitly. */

import type { GltfFeature } from "./gltf-feature.js";
import type { Camera } from "../camera/camera.js";
import { createFreeCamera } from "../camera/free-camera.js";
import { createTransformNode } from "../scene/transform-node.js";
import { createSceneNodeFromMatrix } from "../scene/scene-node.js";
import { computeNodeWorldMatrix } from "./gltf-parser.js";
import { _registerEnabledGltfFeature } from "./gltf-feature-hooks.js";

interface GltfCameraDef {
    type?: "perspective" | "orthographic";
    name?: string;
    perspective?: { yfov: number; znear: number; zfar?: number };
    orthographic?: { xmag: number; ymag: number; znear: number; zfar: number };
}

/** Far plane substituted when a glTF perspective camera omits `zfar` — the spec's way of
 *  requesting an "infinite" projection. Lite's perspective matrix builder wants a finite
 *  value; this is large enough for any practical scene while staying inside F32 precision. */
const INFINITE_FAR_PLANE = 1e6;

function basisLength(matrix: ArrayLike<number>, column: number): number {
    const offset = column * 4;
    return Math.hypot(matrix[offset]!, matrix[offset + 1]!, matrix[offset + 2]!);
}

const feature: GltfFeature = {
    id: "_gltf_camera",
    async applyAsset(_meshes, _root, ctx) {
        const defs: GltfCameraDef[] | undefined = ctx._json.cameras;
        if (!defs?.length) {
            return {};
        }
        const nodes = ctx._json.nodes ?? [];
        const cameras: Camera[] = [];
        for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
            const camIdx: number | undefined = nodes[nodeIdx]?.camera;
            if (camIdx === undefined) {
                continue;
            }
            const def = defs[camIdx];
            if (!def) {
                continue;
            }

            // Rest-pose accumulated world matrix for the unreachable-node fallback below.
            const restWorld = computeNodeWorldMatrix(ctx._json, nodeIdx, ctx._parentMap, ctx._worldMatrixCache);
            const sx = basisLength(restWorld, 0);
            const sy = basisLength(restWorld, 1);
            const sz = basisLength(restWorld, 2);
            const worldScale = (sx + sy + sz) / 3;
            if (worldScale < 1e-8 || Math.max(sx, sy, sz) - Math.min(sx, sy, sz) > worldScale * 1e-4) {
                throw new Error("glTF camera nodes require non-zero uniform scale");
            }

            const inverseScale = 1 / worldScale;
            const fixupNode = createTransformNode(`${def.name ?? `camera${camIdx}`}_fixup`, 0, 0, 0, 0, 0, 0, 1, -inverseScale, inverseScale, inverseScale);
            const sourceNode = ctx._nodeMap?.[nodeIdx];
            if (sourceNode) {
                // Live parent: node TRS animation (classic channels or KHR_animation_pointer)
                // drives the camera every frame through the normal parent chain.
                fixupNode.parent = sourceNode;
            } else {
                // Node unreachable from any scene root — bake its world transform once instead
                // of parenting, mirroring the KHR_lights_punctual fallback for the same case.
                fixupNode.parent = createSceneNodeFromMatrix(`camera${camIdx}_bakedNode`, restWorld);
            }

            // glTF cameras look down their local -Z axis with +Y up. createFreeCamera's lookAt
            // builder reproduces exactly that local orientation for an eye at the origin
            // looking toward (0,0,-1) — mat4LookAtWorldLHToRef: "+Z points from eye to target".
            const cam = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
            cam.name = def.name ?? `camera${camIdx}`;
            cam.parent = fixupNode;

            if (def.type === "orthographic" && def.orthographic) {
                const o = def.orthographic;
                cam.nearPlane = o.znear;
                cam.farPlane = o.zfar;
                // Lazy: orthographic support is opt-in engine-wide (see camera/orthographic.ts),
                // so a perspective-only asset like VirtualCity never pays for it.
                const { enableOrthographicCamera } = await import("../camera/orthographic.js");
                const xmag = o.xmag;
                const ymag = o.ymag;
                enableOrthographicCamera(cam, { halfHeight: ymag, left: -xmag, right: xmag, bottom: -ymag, top: ymag });
            } else if (def.perspective) {
                const p = def.perspective;
                cam.fov = p.yfov;
                cam.nearPlane = p.znear;
                cam.farPlane = p.zfar ?? INFINITE_FAR_PLANE;
            }

            cameras.push(cam);
        }
        return cameras.length ? { cameras } : {};
    },
};

let enabled = false;

/** Enable glTF camera import for subsequent `loadGltf` calls. Idempotent and tree-shakable. */
export function enableGltfCameras(): void {
    if (!enabled) {
        enabled = true;
        _registerEnabledGltfFeature((json) => !!json.cameras?.length, feature);
    }
}

export default feature;
