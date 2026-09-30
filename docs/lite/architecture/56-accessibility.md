# Module: Accessibility

> Package paths: `packages/babylon-lite/src/accessibility/` and `packages/babylon-lite/src/scene/scene-html-twin.ts`

## Purpose

The accessibility module stores descriptive metadata for scene objects, projects scene state into a logical accessibility tree, and can mount that tree as synchronized HTML.

The logical tree is usable without a DOM. The scene adapter and HTML twin are opt-in root exports. Importing other Babylon Lite features does not create accessibility state, observers, or DOM nodes.

The common browser entry point uses the scene canvas's parent element:

```ts
import { addToScene, createSceneHtmlTwin, setAccessibilityTag } from "@babylonjs/lite";

const twin = createSceneHtmlTwin(scene);

setAccessibilityTag(centerBox, {
    name: "Center box",
    description: "The large blue box between two smaller boxes",
});
addToScene(scene, centerBox);
```

## Public API Surface

All public state uses interfaces. All behavior uses standalone functions exported from the package root.

### Logical tree types

```ts
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

export interface AccessibilityNode {
    tag: AccessibilityTag | null;
    parent: AccessibilityNode | null;
    readonly children: readonly AccessibilityNode[];
    hidden: boolean;
    disabled: boolean;
    target?: object;
}

export interface AccessibilityTree {
    readonly roots: readonly AccessibilityNode[];
    readonly disposed: boolean;
}
```

`AccessibilityNode.children` and `AccessibilityTree.roots` expose stable array objects as read-only views. Tree mutation functions own the corresponding mutable arrays. Applications must not edit structural arrays directly.

`target` links a logical node to application data. The tree clears the reference when it removes the node, but it never disposes the target.

### Logical tree functions

```ts
export function createAccessibilityTree(): AccessibilityTree;

export function batchAccessibilityUpdates(tree: AccessibilityTree, update: () => void): void;

export function onAccessibilityTreeChanged(tree: AccessibilityTree, listener: () => void): () => void;

export function addAccessibilityNode(tree: AccessibilityTree, options: AccessibilityNodeOptions): AccessibilityNode;

export function updateAccessibilityNode(tree: AccessibilityTree, node: AccessibilityNode, patch: AccessibilityNodeOptions): void;

export function removeAccessibilityNode(tree: AccessibilityTree, node: AccessibilityNode): void;

export function disposeAccessibilityTree(tree: AccessibilityTree): void;
```

`addAccessibilityNode` appends to the selected root or child list unless `before` names a sibling. `updateAccessibilityNode` preserves node identity while changing metadata, parentage, ordering, availability, or target.

`removeAccessibilityNode` removes the node and its descendants. Removed handles no longer belong to the tree. A later representation of the same target receives a new node.

`batchAccessibilityUpdates` delays observer notification until the outermost synchronous batch completes. Nested batches are supported. A dirty batch emits one notification.

An update that leaves metadata, availability, target, parent, and sibling position unchanged does not mark the tree dirty or notify observers.

`onAccessibilityTreeChanged` observes completed mutations. The returned function removes the listener. Observer errors are collected: one error is rethrown directly, and multiple errors are rethrown as an `AggregateError`.

### HTML twin types

```ts
export interface HtmlTwinOptions {
    parent: HTMLElement;
    /** Accessible name of the generated region. */
    label?: string;
}

export interface HtmlTwin {
    readonly element: HTMLDivElement;
    readonly tree: AccessibilityTree;
}
```

### HTML twin functions

```ts
export function createHtmlTwin(tree: AccessibilityTree, options: HtmlTwinOptions): HtmlTwin;

export function updateHtmlTwin(twin: HtmlTwin): void;

export function getHtmlTwinElement(twin: HtmlTwin, node: AccessibilityNode): HTMLElement | undefined;

export function disposeHtmlTwin(twin: HtmlTwin): void;
```

`createHtmlTwin` creates one visually clipped `div` region under `options.parent`. The region has `role="region"` and uses `options.label`, or `"Scene"` when the label is omitted.

The twin uses `options.parent.ownerDocument` for every generated element. A parent from an iframe or another document therefore produces elements in that document.

