/**
 * Babylon.js-compatible `Node` — the base of the scene-graph class hierarchy.
 *
 * In Babylon.js every scene object derives from `Node`
 * (`Mesh → AbstractMesh → TransformNode → Node`, `Camera → Node`,
 * `Light → Node`). The compat layer mirrors that chain so `instanceof` checks and
 * inherited members (`getScene`, `parent`, `getClassName`, `dispose`, …) behave as
 * ported code expects, even where intermediate classes are only partial.
 *
 * `Node` itself holds the cross-cutting state every scene object shares: name/id,
 * a unique id, an owning scene, a parent link, and enabled/disposed flags.
 */

import type { Scene } from "../scene/scene.js";
import type { WebGPUEngine } from "../engine/engine.js";
import { Observable } from "../misc/observable.js";

let _uniqueIdCounter = 0;

export abstract class Node {
    public name: string;
    /** String id. Defaults to the name (Babylon.js parity). */
    public id: string;
    /** Process-unique numeric id, assigned at construction. */
    public readonly uniqueId: number;
    /** Free-form user data slot (Babylon.js `Node.metadata`). */
    public metadata: unknown = null;

    /** @internal Owning compat scene, when constructed against one. */
    protected _scene: Scene | undefined;
    /** @internal */
    protected _parent: Node | null = null;
    /** @internal Direct children, maintained as `parent` / `setParent` links change. */
    protected readonly _children: Node[] = [];
    /** @internal */
    protected _enabled = true;
    /** @internal */
    protected _disposed = false;
    /** @internal Lazily-allocated so nodes that never observe enabled changes pay no cost. */
    private _onEnabledStateChangedObservable: Observable<boolean> | null = null;
    /** @internal Lazily-allocated effective-enabled observable. */
    private _onEffectiveEnabledStateChangedObservable: Observable<boolean> | null = null;

    protected constructor(name: string, scene?: Scene) {
        this.name = name;
        this.id = name;
        this.uniqueId = ++_uniqueIdCounter;
        this._scene = scene;
    }

    /** The runtime class name (overridden by each subclass). */
    public getClassName(): string {
        return "Node";
    }

    /** The scene this node belongs to, if any. */
    public getScene(): Scene | undefined {
        return this._scene;
    }

    /** The engine backing this node's scene, if any. */
    public getEngine(): WebGPUEngine | undefined {
        return this._scene?.getEngine();
    }

    public get parent(): Node | null {
        return this._parent;
    }
    public set parent(value: Node | null) {
        this._linkParent(value);
        this._applyParent(value);
    }

    /**
     * @internal Update the parent link and both nodes' child registries. Shared by
     * the `parent` setter and `TransformNode.setParent` (which differ only in how
     * the Lite-side transform is reparented, handled by their own callers).
     */
    protected _linkParent(value: Node | null): void {
        if (this._parent === value) {
            return;
        }
        // Reparenting can flip this subtree's effective enabled state (e.g. moving a
        // node under a disabled ancestor), so diff it the same way `setEnabled` does.
        const captured = this._captureEffectiveEnabled();
        if (this._parent) {
            const i = this._parent._children.indexOf(this);
            if (i !== -1) {
                this._parent._children.splice(i, 1);
            }
        }
        this._parent = value;
        if (value && !value._children.includes(this)) {
            value._children.push(this);
        }
        this._settleEffectiveEnabled(captured);
    }

    /** @internal Whether this node is an `AbstractMesh` (overridden there) — drives `getChildMeshes`. */
    protected _isMeshNode(): boolean {
        return false;
    }

    /**
     * Babylon.js `node.getDescendants(directDescendantsOnly?, predicate?)` — the
     * nodes parented (directly or transitively) under this one, optionally filtered.
     */
    public getDescendants(directDescendantsOnly = false, predicate?: (node: Node) => boolean): Node[] {
        const results: Node[] = [];
        const collect = (node: Node): void => {
            for (const child of node._children) {
                if (!predicate || predicate(child)) {
                    results.push(child);
                }
                if (!directDescendantsOnly) {
                    collect(child);
                }
            }
        };
        collect(this);
        return results;
    }

    /**
     * Babylon.js `node.getChildren(predicate?, directDescendantsOnly?)` — descendant
     * nodes (direct children by default), optionally filtered by a predicate.
     */
    public getChildren(predicate?: (node: Node) => boolean, directDescendantsOnly = true): Node[] {
        return this.getDescendants(directDescendantsOnly, predicate);
    }

