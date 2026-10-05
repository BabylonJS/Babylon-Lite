import {
    addToScene,
    batchAccessibilityUpdates,
    createNullEngine,
    createSceneContext,
    createSceneHtmlTwin,
    createTransformNode,
    disposeScene,
    onAccessibilityTreeChanged,
    onSceneDispose,
    removeFromScene,
    setAccessibilityTag,
    setMeshVisible,
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
const runtimeParent = createTransformNode("Runtime parent");
const runtimeChild = createTransformNode("Runtime child");

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
    hidden: true,
});
setAccessibilityTag(status, {
    name: "Loading box scene",
    role: "status",
    aria: {
        "aria-live": "polite",
        "aria-atomic": true,
    },
});
const runtimeParentTag = {
    name: "Runtime parent",
    description: "Runtime-hidden parent description",
    role: "img",
    disabled: true,
    aria: { "aria-roledescription": "model" },
} as const;
setAccessibilityTag(runtimeParent, runtimeParentTag);
setAccessibilityTag(runtimeChild, { name: "Runtime child", role: "button" });
setParent(centerBox, group);
setParent(leftBox, group);
setParent(rightBox, group);
setParent(runtimeChild, runtimeParent);

const twin = createSceneHtmlTwin(scene);
addToScene(scene, group);
addToScene(scene, status);
addToScene(scene, runtimeParent);

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
        hideRuntimeParent(): void {
            setMeshVisible(runtimeParent, false);
            setMeshVisible(runtimeChild, true);
        },
        authorHideRuntimeParent(hidden: boolean): void {
            setAccessibilityTag(runtimeParent, hidden ? { ...runtimeParentTag, hidden: true } : runtimeParentTag);
        },
        showRuntimeParent(): void {
            setMeshVisible(runtimeParent, true);
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
        createAfterDispose(): { error: string | null; hasLifecycleState: boolean } {
            try {
                createSceneHtmlTwin(disposedScene, {
                    parent: document.querySelector<HTMLElement>("#disposed-accessibility")!,
                    label: "Disposed scene",
                });
                return { error: null, hasLifecycleState: disposedScene._sceneChanges !== undefined };
            } catch (error) {
                return { error: error instanceof Error ? error.message : String(error), hasLifecycleState: disposedScene._sceneChanges !== undefined };
            }
        },
        disposeAfterCleanupFailure(): {
            error: string | null;
            treeDisposed: boolean;
            adapterDisposed: boolean;
            bindingsReleased: boolean;
            viewDisposed: boolean;
            htmlRemoved: boolean;
            descriptorRestored: boolean;
        } {
            const host = document.createElement("div");
            document.body.append(host);
            const failingScene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
            const source = createTransformNode("Cleanup failure");
            const failingTwin = createSceneHtmlTwin(failingScene, { parent: host, roots: [source], label: "Cleanup failure" });
            const failure = new Error("canonical cleanup failed");
            onSceneDispose(failingScene, () => {
                throw failure;
            });

            let error: string | null = null;
            try {
                disposeScene(failingScene);
            } catch (caught) {
                error = caught instanceof Error ? caught.message : String(caught);
            }
            const descriptor = Object.getOwnPropertyDescriptor(source, "name");
            const result = {
                error,
                treeDisposed: failingTwin.accessibility.tree.disposed,
                adapterDisposed: failingTwin.accessibility._disposed,
                bindingsReleased: failingTwin.accessibility._bindings.size === 0,
                viewDisposed: failingTwin.view._disposed,
                htmlRemoved: !failingTwin.view.element.isConnected,
                descriptorRestored: descriptor?.get === undefined && descriptor?.set === undefined && descriptor?.writable === true,
            };
            host.remove();
            return result;
        },
        disposeDuringAccessibilityBatch(): {
            treeDisposed: boolean;
            viewDisposed: boolean;
            htmlRemoved: boolean;
        } {
            const host = document.createElement("div");
            document.body.append(host);
            const batchedScene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
            const source = createTransformNode("Batched disposal");
            const batchedTwin = createSceneHtmlTwin(batchedScene, { parent: host, roots: [source], label: "Batched disposal" });

            batchAccessibilityUpdates(batchedTwin.accessibility.tree, () => disposeScene(batchedScene));
            const result = {
                treeDisposed: batchedTwin.accessibility.tree.disposed,
                viewDisposed: batchedTwin.view._disposed,
                htmlRemoved: !batchedTwin.view.element.isConnected,
            };
            host.remove();
            return result;
        },
        async measureSingleNodeUpdate(): Promise<{
            unrelatedMutations: number;
            unrelatedIdentityStable: boolean;
            unrelatedHidden: boolean;
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
                unrelatedHidden: unrelatedAfter.hidden === true,
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
