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

import { setAccessibilityTag, type AccessibilityTag } from "babylon-lite";

import type { Scene } from "../scene/scene.js";
import type { WebGPUEngine } from "../engine/engine.js";
import type { AbstractMesh } from "../meshes/meshes.js";
import { Vector3 } from "../math/vector.js";
import { Observable } from "../misc/observable.js";
import { unsupported } from "../error.js";

type AccessibilityRole =
    | "toolbar"
    | "tooltip"
    | "feed"
    | "math"
    | "presentation"
    | "none"
    | "note"
    | "application"
    | "article"
    | "cell"
    | "columnheader"
    | "definition"
    | "directory"
    | "document"
    | "figure"
    | "group"
    | "heading"
    | "img"
    | "list"
    | "listitem"
    | "meter"
    | "row"
    | "rowgroup"
    | "rowheader"
    | "separator"
    | "table"
    | "term"
    | "scrollbar"
    | "searchbox"
    | "slider"
    | "spinbutton"
    | "switch"
    | "tab"
    | "tabpanel"
    | "treeitem"
    | "combobox"
    | "menu"
    | "menubar"
    | "tablist"
    | "tree"
    | "treegrid"
    | "banner"
    | "complementary"
    | "contentinfo"
    | "form"
    | "main"
    | "navigation"
    | "region"
    | "search"
    | "alert"
    | "log"
    | "marquee"
    | "status"
    | "timer"
    | "alertdialog"
    | "dialog";

type AccessibilityAria =
    | "aria-autocomplete"
    | "aria-checked"
    | "aria-disabled"
    | "aria-errormessage"
    | "aria-expanded"
    | "aria-haspopup"
    | "aria-hidden"
    | "aria-invalid"
    | "aria-label"
    | "aria-level"
    | "aria-modal"
    | "aria-multiline"
    | "aria-multiselectable"
    | "aria-orientation"
    | "aria-placeholder"
    | "aria-pressed"
    | "aria-readonly"
    | "aria-required"
    | "aria-selected"
    | "aria-sort"
    | "aria-valuemax"
    | "aria-valuemin"
    | "aria-valuenow"
    | "aria-valuetext"
    | "aria-busy"
    | "aria-live"
    | "aria-relevant"
    | "aria-atomic"
    | "aria-dropeffect"
    | "aria-grabbed"
    | "aria-activedescendant"
    | "aria-colcount"
    | "aria-colindex"
    | "aria-colspan"
    | "aria-controls"
    | "aria-describedby"
    | "aria-description"
    | "aria-details"
    | "aria-flowto"
    | "aria-labelledby"
    | "aria-owns"
    | "aria-posinset"
    | "aria-rowcount"
    | "aria-rowindex"
    | "aria-rowspan"
    | "aria-setsize";

export interface IAccessibilityTag {
    description?: string;
    eventHandler?: { [K in keyof HTMLElementEventMap]: (event?: Event) => void };
    role?: AccessibilityRole;
    aria?: { [K in AccessibilityAria]: any };
}

function toLiteAriaValue(value: unknown): string | number | boolean | null | undefined {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return String(value);
}

let _uniqueIdCounter = 0;

export abstract class Node {
    public name: string;
    /** String id. Defaults to the name (Babylon.js parity). */
    public id: string;
    /** Process-unique numeric id, assigned at construction. */
    public readonly uniqueId: number;
    /** Free-form user data slot (Babylon.js `Node.metadata`). */
    public metadata: unknown = null;
    public readonly onDisposeObservable = new Observable<Node>();
    public onAccessibilityTagChangedObservable = new Observable<IAccessibilityTag | null>();

    /** @internal Owning compat scene, when constructed against one. */
    protected _scene: Scene | undefined;
    /** @internal */
    protected _parent: Node | null = null;
    /** @internal Direct children, maintained as `parent` / `setParent` links change. */
    protected readonly _children: Node[] = [];
    /** @internal */
    protected _enabled = true;
    /** @internal Effective enabled state inherited from the parent chain. */
    protected _parentEnabled = true;
    /** @internal */
    protected _disposed = false;
    /** @internal Babylon.js preserves the assigned tag object rather than returning Lite's immutable snapshot. */
    protected _accessibilityTag: IAccessibilityTag | null = null;
    /** @internal Monotonic guard preventing a re-entrant observer assignment from being overwritten in Lite. */
    private _accessibilityTagAssignment = 0;

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

    public get accessibilityTag(): IAccessibilityTag | null {
        return this._accessibilityTag;
    }
    public set accessibilityTag(value: IAccessibilityTag | null) {
        if (value?.eventHandler && Object.keys(value.eventHandler).length) {
            unsupported(
                "Node.accessibilityTag.eventHandler",
                "Lite's HTML-twin renderer does not expose an event-listener registration and disposal seam; adding one requires changing its existing DOM lifecycle."
            );
        }
        const assignment = ++this._accessibilityTagAssignment;
        this._accessibilityTag = value;
        this.onAccessibilityTagChangedObservable.notifyObservers(value);
        if (assignment === this._accessibilityTagAssignment) {
            this._syncAccessibilityTag();
        }
    }

    /** @internal Resolve the plain Lite scene object owned by the concrete wrapper. */
    protected _accessibilitySource(): object | null {
        const wrapper = this as unknown as { _node?: object; _lite?: object };
        return wrapper._node ?? wrapper._lite ?? null;
    }

