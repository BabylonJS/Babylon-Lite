import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { createServer } from "vite";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { adaptContactDemo, parseContactOptions } from "./contact-contract.js";
import { temporalValidationLaunchOptions } from "./temporal-validation-options.js";
import type { ContactCase, ContactClient } from "./validate-contact-client.js";
import { diagnosticWorkerPlugin } from "./diagnostic-worker-plugin.js";

export async function validateContactAo(args: readonly string[] = process.argv.slice(2)) {
    const options = parseContactOptions(args);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = join(root, ".ao-reference-cache", "ssao-contact");
    const source = adaptContactDemo(await readFile(join(root, "lab", "lite", "src", "demos", "ambient-occlusion.ts"), "utf8"));
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
        outdir: join(directory, "unused-build"),
        logLevel: "silent",
    });
    const code = bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
    if (!code) {
        throw new Error("Contact validation bundle was not generated.");
    }
    let html = await readFile(join(root, "lab", "lite", "demo-ambient-occlusion.html"), "utf8");
    for (const [before, after] of [
        ['id="gpuTiming" type="checkbox" checked', 'id="gpuTiming" type="checkbox"'],
        ['src="/lite/bundle/demos/ambient-occlusion.js"', 'src="/contact-check.js"'],
    ] as const) {
        if (html.split(before).length !== 2) {
            throw new Error(`Contact HTML hook must occur exactly once: ${before}`);
        }
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
                name: "contact-numerical-validation",
                configureServer(instance) {
                    instance.middlewares.use("/contact-check.js", (_request, response) => {
                        response.setHeader("Content-Type", "text/javascript");
                        response.end(code);
                    });
                    instance.middlewares.use("/contact-check", (_request, response) => {
                        response.setHeader("Content-Type", "text/html");
                        response.end(html);
                    });
                },
            },
        ],
    });
    let browser: Browser | undefined;
    const results: Omit<Awaited<ReturnType<ContactClient["run"]>>, "traces">[] = [];
    const errors: string[] = [];
    const persist = async (status: string) => {
        await mkdir(directory, { recursive: true });
        await writeFile(
            join(directory, options.software ? "software.json" : "native.json"),
            JSON.stringify(
                {
                    status,
                    options,
                    browser: browser?.version(),
                    bundleSha256: createHash("sha256").update(code).digest("hex"),
                    createdAt: new Date().toISOString(),
                    results,
                    errors,
                },
                null,
                2
            )
        );
    };
    try {
        await server.listen();
        const address = server.httpServer?.address();
        if (!address || typeof address === "string") {
            throw new Error("Contact validation server did not bind.");
        }
        browser = await chromium.launch(temporalValidationLaunchOptions(options.software));
        for (const resolution of ["full", "half"] as const) {
            for (const providedNormals of [true, false]) {
                const config: ContactCase = { resolution, providedNormals };
                const page = await browser.newPage({ viewport: { width: 1146, height: 1308 } });
                const pageErrors: string[] = [];
                page.on("pageerror", (error) => pageErrors.push(String(error)));
                try {
                    await page.goto(`http://127.0.0.1:${address.port}/contact-check`);
                    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true" || !!document.querySelector("canvas")?.dataset.error);
                    const output = await page.evaluate(async (settings: ContactCase) => {
                        const error = document.querySelector("canvas")?.dataset.error;
                        if (error) {
                            throw new Error(error);
                        }
                        const client = (globalThis as typeof globalThis & { ssaoContactValidation: ContactClient }).ssaoContactValidation;
                        if (!client) {
                            throw new Error("Contact manual frame driver is missing.");
                        }
                        try {
                            return await client.run(settings);
                        } finally {
                            await client.dispose();
                        }
                    }, config);
                    if (pageErrors.length) {
                        throw new Error(pageErrors.join("\n"));
                    }
                    const { traces, ...result } = output;
                    await mkdir(directory, { recursive: true });
                    await writeFile(join(directory, `${options.software ? "software" : "native"}-${resolution}-${providedNormals}.deflate`), deflateSync(JSON.stringify(traces)));
                    results.push(result);
                    errors.push(...result.violations.map((failure) => `${resolution}/${providedNormals ? "texture" : "depth"}: ${failure}`));
                    console.info(JSON.stringify(result));
                } catch (error) {
                    const message = error instanceof Error ? error.message : JSON.stringify(error);
                    errors.push(`${resolution}/${providedNormals ? "texture" : "depth"}: ${message}${pageErrors.length ? `\n${pageErrors.join("\n")}` : ""}`);
                    console.error(errors.at(-1));
                } finally {
                    await page.close();
                }
                await persist("running");
            }
        }
        await persist(errors.length ? "failed" : "complete");
        if (errors.length) {
            throw new Error(errors.join("\n"));
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        if (!errors.length) {
            errors.push(message);
        }
        await persist("failed");
        throw error;
    } finally {
        await browser?.close();
        await server.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    validateContactAo().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
