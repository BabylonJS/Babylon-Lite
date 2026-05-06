/**
 * Build Lab Site - creates a deployable static version of the lab website.
 *
 * The dev server serves a few repo-root files (/scene-config.json and
 * /reference/*) through middleware. This script runs the normal Vite build,
 * copies those files into lab/dist, and optionally rewrites root-relative URLs
 * for deployment under a build-specific subpath.
 *
 * Env: LAB_BASE_PATH - public base path for the deployed site, e.g.
 *      /lite/$(Build.BuildNumber)/lab/
 */
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { extname, resolve } from "path";

const ROOT = resolve(__dirname, "..");
const LAB_DIR = resolve(ROOT, "lab");
const DIST_DIR = resolve(LAB_DIR, "dist");
const SCENE_CONFIG = resolve(ROOT, "scene-config.json");
const REFERENCE_DIR = resolve(ROOT, "reference");

const ROOT_RELATIVE_PREFIXES = [
    "HavokPhysics.wasm",
    "babylon-ref-scene",
    "brdf-lut.png",
    "bundle",
    "bundle-baseline",
    "bundle-baseline-scene",
    "bundle-bjs-scene",
    "bundle-scene",
    "draco_decoder.js",
    "draco_decoder.wasm",
    "lab-api",
    "loader.js",
    "models",
    "perf-manifest.json",
    "perf-regression-manifest.json",
    "reference",
    "scene",
    "scene-config.json",
    "textures",
    "thumbnails",
    "vendor",
];

function normalizeBasePath(value: string | undefined): string {
    if (!value) {
        return "/";
    }
    const withLeading = value.startsWith("/") ? value : `/${value}`;
    return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

function runViteBuild(basePath: string): void {
    const result = spawnSync("pnpm", ["--filter", "@babylon-lite/lab", "exec", "vite", "build", "--base", basePath], {
        cwd: ROOT,
        stdio: "inherit",
        env: process.env,
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function copyStaticRuntimeData(): void {
    mkdirSync(DIST_DIR, { recursive: true });
    cpSync(SCENE_CONFIG, resolve(DIST_DIR, "scene-config.json"));
    if (existsSync(REFERENCE_DIR)) {
        const target = resolve(DIST_DIR, "reference");
        rmSync(target, { recursive: true, force: true });
        cpSync(REFERENCE_DIR, target, { recursive: true });
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteRootRelativeUrls(text: string, basePath: string): string {
    const prefixes = ROOT_RELATIVE_PREFIXES.map(escapeRegExp).join("|");
    return text.replace(new RegExp(`(["'=(:\\s])/((${prefixes})(?=[/"'.?#)\\s]|[0-9A-Za-z_-]))`, "g"), `$1${basePath}$2`);
}

function rewriteFilesForBasePath(dir: string, basePath: string): void {
    for (const entry of readdirSync(dir)) {
        const path = resolve(dir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
            rewriteFilesForBasePath(path, basePath);
            continue;
        }

        if (![".css", ".html", ".js", ".json"].includes(extname(path))) {
            continue;
        }

        const before = readFileSync(path, "utf-8");
        const after = rewriteRootRelativeUrls(before, basePath);
        if (after !== before) {
            writeFileSync(path, after);
        }
    }
}

const basePath = normalizeBasePath(process.env.LAB_BASE_PATH);
runViteBuild(basePath);
copyStaticRuntimeData();

if (basePath !== "/") {
    rewriteFilesForBasePath(DIST_DIR, basePath);
}

console.log(`Lab static site built to ${DIST_DIR}`);
