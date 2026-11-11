import { isHtmlInCanvasPolyfillInstalled, isHtmlInCanvasSupportedNatively, installHtmlInCanvasPolyfill, uninstallHtmlInCanvasPolyfill } from "babylon-lite";
import type { HtmlInCanvasPolyfillModule, HtmlInCanvasPolyfillOptions } from "babylon-lite";

import { Logger } from "../misc/misc-utils.js";

/** Shape of an HTML-in-Canvas polyfill module accepted by Babylon.js. */
export interface IHtmlInCanvasPolyfillModule extends HtmlInCanvasPolyfillModule {}

/** Options accepted by Babylon.js `InstallHtmlInCanvasPolyfill`. */
export interface IInstallHtmlInCanvasPolyfillOptions extends HtmlInCanvasPolyfillOptions {
    polyfillModule?: IHtmlInCanvasPolyfillModule;
}

/** Babylon.js `IsHtmlInCanvasSupportedNatively`. */
export function IsHtmlInCanvasSupportedNatively(): boolean {
    return isHtmlInCanvasSupportedNatively();
}

/** Babylon.js internal installer-state query. */
export function _IsHtmlInCanvasPolyfillInstalled(): boolean {
    return isHtmlInCanvasPolyfillInstalled();
}

/** Babylon.js `InstallHtmlInCanvasPolyfill`. */
export function InstallHtmlInCanvasPolyfill(options?: IInstallHtmlInCanvasPolyfillOptions): Promise<boolean> {
    return installHtmlInCanvasPolyfill(options, (message) => Logger.Warn(message));
}

/** Babylon.js `UninstallHtmlInCanvasPolyfill`. */
export function UninstallHtmlInCanvasPolyfill(): void {
    uninstallHtmlInCanvasPolyfill();
}
