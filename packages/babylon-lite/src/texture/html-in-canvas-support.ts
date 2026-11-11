/** Optional HTML-in-Canvas polyfill module accepted by the installer. */
export interface HtmlInCanvasPolyfillModule {
    installHtmlInCanvasPolyfill?: (options?: { force?: boolean }) => void;
    uninstallHtmlInCanvasPolyfill?: () => void;
}

/** Options for {@link installHtmlInCanvasPolyfill}. */
export interface HtmlInCanvasPolyfillOptions {
    force?: boolean;
    moduleSpecifier?: string;
    polyfillModule?: HtmlInCanvasPolyfillModule;
}

let installedModule: HtmlInCanvasPolyfillModule | null = null;

/** True when the Lite installer currently owns an HTML-in-Canvas polyfill. */
export function isHtmlInCanvasPolyfillInstalled(): boolean {
    return installedModule !== null;
}

/** True when the current browser exposes the WICG HTML-in-Canvas capture API. */
export function isHtmlInCanvasSupportedNatively(): boolean {
    if (typeof document === "undefined") {
        return false;
    }
    return typeof (document.createElement("canvas") as HTMLCanvasElement & { captureElementImage?: unknown }).captureElementImage === "function";
}

/** Install an optional HTML-in-Canvas polyfill on demand. */
export async function installHtmlInCanvasPolyfill(
    options: HtmlInCanvasPolyfillOptions = {},
    warn: (message: string) => void = (message) => console.warn(message)
): Promise<boolean> {
    const force = options.force ?? hasPolyfillUrlFlag();
    if (!force && isHtmlInCanvasSupportedNatively()) {
        return false;
    }

    const module = options.polyfillModule ?? (await loadPolyfill(options.moduleSpecifier ?? "three-html-render", warn));
    if (!module || typeof module.installHtmlInCanvasPolyfill !== "function") {
        warn("HTML-in-Canvas: the polyfill module does not expose installHtmlInCanvasPolyfill; nothing was installed.");
        return false;
    }

    module.installHtmlInCanvasPolyfill(force ? { force: true } : undefined);
    installedModule = module;
    return true;
}

/** Uninstall the HTML-in-Canvas polyfill previously installed through Lite. */
export function uninstallHtmlInCanvasPolyfill(): void {
    installedModule?.uninstallHtmlInCanvasPolyfill?.();
    installedModule = null;
}

async function importPolyfill(specifier: string): Promise<HtmlInCanvasPolyfillModule | null> {
    try {
        return (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as HtmlInCanvasPolyfillModule;
    } catch {
        return null;
    }
}

async function loadPolyfill(specifier: string, warn: (message: string) => void): Promise<HtmlInCanvasPolyfillModule | null> {
    const module = await importPolyfill(specifier);
    if (!module) {
        warn(`HTML-in-Canvas: could not load polyfill module "${specifier}". Install three-html-render or pass polyfillModule.`);
        return null;
    }
    return module;
}

function hasPolyfillUrlFlag(): boolean {
    return typeof window !== "undefined" && !!window.location && /[?&]polyfillHIC\b/i.test(window.location.search);
}
