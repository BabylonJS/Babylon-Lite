import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AO_GOLDEN_DIRECTORY } from "./generate.js";
import type { AoReferenceManifest } from "./generate.js";
import type * as Client from "./validate-webgpu-client.js";
import { encodeAoPreview } from "./compare.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function validateWebGpuAo(): Promise<void> {
    const manifest = JSON.parse(await readFile(join(AO_GOLDEN_DIRECTORY, "manifest.json"), "utf8")) as AoReferenceManifest;
    const server = await createServer({
        configFile: false,
        root,
        publicDir: false,
        logLevel: "error",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
            {
                name: "ao-validation-page",
                configureServer(instance) {
                    instance.middlewares.use("/ao-check", (_request, response) => {
                        response.setHeader("Content-Type", "text/html");
                        response.end("<!doctype html><title>Numerical WebGPU AO validation</title>");
                    });
                },
            },
        ],
    });
    let browser: Browser | undefined;
    try {
        await server.listen();
        const address = server.httpServer?.address();
        if (!address || typeof address === "string") throw new Error("Cannot determine the AO validation server port.");
        browser = await chromium.launch({ channel: "msedge", headless: true });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/ao-check`);
        const results = await page.evaluate(async (fixtures) => {
            const url = "/scripts/ao-reference/validate-webgpu-client.ts";
            const client: typeof Client = await import(url);
            return client.validateFixtures(fixtures);
        }, manifest.fixtures);
        for (const result of results) {
            const fixture = manifest.fixtures.find((record) => record.id === result.fixture)!;
            await writeFile(
                join(AO_GOLDEN_DIRECTORY, result.fixture, "test-actual-xegtao.png"),
                encodeAoPreview(new Float32Array(result.actual), fixture.settings.width, fixture.settings.height)
            );
        }
        console.table(
            results.map((result) => ({
                fixture: result.fixture,
                rawChanged: result.stages.raw?.changed ?? "-",
                edgesChanged: result.stages.edges?.changed ?? "-",
                maxFinal: result.stages.final!.maximum.toFixed(7),
                meanFinal: result.stages.final!.mean.toFixed(7),
            }))
        );
        console.log(`All ${results.length} numerical WebGPU/native comparisons pass without changing any golden.`);
    } finally {
        await browser?.close();
        await server.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    validateWebGpuAo().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
