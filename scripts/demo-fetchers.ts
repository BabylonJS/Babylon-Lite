/**
 * demo-fetchers.ts — registry that maps a demo's `fetch` id (declared in
 * demos-config.json) to the function that downloads that demo's runtime assets.
 *
 * Demo art/data (Freedoom IWAD, LibreQuake assets, Kenney voxel textures, the
 * Freeciv tileset, …) is NOT committed to git; each demo that needs assets
 * names its fetcher via the `fetch` field in demos-config.json. Both the demo
 * bundle build (bundle-demos-core.ts) and the public Pages-site build
 * (build-pages-site.ts) call {@link fetchDemoAssets} so a clean checkout ends
 * up with every required asset locally before bundling/copying.
 *
 * Each fetcher is idempotent (it no-ops when its assets are already present),
 * so calling this on every build is cheap.
 *
 * To add assets for a new demo: write a `fetch-<name>.ts` script that exports an
 * idempotent async function, register it below, and set `"fetch": "<name>"` on
 * the demo in demos-config.json.
 */
import { fetchFreedoom } from "./fetch-freedoom";
import { fetchLibrequake } from "./fetch-librequake";
import { fetchVoxelpack } from "./fetch-voxelpack";
import { fetchFreeciv } from "./fetch-freeciv";

/** Map of `fetch` id (as used in demos-config.json) → asset downloader. */
export const DEMO_FETCHERS: Record<string, () => Promise<void>> = {
    freedoom: fetchFreedoom,
    librequake: fetchLibrequake,
    voxelpack: fetchVoxelpack,
    freeciv: fetchFreeciv,
};

/** Minimal shape of a demos-config.json entry needed to resolve its fetcher. */
export interface FetchableDemo {
    slug: string;
    /** Optional id of the asset fetcher for this demo (see {@link DEMO_FETCHERS}). */
    fetch?: string;
}

/**
 * Run the asset fetcher for every demo that declares one (de-duplicated, so a
 * fetcher shared by multiple demos runs once). Throws on an unknown fetcher id.
 */
export async function fetchDemoAssets(demos: FetchableDemo[]): Promise<void> {
    const names = [...new Set(demos.map((d) => d.fetch).filter((f): f is string => !!f))];
    if (names.length === 0) return;
    for (const name of names) {
        const fetcher = DEMO_FETCHERS[name];
        if (!fetcher) {
            throw new Error(`Unknown demo asset fetcher "${name}" in demos-config.json. Known fetchers: ${Object.keys(DEMO_FETCHERS).join(", ")}.`);
        }
        console.log(`Fetching demo assets: ${name} …`);
        await fetcher();
    }
}
