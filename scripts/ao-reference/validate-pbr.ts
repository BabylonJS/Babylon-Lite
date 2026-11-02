import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Client from "./validate-pbr-client.js";

export async function validatePbrAo(): Promise<void> {
    const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL("../../", import.meta.url)),
        publicDir: false,
        logLevel: "error",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
            {
                name: "pbr-check",
                configureServer(instance) {
                    instance.middlewares.use("/pbr-check", (_request, response) => {
                        response.setHeader("Content-Type", "text/html");
                        response.end("<title>PBR AO integration check</title>");
                    });
                },
            },
        ],
    });
    let browser: Browser | undefined;
    try {
        await server.listen();
        const address = server.httpServer!.address();
        if (!address || typeof address === "string") throw new Error("PBR validation server did not bind.");
        browser = await chromium.launch({ channel: "msedge", headless: true });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/pbr-check`);
        const results = await page.evaluate(async () => {
            const url = "/scripts/ao-reference/validate-pbr-client.ts";
            const client: typeof Client = await import(url);
            return client.validatePbrAo();
        });
        console.table(results);
        console.log("PBR AO diffuse/direct/emissive/baked-AO, resize, and disposal checks pass on a real GPU.");
    } finally {
        await browser?.close();
        await server.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    validatePbrAo().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