`getHtmlTwinElement` returns the generated element for a node that is currently represented. It returns `undefined` for nodes that are absent or already removed.

### Scene projection types

The scene adapter accepts `SceneNode | Camera` values as sources. This source union covers meshes, lights, cameras, transform nodes, and other scene nodes with a logical hierarchy.

```ts
type SceneSource = SceneNode | Camera;

export interface SceneAccessibilityOptions {
    roots?: readonly SceneSource[];
}

export interface SceneAccessibility {
    readonly tree: AccessibilityTree;
}
```

`roots` supplies transform-only or otherwise unretained source objects that cannot be discovered from the scene's retained arrays. Each explicit root includes its complete descendant subtree and the ancestors needed to connect it.

Subtree discovery follows only current parent links. A stale entry in a source's `children` array does not retain a child whose `parent` points elsewhere.

### Scene projection functions

```ts
export function createSceneAccessibility(scene: SceneContext, options?: SceneAccessibilityOptions): SceneAccessibility;

export function updateSceneAccessibility(adapter: SceneAccessibility): void;

export function setAccessibilityTag(source: object, tag: AccessibilityTag | null): void;

export function getAccessibilityTag(source: object): AccessibilityTag | null;

export function getAccessibilityNode(adapter: SceneAccessibility, source: SceneSource): AccessibilityNode | undefined;

export function setAccessibilityParent(adapter: SceneAccessibility, source: SceneSource, parent: SceneSource | null | undefined): void;

export function disposeSceneAccessibility(adapter: SceneAccessibility): void;
```

A scene owns at most one `SceneAccessibility` projection. `createSceneAccessibility` rejects a disposed scene and rejects a scene that already owns a projection. Both checks run before the function creates the logical tree or installs scene hooks.

`updateSceneAccessibility` performs an immediate full reconciliation. Use it after direct edits to `scene.meshes`, `scene.lights`, or other retained state that bypass the normal scene helpers.

`setAccessibilityTag` replaces the entire metadata record. Passing `null` removes the record. `getAccessibilityTag` returns the stored immutable snapshot, not a mutable caller object.

`setAccessibilityParent` changes only the semantic hierarchy. It does not change the source's render transform. A `null` parent makes the source a logical root. An `undefined` parent restores natural source parentage.

### Owned scene HTML twin types

```ts
export interface SceneHtmlTwinOptions extends Omit<HtmlTwinOptions, "parent">, SceneAccessibilityOptions {
    /** Host for the generated region. Defaults to the DOM canvas's parent element. */
    parent?: HTMLElement;
}

export interface SceneHtmlTwin {
    readonly accessibility: SceneAccessibility;
    readonly view: HtmlTwin;
}
```

### Owned scene HTML twin functions

```ts
export function createSceneHtmlTwin(scene: SceneContext, options?: SceneHtmlTwinOptions): SceneHtmlTwin;

export function disposeSceneHtmlTwin(twin: SceneHtmlTwin): void;
```

When `options.parent` is omitted, `createSceneHtmlTwin` requires a DOM canvas with a parent element and mounts beside that canvas. A null-engine scene or an `OffscreenCanvas` scene must supply `parent`.

The function resolves the DOM parent before it installs the scene projection. If parent resolution fails, the scene remains unbound. If HTML creation fails after the projection is installed, the function disposes the projection before it rethrows the error.

## Validation and Snapshot Semantics

Accessibility metadata is validated before publication.

- Every `aria` key must match `aria-[a-z-]+`.
- An ARIA value may be a string, finite number, boolean, `null`, or `undefined`.
- `hidden` must not conflict with `aria-hidden`.
- `disabled` must not conflict with `aria-disabled`.
- Parent and ordering references must belong to the same live tree.
- `before` must identify a sibling under the selected parent.
- A parent change must not create a cycle.
- Tree mutation functions reject disposed trees.
- Scene semantic parent overrides reject cycles synchronously.

`setAccessibilityTag`, `addAccessibilityNode`, and tag updates make a shallow frozen copy of the tag and a separate frozen copy of its `aria` record. Later writes to the caller's original objects do not change published metadata.

The lower-level tree stores authored `hidden` and `disabled` values independently from tag-derived state. Effective state follows this precedence:

