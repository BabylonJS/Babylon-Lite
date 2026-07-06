// CDN selection with automatic fallback.
//
// External npm packages and pinned `@babylonjs/lite` releases load from a public
// ESM CDN. The primary CDN (esm.sh) is unreachable in some regions (e.g. Russia),
// so on first use we probe its reachability once and fall back to jsDelivr if the
// probe fails. The chosen CDN is cached for the page session and used consistently
// for the engine import map, esbuild's bare-import rewrite, and downloads, so a
// project's whole dependency graph stays on a single reachable CDN.
//
// Browsers can't natively retry a failed static `import` against a second URL, so a
// per-module try/catch fallback isn't possible. The realistic failure here is "the
// whole esm.sh host is blocked", which a single startup reachability probe captures.

/** A CDN that can serve npm packages as ESM and raw package files. */
export interface Cdn {
    readonly id: "esm.sh" | "jsdelivr";
    /** URL for a bare npm specifier imported as ESM, e.g. `seedrandom` or `@scope/pkg/sub`. */
    packageUrl(specifier: string): string;
    /** URL for a published `@babylonjs/lite` release (omit `version` for the latest). */
    engineUrl(version?: string): string;
    /** URL for a raw (non-module) file inside a package, e.g. a `.wasm` binary. */
    rawFileUrl(path: string): string;
}

const ESM_SH: Cdn = {
    id: "esm.sh",
    packageUrl: (specifier) => `https://esm.sh/${specifier}`,
    engineUrl: (version) => `https://esm.sh/@babylonjs/lite${version ? `@${version}` : ""}`,
    rawFileUrl: (path) => `https://esm.sh/${path}`,
};

const JSDELIVR: Cdn = {
    id: "jsdelivr",
    packageUrl: (specifier) => `https://cdn.jsdelivr.net/npm/${specifier}/+esm`,
    engineUrl: (version) => `https://cdn.jsdelivr.net/npm/@babylonjs/lite${version ? `@${version}` : ""}/+esm`,
    rawFileUrl: (path) => `https://cdn.jsdelivr.net/npm/${path}`,
};

/** Lightweight, reachability-only probe target on the primary CDN. */
const PROBE_URL = "https://esm.sh/";
const PROBE_TIMEOUT_MS = 3000;

let cdnPromise: Promise<Cdn> | null = null;

/**
 * Resolve the active CDN, probing the primary once and caching the result for the
 * rest of the page session. Concurrent callers share the single in-flight probe.
 */
export function getCdn(): Promise<Cdn> {
    if (!cdnPromise) {
        cdnPromise = probePrimary();
    }
    return cdnPromise;
}

/**
 * Probe esm.sh for reachability. Any HTTP response (even an error status) proves the
 * host is reachable; only a network failure or timeout selects the jsDelivr fallback.
 */
async function probePrimary(): Promise<Cdn> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        // `no-cors` keeps this a pure reachability check: the opaque response is never
        // read, and the request resolves for any HTTP reply while rejecting only on a
        // network-level failure (DNS block, refused/dropped connection) — exactly the
        // case where esm.sh is unavailable and we must fall back.
        await fetch(PROBE_URL, { method: "HEAD", mode: "no-cors", cache: "no-store", signal: controller.signal });
        return ESM_SH;
    } catch {
        return JSDELIVR;
    } finally {
        clearTimeout(timer);
    }
}
