# Scene accessibility

Babylon Lite can expose scene descriptions, roles, and ARIA attributes through an HTML representation that stays synchronized with the scene.

## Describe scene objects

Attach immutable metadata with `setAccessibilityTag`:

```ts
import { setAccessibilityTag } from "@babylonjs/lite";

setAccessibilityTag(centerBox, {
    name: "Center box",
    description: "A large blue box between two smaller boxes",
});
```

If you are porting a Babylon.js scene, keep each name and description tied to what the object means in that scene.

`AccessibilityTag` supports these fields:

| Field         | Purpose                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `name`        | The accessible name.                                                       |
| `description` | Additional readable text. If `name` is absent, this is the name.           |
| `role`        | An authored ARIA role.                                                     |
| `hidden`      | Hides the object and its descendants from the representation.              |
| `disabled`    | Reports the object and its descendants as unavailable.                     |
| `aria`        | A map of `aria-*` attributes, including states and live-region attributes. |

Replacing the tag replaces the published semantics. Pass `null` to remove the tag.

## Mount a scene view

For a scene that renders to a DOM canvas, create the view without options:

```ts
import { addToScene, createSceneHtmlTwin, setAccessibilityTag } from "@babylonjs/lite";

const twin = createSceneHtmlTwin(scene);

setAccessibilityTag(centerBox, {
    name: "Center box",
    description: "A large blue box between two smaller boxes",
});
addToScene(scene, centerBox);
```

The generated region uses the canvas's document and is added to the canvas's parent element. Pass `parent` to use a different host or to mount a scene that uses an `OffscreenCanvas` or null engine:

```ts
const twin = createSceneHtmlTwin(scene, {
    parent: document.querySelector("#scene-accessibility")!,
    label: "Product preview",
});
```

Create the view before scene population when you need it to retain transform-only nodes.

For transform-only objects that were added before the view was created, pass them through `roots`:

```ts
const twin = createSceneHtmlTwin(scene, {
    roots: [logicalGroup],
});
```

The view creates nested `div` elements with readable text, authored roles, and ARIA attributes. Use roles that match the application's behavior.

Use additional ARIA attributes when they describe real application state. For example, a status node can announce a changing load state:

```ts
setAccessibilityTag(loadStatus, {
    name: "Loading product model",
    role: "status",
    aria: {
        "aria-live": "polite",
        "aria-atomic": true,
    },
});

setAccessibilityTag(loadStatus, {
    name: "Product model loaded",
    role: "status",
    aria: {
        "aria-live": "polite",
        "aria-atomic": true,
    },
});
```

## Keep the view current

The scene binding updates after:

- `setAccessibilityTag` replaces or removes metadata.
- `addToScene` adds an object.
- `removeFromScene` removes an object.
- A tracked object's `name`, `visible`, or `parent` property changes.
- The active camera changes.
- The scene is disposed.

Natural scene parentage defines the HTML hierarchy. Use `setAccessibilityParent` when the semantic hierarchy must differ from the render transform:

```ts
setAccessibilityParent(twin.accessibility, mesh, logicalGroup);
```

Pass `undefined` as the parent to restore natural scene parentage.

## Use the model without the DOM

Headless tools can create a scene binding without mounting HTML:

```ts
const accessibility = createSceneAccessibility(scene, {
    roots: [logicalGroup],
});

const node = getAccessibilityNode(accessibility, mesh);
```

The lower-level `AccessibilityTree` API can also represent non-scene hierarchies.

## Clean up

`disposeSceneHtmlTwin(twin)` removes the HTML and scene binding. Disposing the scene also disposes its accessibility tree and mounted view.
