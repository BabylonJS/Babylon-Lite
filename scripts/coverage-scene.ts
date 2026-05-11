/**
 * On-demand Chrome JavaScript coverage for lab scenes.
 *
 * Usage:
 *   pnpm coverage:scene scene1
 *   pnpm coverage:scene 1 --top 25 --functions 50 --timeout 60000 --settle 500
 *   HEADLESS=false pnpm coverage:scene scene1?seekTime=1
 *   pnpm coverage:scene scene1 --dev
 */
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { createServer as createHttpServer } from "http";
import type { Server } from "http";
import { createRequire } from "module";
import { basename, extname, isAbsolute, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { createServer } from "vite";
import type { Plugin, ViteDevServer } from "vite";

type CoverageMode = "prod" | "dev";

interface CliOptions {
    scene: string;
    mode: CoverageMode;
    build: boolean;
    topFiles: number;
    topFunctions: number;
    timeoutMs: number;
    settleMs: number;
    printJson: boolean;
}

interface CoverageRange {
    startOffset: number;
    endOffset: number;
    count: number;
}

interface CoverageFunction {
    functionName: string;
    ranges: CoverageRange[];
    isBlockCoverage: boolean;
}

interface JsCoverageEntry {
    url: string;
    source?: string;
    functions: CoverageFunction[];
}

interface FileReport {
    path: string;
    repoPath: string;
    url: string;
    totalBytes: number;
    usedBytes: number;
    unusedBytes: number;
    unusedPercent: number;
}

interface UnusedFunctionReport {
    file: string;
    functionName: string;
    line: number;
    bytes: number;
    snippet: string;
}

interface CoverageReport {
    generatedAt: string;
    scene: string;
    mode: CoverageMode;
    url: string;
    totals: {
        files: number;
        totalBytes: number;
        usedBytes: number;
        unusedBytes: number;
        unusedPercent: number;
    };
    files: FileReport[];
    unusedFunctions: UnusedFunctionReport[];
    caveat: string;
}

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const labDir = resolve(repoRoot, "lab");
const labPublicDir = resolve(labDir, "public");
const bundleDir = resolve(labPublicDir, "bundle");
const liteSrcDir = resolve(repoRoot, "packages", "babylon-lite", "src");
const labLiteSrcDir = resolve(labDir, "src", "lite");
const require = createRequire(import.meta.url);

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = {
        scene: "scene1",
        mode: "prod",
        build: true,
        topFiles: 25,
        topFunctions: 50,
        timeoutMs: 60_000,
        settleMs: 500,
        printJson: false,
    };

    let i = 0;
    if (argv[0] && !argv[0].startsWith("--")) {
        opts.scene = argv[0];
        i = 1;
    }

    while (i < argv.length) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--top" && next) {
            opts.topFiles = Number.parseInt(next, 10);
            i += 2;
            continue;
        }
        if (arg === "--functions" && next) {
            opts.topFunctions = Number.parseInt(next, 10);
            i += 2;
            continue;
        }
        if (arg === "--timeout" && next) {
            opts.timeoutMs = Number.parseInt(next, 10);
            i += 2;
            continue;
        }
        if (arg === "--settle" && next) {
            opts.settleMs = Number.parseInt(next, 10);
            i += 2;
            continue;
        }
        if (arg === "--json") {
            opts.printJson = true;
            i += 1;
            continue;
        }
        if (arg === "--dev") {
            opts.mode = "dev";
            i += 1;
            continue;
        }
        if (arg === "--prod") {
            opts.mode = "prod";
            i += 1;
            continue;
        }
        if (arg === "--no-build") {
            opts.build = false;
            i += 1;
            continue;
        }
        throw new Error(`Unknown or incomplete argument: ${arg}`);
    }

    if (!Number.isFinite(opts.topFiles) || opts.topFiles < 1) {
        throw new Error("--top must be a positive number");
    }
    if (!Number.isFinite(opts.topFunctions) || opts.topFunctions < 0) {
        throw new Error("--functions must be zero or a positive number");
    }
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1_000) {
        throw new Error("--timeout must be at least 1000 ms");
    }
    if (!Number.isFinite(opts.settleMs) || opts.settleMs < 0) {
        throw new Error("--settle must be zero or a positive number");
    }

    return opts;
}