    /**
     * Babylon.js `node.getChildMeshes(directDescendantsOnly?, predicate?)` — the
     * descendant nodes that are meshes (all descendants by default).
     */
    public getChildMeshes(directDescendantsOnly = false, predicate?: (node: Node) => boolean): Node[] {
        return this.getDescendants(directDescendantsOnly, (node) => node._isMeshNode() && (!predicate || predicate(node)));
    }

    public isEnabled(checkAncestors = true): boolean {
        if (checkAncestors === false) {
            return this._enabled;
        }
        // Effective enabled state: false if this node or any ancestor is disabled.
        if (!this._enabled) {
            return false;
        }
        for (let node = this._parent; node; node = node._parent) {
            if (!node._enabled) {
                return false;
            }
        }
        return true;
    }

    public setEnabled(value: boolean): void {
        if (this._enabled === value) {
            return;
        }
        const captured = this._captureEffectiveEnabled();
        this._enabled = value;
        this._settleEffectiveEnabled(captured);
        this._onEnabledStateChangedObservable?.notifyObservers(value);
    }

    /**
     * @internal Hook fired on this node when its **effective** enabled state — the value
     * {@link isEnabled}() returns — flips, whether because its own flag changed or an
     * ancestor's did. Subclasses that mirror the state onto a Lite object (`Light` zeroes
     * its intensity, `AbstractMesh` hides itself) override this instead of `setEnabled`,
     * so ancestor-driven changes are handled too. Runs after the whole subtree's state has
     * settled and before any observable fires.
     */
    protected _onEffectiveEnabledChanged(_effective: boolean): void {}

    /**
     * @internal Snapshot this node's subtree and each member's effective enabled state,
     * ready for {@link _settleEffectiveEnabled} to diff against once the change lands.
     */
    private _captureEffectiveEnabled(): { subtree: Node[]; before: boolean[] } {
        const subtree = [this, ...this.getDescendants(false)];
        return { subtree, before: subtree.map((n) => n.isEnabled(true)) };
    }

    /**
     * @internal Re-evaluate a captured subtree: run `_onEffectiveEnabledChanged` on every
     * node whose effective state flipped, then fire their observables. Hooks run before any
     * observer so the whole subtree is consistent by the time user code sees the change.
     */
    private _settleEffectiveEnabled({ subtree, before }: { subtree: Node[]; before: boolean[] }): void {
        const flipped: { node: Node; now: boolean }[] = [];
        for (let i = 0; i < subtree.length; i++) {
            const node = subtree[i]!;
            const now = node.isEnabled(true);
            if (now !== before[i]) {
                flipped.push({ node, now });
            }
        }
        for (const { node, now } of flipped) {
            node._onEffectiveEnabledChanged(now);
        }
        for (const { node, now } of flipped) {
            node._onEffectiveEnabledStateChangedObservable?.notifyObservers(now);
        }
    }

    /**
     * Babylon.js `node.onEnabledStateChangedObservable` — fires when this node's own
     * enabled flag changes (via {@link setEnabled}), not when an ancestor's does.
     */
    public get onEnabledStateChangedObservable(): Observable<boolean> {
        return (this._onEnabledStateChangedObservable ??= new Observable<boolean>());
    }

    /**
     * Babylon.js `node.onEffectiveEnabledStateChangedObservable` — fires whenever the
     * value returned by {@link isEnabled}() (with ancestor checks) changes, including
     * changes caused by an ancestor's enabled state. Created on first access.
     */
    public get onEffectiveEnabledStateChangedObservable(): Observable<boolean> {
        return (this._onEffectiveEnabledStateChangedObservable ??= new Observable<boolean>());
    }

    public isDisposed(): boolean {
        return this._disposed;
    }

    public dispose(): void {
        this._disposed = true;
        // Detach from the parent's child registry, then drop this node from its
        // scene's camera / light / mesh registries.
        this._linkParent(null);
        this._scene?._unregisterNode(this);
    }

    /** @internal Hook for subclasses to wire the parent link into the Lite scene graph. */
    protected _applyParent(_parent: Node | null): void {
        // Base node has no Lite handle to reparent; TransformNode overrides this.
    }
}
