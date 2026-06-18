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

    public isEnabled(): boolean {
        return this._enabled;
    }

    public setEnabled(value: boolean): void {
        this._enabled = value;
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