function normalizeSceneArg(sceneArg: string): { sceneName: string; query: string } {
    const [rawScene, rawQuery = ""] = sceneArg.split("?", 2);
    const sceneName = /^\d+$/.test(rawScene) ? `scene${rawScene}` : rawScene || "scene1";
    const query = rawQuery ? `?${rawQuery}` : "";
    return { sceneName, query };
}

function scenePagePath(sceneName: string, query: string, mode: CoverageMode): string {
    return mode === "prod" ? `/bundle-${sceneName}.html${query}` : `/${sceneName}.html${query}`;
}

interface StartedServer {
    baseUrl: string;
    close(): Promise<void>;
}

async function startViteLabServer(): Promise<StartedServer> {
    const server = await createServer({
        root: labDir,
        configFile: resolve(labDir, "vite.config.ts"),
        logLevel: "warn",
        plugins: [optionalManifoldStubPlugin()],
        server: {
            host: "127.0.0.1",
            port: 0,
            strictPort: false,
        },
    });
    await server.listen();
    const localUrl = server.resolvedUrls?.local[0];
    if (!localUrl) {
        await server.close();
        throw new Error("Vite did not report a local dev-server URL");
    }
    return { baseUrl: localUrl.replace(/\/$/, ""), close: () => server.close() };
}

const MIME: Record<string, string> = {
    ".bin": "application/octet-stream",
    ".dds": "application/octet-stream",
    ".env": "application/octet-stream",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".html": "text/html",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".wasm": "application/wasm",
};

async function startStaticLabServer(): Promise<StartedServer> {
    const server = await new Promise<Server>((resolveServer, reject) => {
        const httpServer = createHttpServer((req, res) => {
            const urlPath = decodeURIComponent((req.url ?? "/").split("?", 1)[0] || "/");
            const cleanPath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
            if (cleanPath.split(/[\\/]/).includes("..")) {
                res.writeHead(400);
                res.end("Bad request");
                return;
            }

            const candidates = [resolve(labDir, cleanPath), resolve(labPublicDir, cleanPath)];
            for (const filePath of candidates) {
                if (existsSync(filePath) && statSync(filePath).isFile()) {
                    res.writeHead(200, {
                        "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
                        "Cache-Control": "no-store",
                    });
                    res.end(readFileSync(filePath));
                    return;
                }
            }

            res.writeHead(404);
            res.end("Not found");
        });
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => resolveServer(httpServer));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
        server.close();
        throw new Error("Static server did not report a TCP port");
    }
    return {
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
            new Promise<void>((resolveClose, reject) => {
                server.close((err) => (err ? reject(err) : resolveClose()));
            }),
    };
}

async function buildProductionBundle(sceneName: string): Promise<void> {
    const prevBundleScenes = process.env.BUNDLE_SCENES;
    const prevSkipBjs = process.env.SKIP_BJS;
    const prevSkipMeasure = process.env.SKIP_MEASURE;
    process.env.BUNDLE_SCENES = sceneName;
    process.env.SKIP_BJS = "1";
    process.env.SKIP_MEASURE = "1";
    try {
        const { buildBundleScenes } = await import("./bundle-scenes-core");
        await buildBundleScenes();
    } finally {
        restoreEnv("BUNDLE_SCENES", prevBundleScenes);
        restoreEnv("SKIP_BJS", prevSkipBjs);
        restoreEnv("SKIP_MEASURE", prevSkipMeasure);
    }
}

function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

function optionalManifoldStubPlugin(): Plugin {
    let hasManifold = true;
    try {
        require.resolve("manifold-3d");
        require.resolve("manifold-3d/manifold.wasm");
    } catch {
        hasManifold = false;
    }

    const manifoldModuleId = "\0coverage-scene:missing-manifold";
    const manifoldWasmId = "\0coverage-scene:missing-manifold-wasm";
    return {
        name: "coverage-scene-optional-manifold-stub",
        enforce: "pre",
        resolveId(source) {
            if (hasManifold) {
                return null;
            }
            if (source === "manifold-3d") {
                return manifoldModuleId;
            }
            if (source === "manifold-3d/manifold.wasm?url") {
                return manifoldWasmId;
            }
            return null;
        },
        load(id) {
            if (id === manifoldModuleId) {
                return 'export default async function missingManifold() { throw new Error("manifold-3d is not installed; CSG2 coverage scenes require that optional dependency."); }';
            }
            if (id === manifoldWasmId) {
                return 'export default "";';
            }
            return null;
        },
    };
}