```text
explicit node option
    ?? matching AccessibilityTag field
    ?? matching aria-hidden / aria-disabled value
    ?? false
```

If more than one authored source supplies the same state, all supplied values must agree.

## Internal Architecture

### Logical tree ownership

Each `AccessibilityTree` owns:

- an ordered mutable root array exposed as `roots`;
- a membership `Set` used to reject foreign and removed nodes;
- a change-listener `Set`;
- a disposal flag;
- synchronous batch depth and dirty state.

Each `AccessibilityNode` owns:

- an ordered mutable child array exposed as `children`;
- its current logical parent;
- one immutable tag snapshot;
- effective hidden and disabled values;
- optional authored availability overrides;
- an optional caller-owned target reference.

Reparenting detaches the node from its old sibling array before insertion into the new array. Descendant removal clears child arrays, parents, tags, authored state, and target references before deleting membership.

### Scene source discovery

One `SceneAccessibility` adapter owns these source sets:

- retained scene meshes and lights;
- the active camera and its subtree;
- sources reported through the scene's optional accessibility add/remove hook;
- explicit `roots` and their subtrees;
- natural ancestors required to connect any desired source.

Meshes and lights are rediscovered from `scene.meshes` and `scene.lights` during every reconciliation. Transform-only nodes added after adapter creation are retained by the optional scene hook. Transform-only nodes added before adapter creation must remain reachable through another desired source or be passed through `roots`.

The adapter stores one stable `AccessibilityNode` binding per desired source. Existing bindings are updated in place. Sources that are no longer desired are unobserved, removed from the binding map, and removed from the logical tree.

Existing bindings reconcile in final-parent order. The adapter updates each desired parent before its descendants, so a coalesced hierarchy reversal cannot encounter a temporary cycle from the previous tree.

### Logical hierarchy

Natural source parentage supplies the default logical parent. A valid explicit semantic parent override takes precedence. A parent participates only while both the source and parent are in the desired source set.

If a source or its semantic parent leaves the desired set, reconciliation removes the stored override. Re-adding the source therefore uses its current natural parentage until the application sets another override.

Cycle checks walk the effective parent chain, including existing overrides and natural parents. Binding creation repeats a cycle guard so malformed source data cannot recurse indefinitely.

### Source metadata projection

The adapter reads the stored authored tag and creates a node-specific snapshot:

1. If the tag has neither `name` nor `description`, the source's current `name` becomes the accessible name.
2. If the tag has a `description` but no `name`, the description remains the name source for the HTML projection.
3. A source with `_disposed === true` or `visible === false` becomes hidden.
4. Runtime hiding publishes `hidden: true`. If the tag includes `aria-hidden`, the projected snapshot sets that attribute to `true`.
5. Disabled state comes from the authored metadata.

`getAccessibilityTag` continues to return the authored snapshot. Runtime-derived names and visibility exist only on projected tree nodes.

### Observation and coalescing

The adapter observes:

- the scene's `camera` property;
- each retained source's `name`, `visible`, `_disposed`, and `parent` properties;
- metadata replacement through `setAccessibilityTag`;
- scene additions and removals through `SceneContext._accessibility`;
- explicit semantic parent changes.

Direct observed writes schedule one microtask. Additional writes before that microtask reuse the pending update. Disposal cancels the pending reconciliation by marking the adapter disposed.

Property observation preserves the original property shape. The last unsubscribe restores an own descriptor, exposes a final ordinary data value, or removes a temporary wrapper so an inherited accessor becomes visible again.

### HTML synchronization

Each logical node maps to one `div` with `data-lite-accessibility-node` and one child `span` with `data-lite-accessibility-text`.

On every update, the renderer compares generated attributes, text, parent, and sibling position with the desired state. It writes only changed values and moves an element only when its parent or order changed.

| Source state                     | HTML result                                                       |
| -------------------------------- | ----------------------------------------------------------------- |
| `tag.role`                       | `role`                                                            |
| `tag.name`                       | `aria-label`                                                      |
| Description with no name         | Description becomes `aria-label`                                  |
| Name and description             | Name becomes `aria-label`; description becomes `aria-description` |
| `node.hidden`                    | The element's `hidden` property                                   |
| `node.disabled`                  | `aria-disabled="true"`                                            |
| `tag.aria` entry                 | Attribute string value                                            |
| `null` or `undefined` ARIA value | Attribute removal                                                 |