    /** @internal Forward the current tag when a deferred wrapper acquires or changes its Lite source. */
    protected _syncAccessibilityTag(previousSource?: object | null): void {
        const source = this._accessibilitySource();
        if (previousSource && previousSource !== source) {
            setAccessibilityTag(previousSource, null);
        }
        if (source) {
            setAccessibilityTag(source, this._accessibilityTag ? this._toLiteAccessibilityTag(this._accessibilityTag) : null);
        }
    }

    /** @internal Translate the Babylon.js tag into Lite's metadata-only shape. */
    private _toLiteAccessibilityTag(value: IAccessibilityTag): AccessibilityTag {
        const aria = value.aria ? Object.fromEntries(Object.entries(value.aria).map(([key, entry]) => [key, toLiteAriaValue(entry)])) : undefined;
        return {
            description: value.description,
            role: value.role,
            aria: aria as AccessibilityTag["aria"],
        };
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
        this._syncParentEnabledState();
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

    /**
     * Babylon.js `node.getHierarchyBoundingVectors(includeDescendants?, predicate?)`
     * — world-space bounds spanning this mesh and eligible descendant meshes.
     */
    public getHierarchyBoundingVectors(includeDescendants = true, predicate: ((mesh: AbstractMesh) => boolean) | null = null): { min: Vector3; max: Vector3 } {
        const min = new Vector3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
        const max = new Vector3(-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE);

        if (this._isMeshNode()) {
            const boundingBox = (this as unknown as AbstractMesh).getBoundingInfo().boundingBox;
            min.copyFrom(boundingBox.minimumWorld);
            max.copyFrom(boundingBox.maximumWorld);
        }

        if (includeDescendants) {
            for (const descendant of this.getDescendants()) {
                const descendantMesh = descendant as AbstractMesh;
                if ((predicate && !predicate(descendantMesh)) || !descendant._isMeshNode() || descendantMesh.getTotalVertices() === 0) {
                    continue;
                }
                const boundingBox = descendantMesh.getBoundingInfo().boundingBox;
                min.minimizeInPlace(boundingBox.minimumWorld);
                max.maximizeInPlace(boundingBox.maximumWorld);
            }
        }

        return { min, max };
    }

    public isEnabled(checkAncestors = true): boolean {
        return this._enabled && (!checkAncestors || this._parentEnabled);
    }

    public setEnabled(value: boolean): void {
        if (this._enabled === value) {
            return;
        }
        this._enabled = value;
        this._syncParentEnabledState();
    }

    /** @internal Refresh this subtree after a local enabled or parent change. */
    protected _syncParentEnabledState(): void {
        this._parentEnabled = this._parent?.isEnabled() ?? true;
        this._onEffectiveEnabledStateChanged(this.isEnabled());
        for (const child of this._children) {
            child._syncParentEnabledState();
        }
    }

    /** @internal Hook for wrappers that must materialize effective enabled state in Lite. */
    protected _onEffectiveEnabledStateChanged(_enabled: boolean): void {
        // Base nodes carry no Lite-side enabled state.
    }

    public isDisposed(): boolean {
        return this._disposed;
    }

    public dispose(doNotRecurse = false): void {
        this._disposeWrapperTree(doNotRecurse);
    }

    /** @internal Dispose this node's subclass-owned resources. */
    protected _disposeSelf(_doNotRecurse: boolean): void {
        // Base nodes own no external resources.
    }

    /** @internal Dispose this compat wrapper tree in post-order. */
    public _disposeWrapperTree(doNotRecurse = false): void {
        this._disposeWrapperTreeInternal(doNotRecurse, true);
    }

    /**
     * @internal Retire a loader-owned wrapper without disposing its Lite node.
     * Asset-container teardown removes the native nodes as one ownership unit.
     */
    public _disposeWrapperOnly(): void {
        this._disposeWrapperTreeInternal(true, false);
    }

    /** @internal Shared wrapper lifecycle for ordinary and container-owned disposal. */
    private _disposeWrapperTreeInternal(doNotRecurse: boolean, disposeSelf: boolean): void {
        if (this._disposed) {
            return;
        }
        if (doNotRecurse) {
            for (const child of [...this._children]) {
                child.parent = null;
            }
        } else {
            for (const child of [...this._children]) {
                child._disposeWrapperTreeInternal(false, disposeSelf);
            }
        }
        if (disposeSelf) {
            this._disposeSelf(doNotRecurse);
        }
        this._disposed = true;
        let hasError = false;
        let firstError: unknown;
        try {
            this.onDisposeObservable.notifyObservers(this);
        } catch (error) {
            hasError = true;
            firstError = error;
        } finally {
            this.onDisposeObservable.clear();
        }
        try {
            this._linkParent(null);
        } catch (error) {
            if (!hasError) {
                hasError = true;
                firstError = error;
            }
        }
        try {
            this._scene?._unregisterNode(this);
        } catch (error) {
            if (!hasError) {
                hasError = true;
                firstError = error;
            }
        }
        if (hasError) {
            throw firstError;
        }
    }

    /** @internal Hook for subclasses to wire the parent link into the Lite scene graph. */
    protected _applyParent(_parent: Node | null): void {
        // Base node has no Lite handle to reparent; TransformNode overrides this.
    }
}