function browserArgs(): string[] {
    const isCI = !!process.env.CI;
    const swiftShaderArgs = isCI
        ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
        : [];
    return ["--force-color-profile=srgb", "--enable-unsafe-webgpu", ...swiftShaderArgs];
}

async function collectCoverage(page: Page, url: string, timeoutMs: number, settleMs: number): Promise<JsCoverageEntry[]> {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", undefined, { timeout: timeoutMs });
    if (settleMs > 0) {
        await page.waitForTimeout(settleMs);
    }
    return (await page.coverage.stopJSCoverage()) as JsCoverageEntry[];
}

function stripQueryAndHash(value: string): string {
    return value.split("#", 1)[0].split("?", 1)[0];
}

function normalizePathCase(value: string): string {
    return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInsideDir(filePath: string, dir: string): boolean {
    const rel = relative(dir, filePath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathFromCoverageUrl(rawUrl: string): string | null {
    if (!rawUrl || rawUrl.startsWith("chrome-extension:") || rawUrl.startsWith("devtools:")) {
        return null;
    }

    const withoutQuery = stripQueryAndHash(rawUrl);
    if (withoutQuery.startsWith("file:")) {
        return resolve(fileURLToPath(withoutQuery));
    }

    let pathname: string;
    try {
        pathname = decodeURIComponent(new URL(withoutQuery).pathname);
    } catch {
        return null;
    }

    if (pathname === "/@vite/client" || pathname.includes("/node_modules/") || pathname.includes("/.vite/deps/")) {
        return null;
    }

    if (pathname.startsWith("/@fs/")) {
        return resolve(pathname.slice("/@fs/".length));
    }
    if (pathname.startsWith("/src/")) {
        return resolve(labDir, `.${pathname}`);
    }
    if (pathname.startsWith("/packages/")) {
        return resolve(repoRoot, `.${pathname}`);
    }
    if (pathname.startsWith("/bundle/")) {
        return resolve(labPublicDir, `.${pathname}`);
    }
    return null;
}

function isFirstPartyCoverageFile(filePath: string, mode: CoverageMode): boolean {
    const normalized = normalizePathCase(filePath);
    if (normalized.includes(`${sep}node_modules${sep}`) || normalized.includes(`${sep}.vite${sep}deps${sep}`)) {
        return false;
    }
    if (basename(normalized) === "loader.js") {
        return false;
    }
    if (!/\.[cm]?[jt]sx?$/.test(normalized)) {
        return false;
    }
    if (mode === "prod") {
        return isInsideDir(filePath, bundleDir);
    }
    return isInsideDir(filePath, liteSrcDir) || isInsideDir(filePath, labLiteSrcDir);
}

function mergePreciseUsedBytes(totalBytes: number, functions: CoverageFunction[]): number {
    const ranges = functions
        .flatMap((fn) => fn.ranges)
        .map((range) => ({
            startOffset: Math.max(0, Math.min(totalBytes, range.startOffset)),
            endOffset: Math.max(0, Math.min(totalBytes, range.endOffset)),
            count: range.count,
        }))
        .filter((range) => range.endOffset > range.startOffset);

    if (ranges.length === 0) {
        return 0;
    }

    const points = new Set<number>([0, totalBytes]);
    for (const range of ranges) {
        points.add(range.startOffset);
        points.add(range.endOffset);
    }
    const sortedPoints = [...points].sort((a, b) => a - b);

    let usedBytes = 0;
    for (let i = 0; i < sortedPoints.length - 1; i++) {
        const start = sortedPoints[i];
        const end = sortedPoints[i + 1];
        const covering = ranges
            .filter((range) => range.startOffset <= start && range.endOffset >= end)
            .sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset))[0];
        if (covering && covering.count > 0) {
            usedBytes += end - start;
        }
    }
    return usedBytes;
}

function lineNumberAt(source: string, offset: number): number {
    let line = 1;
    const end = Math.max(0, Math.min(source.length, offset));
    for (let i = 0; i < end; i++) {
        if (source.charCodeAt(i) === 10) {
            line++;
        }
    }
    return line;
}

function compactSnippet(source: string, startOffset: number, endOffset: number): string {
    return source
        .slice(startOffset, Math.min(endOffset, startOffset + 240))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
}

function repoRelative(filePath: string): string {
    return relative(repoRoot, filePath).split(sep).join("/");
}

function buildReport(entries: JsCoverageEntry[], sceneName: string, mode: CoverageMode, pageUrl: string): CoverageReport {
    const files: FileReport[] = [];
    const unusedFunctions: UnusedFunctionReport[] = [];

    for (const entry of entries) {
        const filePath = pathFromCoverageUrl(entry.url);
        if (!filePath || !isFirstPartyCoverageFile(filePath, mode)) {
            continue;
        }

        const source = entry.source ?? "";
        const totalBytes = source.length || Math.max(0, ...entry.functions.flatMap((fn) => fn.ranges.map((range) => range.endOffset)));
        const usedBytes = mergePreciseUsedBytes(totalBytes, entry.functions);
        const unusedBytes = Math.max(0, totalBytes - usedBytes);
        const unusedPercent = totalBytes > 0 ? (unusedBytes / totalBytes) * 100 : 0;
        const repoPath = repoRelative(filePath);

        files.push({
            path: filePath,
            repoPath,
            url: entry.url,
            totalBytes,
            usedBytes,
            unusedBytes,
            unusedPercent,
        });

        for (const fn of entry.functions) {
            if (fn.ranges.length === 0 || fn.ranges.some((range) => range.count > 0)) {
                continue;
            }
            const startOffset = Math.min(...fn.ranges.map((range) => range.startOffset));
            const endOffset = Math.max(...fn.ranges.map((range) => range.endOffset));
            if (endOffset <= startOffset) {
                continue;
            }
            unusedFunctions.push({
                file: repoPath,
                functionName: fn.functionName || "(anonymous)",
                line: source ? lineNumberAt(source, startOffset) : 0,
                bytes: endOffset - startOffset,
                snippet: source ? compactSnippet(source, startOffset, endOffset) : "",
            });
        }
    }

    files.sort((a, b) => b.unusedBytes - a.unusedBytes);
    unusedFunctions.sort((a, b) => b.bytes - a.bytes);

    const totals = files.reduce(
        (acc, file) => {
            acc.totalBytes += file.totalBytes;
            acc.usedBytes += file.usedBytes;
            acc.unusedBytes += file.unusedBytes;
            return acc;
        },
        { files: files.length, totalBytes: 0, usedBytes: 0, unusedBytes: 0, unusedPercent: 0 }
    );
    totals.unusedPercent = totals.totalBytes > 0 ? (totals.unusedBytes / totals.totalBytes) * 100 : 0;

    return {
        generatedAt: new Date().toISOString(),
        scene: sceneName,
        mode,
        url: pageUrl,
        totals,
        files,
        unusedFunctions,
        caveat:
            mode === "prod"
                ? "Chrome coverage is production-bundle runtime-path coverage. It identifies delivered bundle bytes not executed by this scene path; use bundle-info or analyze-bundle to map chunks back to source modules before changing boundaries."
                : "Chrome coverage is Vite dev runtime-path coverage. It is useful for source-level clues, but dev/barrel imports can report false positives; production-bundle mode is the tree-shaking signal.",
    };
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${bytes} B`;
}

function renderMarkdown(report: CoverageReport, topFiles: number, topFunctions: number): string {
    const lines = [
        `# Chrome JS Coverage — ${report.scene} (${report.mode})`,
        "",
        `- URL: ${report.url}`,
        `- Generated: ${report.generatedAt}`,
        `- Files: ${report.totals.files}`,
        `- Total: ${formatBytes(report.totals.totalBytes)}`,
        `- Unused: ${formatBytes(report.totals.unusedBytes)} (${report.totals.unusedPercent.toFixed(1)}%)`,
        "",
        "## Top unused files",
        "",
        "| Unused | Unused % | Total | File |",
        "|---:|---:|---:|---|",
        ...report.files.slice(0, topFiles).map((file) => `| ${formatBytes(file.unusedBytes)} | ${file.unusedPercent.toFixed(1)}% | ${formatBytes(file.totalBytes)} | \`${file.repoPath}\` |`),
        "",
        "## Fully unused functions/ranges",
        "",
        "| Bytes | File:line | Function | Snippet |",
        "|---:|---|---|---|",
        ...report.unusedFunctions
            .slice(0, topFunctions)
            .map((fn) => `| ${formatBytes(fn.bytes)} | \`${fn.file}:${fn.line}\` | \`${fn.functionName}\` | ${fn.snippet.replace(/\|/g, "\\|")} |`),
        "",
        `> ${report.caveat}`,
        "",
    ];
    return `${lines.join("\n")}\n`;
}

