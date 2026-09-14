/** Shared light base — world matrix state + dirty callback used by all light factories.
 *  Eliminates boilerplate repeated across hemispheric, directional, point, and spot lights. */

import type { Mat4, Mat4Storage } from "../math/types.js";
import type { LightBase } from "./types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { initSceneNodeTransform } from "../scene/scene-node.js";
import type { ObservableVec3 } from "../math/observable-vec3.js";

export { ObservableVec3 } from "../math/observable-vec3.js";

/** Monotonically increasing version counter — bumped whenever any UBO-relevant
 *  property changes (position, direction, intensity, color, range, etc.).
 *  Shared across all lights created from the same createLightBase call. */
export interface LightVersionState {
    /** @internal */
    _lightVersion: number;
    b(): void;
}

/** Create the SceneNode transform and version state shared by all light types. */
export function createLightBase(position: readonly [number, number, number]): { node: SceneNode; lvs: LightVersionState } {
    const lvs: LightVersionState = {
        _lightVersion: 0,
        b() {
            lvs._lightVersion++;
        },
    };
    return { node: initSceneNodeTransform({ name: "", children: [] }, position[0], position[1], position[2]), lvs };
}

/** Write a normalized world-space direction from a light matrix. Parent scale
 *  must not change lighting intensity or spotlight cone tests. */
export function writeWorldLightDirection(data: Float32Array, offset: number, world: Mat4, direction: ObservableVec3): void {
    const x = world[0]! * direction.x + world[4]! * direction.y + world[8]! * direction.z;
    const y = world[1]! * direction.x + world[5]! * direction.y + world[9]! * direction.z;
    const z = world[2]! * direction.x + world[6]! * direction.y + world[10]! * direction.z;
    const invLength = 1 / (Math.hypot(x, y, z) || 1);
    data[offset] = x * invLength;
    data[offset + 1] = y * invLength;
    data[offset + 2] = z * invLength;
}

/** Add light-specific state to a SceneNode and return the same object. */
export function applyLightBase<R>(node: SceneNode, target: object, lvs?: LightVersionState): R {
    Object.assign(node, target);
    if (lvs) {
        Object.defineProperty(node, "_lightVersion", {
            get() {
                return lvs._lightVersion + node.worldMatrixVersion;
            },
            enumerable: false,
            configurable: true,
        });
        // Direct scalar/array writes cannot notify, so expose the version-only bump without
        // dirtying the world matrix (unlike a no-op ObservableVec3 set).
        (node as { _bumpLightVersion?: () => void })._bumpLightVersion = lvs.b;
    }
    return node as R;
}

/** Copy the common SceneNode and light-filter state into a freshly created light clone. */
export function copyLightBase(source: LightBase, clone: LightBase): void {
    clone.name = source.name + "_clone";
    clone.position.copyFrom(source.position);
    clone.rotationQuaternion.copyFrom(source.rotationQuaternion);
    clone.scaling.copyFrom(source.scaling);
    clone.visible = source.visible;
    clone.metadata = source.metadata;
    clone.excludedMeshIds = source.excludedMeshIds;
    clone.includedOnlyMeshIds = source.includedOnlyMeshIds;
    if (source._localMatrix) {
        clone._localMatrix = (source._localMatrix as unknown as Mat4Storage).slice() as unknown as Mat4;
    }
}