The authored ARIA record is applied after derived attributes. Validation keeps `aria-hidden` and `aria-disabled` consistent with the authored availability fields.

Readable text is assigned through `textContent`. Name and description are joined with `". "` when both are present. Text such as `<three>` remains text rather than markup.

Children are inserted in logical order relative to the current DOM cursor. Elements that already occupy the correct parent and position remain untouched. Elements for inactive nodes are removed and deleted from the node-to-element map.

The generated region is visually clipped with inline styles while remaining in the document's accessibility representation.

## State Machine / Lifecycle

### Accessibility tree

```text
created -> mutated/batched -> disposed
```

- Creation returns an empty live tree.
- Mutations validate before they publish state.
- Disposal recursively releases every node, marks the tree disposed, emits one final change notification, and clears listeners.
- Repeated disposal is a no-op.

### HTML twin

```text
tree live + mounted -> synchronized -> tree disposed or explicit disposal -> removed
```

- Creation subscribes before the first update, appends the region, and renders current roots.
- A tree notification calls `updateHtmlTwin`.
- If the tree is already disposed, the update disposes the twin.
- Disposal unsubscribes, clears the item map, removes the region, and is idempotent.

### Scene projection

```text
live scene -> projection installed -> reconciled as scene changes -> scene or projection disposed
```

- Creation rejects `scene._z` before tree creation, property observation, or hook installation.
- The scene hook is installed before the initial reconciliation so additions cannot be missed after ownership begins.
- If initial reconciliation fails, creation disposes all installed state before rethrowing.
- Explicit projection disposal removes observations and bindings, clears source and parent sets, uninstalls the scene hook, and disposes the tree.
- `disposeScene` invokes the installed projection disposer before canonical scene cleanup. If an accessibility observer throws during disposal, scene cleanup still completes and `disposeScene` then rethrows the observer failure.
- Repeated projection disposal is a no-op.

### Owned scene HTML twin

`SceneHtmlTwin` owns both the scene projection and the mounted HTML view. Explicit disposal removes the view first, then disposes the projection. Scene disposal disposes the projection tree; the tree's final notification removes the mounted HTML view.

## Pipeline Configuration

Not applicable. The accessibility subsystem does not create render pipelines, bind groups, depth or stencil state, or GPU resources.

## Shader Logic

Not applicable. The accessibility subsystem contains no WGSL and performs no shader work.

## Babylon.js Equivalence Map

