/** Declarative descriptions, roles, and ARIA attributes for a scene object. */
export interface AccessibilityTag {
    name?: string;
    description?: string;
    role?: string;
    /** Remove the object and its descendants from the accessible representation. */
    hidden?: boolean;
    /** Report that the object and its descendants are unavailable. */
    disabled?: boolean;
    aria?: Readonly<Record<`aria-${string}`, string | number | boolean | null | undefined>>;
}

/** Options used to register or update one logical object. */
export interface AccessibilityNodeOptions {
    tag?: AccessibilityTag | null;
    parent?: AccessibilityNode | null;
    /** Insert before a sibling; null appends. Omit to preserve the current position. */
    before?: AccessibilityNode | null;
    hidden?: boolean;
    disabled?: boolean;
    /** Application object represented by this node. Accessibility never disposes it. */
    target?: object;
}

/** One object in an accessibility tree. Change it through {@link updateAccessibilityNode}. */
export interface AccessibilityNode {
    tag: AccessibilityTag | null;
    parent: AccessibilityNode | null;
    readonly children: readonly AccessibilityNode[];
    hidden: boolean;
    disabled: boolean;
    target?: object;
    /** @internal */
    _children: AccessibilityNode[];
    /** @internal */
    _authoredHidden?: boolean;
    /** @internal */
    _authoredDisabled?: boolean;
}

/** Logical hierarchy independent of a DOM renderer. */
export interface AccessibilityTree {
    readonly roots: readonly AccessibilityNode[];
    readonly disposed: boolean;
    /** @internal */
    _roots: AccessibilityNode[];
    /** @internal */
    _nodes: Set<AccessibilityNode>;
    /** @internal */
    _listeners: Set<() => void>;
    /** @internal */
    _disposed: boolean;
    /** @internal */
    _batchDepth: number;
    /** @internal */
    _dirty: boolean;
}

/** @internal Validate and freeze an accessibility tag before publication. */
export function snapshotAccessibilityTag(tag: AccessibilityTag | null | undefined): AccessibilityTag | null {
    if (!tag) {
        return null;
    }
    for (const [key, value] of Object.entries(tag.aria ?? {})) {
        if (!/^aria-[a-z-]+$/.test(key) || (value != null && !["string", "number", "boolean"].includes(typeof value)) || (typeof value === "number" && !Number.isFinite(value))) {
            throw new Error(`Invalid ARIA attribute: ${key}`);
        }
    }
    const snapshot = Object.freeze({
        ...tag,
        aria: tag.aria ? Object.freeze({ ...tag.aria }) : undefined,
    });
    validateState({}, snapshot);
    return snapshot;
}

function stateValue(authored: boolean | undefined, tag: AccessibilityTag | null, state: "hidden" | "disabled"): boolean {
    const aria = state === "hidden" ? "aria-hidden" : "aria-disabled";
    return authored ?? tag?.[state] ?? String(tag?.aria?.[aria]) === "true";
}

function tagsEqual(a: AccessibilityTag | null, b: AccessibilityTag | null): boolean {
    if (a === b) {
        return true;
    }
    if (!a || !b || a.name !== b.name || a.description !== b.description || a.role !== b.role || a.hidden !== b.hidden || a.disabled !== b.disabled) {
        return false;
    }
    const aEntries = Object.entries(a.aria ?? {});
    const bAria = b.aria ?? {};
    return aEntries.length === Object.keys(bAria).length && aEntries.every(([key, value]) => Object.hasOwn(bAria, key) && Object.is(value, bAria[key as `aria-${string}`]));
}

function validateState(options: AccessibilityNodeOptions, tag: AccessibilityTag | null): void {
    for (const [state, aria] of [
        ["hidden", "aria-hidden"],
        ["disabled", "aria-disabled"],
    ] as const) {
        const values = [options[state], tag?.[state], tag?.aria?.[aria]].filter((value) => value !== undefined && value !== null).map(String);
        if (new Set(values).size > 1) {
            throw new Error(`Conflicting accessibility state: ${state} and ${aria}.`);
        }
    }
}

function requireTree(tree: AccessibilityTree, node?: AccessibilityNode | null): void {
    if (tree.disposed) {
        throw new Error("Accessibility tree is disposed.");
    }
    if (node && !tree._nodes.has(node)) {
        throw new Error("Accessibility node does not belong to this tree.");
    }
}

