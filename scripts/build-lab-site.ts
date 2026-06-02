/**
 * Build Lab Site - creates a deployable static version of the lab website.
 *
 * The dev server serves a few repo-root files (/scene-config*.json and
 * /reference/lite/*) through middleware. This script runs the normal Vite build,
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
const DEMOS_CONFIG = resolve(ROOT, "demos-config.json");
const SCENE_CONFIG_WEBGL = resolve(ROOT, "scene-config-webgl.json");
const DEMOS_CONFIG_WEBGL = resolve(ROOT, "demos-config-webgl.json");
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
    "demo-",
    "demos-config.json",
    "demos-config-webgl.json",
    "draco_decoder.js",
    "draco_decoder.wasm",
    "lab-api",
    "gl",
    "lite",
    "loader.js",
    "models",
    "perf-manifest.json",
    "perf-regression-manifest.json",
    "reference",
    "scene",
    "scene-config.json",
    "scene-config-webgl.json",
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
        shell: process.platform === "win32",
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function copyStaticRuntimeData(): void {
    mkdirSync(DIST_DIR, { recursive: true });
    cpSync(SCENE_CONFIG, resolve(DIST_DIR, "scene-config.json"));
    if (existsSync(DEMOS_CONFIG)) {
        cpSync(DEMOS_CONFIG, resolve(DIST_DIR, "demos-config.json"));
    }
    if (existsSync(SCENE_CONFIG_WEBGL)) {
        cpSync(SCENE_CONFIG_WEBGL, resolve(DIST_DIR, "scene-config-webgl.json"));
    }
    if (existsSync(DEMOS_CONFIG_WEBGL)) {
        cpSync(DEMOS_CONFIG_WEBGL, resolve(DIST_DIR, "demos-config-webgl.json"));
    }
    if (existsSync(REFERENCE_DIR)) {
        const target = resolve(DIST_DIR, "reference");
        rmSync(target, { recursive: true, force: true });
        cpSync(REFERENCE_DIR, target, { recursive: true });
    }
    const liteDist = resolve(DIST_DIR, "lite");
    mkdirSync(liteDist, { recursive: true });
    for (const dir of ["bundle", "thumbnails", "reference"]) {
        const source = resolve(DIST_DIR, dir);
        if (existsSync(source)) {
            const target = resolve(liteDist, dir);
            rmSync(target, { recursive: true, force: true });
            cpSync(source, target, { recursive: true });
        }
    }
    const liteSourceDir = resolve(LAB_DIR, "lite");
    if (existsSync(liteSourceDir)) {
        const docsSource = resolve(liteSourceDir, "docs");
        if (existsSync(docsSource)) {
            const docsTarget = resolve(liteDist, "docs");
            rmSync(docsTarget, { recursive: true, force: true });
            cpSync(docsSource, docsTarget, { recursive: true });
        }
        const apiDocsSource = resolve(LAB_DIR, "public", "lite", "api-docs");
        if (existsSync(apiDocsSource)) {
            const apiDocsTarget = resolve(liteDist, "api-docs");
            rmSync(apiDocsTarget, { recursive: true, force: true });
            cpSync(apiDocsSource, apiDocsTarget, { recursive: true });
        }
        for (const file of readdirSync(liteSourceDir)) {
            if (file.endsWith(".html")) {
                const html = readFileSync(resolve(liteSourceDir, file), "utf-8");
                if (html.includes('src="/lite/bundle/')) {
                    writeFileSync(resolve(liteDist, file), html);
                }
            }
        }
    }
    const glDocsSource = resolve(LAB_DIR, "gl", "docs");
    if (existsSync(glDocsSource)) {
        const glDocsTarget = resolve(DIST_DIR, "gl", "docs");
        rmSync(glDocsTarget, { recursive: true, force: true });
        mkdirSync(resolve(DIST_DIR, "gl"), { recursive: true });
        cpSync(glDocsSource, glDocsTarget, { recursive: true });
    }
    const glApiDocsSource = resolve(LAB_DIR, "public", "gl", "api-docs");
    if (existsSync(glApiDocsSource)) {
        const glApiDocsTarget = resolve(DIST_DIR, "gl", "api-docs");
        rmSync(glApiDocsTarget, { recursive: true, force: true });
        mkdirSync(resolve(DIST_DIR, "gl"), { recursive: true });
        cpSync(glApiDocsSource, glApiDocsTarget, { recursive: true });
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