| Babylon Lite                                                       | Babylon.js                                                | Relationship                                                                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccessibilityTag`                                                 | `IAccessibilityTag`                                       | Both describe scene-object semantics. Lite adds a distinct `name`, availability fields, immutable snapshots, and typed `aria-*` values.                   |
| `setAccessibilityTag(source, tag)` / `getAccessibilityTag(source)` | `Node.accessibilityTag`                                   | Lite uses standalone functions and lazy metadata storage instead of an attached mutable property.                                                         |
| `createSceneHtmlTwin(scene)`                                       | `HTMLTwinRenderer.Render(scene)`                          | Both create an HTML representation for scene semantics. Lite returns an owned plain-data handle and uses native DOM synchronization without a React root. |
| `SceneAccessibility`                                               | Babylon.js HTML twin node adaptation                      | Lite separates scene discovery from DOM rendering so the logical tree also works headlessly.                                                              |
| `setAccessibilityParent`                                           | Scene-node hierarchy consumed by the Babylon.js HTML twin | Lite can override semantic grouping without changing render transforms.                                                                                   |

## Dependencies

Runtime dependencies are limited to:

- `Camera`, `SceneNode`, and `SceneContext` types and state;
- the scene's optional `_accessibility` add/remove/disposal seam;
- `isDomCanvas` for default host resolution;
- native `WeakMap`, `Map`, `Set`, `Object.freeze`, `queueMicrotask`, and `AggregateError`;
- native DOM interfaces when an HTML twin is created.

The metadata maps and observation maps initialize lazily. No accessibility module creates module-level collections or performs work at import time.

The root package re-exports each public type and function from its single `"."` entry point. Unused accessibility imports tree-shake away, and the DOM projection is retained only when an HTML twin export is used.

## Test Specification

### Unit tests

`tests/lite/unit/accessibility-tree.test.ts` covers:

- immutable tag and ARIA snapshots;
- logical root and child hierarchy;
- stable node identity across updates;
- reparenting and metadata removal;
- hidden and disabled derivation;
- malformed ARIA and conflicting availability rejection;
- suppression of unchanged update notifications;
- batched notification;
- subtree removal and tree disposal.

`tests/lite/unit/scene-accessibility.test.ts` covers:

- rejection after scene disposal without hook installation;
- missing default DOM host without hook installation;
- tag validation before publication;
- source-name fallback and metadata replacement;
- scene membership, camera, lights, explicit roots, and direct array reconciliation;
- exclusion of detached children from explicit-root and active-camera traversal;
- microtask updates for visibility, name, parentage, and tags;
- stable source bindings;
- semantic parent override, final-order reversal, restoration, removal, and cycle rejection;
- scene cleanup when a tree observer throws;
- reversible property observation.

### Browser plumbing tests

`tests/lite/plumbing/accessibility.spec.ts` and `lab/lite/src/accessibility.ts` cover:

- default canvas-parent mounting;
- custom host mounting;
- owner-document behavior in an iframe;
- hierarchy, names, descriptions, roles, and arbitrary ARIA values;
- description-only naming;
- text escaping through `textContent`;
- metadata replacement and attribute removal;
- single-node updates without unrelated attribute, text, or move mutations;
- no-op scene refreshes without tree notifications or DOM mutations;
- visibility, reparenting, scene removal, and scene disposal;
- rejection after scene disposal without leaked DOM or a retained scene binding.

### Build and declaration tests

`tests/lite/build/accessibility-treeshake.test.ts` covers:

- root-export availability in emitted declarations;
- default and explicit parent signatures;
- removal of internal fields from public declarations;
- unused accessibility imports producing no bundle change;
- DOM synchronization code retained only when requested.

## File Manifest

| File                                                             | Responsibility                                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/babylon-lite/src/accessibility/accessibility-tree.ts`  | Public metadata contracts, logical tree ownership, validation, mutation, batching, and disposal                              |
| `packages/babylon-lite/src/accessibility/html-twin.ts`           | Native DOM region creation, node-to-element mapping, synchronization, and disposal                                           |
| `packages/babylon-lite/src/accessibility/observe-property.ts`    | Reversible direct-property observation used by the scene adapter                                                             |
| `packages/babylon-lite/src/accessibility/scene-accessibility.ts` | Lazy object metadata, scene source discovery, logical projection, coalescing, semantic parent overrides, and scene lifecycle |
| `packages/babylon-lite/src/scene/scene-html-twin.ts`             | Default/custom host resolution and owned scene-plus-HTML convenience API                                                     |
| `packages/babylon-lite/src/scene/scene-core.ts`                  | Optional accessibility membership and disposal seam                                                                          |
| `packages/babylon-lite/src/scene/scene-remove.ts`                | Optional scene-removal notification                                                                                          |
| `packages/babylon-lite/src/index.ts`                             | Single root public exports                                                                                                   |
| `tests/lite/unit/accessibility-tree.test.ts`                     | Logical tree unit coverage                                                                                                   |
| `tests/lite/unit/scene-accessibility.test.ts`                    | Scene adapter and observation unit coverage                                                                                  |
| `tests/lite/plumbing/accessibility.spec.ts`                      | Browser DOM and lifecycle coverage                                                                                           |
| `tests/lite/build/accessibility-treeshake.test.ts`               | Declaration and tree-shaking coverage                                                                                        |
| `lab/lite/accessibility.html`                                    | Browser plumbing fixture page                                                                                                |
| `lab/lite/src/accessibility.ts`                                  | Browser plumbing fixture behavior                                                                                            |
| `docs/lite/architecture/56-accessibility.md`                     | One-shot subsystem reference                                                                                                 |
