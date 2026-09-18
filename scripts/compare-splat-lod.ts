import { chromium } from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "vite";
import {
    DEFAULT_SPLAT_LOD_WAYPOINTS,
    type SplatLodComparisonOptions,
    type SplatLodRunSummary,
    type SplatLodSampleRecord,
    type SplatLodWaypoint,
} from "./splat-lod-comparison-types";

const DEFAULT_ASSET_URL = "https://assets.babylonjs.com/splats/Trogir/lod-meta.json";
const SUPPORTED_OPTIONS = new Set([
    "asset-url",
    "cpu-mib",
    "dpr",
    "engine",
    "gpu-mib",
    "headed",
    "height",
    "hold-ms",
    "output",
    "port",
    "poses",
    "profiles",
    "sample-ms",
    "screen-error",
    "splat-budget",
    "timeout-ms",
    "waypoints",
    "width",
]);
const USAGE =
    "tsx scripts/compare-splat-lod.ts [--engine=lite|playcanvas|both] [--profiles=matched|all] " +
    "[--asset-url=URL] [--output=DIR] [--poses=FILE] [--waypoints=NAMES] [--width=N] [--height=N] [--dpr=N] " +
    "[--splat-budget=N] [--gpu-mib=N] [--cpu-mib=N] [--screen-error=N] [--sample-ms=N] [--hold-ms=N] " +
    "[--timeout-ms=N] [--port=N] [--headed=true|false]";

function validateArguments(): boolean {
    for (const argument of process.argv.slice(2)) {
        if (argument === "--help") {
            process.stdout.write(`${USAGE}\n`);
            return false;
        }
        const match = /^--([^=]+)=(.*)$/.exec(argument);
        if (!match || !SUPPORTED_OPTIONS.has(match[1]!)) {
            throw new RangeError(`unsupported argument ${argument}; expected --name=value\n${USAGE}`);
        }
    }
    const headed = option("headed");
    if (headed !== undefined && headed !== "true" && headed !== "false") {
        throw new RangeError("--headed must be true or false");
    }
    return true;
}

function option(name: string): string | undefined {
    const argument = process.argv.find((value) => value.startsWith(`--${name}=`));
    return argument?.slice(name.length + 3);
}

function numberOption(name: string, fallback: number, integer = false, maximum = Number.MAX_SAFE_INTEGER): number {
    const value = option(name);
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum || (integer && !Number.isSafeInteger(parsed))) {
        throw new RangeError(`--${name} must be a positive finite number`);
    }
    return parsed;
}

function waypoints(): readonly SplatLodWaypoint[] {
    const path = option("poses");
    const source = path ? (JSON.parse(readFileSync(resolve(path), "utf8")) as unknown) : DEFAULT_SPLAT_LOD_WAYPOINTS;
    if (!Array.isArray(source) || source.length === 0) {
        throw new Error("--poses must name a nonempty JSON array");
    }
    const seen = new Set<string>();
    for (const value of source) {
        if (!value || typeof value !== "object") {
            throw new Error("--poses entries must be objects");
        }
        const supportedFields = new Set(["name", "eye", "target", "yawDegrees", "pitchDegrees"]);
        const unknownField = Object.keys(value).find((field) => !supportedFields.has(field));
        if (unknownField) {
            throw new Error(`--poses contains unsupported field ${unknownField}`);
        }
        const waypoint = value as Partial<SplatLodWaypoint>;
        if (typeof waypoint.name !== "string" || waypoint.name.length === 0 || seen.has(waypoint.name)) {
            throw new Error("--poses waypoint names must be nonempty and unique");
        }
        seen.add(waypoint.name);
        for (const field of ["eye", "target"] as const) {
            const vector = waypoint[field];
            if (vector !== undefined && (!Array.isArray(vector) || vector.length !== 3 || vector.some((component) => !Number.isFinite(component)))) {
                throw new Error(`--poses ${waypoint.name}.${field} must contain three finite numbers`);
            }
        }
        for (const field of ["yawDegrees", "pitchDegrees"] as const) {
            if (waypoint[field] !== undefined && !Number.isFinite(waypoint[field])) {
                throw new Error(`--poses ${waypoint.name}.${field} must be finite`);
            }
        }
        if ((waypoint.yawDegrees === undefined) !== (waypoint.pitchDegrees === undefined) || (waypoint.target !== undefined && waypoint.yawDegrees !== undefined)) {
            throw new Error(`--poses ${waypoint.name} must use either target or both yawDegrees and pitchDegrees`);
        }
    }
    const names = option("waypoints")?.split(",");
    if (names?.some((name) => name.length === 0 || names.indexOf(name) !== names.lastIndexOf(name))) {
        throw new Error("--waypoints names must be nonempty and unique");
    }
    const selected = names ? names.map((name) => source.find((value) => (value as SplatLodWaypoint).name === name)) : source;
    if (selected.some((value) => !value)) {
        throw new Error("--waypoints contains an unknown pose name");
    }
    return selected as SplatLodWaypoint[];
}

