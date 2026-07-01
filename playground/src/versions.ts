// Engine version selection for the playground runtime.
//
// The runner resolves the bare `@babylonjs/lite` import to an engine bundle URL
// chosen here: the self-hosted "nightly" bundle (built from workspace source and
// served alongside the app) by default, or a specific published release loaded on
// demand from a public ESM CDN. Switching versions only changes the import URL — no
// redeploy is needed to target a released version. The CDN (esm.sh, with an automatic
// jsDelivr fallback) is selected by `./cdn`.

import { getCdn } from "./cdn";

/** Sentinel value for the self-hosted, source-tracking engine build. */
export const NIGHTLY = "nightly";

/** URL of the self-hosted nightly engine bundle (served at the app root). */
export const NIGHTLY_ENGINE_URL = "/engine/dev/index.js";

const REGISTRY_URL = "https://registry.npmjs.org/@babylonjs/lite";

/** How many recent published versions to offer in the selector. */
const MAX_VERSIONS = 20;

/** Resolve the engine bundle URL for a selected version (`"nightly"` or a semver). */
export async function engineUrlForVersion(version: string): Promise<string> {
    if (version === NIGHTLY) {
        return NIGHTLY_ENGINE_URL;
    }
    const cdn = await getCdn();
    return cdn.engineUrl(version);
}

/**
 * The CDN specifier baked into a *downloaded* project's import map. The self-hosted
 * nightly bundle isn't reachable outside the playground, so a download targeting
 * nightly pins to the CDN's latest published release; an explicit version pins to it.
 * The CDN is whichever one the playground resolved (esm.sh or its jsDelivr fallback).
 */
export async function downloadEngineUrl(version: string): Promise<string> {
    const cdn = await getCdn();
    return version === NIGHTLY ? cdn.engineUrl() : cdn.engineUrl(version);
}

/**
 * Fetch the list of published `@babylonjs/lite` versions, newest first, excluding
 * pre-releases. Returns an empty list if the registry can't be reached so the
 * selector can still offer nightly.
 */
export async function fetchPublishedVersions(): Promise<string[]> {
    try {
        const response = await fetch(REGISTRY_URL, { headers: { Accept: "application/vnd.npm.install-v1+json" } });
        if (!response.ok) {
            return [];
        }
        const data = (await response.json()) as { versions?: Record<string, unknown> };
        const versions = Object.keys(data.versions ?? {}).filter((version) => !version.includes("-"));
        versions.sort(compareSemver);
        return versions.reverse().slice(0, MAX_VERSIONS);
    } catch {
        return [];
    }
}

/** Ascending semver comparison for `MAJOR.MINOR.PATCH` release versions. */
function compareSemver(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}
