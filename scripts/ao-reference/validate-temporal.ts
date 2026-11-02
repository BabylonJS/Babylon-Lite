import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as LegacyClient from "./legacy/validate-temporal-client.js";
import type * as MovingClient from "./validate-moving-occluder-client.js";
import type * as DiligentClient from "./validate-diligent-client.js";
import type * as HalfClient from "./validate-half-client.js";
import { parseTemporalValidationOptions, temporalValidationLaunchOptions } from "./temporal-validation-options.js";
import type { TemporalValidationOptions } from "./temporal-validation-options.js";

export async function validateTemporalAo(args: readonly string[] = process.argv.slice(2)): Promise<void> {
    const options = parseTemporalValidationOptions(args);
    const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL("../../", import.meta.url)),
        publicDir: false,
        logLevel: "error",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
            {
                name: "ao-temporal-check",
                configureServer(instance) {
                    instance.middlewares.use("/temporal-check", (_request, response) => {
                        response.setHeader("Content-Type", "text/html");
                        response.end("<title>Temporal AO numerical checks</title>");
                    });
                },
            },
        ],
    });
    let browser: Browser | undefined;
    try {
        await server.listen();
        const address = server.httpServer!.address();
        if (!address || typeof address === "string") throw new Error("Temporal AO validation server did not bind.");
        browser = await chromium.launch(temporalValidationLaunchOptions(options.software));
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/temporal-check`);
        const results = await page.evaluate(async ({ suite, profile, halfResolution }: TemporalValidationOptions) => {
            if (suite === "moving") {
                const url = "/scripts/ao-reference/validate-moving-occluder-client.ts";
                const client: typeof MovingClient = await import(url);
                return [await client.validateMovingOccluder(profile, halfResolution)];
            }
            if (suite === "half") {
                const url = "/scripts/ao-reference/validate-half-client.ts";
                const client: typeof HalfClient = await import(url);
                return client.validateHalfSsao();
            }
            if (suite === "production") {
                const url = "/scripts/ao-reference/validate-diligent-client.ts";
                const client: typeof DiligentClient = await import(url);
                return client.validateDiligentAo();
            }
            const url = "/scripts/ao-reference/legacy/validate-temporal-client.ts";
            const client: typeof LegacyClient = await import(url);
            return client.validateTemporalAo();
        }, options);
        console.table(results);
    } finally {
        await browser?.close();
        await server.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    validateTemporalAo().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