async function waitForServer(url: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {
            // The owned server may still be binding.
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`comparison server did not become ready at ${url}`);
}

async function runAdapter(url: string, engine: "lite" | "playcanvas", options: SplatLodComparisonOptions, jsonlPath: string): Promise<SplatLodRunSummary> {
    const browser = await chromium.launch({
        channel: "chrome",
        headless: option("headed") !== "true",
        args: ["--force-color-profile=srgb", "--enable-unsafe-webgpu"],
    });
    try {
        const page = await browser.newPage({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: options.dpr });
        const runtimeErrors: string[] = [];
        page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
        page.on("console", (message) => {
            if (message.type() === "error") {
                runtimeErrors.push(`console: ${message.text()}`);
            }
        });
        await page.exposeFunction("__emitSplatLodRecord", (record: SplatLodSampleRecord) => {
            appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
        });
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const adapterPath = engine === "lite" ? "lab/lite/src/tools/splat-lod-comparison-lite.ts" : "lab/lite/src/tools/splat-lod-comparison-playcanvas.mjs";
        const adapterFunction = engine === "lite" ? "runLiteLodComparison" : "runPlayCanvasLodComparison";
        const adapterUrl = `/@fs/${resolve(adapterPath).replaceAll("\\", "/")}`;
        const expression = `(async()=>{const adapter=await import(${JSON.stringify(adapterUrl)});const binding=globalThis.__emitSplatLodRecord;if(!binding)throw new Error("LOD comparison record binding is unavailable");return adapter[${JSON.stringify(adapterFunction)}](${JSON.stringify(options)},record=>binding(record));})()`;
        const evaluation = page.evaluate(expression) as Promise<SplatLodRunSummary>;
        const evaluationTimeoutMs = options.timeoutMs * (options.waypoints.length + 1) + 5000;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const summary = await Promise.race([
            evaluation,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${engine} page evaluation timed out after ${evaluationTimeoutMs} ms`)), evaluationTimeoutMs);
            }),
        ]).finally(() => {
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
        });
        await page.waitForTimeout(0);
        if (runtimeErrors.length > 0) {
            throw new Error(`${engine} browser runtime error(s): ${runtimeErrors.join(" | ")}`);
        }
        return summary;
    } finally {
        await browser.close();
    }
}

function humanSummary(summaries: readonly SplatLodRunSummary[]): string {
    const lines = ["Trogir LOD convergence comparison", ""];
    for (const summary of summaries) {
        lines.push(`${summary.engine} ${summary.engineVersion} · ${summary.profile}`);
        for (const waypoint of summary.waypoints) {
            const nearest = waypoint.nearest
                .slice(0, 6)
                .map((leaf) => `${leaf.index}@${leaf.distance.toFixed(2)}m target ${leaf.targetLod ?? "-"} displayed ${leaf.displayedLod ?? "-"}`)
                .join("; ");
            lines.push(
                `  ${waypoint.name}: ${waypoint.disposition} in ${Math.round(waypoint.elapsedMs)} ms, ${waypoint.visibleLeaves} visible, ` +
                    `${waypoint.targetDisplayGapLeaves} target/display gaps`,
                `    nearest: ${nearest}`
            );
        }
        lines.push("");
    }
    const lite = summaries.find((summary) => summary.engine === "babylon-lite" && summary.profile === "matched-budget");
    const playcanvas = summaries.find((summary) => summary.engine === "playcanvas" && summary.profile === "matched-budget");
    if (lite && playcanvas) {
        lines.push("Matched-profile nearest displayed LOD differences (PlayCanvas - Babylon Lite)");
        for (const liteWaypoint of lite.waypoints) {
            const playCanvasWaypoint = playcanvas.waypoints.find((waypoint) => waypoint.name === liteWaypoint.name);
            if (!playCanvasWaypoint) {
                continue;
            }
            const playCanvasLeaves = new Map(playCanvasWaypoint.nearest.map((leaf) => [leaf.id, leaf]));
            const differences = liteWaypoint.nearest
                .map((leaf) => {
                    const reference = playCanvasLeaves.get(leaf.id);
                    return reference && reference.displayedLod !== null && leaf.displayedLod !== null ? `${leaf.index}:${reference.displayedLod - leaf.displayedLod}` : null;
                })
                .filter((value): value is string => value !== null);
            lines.push(`  ${liteWaypoint.name}: ${differences.join(", ")}`);
        }
        lines.push("");
    }
    return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
    if (!validateArguments()) {
        return;
    }
    const port = numberOption("port", 5191, true, 65_535);
    const outputDirectory = resolve(option("output") ?? ".splat-lod-reports");
    mkdirSync(outputDirectory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const jsonlPath = resolve(outputDirectory, `${stamp}-comparison.jsonl`);
    const summaryPath = resolve(outputDirectory, `${stamp}-comparison-summary.json`);
    const textPath = resolve(outputDirectory, `${stamp}-comparison-summary.txt`);
    writeFileSync(jsonlPath, "");
    const common = {
        codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        workingTreeDirty: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { encoding: "utf8" }).trim().length > 0,
        assetUrl: option("asset-url") ?? DEFAULT_ASSET_URL,
        width: numberOption("width", 900, true, 16_384),
        height: numberOption("height", 1000, true, 16_384),
        dpr: numberOption("dpr", 1, false, 8),
        maxSplats: numberOption("splat-budget", 750_000, true, 4_000_000),
        maxGpuBytes: numberOption("gpu-mib", 256, true, Math.floor(Number.MAX_SAFE_INTEGER / 1024 / 1024)) * 1024 * 1024,
        maxCpuBytes: numberOption("cpu-mib", 96, true, Math.floor(Number.MAX_SAFE_INTEGER / 1024 / 1024)) * 1024 * 1024,
        screenError: numberOption("screen-error", 2),
        sampleMs: numberOption("sample-ms", 250, true),
        quietMs: numberOption("hold-ms", 2000, true),
        timeoutMs: numberOption("timeout-ms", 60_000, true),
        waypoints: waypoints(),
        profile: "matched-budget",
    } as const;
    const server = await createServer({
        root: resolve("lab"),
        configFile: resolve("lab/vite.config.ts"),
        server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
        clearScreen: false,
    });
    try {
        await server.listen();
        const url = `http://127.0.0.1:${port}/lite/splat-lod-comparison.html`;
        await waitForServer(url);
        const summaries: SplatLodRunSummary[] = [];
        const engine = option("engine") ?? "both";
        const profiles = option("profiles") ?? "all";
        if (engine !== "lite" && engine !== "playcanvas" && engine !== "both") {
            throw new RangeError("--engine must be lite, playcanvas, or both");
        }
        if (profiles !== "matched" && profiles !== "all") {
            throw new RangeError("--profiles must be matched or all");
        }
        if (engine === "lite" || engine === "both") {
            summaries.push(await runAdapter(url, "lite", { ...common, sequence: "cold", profile: "matched-budget" }, jsonlPath));
        }
        if (engine === "playcanvas" || engine === "both") {
            summaries.push(await runAdapter(url, "playcanvas", { ...common, sequence: "cold", profile: "matched-budget" }, jsonlPath));
            if (profiles === "all") {
                summaries.push(await runAdapter(url, "playcanvas", { ...common, sequence: "cold", profile: "viewer-budget", maxSplats: 4_000_000 }, jsonlPath));
            }
        }
        writeFileSync(summaryPath, `${JSON.stringify(summaries, null, 2)}\n`);
        writeFileSync(textPath, humanSummary(summaries));
        process.stdout.write(`${summaryPath}\n${textPath}\n${jsonlPath}\n`);
    } finally {
        await server.close();
    }
}

void main().catch((reason: unknown) => {
    console.error(reason);
    process.exitCode = 1;
});
