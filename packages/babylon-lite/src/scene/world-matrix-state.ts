/** Shared version-based lazy world matrix computation.
 *
 *  Each entity provides only getLocalMatrix(). This module handles:
 *  - version tracking (_worldVersion bumped by own TRS changes and ancestor motion)
 *  - parent chain validation (version-only walk via detectParentChange)
 *  - caching and staleness detection (_cachedWorld nulled on any change)
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

    // Detect whether an ancestor moved since we last looked. This is a pure
    // version-only walk up the parent chain (no matrix math): it bumps our own
    // version and invalidates our cached matrix when a parent's version changed.
    // Both getWorldMatrix and getWorldMatrixVersion run it so that ancestor-only
    // changes (e.g. animating a parent transform node) are observed even when
    // nothing reads this node's world matrix directly.
    function detectParentChange(): void {
        if (_parent === null) {
            return;
        }
        const pv = _parent.worldMatrixVersion;
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
                _lastSeenParentVersion = -1;
                _worldVersion++;
                _cachedWorld = null;
            }
        },

        markLocalDirty(): void {
            _worldVersion++;
            _cachedWorld = null;
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
