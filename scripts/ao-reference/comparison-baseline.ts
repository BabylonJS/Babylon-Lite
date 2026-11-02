import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { SSAO_BASELINE } from "../../lab/lite/src/shared/ssao-comparison-contract.js";

export function comparisonGitBlobHash(bytes: Uint8Array): string {
    return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** PR839 imports `_resolveRenderTargetSize`; newer checkouts export it, older ones only define `resolveSize`. */
export function comparisonSizeExport(code: string): string {
    if (code.includes("export function _resolveRenderTargetSize(")) {
        return code;
    }
    if (!code.includes("function resolveSize(")) {
        throw new Error("The comparison's render-target size compatibility seam no longer matches this checkout.");
    }
    return `${code}\nexport { resolveSize as _resolveRenderTargetSize };\n`;
}

export function comparisonBaselineImport(root: string, snapshot: string, source: string, importer: string): string | null {
    const from = resolve(importer.split("?")[0]!);
    const inside = relative(snapshot, from);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !source.startsWith(".")) {
        return null;
    }
    const local = resolve(snapshot, "post-process", source).replace(/\.js$/, ".ts");
    const filename = relative(resolve(snapshot, "post-process"), local);
    if (Object.hasOwn(SSAO_BASELINE.blobs, filename)) {
        return local;
    }
    const target = resolve(root, "packages", "babylon-lite", "src", "post-process", source).replace(/\.js$/, ".ts");
    const boundary = relative(resolve(root, "packages", "babylon-lite", "src"), target);
    if (boundary === ".." || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) {
        throw new Error(`Baseline dependency escaped the engine source: ${source}`);
    }
    return target;
}

export async function prepareComparisonBaseline(root: string): Promise<string> {
    const snapshot = resolve(root, ".ao-reference-cache", "ssao-comparison-baseline", SSAO_BASELINE.commit);
    const directory = resolve(snapshot, "post-process");
    await mkdir(directory, { recursive: true });
    await Promise.all(
        Object.entries(SSAO_BASELINE.blobs).map(async ([name, expected]) => {
            const file = resolve(directory, name);
            let bytes: Uint8Array | null = null;
            try {
                bytes = await readFile(file);
            } catch (error) {
                if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
                    throw error;
                }
            }
            if (bytes === null) {
                const url = `https://raw.githubusercontent.com/${SSAO_BASELINE.repository}/${SSAO_BASELINE.commit}/packages/babylon-lite/src/post-process/${name}`;
                const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
                if (!response.ok) {
                    throw new Error(`Cannot fetch pinned SSAO baseline ${name}: HTTP ${response.status}`);
                }
                bytes = new Uint8Array(await response.arrayBuffer());
                if (comparisonGitBlobHash(bytes) !== expected) {
                    throw new Error(`Downloaded SSAO baseline blob mismatch: ${name}`);
                }
                await writeFile(file, bytes);
            }
            if (comparisonGitBlobHash(bytes) !== expected) {
                throw new Error(`Cached SSAO baseline blob mismatch: ${file}`);
            }
        })
    );
    return snapshot;
}

/** Build-only fixture loading; never changes the engine's package exports or source. */
export async function comparisonBaselinePlugin(root: string): Promise<Plugin> {
    const snapshot = await prepareComparisonBaseline(root);
    return {
        name: "pinned-ssao-comparison-baseline",
        enforce: "pre",
        resolveId(source, importer) {
            if (source === "ssao-comparison-baseline") {
                return resolve(snapshot, "post-process", "screen-space-ambient-occlusion.ts");
            }
            return importer ? comparisonBaselineImport(root, snapshot, source, importer) : null;
        },
        transform(code, id) {
            if (resolve(id.split("?")[0]!) !== resolve(root, "packages", "babylon-lite", "src", "engine", "render-target.ts")) {
                return null;
            }
            return { code: comparisonSizeExport(code), map: null };
        },
    };
}
