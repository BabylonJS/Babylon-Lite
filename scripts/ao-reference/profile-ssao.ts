import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { adaptSsaoProfileDemo, parseSsaoProfileOptions } from "./ssao-profile-contract.js";
import { temporalValidationLaunchOptions } from "./temporal-validation-options.js";
import type { SsaoProfileClient, SsaoProfileCase } from "./ssao-profile-client.js";
import { diagnosticWorkerPlugin } from "./diagnostic-worker-plugin.js";

export async function profileSsao(args: readonly string[] = process.argv.slice(2)): Promise<void> {
    const options = parseSsaoProfileOptions(args);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = join(root, ".ao-reference-cache", "ssao-profile");
    const source = adaptSsaoProfileDemo(await readFile(join(root, "lab", "lite", "src", "demos", "ambient-occlusion.ts"), "utf8"));
    const bundle = await build({
        stdin: { contents: source, loader: "ts", resolveDir: join(root, "lab", "lite", "src", "demos") },
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "esnext",
        packages: "external",
        plugins: [diagnosticWorkerPlugin()],
        alias: { "babylon-lite": join(root, "packages", "babylon-lite", "src", "index.ts") },
        loader: { ".wgsl": "text", ".wasm": "file" },
        outdir: join(directory, "unused-build-output"),
        logLevel: "silent",
    });
    const code = bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
    if (!code) throw new Error("SSAO diagnostic bundling produced no JavaScript.");
    let html = await readFile(join(root, "lab", "lite", "demo-ambient-occlusion.html"), "utf8");
    for (const [before, after] of [
        ['id="gpuTiming" type="checkbox" checked', 'id="gpuTiming" type="checkbox"'],
        ['src="/lite/bundle/demos/ambient-occlusion.js"', 'src="/ssao-profile.js"'],
    ] as const) {
        if (html.split(before).length !== 2) throw new Error(`SSAO diagnostic HTML hook must occur exactly once: ${before}`);
        html = html.replace(before, after);
    }
    const server = await createServer({
        root,
        configFile: false,
        publicDir: join(root, "lab", "public"),
        logLevel: "error",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
            {
                name: "ssao-pass-diagnostic",
                configureServer(instance) {
                    instance.middlewares.use("/ssao-profile.js", (_request, response) => {
                        response.setHeader("Content-Type", "text/javascript");
                        response.end(code);
                    });
                    instance.middlewares.use("/ssao-profile", (_request, response) => {
                        response.setHeader("Content-Type", "text/html");
                        response.end(html);
                    });
                },
            },
        ],
    });
    let browser: Browser | undefined;
    const results: Awaited<ReturnType<SsaoProfileClient["run"]>>[] = [];
    const comparisons: Awaited<ReturnType<SsaoProfileClient["comparePruning"]>>[] = [];
    let activeCase: SsaoProfileCase | undefined;
    const path = join(directory, options.comparePruning ? "pruning-comparison.json" : "profile.json");
    const persist = async (status: "running" | "complete" | "failed", error?: unknown) => {
        await mkdir(directory, { recursive: true });
        await writeFile(
            path,
            JSON.stringify(
                {
                    status,
                    ...(error === undefined ? {} : { error: error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error), failedCase: activeCase }),
                    configuration: {
                        ...options,
                        width: 1920,
                        height: 1080,
                        warmup: 64,
                        deltaMs: 16,
                        radius: 0.35,
                        pruning: options.comparePruning ? "paired-off/on" : false,
                        temporal: true,
                        historySamples: 16,
                        aoOnly: true,
                        ...(options.comparePruning ? { correctnessFrames: 32, timingBlocks: 4, blockOrder: ["off/on", "on/off", "on/off", "off/on"] } : {}),
                    },
                    browser: browser?.version(),
                    bundleSha256: createHash("sha256").update(code).digest("hex"),
                    createdAt: new Date().toISOString(),
                    caveats: [
                        "Detailed compute-pass splitting and timestamps change scheduling; compare the separate unmodified-task baseline.",
                        "Texture bytes are nominal live payload, not driver residency, buffers or bandwidth.",
                        "The demo still allocates a normal MRT when AO reconstructs normals.",
                        "Bounded local observations, not a cross-device performance guarantee or CI gate.",
                        "The pruned transport pass may only clear its output with an indirect zero-vertex draw.",
                    ],
                    results: options.comparePruning ? comparisons : results,
                },
                null,
                2
            )
        );
    };
    try {
        await server.listen();
        const address = server.httpServer?.address();
        if (!address || typeof address === "string") throw new Error("SSAO diagnostic server did not bind.");
        browser = await chromium.launch(temporalValidationLaunchOptions(false));
        const motions = options.comparePruning
            ? [
                  { moving: false, cameraMoving: false },
                  { moving: true, cameraMoving: false },
                  { moving: false, cameraMoving: true },
                  { moving: true, cameraMoving: true },
              ]
            : [
                  { moving: false, cameraMoving: false },
                  { moving: true, cameraMoving: false },
              ];
        for (const motion of motions) {
            for (const resolution of ["full", "half"] as const) {
                for (const providedNormals of [true, false]) {
                    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
                    const errors: string[] = [];
                    page.on("pageerror", (error) => errors.push(String(error)));
                    try {
                        activeCase = { ...options, ...motion, resolution, providedNormals };
                        await page.goto(`http://127.0.0.1:${address.port}/ssao-profile`);
                        await page.waitForFunction(() => {
                            const canvas = document.querySelector("canvas");
                            return canvas?.dataset.ready === "true" || !!canvas?.dataset.error;
                        });
                        const evaluate = async (config: SsaoProfileCase) => {
                            const failure = document.querySelector("canvas")?.dataset.error;
                            if (failure) throw new Error(failure);
                            const client = (globalThis as typeof globalThis & { ssaoPassProfile: SsaoProfileClient }).ssaoPassProfile;
                            if (!client) throw new Error("SSAO diagnostic did not expose its manual frame driver.");
                            try {
                                return config.comparePruning ? { comparison: await client.comparePruning(config) } : { single: await client.run(config) };
                            } finally {
                                await client.dispose();
                            }
                        };
                        const result = await page.evaluate(evaluate, activeCase);
                        if (errors.length) throw new Error(errors.join("\n"));
                        if (result.comparison) {
                            const pair = result.comparison;
                            comparisons.push(pair);
                            console.info(
                                JSON.stringify({
                                    ...motion,
                                    resolution,
                                    normals: providedNormals ? "texture" : "depth",
                                    offMs: pair.off.baseline.meanMs.toFixed(4),
                                    onMs: pair.on.baseline.meanMs.toFixed(4),
                                    savedPercent: pair.savedPercent.toFixed(1),
                                    extraKiB: (pair.extraTextureBytes / 1024).toFixed(1),
                                    equivalentFrames: pair.equivalence.frames,
                                    activeMaskFrames: pair.equivalence.activeMaskFrames,
                                })
                            );
                        } else if (result.single) {
                            const single = result.single;
                            results.push(single);
                            console.table([
                                {
                                    ...motion,
                                    resolution,
                                    normals: providedNormals ? "texture" : "depth",
                                    taskMs: single.baseline.meanMs.toFixed(4),
                                    detailedMs: single.detailedTotal.meanMs.toFixed(4),
                                    ownedMiB: (single.memory.ownedBytes / 2 ** 20).toFixed(2),
                                    historiesMiB: (single.memory.historyBytes / 2 ** 20).toFixed(2),
                                    equivalent: single.outputEquivalent,
                                },
                            ]);
                        } else {
                            throw new Error("SSAO diagnostic returned neither a single run nor a pruning comparison.");
                        }
                        if (options.comparePruning) await persist("running");
                    } finally {
                        await page.close();
                    }
                }
            }
        }
        await persist("complete");
        console.info(`SSAO pass timings, raw samples, output equivalence and texture inventory saved to ${path}`);
    } catch (error) {
        await persist("failed", error);
        throw error;
    } finally {
        await browser?.close();
        await server.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    profileSsao().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
