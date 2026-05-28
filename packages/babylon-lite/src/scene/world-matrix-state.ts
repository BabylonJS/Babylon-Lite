/** Shared version-based lazy world matrix computation.
 *
 *  Each entity provides only getLocalMatrix(). This module handles:
 *  - version tracking (_localVersion, _worldVersion, _lastParentVersion)
 *  - parent chain validation (recursive parent.worldMatrix call)
 *  - caching and staleness detection
 *
 *  Zero entity imports — depends only on Mat4 and mat4Multiply. */

import type { Mat4 } from "../math/types.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import { asMat4Storage } from "../math/_mat4-storage.js";
import type { MatrixAllocator } from "../math/_matrix-allocator.js";

export interface WorldMatrixAccessors {
    /** Getter — returns lazily computed world matrix. */
    getWorldMatrix(): Mat4;
    /** Getter — returns current version. */
    getWorldMatrixVersion(): number;
    /** Call when own TRS changes. Invalidates cache, forces recompute on next read. */
    markLocalDirty(): void;
    /** Reference to parent — set directly. */
    parent: IWorldMatrixProvider | null;
    /** @internal Reallocate `_ownedWorld` from the given allocator and invalidate caches.
     *  Called by `bindEntityMatrixPolicy` when the owning entity attaches to a scene. */
    _rebindAllocator(allocator: MatrixAllocator): void;
}

/**
 * Create world matrix state for any entity type.
 *
 * @param getLocalMatrix - Entity-specific function that returns the local (pre-parent)
 *   transform matrix. Called only when the cache is stale.
 */
export function createWorldMatrixState(getLocalMatrix: () => Mat4): WorldMatrixAccessors {
    let _localVersion = 0;
    let _worldVersion = 0;
    let _lastLocalVersion = -1;
    let _lastParentVersion = -1;
    let _cachedWorld: Mat4 | null = null;
    // Default storage is F32 — re-allocated through _rebindAllocator at scene-attach
    // time if the scene's policy is F64. Production code always rebinds before the
    // first read; the F32 default keeps standalone entity construction working.
    let _ownedWorld: Mat4 = new Float32Array(16) as unknown as Mat4;
    let _parent: IWorldMatrixProvider | null = null;

    return {
        get parent(): IWorldMatrixProvider | null {
            return _parent;
        },
        set parent(p: IWorldMatrixProvider | null) {
            if (p !== _parent) {
                _parent = p;
                _cachedWorld = null;
            }
        },

        markLocalDirty(): void {
            _localVersion++;
            _worldVersion++;
            _cachedWorld = null;
        },

        _rebindAllocator(allocator: MatrixAllocator): void {
            _ownedWorld = allocator.allocate();
            _cachedWorld = null;
            _lastLocalVersion = -1;
            _lastParentVersion = -1;
        },

        getWorldMatrix(): Mat4 {
            // Fast path: cache valid + local unchanged
            if (_cachedWorld !== null && _localVersion === _lastLocalVersion) {
                if (_parent === null) {
                    return _cachedWorld;
                }
                // Walk parent chain (triggers lazy recompute if stale)
                void _parent.worldMatrix;
                if (_parent.worldMatrixVersion === _lastParentVersion) {
                    return _cachedWorld;
                }
            }

            // Recompute
            const local = getLocalMatrix();
            if (_parent !== null) {
                const pw = _parent.worldMatrix;
                mat4MultiplyInto(asMat4Storage(_ownedWorld), 0, asMat4Storage(pw), 0, asMat4Storage(local), 0);
                _cachedWorld = _ownedWorld;
            } else {
                _cachedWorld = local;
            }

            _lastLocalVersion = _localVersion;
            _lastParentVersion = _parent?.worldMatrixVersion ?? -1;
            _worldVersion++;
            return _cachedWorld;
        },

        getWorldMatrixVersion(): number {
            return _worldVersion;
        },
    };
}
