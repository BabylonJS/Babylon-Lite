import type { Camera } from "../camera/camera.js";
import type { SceneChangeEvent, SceneContext } from "../scene/scene-core.js";
import { onSceneChange, onSceneDispose } from "../scene/scene-change.js";
import type { SceneNode } from "../scene/scene-node.js";
import {
    addAccessibilityNode,
    batchAccessibilityUpdates,
    createAccessibilityTree,
    disposeAccessibilityTree,
    removeAccessibilityNode,
    snapshotAccessibilityTag,
    updateAccessibilityNode,
} from "./accessibility-tree.js";
import type { AccessibilityNode, AccessibilityTag, AccessibilityTree } from "./accessibility-tree.js";
import { observeProperty } from "./observe-property.js";

type SceneSource = SceneNode | Camera;

/** Optional roots for transform-only objects that the rendering scene does not retain. */
export interface SceneAccessibilityOptions {
    roots?: readonly SceneSource[];
}

interface SourceBinding {
    node: AccessibilityNode;
    unsubscribe: (() => void)[];
}

/** Semantic projection owned by one scene. */
export interface SceneAccessibility {
    readonly tree: AccessibilityTree;
    /** @internal */
    _scene: SceneContext;
    /** @internal */
    _automatic: Set<SceneSource>;
    /** @internal */
    _explicit: Set<SceneSource>;
    /** @internal */
    _parents: Map<SceneSource, SceneSource | null>;
    /** @internal */
    _bindings: Map<SceneSource, SourceBinding>;
    /** @internal */
    _unobserveCamera: () => void;
    /** @internal */
    _unsubscribeSceneChanges: () => void;
    /** @internal */
    _unsubscribeSceneDispose: () => void;
    /** @internal */
    _pending: boolean;
    /** @internal */
    _disposed: boolean;
}

let tags: WeakMap<object, AccessibilityTag> | undefined;
let tagListeners: WeakMap<object, Set<() => void>> | undefined;
let sceneBindings: WeakMap<SceneContext, SceneAccessibility> | undefined;

function isSceneSource(value: unknown): value is SceneSource {
    return typeof value === "object" && value !== null && "children" in value && Array.isArray(value.children) && "worldMatrix" in value;
}

function sceneChanged(adapter: SceneAccessibility, event: SceneChangeEvent): void {
    const source = event.entity;
    if (!isSceneSource(source)) {
        return;
    }
    if (event.type === "added") {
        if (!(("_gpu" in source && "material" in source) || "lightType" in source)) {
            adapter._automatic.add(source);
        }
    } else {
        adapter._automatic.delete(source);
    }
    schedule(adapter);
}

function sourceParent(source: SceneSource): SceneSource | null {
    const parent = "parent" in source ? source.parent : null;
    return isSceneSource(parent) ? parent : null;
}

function projectRuntimeHidden(tag: AccessibilityTag | null, hidden: boolean): AccessibilityTag | null {
    if (!tag || !hidden) {
        return tag;
    }
    const hasAriaHidden = tag.aria ? "aria-hidden" in tag.aria : false;
    if (tag.hidden !== false && (!hasAriaHidden || String(tag.aria?.["aria-hidden"]) === "true")) {
        return tag;
    }
    return Object.freeze({
        ...tag,
        hidden: true,
        aria: hasAriaHidden ? Object.freeze({ ...tag.aria, "aria-hidden": true }) : tag.aria,
    });
}

function sourceState(source: SceneSource): Pick<AccessibilityNode, "tag" | "hidden" | "disabled"> {
    const authored = getAccessibilityTag(source);
    const runtimeHidden = ("_disposed" in source && source._disposed === true) || ("visible" in source && source.visible === false);
    const snapshot = authored
        ? Object.freeze({
              ...authored,
              name: authored.name ?? (authored.description === undefined ? source.name : undefined),
              aria: authored.aria ? Object.freeze({ ...authored.aria }) : undefined,
          })
        : null;
    const tag = projectRuntimeHidden(snapshot, runtimeHidden);
    return {
        tag,
        hidden: runtimeHidden || tag?.hidden === true || String(tag?.aria?.["aria-hidden"]) === "true",
        disabled: tag?.disabled === true || String(tag?.aria?.["aria-disabled"]) === "true",
    };
}

function schedule(adapter: SceneAccessibility): void {
    if (adapter._pending || adapter._disposed) {
        return;
    }
    adapter._pending = true;
    queueMicrotask(() => {
        adapter._pending = false;
        if (!adapter._disposed) {
            updateSceneAccessibility(adapter);
        }
    });
}