function notify(tree: AccessibilityTree): void {
    if (tree._batchDepth) {
        tree._dirty = true;
        return;
    }
    const errors: unknown[] = [];
    for (const listener of [...tree._listeners]) {
        try {
            listener();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length) {
        throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Accessibility tree observers failed.");
    }
}

/** Create an empty accessibility tree. This function does not access the DOM. */
export function createAccessibilityTree(): AccessibilityTree {
    const roots: AccessibilityNode[] = [];
    return {
        roots,
        _roots: roots,
        _nodes: new Set(),
        _listeners: new Set(),
        _disposed: false,
        _batchDepth: 0,
        _dirty: false,
        get disposed() {
            return this._disposed;
        },
    };
}

/** Coalesce a synchronous group of mutations into one notification. */
export function batchAccessibilityUpdates(tree: AccessibilityTree, update: () => void): void {
    requireTree(tree);
    tree._batchDepth++;
    try {
        update();
    } finally {
        tree._batchDepth--;
        if (!tree._batchDepth && tree._dirty) {
            tree._dirty = false;
            notify(tree);
        }
    }
}

/** Observe completed tree changes. The returned function removes the observer. */
export function onAccessibilityTreeChanged(tree: AccessibilityTree, listener: () => void): () => void {
    requireTree(tree);
    tree._listeners.add(listener);
    return () => tree._listeners.delete(listener);
}

function siblings(tree: AccessibilityTree, parent: AccessibilityNode | null): AccessibilityNode[] {
    return parent?._children ?? tree._roots;
}

function validatePosition(tree: AccessibilityTree, parent: AccessibilityNode | null, before: AccessibilityNode | null | undefined): void {
    requireTree(tree, parent);
    if (before && (!tree._nodes.has(before) || before.parent !== parent)) {
        throw new Error("Accessibility ordering requires a sibling in the same tree.");
    }
}

/** Register one logical object. */
export function addAccessibilityNode(tree: AccessibilityTree, options: AccessibilityNodeOptions): AccessibilityNode {
    requireTree(tree);
    const parent = options.parent ?? null;
    validatePosition(tree, parent, options.before);
    const tag = snapshotAccessibilityTag(options.tag);
    validateState(options, tag);
    const children: AccessibilityNode[] = [];
    const node: AccessibilityNode = {
        tag,
        parent,
        children,
        _children: children,
        _authoredHidden: options.hidden,
        _authoredDisabled: options.disabled,
        hidden: stateValue(options.hidden, tag, "hidden"),
        disabled: stateValue(options.disabled, tag, "disabled"),
        target: options.target,
    };
    tree._nodes.add(node);
    const items = siblings(tree, parent);
    items.splice(options.before ? items.indexOf(options.before) : items.length, 0, node);
    notify(tree);
    return node;
}

function detach(tree: AccessibilityTree, node: AccessibilityNode): void {
    const items = siblings(tree, node.parent);
    const index = items.indexOf(node);
    if (index !== -1) {
        items.splice(index, 1);
    }
}

/** Apply a partial update while preserving node identity. */
export function updateAccessibilityNode(tree: AccessibilityTree, node: AccessibilityNode, patch: AccessibilityNodeOptions): void {
    requireTree(tree, node);
    const tag = "tag" in patch ? snapshotAccessibilityTag(patch.tag) : node.tag;
    const authoredHidden = patch.hidden === undefined ? node._authoredHidden : patch.hidden;
    const authoredDisabled = patch.disabled === undefined ? node._authoredDisabled : patch.disabled;
    const hidden = stateValue(authoredHidden, tag, "hidden");
    const disabled = stateValue(authoredDisabled, tag, "disabled");
    validateState({ hidden: authoredHidden, disabled: authoredDisabled }, tag);
    const parent = patch.parent === undefined ? node.parent : patch.parent;
    validatePosition(tree, parent, patch.before);
    for (let current = parent; current; current = current.parent) {
        if (current === node) {
            throw new Error("Accessibility parent would create a cycle.");
        }
    }
    let changed =
        ("tag" in patch && !tagsEqual(tag, node.tag)) ||
        hidden !== node.hidden ||
        disabled !== node.disabled ||
        ("target" in patch && patch.target !== node.target) ||
        parent !== node.parent;
    if (parent !== node.parent) {
        detach(tree, node);
        node.parent = parent;
        const items = siblings(tree, node.parent);
        items.splice(patch.before ? items.indexOf(patch.before) : items.length, 0, node);
    } else if (patch.before !== undefined && patch.before !== node) {
        const items = siblings(tree, node.parent);
        const index = items.indexOf(node);
        const positioned = patch.before ? index + 1 === items.indexOf(patch.before) : index === items.length - 1;
        if (!positioned) {
            detach(tree, node);
            items.splice(patch.before ? items.indexOf(patch.before) : items.length, 0, node);
            changed = true;
        }
    }
    if ("tag" in patch) {
        if (!tagsEqual(tag, node.tag)) {
            node.tag = tag;
        }
    }
    if (patch.hidden !== undefined || "tag" in patch) {
        node._authoredHidden = authoredHidden;
        node.hidden = hidden;
    }
    if (patch.disabled !== undefined || "tag" in patch) {
        node._authoredDisabled = authoredDisabled;
        node.disabled = disabled;
    }
    if ("target" in patch) {
        node.target = patch.target;
    }
    if (changed) {
        notify(tree);
    }
}

function release(tree: AccessibilityTree, node: AccessibilityNode): void {
    for (const child of [...node.children]) {
        release(tree, child);
    }
    node._children.length = 0;
    node.parent = null;
    node.tag = null;
    node.target = undefined;
    node._authoredHidden = undefined;
    node._authoredDisabled = undefined;
    tree._nodes.delete(node);
}

/** Remove a node and its descendants. */
export function removeAccessibilityNode(tree: AccessibilityTree, node: AccessibilityNode): void {
    requireTree(tree, node);
    detach(tree, node);
    release(tree, node);
    notify(tree);
}

/** Dispose the tree and release all observers. */
export function disposeAccessibilityTree(tree: AccessibilityTree): void {
    if (tree.disposed) {
        return;
    }
    for (const root of [...tree.roots]) {
        release(tree, root);
    }
    tree._roots.length = 0;
    tree._disposed = true;
    try {
        notify(tree);
    } finally {
        tree._listeners.clear();
    }
}
