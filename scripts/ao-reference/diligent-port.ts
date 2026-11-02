import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import type * as Client from "./diligent-port-client.js";

async function run(): Promise<void> {
    const run = resolve(process.argv[2] ?? "");
    const transport = process.argv.includes("--transport");
    const production = process.argv.includes("--production");
    const motionPruning = process.argv.includes("--motion-pruning");
    if (motionPruning && !transport) {
        throw new Error("--motion-pruning requires --transport.");
    }
    const baselineIndex = process.argv.indexOf("--baseline-source");
    const tagIndex = process.argv.indexOf("--result-tag");
    const resultTag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined;
    if (tagIndex >= 0 && (!resultTag || !/^[a-zA-Z0-9_-]+$/.test(resultTag))) {
        throw new Error("--result-tag requires a simple output label.");
    }
    if (baselineIndex >= 0 && (!process.argv[baselineIndex + 1] || !resultTag)) {
        throw new Error("--baseline-source requires an exact source snapshot directory and --result-tag.");
    }
    const snapshots =
        baselineIndex >= 0
            ? new Map(
                  await Promise.all(
                      ["ssao-diligent-gpu.ts", "ssao-diligent-wgsl.ts"].map(
                          async (file) =>
                              [
                                  fileURLToPath(new URL(`../../packages/babylon-lite/src/post-process/${file}`, import.meta.url)).replace(/\\/g, "/"),
                                  await readFile(join(resolve(process.argv[baselineIndex + 1]!), file), "utf8"),
                              ] as const
                      )
                  )
              )
            : null;
    const outputLabel = resultTag ?? (transport ? "transport" : "wgsl");
    const tasks = (await readFile(join(run, "tasks.tsv"), "utf8")).trim().split(/\r?\n/);
    const header = tasks[0]!.split("\t");
    const width = Number(header[1]),
        height = Number(header[2]);
    if (header[0] !== "diligent-temporal-v1" || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error("Invalid replay tasks.");
    const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL("../../", import.meta.url)),
        publicDir: false,
        logLevel: "error",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
            {
                name: "diligent-port-replay",
                enforce: "pre",
                load(id) {
                    return snapshots?.get(id.replace(/\\/g, "/").split("?")[0]!) ?? null;
                },
                configureServer(instance) {
                    instance.middlewares.use((request, response, next) => {
                        if (request.url === "/port-check") {
                            response.setHeader("Content-Type", "text/html");
                            response.end("<title>Complete Diligent WebGPU port replay</title>");
                            return;
                        }
                        const frame = /^\/port-frame\/(\d+)$/.exec(request.url ?? "");
                        const native = /^\/port-native\/(\d+)\/(temporal|repaired|final|history|mip[0-4]-(?:ao|depth))$/.exec(request.url ?? "");
                        const output = /^\/port-output\/(\d+)\/(temporal|repaired|final|history)$/.exec(request.url ?? "");
                        if (!frame && !native && !output) return next();
                        void (async () => {
                            const index = Number((frame ?? native ?? output)![1]);
                            if (index < 0 || index >= tasks.length - 1) throw new Error("Replay frame is out of range.");
                            response.setHeader("Content-Type", "application/octet-stream");
                            if (output) {
                                if (request.method !== "POST") throw new Error("Replay output requires POST");
                                const chunks: Buffer[] = [];
                                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                                const bytes = Buffer.concat(chunks);
                                const suffix = output[2] === "history" ? "r16" : "u8";
                                if (bytes.length !== width * height * (suffix === "r16" ? 2 : 1)) throw new Error("Invalid output size");
                                const directory = join(run, outputLabel, index.toString().padStart(4, "0"));
                                await mkdir(directory, { recursive: true });
                                await writeFile(join(directory, `${output[2]}.${suffix}`), bytes);
                                response.end();
                                return;
                            }
                            if (frame) {
                                response.end(gunzipSync(await readFile(tasks[index + 1]!)));
                                return;
                            }
                            const suffix = native![2] === "repaired" ? "resampled" : native![2];
                            response.end(
                                await readFile(
                                    join(
                                        run,
                                        "native",
                                        index.toString().padStart(4, "0"),
                                        `shared-${suffix}.${suffix === "history" ? "r16" : suffix?.endsWith("-depth") ? "f32" : "u8"}`
                                    )
                                )
                            );
                        })().catch((error: unknown) => {
                            response.statusCode = 500;
                            response.end(String(error));
                        });
                    });
                },
            },
        ],
    });
    const browser = await chromium.launch({ channel: "msedge", headless: true }).catch(async (error: unknown) => {
        await server.close();
        throw error;
    });
    try {
        await server.listen();
        const address = server.httpServer!.address();
        if (!address || typeof address === "string") throw new Error("Replay server did not bind.");
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/port-check`);
        const frames = process.argv.includes("--quick") ? Math.min(16, tasks.length - 1) : tasks.length - 1;
        const result = await page.evaluate(
            async (config: { width: number; height: number; frames: number; transport: boolean; production: boolean; motionPruning: boolean }) => {
                const url = "/scripts/ao-reference/diligent-port-client.ts";
                const client: typeof Client = await import(url);
                return client.replayDiligentPort(config);
            },
            { width, height, frames, transport, production, motionPruning }
        );
        console.log(JSON.stringify(result.statistics, null, 2));
        await writeFile(join(run, `${outputLabel}-port.json`), JSON.stringify(result, null, 2));
        if (
            !transport &&
            (result.statistics.final!.max > 1 || result.statistics.temporal!.max > 1 || result.mipStatistics.some((mip) => mip.ao.max !== 0 || mip.depth.max !== 0))
        ) {
            throw new Error("The unmodified WGSL baseline no longer matches native final/temporal AO within one byte and exact initial mips.");
        }
    } finally {
        await browser.close();
        await server.close();
    }
}
void run().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