function observeSource(adapter: SceneAccessibility, source: SceneSource, binding: SourceBinding): void {
    for (const property of ["name", "visible", "_disposed", "parent"]) {
        binding.unsubscribe.push(observeProperty(source, property, () => schedule(adapter)));
    }
    const listeners = (tagListeners ??= new WeakMap()).get(source) ?? new Set<() => void>();
    tagListeners.set(source, listeners);
    const changed = (): void => schedule(adapter);
    listeners.add(changed);
    binding.unsubscribe.push(() => {
        listeners.delete(changed);
        if (!listeners.size) {
            tagListeners?.delete(source);
        }
    });
}

function collectAncestors(source: SceneSource, desired: Set<SceneSource>): void {
    for (let current: SceneSource | null = source; current && !desired.has(current); current = sourceParent(current)) {
        desired.add(current);
    }
}

function collectSubtree(source: SceneSource, desired: Set<SceneSource>): void {
    collectAncestors(source, desired);
    for (const child of source.children) {
        if (sourceParent(child) === source) {
            collectSubtree(child, desired);
        }
    }
}

function desiredSources(adapter: SceneAccessibility): Set<SceneSource> {
    const desired = new Set<SceneSource>();
    for (const source of [...adapter._scene.meshes, ...adapter._scene.lights]) {
        if (isSceneSource(source)) {
            collectAncestors(source, desired);
        }
    }
    for (const source of adapter._automatic) {
        collectAncestors(source, desired);
    }
    for (const source of adapter._explicit) {
        collectSubtree(source, desired);
    }
    if (adapter._scene.camera) {
        collectSubtree(adapter._scene.camera, desired);
    }
    return desired;
}

function semanticParent(adapter: SceneAccessibility, source: SceneSource, desired: Set<SceneSource>): SceneSource | null {
    const parent = adapter._parents.has(source) ? adapter._parents.get(source)! : sourceParent(source);
    return parent && desired.has(parent) ? parent : null;
}

function ensureBinding(adapter: SceneAccessibility, source: SceneSource, desired: Set<SceneSource>, creating: Set<SceneSource>): SourceBinding {
    let binding = adapter._bindings.get(source);
    if (!binding) {
        if (creating.has(source)) {
            throw new Error("Accessibility parent would create a cycle.");
        }
        creating.add(source);
        const parent = semanticParent(adapter, source, desired);
        const parentBinding = parent ? ensureBinding(adapter, parent, desired, creating) : undefined;
        binding = {
            node: addAccessibilityNode(adapter.tree, { target: source, parent: parentBinding?.node ?? null, ...sourceState(source) }),
            unsubscribe: [],
        };
        adapter._bindings.set(source, binding);
        observeSource(adapter, source, binding);
        creating.delete(source);
    }
    return binding;
}

function disposeBinding(binding: SourceBinding): void {
    for (const unsubscribe of binding.unsubscribe) {
        unsubscribe();
    }
}

function reconcileBinding(adapter: SceneAccessibility, source: SceneSource, desired: Set<SceneSource>, reconciling: Set<SceneSource>, reconciled: Set<SceneSource>): void {
    if (reconciled.has(source)) {
        return;
    }
    if (reconciling.has(source)) {
        throw new Error("Accessibility parent would create a cycle.");
    }
    reconciling.add(source);
    const parent = semanticParent(adapter, source, desired);
    if (parent) {
        reconcileBinding(adapter, parent, desired, reconciling, reconciled);
    }
    const binding = adapter._bindings.get(source)!;
    updateAccessibilityNode(adapter.tree, binding.node, {
        ...sourceState(source),
        parent: parent ? adapter._bindings.get(parent)!.node : null,
        target: source,
    });
    reconciling.delete(source);
    reconciled.add(source);
}

/** Synchronize the semantic tree immediately. Normal property writes are coalesced to a microtask. */
export function updateSceneAccessibility(adapter: SceneAccessibility): void {
    if (adapter._disposed) {
        return;
    }
    const desired = desiredSources(adapter);
    batchAccessibilityUpdates(adapter.tree, () => {
        for (const [source, parent] of adapter._parents) {
            if (!desired.has(source) || (parent !== null && !desired.has(parent))) {
                adapter._parents.delete(source);
            }
        }
        const creating = new Set<SceneSource>();
        for (const source of desired) {
            ensureBinding(adapter, source, desired, creating);
        }
        const reconciling = new Set<SceneSource>();
        const reconciled = new Set<SceneSource>();
        for (const source of desired) {
            reconcileBinding(adapter, source, desired, reconciling, reconciled);
        }
        for (const [source, binding] of [...adapter._bindings]) {
            if (desired.has(source)) {
                continue;
            }
            disposeBinding(binding);
            adapter._bindings.delete(source);
            if (adapter.tree._nodes.has(binding.node)) {
                removeAccessibilityNode(adapter.tree, binding.node);
            }
        }
    });
}

