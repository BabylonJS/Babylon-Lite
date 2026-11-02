import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseContactOptions } from "./contact-contract.js";
import { temporalValidationLaunchOptions } from "./temporal-validation-options.js";
import type * as Client from "./validate-deformation-velocity-client.js";

export async function validateGeometryVelocity(args: readonly string[] = process.argv.slice(2)) {
    const options = parseContactOptions(args);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const server = await createServer({
        root,
        configFile: false,
        publicDir: false,
        logLevel: "error",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
            {
                name: "geometry-velocity-check",
                configureServer(instance) {
                    instance.middlewares.use("/geometry-velocity-check", (_request, response) => {
                        response.setHeader("Content-Type", "text/html");
                        response.end("<title>Deformation velocity numerical check</title>");
                    });
                },
            },
        ],
    });
    let browser: Browser | undefined;
    try {
        await server.listen();
        const address = server.httpServer?.address();
        if (!address || typeof address === "string") {
            throw new Error("Geometry velocity validation server did not bind.");
        }
        browser = await chromium.launch(temporalValidationLaunchOptions(options.software));
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/geometry-velocity-check`);
        const result = await page.evaluate(async () => {
            const path = "/scripts/ao-reference/validate-deformation-velocity-client.ts";
            const client = (await import(path)) as typeof Client;
            return client.validateDeformationVelocity();
        });
        console.table(result);
        const directory = join(root, ".ao-reference-cache", "deformation-velocity");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, options.software ? "software.json" : "native.json"), JSON.stringify({ options, browser: browser.version(), result }, null, 2));
    } finally {
        await browser?.close();
        await server.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    validateGeometryVelocity().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
