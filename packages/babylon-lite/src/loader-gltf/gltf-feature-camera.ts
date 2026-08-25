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
import { computeNodeWorldMatrix, findParent } from "./gltf-parser.js";
import { _registerEnabledGltfFeature } from "./gltf-feature-hooks.js";

interface GltfCameraDef {
    type?: "perspective" | "orthographic";
    name?: string;
    perspective?: { yfov: number; znear: number; zfar?: number };
    orthographic?: { xmag: number; ymag: number; znear: number; zfar: number };
}

function findChangingScaleAncestor(json: any, nodeIdx: number, parentMap: Map<number, number>): number | undefined {
    for (let ancestor = nodeIdx; ancestor >= 0; ancestor = findParent(parentMap, ancestor)) {
        const rest = json.nodes?.[ancestor]?.scale ?? [1, 1, 1];
        for (const animation of json.animations ?? []) {
            for (const channel of animation.channels ?? []) {
                const target = channel.target;
                if (target?.path === "scale" ? target.node !== ancestor : target?.extensions?.KHR_animation_pointer?.pointer !== `/nodes/${ancestor}/scale`) {
                    continue;
                }
                const sampler = animation.samplers?.[channel.sampler];
                const accessor = json.accessors?.[sampler?.output];
                if (
                    sampler?.interpolation === "CUBICSPLINE" ||
                    !accessor?.min ||
                    !accessor.max ||
                    [...accessor.min, ...accessor.max].some((value: number, axis: number) => Math.abs(value - rest[axis % 3]) / Math.max(0.01, Math.abs(rest[axis % 3])) > 1e-5)
                ) {
                    return ancestor;
                }
            }
        }
    }
    return;
}

const feature: GltfFeature = {
    id: "_camera",
    async applyAsset(_meshes, _root, ctx) {
        const defs: GltfCameraDef[] = ctx._json.cameras;
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
            const perspective = def.perspective;
            const orthographic = def.orthographic;
            const params =
                def.type === "perspective"
                    ? [perspective?.yfov, perspective?.znear]
                    : def.type === "orthographic"
                      ? [orthographic?.xmag, orthographic?.ymag, orthographic?.znear, orthographic?.zfar]
                      : undefined;
            if (!params?.every(Number.isFinite)) {
                throw new Error(`glTF camera ${camIdx}: unsupported projection`);
            }
            const animatedScaleNode = findChangingScaleAncestor(ctx._json, nodeIdx, ctx._parentMap);
            if (animatedScaleNode !== undefined) {
                console.warn("[babylon-lite] Skipping glTF camera", camIdx, "animated scale on node", animatedScaleNode);
                continue;
            }

            // Rest-pose accumulated world matrix for the unreachable-node fallback below.
            const restWorld = computeNodeWorldMatrix(ctx._json, nodeIdx, ctx._parentMap, ctx._worldMatrixCache);
            const scale = [0, 4, 8].map((offset) => Math.hypot(restWorld[offset]!, restWorld[offset + 1]!, restWorld[offset + 2]!));
            const worldScale = (scale[0]! + scale[1]! + scale[2]!) / 3;
            if (worldScale < 1e-8 || Math.max(...scale) - Math.min(...scale) > worldScale * 1e-4) {
                throw new Error("glTF camera nodes require non-zero uniform scale");
            }

            const inverseScale = 1 / worldScale;
            const name = def.name ?? `camera${camIdx}`;
            const fixupNode = createTransformNode(`${name}_fixup`, 0, 0, 0, 0, 0, 0, 1, -inverseScale, inverseScale, inverseScale);
            // Unreachable nodes are baked once; reachable nodes retain live translation/rotation animation.
            fixupNode.parent = ctx._nodeMap?.[nodeIdx] ?? createSceneNodeFromMatrix(`${name}_bakedNode`, restWorld);

            // glTF cameras look down their local -Z axis with +Y up. createFreeCamera's lookAt
            // builder reproduces exactly that local orientation for an eye at the origin
            // looking toward (0,0,-1) — mat4LookAtWorldLHToRef: "+Z points from eye to target".
            const cam = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
            cam.name = name;
            cam.parent = fixupNode;

            if (def.type === "orthographic") {
                const o = orthographic!;
                cam.nearPlane = o.znear;
                cam.farPlane = o.zfar;
                // Lazy: orthographic support is opt-in engine-wide (see camera/orthographic.ts),
                // so a perspective-only asset like VirtualCity never pays for it.
                const { enableOrthographicCamera } = await import("../camera/orthographic.js");
                const xmag = o.xmag;
                const ymag = o.ymag;
                enableOrthographicCamera(cam, { halfHeight: ymag, left: -xmag, right: xmag, bottom: -ymag, top: ymag });
            } else {
                const p = perspective!;
                cam.fov = p.yfov;
                cam.nearPlane = p.znear;
                cam.farPlane = p.zfar ?? 1e6;
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
