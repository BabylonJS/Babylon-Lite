// Deploy-base awareness for the playground app.
//
// The playground is served either at the domain root ("/") for the canonical
// nightly build, or under a sub-path for per-PR ("/pr/123/") and per-version
// ("/v/1.4.0/") snapshots. Vite bakes the configured `base` into
// `import.meta.env.BASE_URL` (always trailing-slashed), so every same-origin
// URL the app builds at runtime — the self-hosted engine bundle, the runner
// iframe, static assets, and SPA snippet routes — must be resolved through here
// rather than hard-coded to the root, or they break under a sub-path deploy.

/** The deploy base path, always leading- and trailing-slashed (e.g. `/`, `/pr/123/`). */
export const BASE: string = import.meta.env.BASE_URL;

/**
 * Resolve a root-relative app path under the deploy base. Pass the path without a
 * leading slash (a leading slash is tolerated and stripped), e.g.
 * `withBase("engine/dev/index.js")` → `/engine/dev/index.js` at root or
 * `/pr/123/engine/dev/index.js` under a PR deploy.
 */
export function withBase(path: string): string {
    return `${BASE}${path.replace(/^\//, "")}`;
}

/**
 * Strip the deploy base prefix from a pathname, returning the remainder without a
 * leading slash. Used to match SPA routes independently of where the app is
 * mounted. A pathname outside the base is returned with only its leading slash
 * removed so callers still get a stable, slash-free value to match against.
 */
export function stripBase(pathname: string): string {
    if (pathname.startsWith(BASE)) {
        return pathname.slice(BASE.length);
    }
    return pathname.replace(/^\//, "");
}

/**
 * The fixed release version of the current deploy, derived from the deploy base:
 * a `/v/<ver>/` snapshot reports `<ver>`. The root nightly build and per-PR
 * snapshots (`/pr/<N>/`) are source builds, not fixed releases, so they report
 * `null` (i.e. "nightly"). Drives the version selector's current selection.
 */
export function currentDeployVersion(): string | null {
    const match = BASE.match(/^\/v\/([^/]+)\/$/);
    return match ? match[1]! : null;
}

/**
 * Deploy base for a selectable engine version: the root (`/`) for nightly, or the
 * immutable `/v/<ver>/` snapshot for a fixed release. Pass `null` for nightly.
 */
export function baseForVersion(version: string | null): string {
    return version ? `/v/${version}/` : "/";
}

// Same-origin asset extensions worth treating as deploy-base-relative when they
// appear as a quoted root-absolute path (e.g. `"/brdf-lut.png"`) in code. Shared
// with the download bundler (see download.ts) so both recognise the same set.
export const ASSET_EXT = "png|jpe?g|webp|gif|svg|env|dds|ktx2?|basis|hdr|exr|glb|gltf|bin|json|mp3|wav|ogg|m4a|ttf|otf|woff2?|wgsl";

/**
 * Rewrite quoted, root-absolute same-origin asset paths (`"/foo.png"`) in code
 * bound for the runner iframe so they resolve under the deploy base. The runner
 * runs at `${BASE}runner.html`, so a leading-slash path resolves against the
 * domain root and 404s under a `/pr` or `/v` sub-path deploy; prefixing the base
 * fixes it. A no-op at the root deploy, so user/example code is untouched there.
 */
export function rebaseAssetReferences(code: string): string {
    if (BASE === "/") {
        return code;
    }
    const re = new RegExp(`(["'\`])(/[\\w./-]+\\.(?:${ASSET_EXT}))\\1`, "g");
    return code.replace(re, (_match, quote: string, path: string) => `${quote}${withBase(path)}${quote}`);
}
