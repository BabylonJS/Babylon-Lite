import { isDomCanvas } from "../engine/surface.js";
import type { SceneContext } from "../scene/scene-core.js";
import { createHtmlTwin, disposeHtmlTwin } from "./html-twin.js";
import type { HtmlTwin, HtmlTwinOptions } from "./html-twin.js";
import { createSceneAccessibility, disposeSceneAccessibility } from "./scene-accessibility.js";
import type { SceneAccessibility, SceneAccessibilityOptions } from "./scene-accessibility.js";

/** Options for mounting a scene's HTML representation. */
export interface SceneHtmlTwinOptions extends Omit<HtmlTwinOptions, "parent">, SceneAccessibilityOptions {
    /** Host for the generated region. Defaults to the DOM canvas's parent element. */
    parent?: HTMLElement;
}

/** A scene binding and its owned HTML view. */
export interface SceneHtmlTwin {
    readonly accessibility: SceneAccessibility;
    readonly view: HtmlTwin;
}

function resolveParent(scene: SceneContext, parent: HTMLElement | undefined): HTMLElement {
    if (parent) {
        return parent;
    }
    const canvas = scene.surface.canvas;
    if (!canvas || !isDomCanvas(canvas) || !canvas.parentElement) {
        throw new Error("A DOM canvas with a parent element is required when createSceneHtmlTwin is called without options.parent.");
    }
    return canvas.parentElement;
}

/** Bind a scene and mount its HTML representation. */
export function createSceneHtmlTwin(scene: SceneContext, options: SceneHtmlTwinOptions = {}): SceneHtmlTwin {
    const htmlOptions = { ...options, parent: resolveParent(scene, options.parent) };
    const accessibility = createSceneAccessibility(scene, options);
    try {
        return {
            accessibility,
            view: createHtmlTwin(accessibility.tree, htmlOptions),
        };
    } catch (error) {
        disposeSceneAccessibility(accessibility);
        throw error;
    }
}

/** Dispose the HTML view and scene binding. */
export function disposeSceneHtmlTwin(twin: SceneHtmlTwin): void {
    disposeHtmlTwin(twin.view);
    disposeSceneAccessibility(twin.accessibility);
}
