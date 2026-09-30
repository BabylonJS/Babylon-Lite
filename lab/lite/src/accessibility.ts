import {
    addToScene,
    createNullEngine,
    createSceneContext,
    createSceneHtmlTwin,
    createTransformNode,
    disposeScene,
    removeFromScene,
    setAccessibilityTag,
    setParent,
} from "babylon-lite";

function createCanvasScene(canvas: HTMLCanvasElement) {
    const engine = createNullEngine();
    Object.defineProperty(engine, "canvas", { value: canvas });
    return createSceneContext(engine, { defaultRenderTask: false });
}

const scene = createCanvasScene(document.querySelector<HTMLCanvasElement>("#renderCanvas")!);
const group = createTransformNode("Box arrangement");
const centerBox = createTransformNode("Center box");
const leftBox = createTransformNode("Left box");
const rightBox = createTransformNode("Right box");
const status = createTransformNode("Scene status");

setAccessibilityTag(group, { name: "Box arrangement", role: "group" });
setAccessibilityTag(centerBox, {
    name: "Center box",
    description: "The center item in the box group",
});
setAccessibilityTag(leftBox, {
    description: "The first item in the box group",
});
setAccessibilityTag(rightBox, {
    name: "Right box",
    description: "The last item in the box group",
});
setAccessibilityTag(status, {
    name: "Loading box scene",
    role: "status",
    aria: {
        "aria-live": "polite",
        "aria-atomic": true,
    },
});
setParent(centerBox, group);
setParent(leftBox, group);
setParent(rightBox, group);

const twin = createSceneHtmlTwin(scene);
addToScene(scene, group);
addToScene(scene, status);

const secondScene = createCanvasScene(document.querySelector<HTMLCanvasElement>("#secondCanvas")!);
const secondTwin = createSceneHtmlTwin(secondScene, { label: "Second scene" });

const customScene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
const customTwin = createSceneHtmlTwin(customScene, {
    parent: document.querySelector<HTMLElement>("#custom-accessibility")!,
    label: "Custom host scene",
});

const iframe = document.querySelector<HTMLIFrameElement>("#iframe-host")!;
const iframeDocument = iframe.contentDocument!;
const iframeSceneHost = iframeDocument.createElement("div");
const iframeCanvas = iframeDocument.createElement("canvas");
iframeSceneHost.append(iframeCanvas);
iframeDocument.body.append(iframeSceneHost);
const iframeScene = createCanvasScene(iframeCanvas);
const iframeTwin = createSceneHtmlTwin(iframeScene, { label: "Iframe scene" });

Object.assign(window, {
    accessibilityFixture: {
        replace(): void {
            setAccessibilityTag(status, {
                name: "Box scene ready",
                description: "All <three> box records are available",
                role: "note",
            });
        },
        hide(hidden: boolean): void {
            centerBox.visible = !hidden;
        },
        reparent(): void {
            setParent(centerBox, null);
        },
        remove(): void {
            removeFromScene(scene, centerBox);
        },
        dispose(): void {
            disposeScene(scene);
        },
        twin,
        secondTwin,
        customTwin,
        iframeTwin,
    },
});

document.body.dataset.ready = "true";
