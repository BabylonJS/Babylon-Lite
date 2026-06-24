// Export the current playground project as a runnable, self-contained zip.
//
// The zip contains an `index.html` whose import map resolves the bare
// `@babylonjs/lite` specifier to the esm.sh CDN, plus a `main.js` bundle produced
// by the same esbuild pipeline the runner uses (relative imports inlined, other
// npm packages already rewritten to esm.sh URLs). Any same-origin assets the scene
// references with a root-absolute path (e.g. `"/brdf-lut.png"`) are fetched and
// bundled alongside, with the reference rewritten to a relative path, so opening
// `index.html` over a static server runs the scene exactly as in the playground.
// Cross-origin `https://` asset URLs are left untouched (they still need internet).

import { strToU8, zipSync, type Zippable } from "fflate";
import { transpile } from "./transpile";
import { downloadEngineUrl } from "./versions";
import type { Project } from "./snippets";

// Asset extensions worth bundling when referenced by a root-absolute path.
const ASSET_EXT = "png|jpe?g|webp|gif|svg|env|dds|ktx2?|basis|hdr|exr|glb|gltf|bin|json|mp3|wav|ogg|m4a|ttf|otf|woff2?|wgsl";
const ASSET_RE = new RegExp(`["'\`](/[\\w./-]+\\.(?:${ASSET_EXT}))["'\`]`, "g");

/**
 * Fetch the same-origin, root-absolute assets a bundle references and return the
 * zip entries for them plus a bundle with those references rewritten to relative
 * paths. Assets that can't be fetched (or resolve to the SPA's HTML fallback) are
 * left as-is so the rewrite never points at a missing file.
 */
async function collectAssets(bundle: string): Promise<{ bundle: string; assets: Record<string, Uint8Array> }> {
    const paths = new Set<string>();
    for (const match of bundle.matchAll(ASSET_RE)) {
        paths.add(match[1]!);
    }
    const assets: Record<string, Uint8Array> = {};
    let rewritten = bundle;
    for (const path of paths) {
        try {
            const response = await fetch(path);
            const contentType = response.headers.get("content-type") ?? "";
            if (!response.ok || contentType.includes("text/html")) {
                continue;
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            const rel = path.replace(/^\//, "");
            assets[rel] = bytes;
            for (const quote of ['"', "'", "`"]) {
                rewritten = rewritten.split(`${quote}${path}${quote}`).join(`${quote}./${rel}${quote}`);
            }
        } catch {
            // Network error — leave the reference untouched.
        }
    }
    return { bundle: rewritten, assets };
}

/** Build the standalone HTML host for a downloaded project. */
function indexHtml(engineUrl: string, title: string): string {
    const importMap = JSON.stringify({ imports: { "@babylonjs/lite": engineUrl, "@babylonjs/lite/": `${engineUrl}/` } });
    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)}</title>
        <script type="importmap">
${importMap}
        </script>
        <style>
            html,
            body {
                margin: 0;
                width: 100%;
                height: 100%;
                overflow: hidden;
                background: #000;
            }
            canvas {
                width: 100%;
                height: 100%;
                display: block;
            }
        </style>
    </head>
    <body>
        <canvas id="renderCanvas"></canvas>
        <script type="module" src="./main.js"></script>
    </body>
</html>
`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/** Turn a snippet title into a safe zip filename stem. */
function slugify(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "babylon-lite-scene";
}

/** Trigger a browser download of an in-memory blob. */
function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

/**
 * Bundle the project and download it as `<name>.zip` containing `index.html`,
 * `main.js`, and any same-origin assets the scene references. `version` is the
 * selected engine version (`"nightly"` or a semver), which determines the esm.sh
 * engine URL baked into the import map.
 */
export async function downloadProject(project: Project, version: string, name: string): Promise<void> {
    const transpiled = await transpile(project.files, project.entry);
    const { bundle, assets } = await collectAssets(transpiled);
    const html = indexHtml(downloadEngineUrl(version), name || "Babylon Lite scene");
    const entries: Zippable = {
        "index.html": strToU8(html),
        "main.js": strToU8(bundle),
        ...assets,
    };
    const zipped = zipSync(entries, { level: 9 });
    triggerDownload(new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" }), `${slugify(name)}.zip`);
}
