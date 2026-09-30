import { onAccessibilityTreeChanged } from "./accessibility-tree.js";
import type { AccessibilityNode, AccessibilityTree } from "./accessibility-tree.js";

/** Options for a browser representation of an accessibility tree. */
export interface HtmlTwinOptions {
    parent: HTMLElement;
    /** Accessible name of the generated region. */
    label?: string;
}

interface HtmlTwinItem {
    element: HTMLDivElement;
    text: HTMLSpanElement;
}

/** A mounted HTML representation of an accessibility tree. */
export interface HtmlTwin {
    readonly element: HTMLDivElement;
    readonly tree: AccessibilityTree;
    /** @internal */
    _items: Map<AccessibilityNode, HtmlTwinItem>;
    /** @internal */
    _unsubscribe: () => void;
    /** @internal */
    _disposed: boolean;
}

function setAttribute(element: HTMLElement, name: string, value: string | null): void {
    if (value === null) {
        element.removeAttribute(name);
    } else {
        element.setAttribute(name, value);
    }
}

function itemFor(twin: HtmlTwin, node: AccessibilityNode): HtmlTwinItem {
    let item = twin._items.get(node);
    if (item) {
        return item;
    }
    const document = twin.element.ownerDocument;
    const element = document.createElement("div");
    const text = document.createElement("span");
    element.setAttribute("data-lite-accessibility-node", "");
    text.setAttribute("data-lite-accessibility-text", "");
    element.append(text);
    item = { element, text };
    twin._items.set(node, item);
    return item;
}

function updateItem(item: HtmlTwinItem, node: AccessibilityNode): void {
    const { element, text } = item;
    for (const attribute of [...element.attributes]) {
        if (attribute.name !== "data-lite-accessibility-node") {
            element.removeAttribute(attribute.name);
        }
    }
    const tag = node.tag;
    const name = tag?.name ?? tag?.description;
    const description = tag?.name ? tag.description : undefined;
    if (tag?.role) {
        element.setAttribute("role", tag.role);
    }
    if (name) {
        element.setAttribute("aria-label", name);
    }
    if (description) {
        element.setAttribute("aria-description", description);
    }
    element.hidden = node.hidden;
    if (node.disabled) {
        element.setAttribute("aria-disabled", "true");
    }
    for (const [key, value] of Object.entries(tag?.aria ?? {})) {
        setAttribute(element, key, value == null ? null : String(value));
    }
    text.textContent = [name, description].filter(Boolean).join(". ");
}

function renderChildren(twin: HtmlTwin, parent: HTMLElement, nodes: readonly AccessibilityNode[], active: Set<AccessibilityNode>): void {
    for (const node of nodes) {
        active.add(node);
        const item = itemFor(twin, node);
        updateItem(item, node);
        parent.append(item.element);
        renderChildren(twin, item.element, node.children, active);
    }
}

/** Synchronize the mounted DOM with the current tree. */
export function updateHtmlTwin(twin: HtmlTwin): void {
    if (twin._disposed) {
        return;
    }
    if (twin.tree.disposed) {
        disposeHtmlTwin(twin);
        return;
    }
    const active = new Set<AccessibilityNode>();
    renderChildren(twin, twin.element, twin.tree.roots, active);
    for (const [node, item] of twin._items) {
        if (!active.has(node)) {
            item.element.remove();
            twin._items.delete(node);
        }
    }
}

/** Return the DOM element that represents a logical node. */
export function getHtmlTwinElement(twin: HtmlTwin, node: AccessibilityNode): HTMLElement | undefined {
    return twin._items.get(node)?.element;
}

/** Mount a labelled DOM region for an accessibility tree. */
export function createHtmlTwin(tree: AccessibilityTree, options: HtmlTwinOptions): HtmlTwin {
    if (tree.disposed) {
        throw new Error("Accessibility tree is disposed.");
    }
    const element = options.parent.ownerDocument.createElement("div");
    element.className = "lite-accessibility";
    element.setAttribute("role", "region");
    element.setAttribute("aria-label", options.label ?? "Scene");
    Object.assign(element.style, {
        position: "absolute",
        width: "1px",
        height: "1px",
        padding: "0",
        margin: "-1px",
        overflow: "hidden",
        clip: "rect(0, 0, 0, 0)",
        whiteSpace: "nowrap",
        border: "0",
    });
    const twin = {
        element,
        tree,
        _items: new Map(),
        _unsubscribe: () => {},
        _disposed: false,
    } satisfies HtmlTwin;
    twin._unsubscribe = onAccessibilityTreeChanged(tree, () => updateHtmlTwin(twin));
    options.parent.append(element);
    updateHtmlTwin(twin);
    return twin;
}

/** Remove the generated DOM. Safe to call more than once. */
export function disposeHtmlTwin(twin: HtmlTwin): void {
    if (twin._disposed) {
        return;
    }
    twin._disposed = true;
    twin._unsubscribe();
    twin._items.clear();
    twin.element.remove();
}
