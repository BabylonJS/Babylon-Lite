/** Shared version-based lazy world matrix computation.
 *
 *  Each entity provides only getLocalMatrix(). This module handles:
 *  - version tracking (_localVersion, _worldVersion, _lastParentVersion)
 *  - parent chain validation (recursive parent.worldMatrix call)
 *  - caching and staleness detection
 *
 *  The allocator is taken at construction time — entities pass through the
 *  one from their owning engine (`engine._matrixPolicy.allocator`). With HPM
 *  off this is the default F32 allocator; with HPM on it's the F64 allocator.
 *  No rebind step exists or is needed; the engine's precision is fixed at
 *  `createEngine` time and entities created against that engine inherit it. */

import type { Mat4 } from "../math/types.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/_mat4-storage.js";
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
}

/**
 * Create world matrix state for any entity type.
 *
 * @param allocator - Per-engine matrix allocator (F32 or F64 depending on
 *   `useHighPrecisionMatrix`). Entities obtain this from
 *   `engine._matrixPolicy.allocator` at construction.
 * @param getLocalMatrix - Entity-specific function that returns the local (pre-parent)
 *   transform matrix. Called only when the cache is stale.
 */
export function createWorldMatrixState(allocator: MatrixAllocator, getLocalMatrix: () => Mat4): WorldMatrixAccessors {
    let _localVersion = 0;
    let _worldVersion = 0;
    let _lastLocalVersion = -1;
    let _lastParentVersion = -1;
    let _cachedWorld: Mat4 | null = null;
    const _ownedWorld: Mat4 = allocator.allocate();
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
                mat4MultiplyInto(_ownedWorld as unknown as Mat4Storage, 0, pw as unknown as Mat4Storage, 0, local as unknown as Mat4Storage, 0);
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
