import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const visualDir = dirname(fileURLToPath(import.meta.url));
export const visualOutDir = resolve(visualDir, ".out");

export async function buildVisualApp() {
    rmSync(visualOutDir, { recursive: true, force: true });
    mkdirSync(visualOutDir, { recursive: true });
    await build({
        entryPoints: [resolve(visualDir, "app.ts")],
        outfile: resolve(visualOutDir, "app.js"),
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        sourcemap: true,
        logLevel: "info",
    });
    cpSync(resolve(visualDir, "index.html"), resolve(visualOutDir, "index.html"));
    cpSync(resolve(visualDir, "fixtures"), resolve(visualOutDir, "fixtures"), { recursive: true });
    const imageSource = resolve(visualDir, "fixtures/images/four-color.png.base64");
    writeFileSync(resolve(visualOutDir, "fixtures/images/four-color.png"), Buffer.from(readFileSync(imageSource, "utf8").trim(), "base64"));
    cpSync(resolve(visualDir, "../../dist/workers"), resolve(visualOutDir, "workers"), { recursive: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await buildVisualApp();
}
