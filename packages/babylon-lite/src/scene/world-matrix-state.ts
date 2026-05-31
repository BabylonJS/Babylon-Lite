/** Shared version-based lazy world matrix computation.
 *
 *  Each entity provides only getLocalMatrix(). This module handles:
 *  - version tracking (_worldVersion bumped by own TRS changes and ancestor motion)
 *  - parent chain validation (version-only walk via detectParentChange)
 *  - caching and staleness detection (_cachedWorld nulled on any change)
 *
 *  Ancestor-only motion (e.g. animating a parent transform node) must bump a
 *  descendant's worldMatrixVersion so per-frame consumers re-upload its UBO.
 *  Because this module holds no child references, that detection is a PULL walk
 *  up the parent chain. To keep it cheap in deep hierarchies it is gated by a
 *  global "transform write epoch": every local TRS change (markLocalDirty) and
 *  reparent bumps the epoch, so a node need re-walk its ancestors only when
 *  something, somewhere, has changed since it last validated. Within a stable
 *  period (e.g. the render phase, after all animation writes) repeated reads of
 *  the same node are O(1). The walk also calls the parent's accessor closure
 *  directly (via the attached _parentState) to skip the host's property getter.
 *
 *  Zero entity imports — depends only on Mat4 and mat4Multiply. */

import type { Mat4 } from "../math/types.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";

export interface WorldMatrixAccessors {
    /** Getter — returns lazily computed world matrix. */
    getWorldMatrix(): Mat4;
    /** Getter — returns current version. */
    getWorldMatrixVersion(): number;
    /** Call when own TRS changes. Invalidates cache, forces recompute on next read. */
    markLocalDirty(): void;
    /** Reference to parent — set directly. */
    parent: IWorldMatrixProvider | null;
}

/** Monotonic counter bumped whenever ANY node's local transform changes or a
 *  reparent happens. Lets descendants skip re-walking their parent chain when
 *  nothing has changed globally since they last validated. */
let _globalTransformEpoch = 1;

const WM_STATE = Symbol("wmState");

/** Tag a host object (mesh, scene node, light, …) with its world-matrix state so
 *  children can call the parent's accessor closure directly, bypassing the host's
 *  property getter on the hot parent-chain walk. */
export function attachWorldMatrixState(host: object, state: WorldMatrixAccessors): void {
    (host as Record<symbol, unknown>)[WM_STATE] = state;
}

function peekWorldMatrixState(p: IWorldMatrixProvider | null): WorldMatrixAccessors | null {
    if (p === null) {
        return null;
    }
    const s = (p as unknown as Record<symbol, unknown>)[WM_STATE];
    return (s as WorldMatrixAccessors | undefined) ?? null;
}

/**
 * Create world matrix state for any entity type.
 *
 * @param getLocalMatrix - Entity-specific function that returns the local (pre-parent)
 *   transform matrix. Called only when the cache is stale.
 */
export function createWorldMatrixState(getLocalMatrix: () => Mat4): WorldMatrixAccessors {
    let _worldVersion = 0;
    let _lastSeenParentVersion = -1;
    let _cachedWorld: Mat4 | null = null;
    const _ownedWorld = new Float32Array(16) as Mat4;
    let _parent: IWorldMatrixProvider | null = null;
    let _parentState: WorldMatrixAccessors | null = null;
    let _validatedEpoch = 0;

    // Detect whether an ancestor moved since we last looked. This bumps our own
    // version and invalidates our cached matrix when a parent's version changed.
    // Both getWorldMatrix and getWorldMatrixVersion run it so that ancestor-only
    // changes (e.g. animating a parent transform node) are observed even when
    // nothing reads this node's world matrix directly.
    //
    // For same-module parents (_parentState !== null) the walk is gated by the
    // global transform epoch: any local change anywhere bumps the epoch, so when
    // our _validatedEpoch is current nothing in the chain can have moved and we
    // skip the walk. Reading the parent's version via its accessor closure
    // synchronously validates the parent first, so the chain stays consistent
    // regardless of read order. Foreign parents (e.g. a camera with its own
    // accessor implementation) may change without bumping our epoch, so for them
    // we always poll the public version.
    function detectParentChange(): void {
        if (_parent === null) {
            return;
        }
        let pv: number;
        if (_parentState !== null) {
            if (_validatedEpoch === _globalTransformEpoch) {
                return;
            }
            _validatedEpoch = _globalTransformEpoch;
            pv = _parentState.getWorldMatrixVersion();
        } else {
            pv = _parent.worldMatrixVersion;
        }
        if (pv !== _lastSeenParentVersion) {
            _lastSeenParentVersion = pv;
            _worldVersion++;
            _cachedWorld = null;
        }
    }

    return {
        get parent(): IWorldMatrixProvider | null {
            return _parent;
        },
        set parent(p: IWorldMatrixProvider | null) {
            if (p !== _parent) {
                _parent = p;
                _parentState = peekWorldMatrixState(p);
                _lastSeenParentVersion = -1;
                _validatedEpoch = 0;
                _worldVersion++;
                _cachedWorld = null;
                _globalTransformEpoch++;
            }
        },

        markLocalDirty(): void {
            _worldVersion++;
            _cachedWorld = null;
            _globalTransformEpoch++;
        },

        getWorldMatrix(): Mat4 {
            detectParentChange();
            if (_cachedWorld !== null) {
                return _cachedWorld;
            }
            const local = getLocalMatrix();
            if (_parent !== null) {
                const pw = _parent.worldMatrix;
                mat4MultiplyInto(_ownedWorld as Float32Array, 0, pw as Float32Array, 0, local as Float32Array, 0);
                _cachedWorld = _ownedWorld;
            } else {
                _cachedWorld = local;
            }
            return _cachedWorld;
        },

        getWorldMatrixVersion(): number {
            detectParentChange();
            return _worldVersion;
        },
    };
}
