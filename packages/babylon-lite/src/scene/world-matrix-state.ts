/** Shared version-based lazy world matrix computation.
 *
 *  Each entity provides only getLocalMatrix(). This module handles:
 *  - version tracking (_worldVersion bumped by own TRS changes and ancestor motion)
 *  - caching and staleness detection (_cachedWorld nulled on any change)
 *  - PUSH dirty propagation: a transform write invalidates the node AND all of its
 *    descendants up front, so per-frame consumers can read worldMatrixVersion in
 *    O(1) (a plain field read) instead of walking the parent chain.
 *
 *  Ancestor-only motion (e.g. animating a parent transform node) must bump a
 *  descendant's worldMatrixVersion so per-frame consumers re-upload its UBO.
 *  Rather than have each node PULL up its parent chain on every read, this module
 *  keeps its own child registry (driven by the reliably-called `parent` setter, NOT
 *  the host's `children` array which loaders/setParent maintain inconsistently) and
 *  PUSHES invalidation down on every local change or reparent. Reads are O(1) (a
 *  plain field read); writers pay an O(subtree) push. This is a clear win for the
 *  common case (few movers, many readers) and never worse than the old pull walk.
 *
 *  Foreign parents — an IWorldMatrixProvider that is not tagged with our state
 *  symbol (e.g. a user-supplied object) — cannot be pushed to because we never see
 *  their writes. For those we keep a cheap PULL fallback that polls the parent's
 *  public version on read. All in-engine hosts (mesh, scene node, camera, light,
 *  Gaussian-splatting mesh) ARE tagged, so engine hierarchies are pure push.
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
    /** Call when own TRS changes. Invalidates cache + subtree, forces recompute. */
    markLocalDirty(): void;
    /** Reference to parent — set directly. */
    parent: IWorldMatrixProvider | null;
}

/** Internal contract exposed via the state symbol so a parent can push invalidation
 *  into a child's closure and a child can (de)register itself in its parent's list,
 *  all without going through the host's public property getters. */
interface WorldMatrixStateInternal extends WorldMatrixAccessors {
    /** Push: mark this node and its whole subtree dirty (clean-guarded). */
    _invalidate(): void;
    /** Register a same-module child so future invalidations reach it. */
    _addChild(child: WorldMatrixStateInternal): void;
    /** Deregister a child (reparent away). */
    _removeChild(child: WorldMatrixStateInternal): void;
}

const WM_STATE = Symbol("wmState");

/** Tag a host object (mesh, scene node, camera, light, …) with its world-matrix
 *  state so children can register for push invalidation and call its accessor
 *  closures directly, bypassing the host's property getters. */
export function attachWorldMatrixState(host: object, state: WorldMatrixAccessors): void {
    (host as unknown as Record<symbol, unknown>)[WM_STATE] = state;
}

function peekWorldMatrixState(p: IWorldMatrixProvider | null): WorldMatrixStateInternal | null {
    if (p === null) {
        return null;
    }
    const s = (p as unknown as Record<symbol, unknown>)[WM_STATE];
    return (s as WorldMatrixStateInternal | undefined) ?? null;
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
    let _parentState: WorldMatrixStateInternal | null = null;
    const _children: WorldMatrixStateInternal[] = [];

    // Mark this node — and, transitively, its whole subtree — dirty, bumping the
    // version so per-frame consumers (which gate UBO uploads on worldMatrixVersion)
    // re-upload. Propagation is eager and unconditional: consumers may never read a
    // pure transform node's world matrix, so a "skip if already dirty" guard would
    // strand its descendants on a stale version when an ancestor moves every frame.
    // Caching is still lazy — getWorldMatrix recomputes only when _cachedWorld is
    // null — so reads stay cheap; only writers pay the O(subtree) push.
    function invalidate(): void {
        _cachedWorld = null;
        _worldVersion++;
        for (const child of _children) {
            child._invalidate();
        }
    }

    // Foreign parent (not tagged with our symbol): we never observe its writes, so
    // poll its public version on read and push a subtree invalidation when it moved.
    function pollForeignParent(): void {
        const pv = (_parent as IWorldMatrixProvider).worldMatrixVersion;
        if (pv !== _lastSeenParentVersion) {
            _lastSeenParentVersion = pv;
            invalidate();
        }
    }

    const state: WorldMatrixStateInternal = {
        get parent(): IWorldMatrixProvider | null {
            return _parent;
        },
        set parent(p: IWorldMatrixProvider | null) {
            if (p === _parent) {
                return;
            }
            if (_parentState !== null) {
                _parentState._removeChild(state);
            }
            _parent = p;
            _parentState = peekWorldMatrixState(p);
            if (_parentState !== null) {
                _parentState._addChild(state);
            }
            _lastSeenParentVersion = -1;
            // Reparenting changes our world transform → dirty us and the subtree.
            invalidate();
        },

        markLocalDirty(): void {
            invalidate();
        },

        getWorldMatrix(): Mat4 {
            if (_parentState === null && _parent !== null) {
                pollForeignParent();
            }
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
            if (_parentState === null && _parent !== null) {
                pollForeignParent();
            }
            return _worldVersion;
        },

        _invalidate(): void {
            invalidate();
        },

        _addChild(child: WorldMatrixStateInternal): void {
            _children.push(child);
        },

        _removeChild(child: WorldMatrixStateInternal): void {
            const i = _children.indexOf(child);
            if (i >= 0) {
                _children.splice(i, 1);
            }
        },
    };

    return state;
}
