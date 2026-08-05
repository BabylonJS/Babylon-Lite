// Engine version selection for the playground runtime.
//
// Every deploy runs its own self-hosted engine bundle (built from the source that
// deploy was cut from and served under its base): nightly at the root, the PR
// build under `/pr/<N>/`, and the exact release under `/v/<ver>/`. The runner
// always imports that self-hosted bundle, so the engine and the surrounding
// playground UI are always a matched pair. The version selector therefore doesn't
// hot-swap an engine URL — it navigates between these snapshots (see main.ts). The
// list of switchable fixed releases is the `/v/versions.json` manifest, written by
// the npm-publish pipeline as versioned snapshots are deployed.
//
// The CDN (esm.sh, with an automatic jsDelivr fallback, selected by `./cdn`) is
// used only to pin a *downloaded* project's import map to a public release.

import { getCdn } from "./cdn";
import { withBase } from "./base";

/** Sentinel value for the self-hosted, source-tracking engine build. */
export const NIGHTLY = "nightly";

/** URL of the self-hosted nightly engine bundle (served under the app's deploy base). */
export const NIGHTLY_ENGINE_URL = withBase("engine/dev/index.js");

/**
 * Location of the deployed-versions manifest, always at the origin root so every
 * snapshot (root nightly, `/pr/<N>/`, `/v/<ver>/`) reads the same shared list.
 */
const VERSIONS_MANIFEST_URL = "/v/versions.json";

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
 * Fetch the fixed `@babylonjs/lite` versions that have a deployed playground
 * snapshot under `/v/<ver>/`, newest first. The manifest is written by the
 * npm-publish pipeline after each versioned snapshot deploys, so the selector
 * only ever offers versions the user can actually switch to. Returns an empty
 * list when the manifest is missing or unreachable, so the selector still offers
 * Nightly.
 */
export async function fetchDeployedVersions(): Promise<string[]> {
    try {
        const response = await fetch(VERSIONS_MANIFEST_URL, { headers: { Accept: "application/json" } });
        if (!response.ok) {
            return [];
        }
        const data = (await response.json()) as unknown;
        const versions = Array.isArray(data) ? data.filter((v): v is string => typeof v === "string" && !v.includes("-")) : [];
        versions.sort(compareSemver);
        return versions.reverse();
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