/** Replace or remove one object's accessibility metadata. */
export function setAccessibilityTag(source: object, tag: AccessibilityTag | null): void {
    const snapshot = snapshotAccessibilityTag(tag);
    if (snapshot) {
        (tags ??= new WeakMap()).set(source, snapshot);
    } else {
        tags?.delete(source);
    }
    for (const listener of [...(tagListeners?.get(source) ?? [])]) {
        listener();
    }
}

/** Return the immutable metadata currently attached to an object. */
export function getAccessibilityTag(source: object): AccessibilityTag | null {
    return tags?.get(source) ?? null;
}

/** Return the stable logical node for a scene object. */
export function getAccessibilityNode(adapter: SceneAccessibility, source: SceneSource): AccessibilityNode | undefined {
    return adapter._bindings.get(source)?.node;
}

function validateSemanticParent(adapter: SceneAccessibility, source: SceneSource, parent: SceneSource | null): void {
    const visited = new Set<SceneSource>();
    for (let current = parent; current; current = adapter._parents.has(current) ? adapter._parents.get(current)! : sourceParent(current)) {
        if (current === source || visited.has(current)) {
            throw new Error("Accessibility parent would create a cycle.");
        }
        visited.add(current);
    }
}

/** Override semantic grouping without changing the render transform. Pass undefined to restore natural parentage. */
export function setAccessibilityParent(adapter: SceneAccessibility, source: SceneSource, parent: SceneSource | null | undefined): void {
    if (adapter._disposed) {
        throw new Error("Scene accessibility is disposed.");
    }
    validateSemanticParent(adapter, source, parent === undefined ? sourceParent(source) : parent);
    if (parent === undefined) {
        adapter._parents.delete(source);
    } else {
        adapter._parents.set(source, parent);
    }
    schedule(adapter);
}

/** Bind a scene to a headless accessibility tree. A scene can own one projection at a time. */
export function createSceneAccessibility(scene: SceneContext, options: SceneAccessibilityOptions = {}): SceneAccessibility {
    if (scene._z) {
        throw new Error("Cannot create accessibility for a disposed scene.");
    }
    if (sceneBindings?.has(scene)) {
        throw new Error("The scene already has an accessibility projection.");
    }
    const adapter: SceneAccessibility = {
        tree: createAccessibilityTree(),
        _scene: scene,
        _automatic: new Set(),
        _explicit: new Set(options.roots ?? []),
        _parents: new Map(),
        _bindings: new Map(),
        _unobserveCamera: () => {},
        _unsubscribeSceneChanges: () => {},
        _unsubscribeSceneDispose: () => {},
        _pending: false,
        _disposed: false,
    };
    (sceneBindings ??= new WeakMap()).set(scene, adapter);
    try {
        adapter._unsubscribeSceneChanges = onSceneChange(scene, (event) => sceneChanged(adapter, event));
        adapter._unsubscribeSceneDispose = onSceneDispose(scene, () => disposeSceneAccessibility(adapter));
        adapter._unobserveCamera = observeProperty(scene, "camera", () => schedule(adapter));
        updateSceneAccessibility(adapter);
        return adapter;
    } catch (error) {
        disposeSceneAccessibility(adapter);
        throw error;
    }
}

/** Dispose the scene binding and its tree. */
export function disposeSceneAccessibility(adapter: SceneAccessibility): void {
    if (adapter._disposed) {
        return;
    }
    adapter._disposed = true;
    adapter._unsubscribeSceneChanges();
    adapter._unsubscribeSceneDispose();
    adapter._unobserveCamera();
    for (const binding of adapter._bindings.values()) {
        disposeBinding(binding);
    }
    adapter._bindings.clear();
    adapter._automatic.clear();
    adapter._explicit.clear();
    adapter._parents.clear();
    if (sceneBindings?.get(adapter._scene) === adapter) {
        sceneBindings.delete(adapter._scene);
    }
    disposeAccessibilityTree(adapter.tree);
}
