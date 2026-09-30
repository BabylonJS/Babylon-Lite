import {
    addToScene,
    createNullEngine,
    createSceneContext,
    createSceneHtmlTwin,
    createTransformNode,
    disposeScene,
    onAccessibilityTreeChanged,
    removeFromScene,
    setAccessibilityTag,
    setParent,
    updateSceneAccessibility,
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
const disposedScene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
disposeScene(disposedScene);

function mutationTouchesNode(mutation: MutationRecord, node: Node): boolean {
    if (mutation.target === node || node.contains(mutation.target)) {
        return true;
    }
    return [...mutation.addedNodes, ...mutation.removedNodes].some((changed) => changed === node || changed.contains(node));
}

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
        createAfterDispose(): { error: string | null; hasBinding: boolean } {
            try {
                createSceneHtmlTwin(disposedScene, {
                    parent: document.querySelector<HTMLElement>("#disposed-accessibility")!,
                    label: "Disposed scene",
                });
                return { error: null, hasBinding: disposedScene._accessibility !== undefined };
            } catch (error) {
                return { error: error instanceof Error ? error.message : String(error), hasBinding: disposedScene._accessibility !== undefined };
            }
        },
        async measureSingleNodeUpdate(): Promise<{
            unrelatedMutations: number;
            unrelatedIdentityStable: boolean;
            level: string | null;
            busy: string | null;
            details: string | null;
            removedLevel: string | null;
            removedBusy: string | null;
            noOpMutations: number;
            noOpNotifications: number;
        }> {
            const unrelatedBefore = twin.view.element.querySelector<HTMLElement>('[aria-label="Right box"]')!;
            const mutations: MutationRecord[] = [];
            const observer = new MutationObserver((records) => mutations.push(...records));
            observer.observe(twin.view.element, { attributes: true, childList: true, characterData: true, subtree: true });

            setAccessibilityTag(centerBox, {
                name: "Center box",
                description: "The center item in the box group",
                aria: {
                    "aria-level": 2,
                    "aria-busy": false,
                    "aria-details": null,
                },
            });
            await Promise.resolve();
            await Promise.resolve();

            const updated = twin.view.element.querySelector<HTMLElement>('[aria-label="Center box"]')!;
            const unrelatedAfter = twin.view.element.querySelector<HTMLElement>('[aria-label="Right box"]')!;
            const level = updated.getAttribute("aria-level");
            const busy = updated.getAttribute("aria-busy");
            const details = updated.getAttribute("aria-details");

            setAccessibilityTag(centerBox, {
                name: "Center box",
                description: "The center item in the box group",
                aria: {
                    "aria-level": undefined,
                    "aria-busy": null,
                },
            });
            await Promise.resolve();
            await Promise.resolve();
            const removedLevel = updated.getAttribute("aria-level");
            const removedBusy = updated.getAttribute("aria-busy");
            const unrelatedMutations = mutations.filter((mutation) => mutationTouchesNode(mutation, unrelatedBefore)).length;

            mutations.length = 0;
            let noOpNotifications = 0;
            const unsubscribe = onAccessibilityTreeChanged(twin.accessibility.tree, () => noOpNotifications++);
            updateSceneAccessibility(twin.accessibility);
            await Promise.resolve();
            await Promise.resolve();
            unsubscribe();
            observer.disconnect();

            return {
                unrelatedMutations,
                unrelatedIdentityStable: unrelatedBefore === unrelatedAfter,
                level,
                busy,
                details,
                removedLevel,
                removedBusy,
                noOpMutations: mutations.length,
                noOpNotifications,
            };
        },
        twin,
        secondTwin,
        customTwin,
        iframeTwin,
    },
});

document.body.dataset.ready = "true";
