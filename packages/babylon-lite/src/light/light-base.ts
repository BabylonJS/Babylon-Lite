/** Shared light base — world matrix state + dirty callback used by all light factories.
 *  Eliminates boilerplate repeated across hemispheric, directional, point, and spot lights. */

import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import type { IWorldMatrixProvider } from "../scene/parentable.js";
import { createWorldMatrixState, type WorldMatrixAccessors } from "../scene/world-matrix-state.js";

export { ObservableVec3 } from "../math/observable-vec3.js";

/** Monotonically increasing version counter — bumped whenever any UBO-relevant
 *  property changes (position, direction, intensity, color, range, etc.).
 *  Shared across all lights created from the same createLightBase call. */
export interface LightVersionState {
    _lightVersion: number;
    bump(): void;
}

/** Create the world-matrix state + dirty callback shared by all light types.
 *  `engine` provides the matrix allocator captured at engine creation — F32
 *  by default, F64 when HPM is enabled. Returns `lvs` — a version state that
 *  callers bump when non-position properties change. */
export function createLightBase(engine: EngineContext, getLocalMatrix: () => Mat4): { wm: WorldMatrixAccessors; onDirty: () => void; lvs: LightVersionState } {
    const wm = createWorldMatrixState((engine as EngineContextInternal)._matrixPolicy, getLocalMatrix);
    const lvs: LightVersionState = {
        _lightVersion: 0,
        bump() {
            lvs._lightVersion++;
        },
    };
    const onDirty = () => {
        wm.markLocalDirty();
        lvs._lightVersion++;
    };
    return { wm, onDirty, lvs };
}

/** Mixin world-matrix accessors (parent, worldMatrix, worldMatrixVersion) onto a light object.
 *  Also adds _lightVersion from the LightVersionState. Returns the same object reference
 *  typed as R (defineProperties adds the accessors at runtime). */
export function applyWorldMatrixAccessors<R>(target: object, wm: WorldMatrixAccessors, lvs?: LightVersionState): R {
    Object.defineProperties(target, {
        parent: {
            get() {
                return wm.parent;
            },
            set(v: IWorldMatrixProvider | null) {
                wm.parent = v;
            },
            enumerable: true,
            configurable: true,
        },
        worldMatrix: {
            get() {
                return wm.getWorldMatrix();
            },
            enumerable: true,
            configurable: true,
        },
        worldMatrixVersion: {
            get() {
                return wm.getWorldMatrixVersion();
            },
            enumerable: true,
            configurable: true,
        },
    });
    if (lvs) {
        Object.defineProperty(target, "_lightVersion", {
            get() {
                return lvs._lightVersion;
            },
            enumerable: false,
            configurable: true,
        });
    }
    return target as R;
}