async function writeReports(report: CoverageReport, topFiles: number, topFunctions: number): Promise<{ jsonPath: string; markdownPath: string }> {
    const outDir = resolve(repoRoot, "test-results", "coverage");
    await mkdir(outDir, { recursive: true });
    const jsonPath = resolve(outDir, `${report.scene}-${report.mode}-coverage.json`);
    const markdownPath = resolve(outDir, `${report.scene}-${report.mode}-coverage.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(markdownPath, renderMarkdown(report, topFiles, topFunctions), "utf-8");
    return { jsonPath, markdownPath };
}

function printSummary(report: CoverageReport, jsonPath: string, markdownPath: string, topFiles: number, topFunctions: number): void {
    console.log(`\nChrome JS coverage for ${report.scene} (${report.mode})`);
    console.log(`URL: ${report.url}`);
    console.log(`JSON report: ${jsonPath}`);
    console.log(`Markdown report: ${markdownPath}`);
    console.log(`First-party total: ${formatBytes(report.totals.totalBytes)}; unused: ${formatBytes(report.totals.unusedBytes)} (${report.totals.unusedPercent.toFixed(1)}%)`);

    console.log(`\nTop ${Math.min(topFiles, report.files.length)} unused files:`);
    for (const file of report.files.slice(0, topFiles)) {
        console.log(`  ${formatBytes(file.unusedBytes).padStart(9)}  ${file.unusedPercent.toFixed(1).padStart(5)}%  ${file.repoPath}`);
    }

    console.log(`\nTop ${Math.min(topFunctions, report.unusedFunctions.length)} fully unused functions/ranges:`);
    for (const fn of report.unusedFunctions.slice(0, topFunctions)) {
        console.log(`  ${formatBytes(fn.bytes).padStart(9)}  ${fn.file}:${fn.line}  ${fn.functionName}  ${fn.snippet}`);
    }

    console.log(`\nCaveat: ${report.caveat}`);
    console.log("Next step: map production chunk gaps through lab/public/bundle/bundle-info before changing tree-shaking boundaries.\n");
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    const { sceneName, query } = normalizeSceneArg(opts.scene);
    let server: StartedServer | undefined;
    const browser = await chromium.launch({
        channel: "chrome",
        headless: process.env.HEADLESS !== "false",
        args: browserArgs(),
    });

    try {
        if (opts.mode === "prod" && opts.build) {
            await buildProductionBundle(sceneName);
        }
        server = opts.mode === "prod" ? await startStaticLabServer() : await startViteLabServer();
        const pageUrl = `${server.baseUrl}${scenePagePath(sceneName, query, opts.mode)}`;
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const entries = await collectCoverage(page, pageUrl, opts.timeoutMs, opts.settleMs);
        await page.close();

        const report = buildReport(entries, sceneName, opts.mode, pageUrl);
        const { jsonPath, markdownPath } = await writeReports(report, opts.topFiles, opts.topFunctions);
        if (opts.printJson) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            printSummary(report, jsonPath, markdownPath, opts.topFiles, opts.topFunctions);
        }
    } finally {
        await browser.close();
        if (server) {
            await server.close();
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
