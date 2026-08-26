import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build, type Plugin } from "esbuild";
import { expect, it } from "vitest";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(packageDir, "dist");

const jsToTs: Plugin = {
    name: "js-to-ts",
    setup(builder) {
        builder.onResolve({ filter: /\.js$/ }, (args) => {
            if (!args.path.startsWith(".")) {
                return undefined;
            }
            const path = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
            return existsSync(path) ? { path } : undefined;
        });
    },
};

it("keeps the standalone client below its size ceiling", async () => {
    const result = await build({
        entryPoints: [resolve(packageDir, "src", "standalone.ts")],
        bundle: true,
        minify: true,
        treeShaking: true,
        format: "iife",
        globalName: "LiteLottie",
        platform: "browser",
        target: "es2020",
        mangleProps: /^(spawn|worker|input|animWidth|animHeight|resizeObserver|_worker)$/,
        legalComments: "none",
        write: false,
        plugins: [jsToTs],
        logLevel: "silent",
    });
    const output = result.outputFiles[0]?.contents;
    expect(output).toBeDefined();

    const rawBytes = output!.byteLength;
    const gzipBytes = gzipSync(output!, { level: 9 }).byteLength;
    expect(rawBytes, `standalone client is ${rawBytes} B raw`).toBeLessThanOrEqual(3_059);
    expect(gzipBytes, `standalone client is ${gzipBytes} B gzip`).toBeLessThanOrEqual(1_426);
});

it("keeps the fixed shapes splash client below its size ceiling", async () => {
    const result = await build({
        entryPoints: [resolve(packageDir, "src", "fixed-shapes-splash.ts")],
        bundle: true,
        minify: true,
        format: "iife",
        platform: "browser",
        target: "es2020",
        legalComments: "none",
        write: false,
        logLevel: "silent",
    });
    const output = result.outputFiles[0]?.contents;
    expect(output).toBeDefined();

    const rawBytes = output!.byteLength;
    const gzipBytes = gzipSync(output!, { level: 9 }).byteLength;
    expect(rawBytes, `fixed shapes splash client is ${rawBytes} B raw`).toBeLessThanOrEqual(521);
    expect(gzipBytes, `fixed shapes splash client is ${gzipBytes} B gzip`).toBeLessThanOrEqual(378);
});

// Approved v10 migration ratchets for exact emitted publish artifacts, measured with gzip level 9.
it.each([
    ["standalone client", "standalone.min.js", 3_059, 1_426],
    ["fixed shapes splash client", "fixed-shapes-splash/client.min.js", 521, 378],
] as const)("keeps the emitted %s at its approved exact size", (label, path, expectedRawBytes, expectedGzipBytes) => {
    const output = readFileSync(resolve(distDir, path));
    const gzipBytes = gzipSync(output, { level: 9 }).byteLength;
    expect.soft(output.byteLength, `${label} is ${output.byteLength} B raw`).toBe(expectedRawBytes);
    expect.soft(gzipBytes, `${label} is ${gzipBytes} B gzip`).toBe(expectedGzipBytes);
});

it.each([
    ["full", 44_244, 16_153],
    ["shapes", 35_809, 13_251],
] as const)("keeps the emitted %s worker at its approved exact size", (variant, expectedRawBytes, expectedGzipBytes) => {
    const output = readFileSync(resolve(distDir, "workers", `${variant}.worker.js`));
    const gzipBytes = gzipSync(output, { level: 9 }).byteLength;
    expect.soft(output.byteLength, `${variant} worker is ${output.byteLength} B raw`).toBe(expectedRawBytes);
    expect.soft(gzipBytes, `${variant} worker is ${gzipBytes} B gzip`).toBe(expectedGzipBytes);
});

it("ships the fixed shapes splash with the exact emitted shapes worker", () => {
    const shapesWorker = readFileSync(resolve(distDir, "workers", "shapes.worker.js"));
    const splashWorker = readFileSync(resolve(distDir, "fixed-shapes-splash", "worker.min.js"));
    expect(splashWorker).toEqual(shapesWorker);
});

const externalizeWorker: Plugin = {
    name: "externalize-worker",
    setup(builder) {
        builder.onResolve({ filter: /\.worker(\.[jt]s)?$/ }, (args) => (args.kind === "entry-point" ? undefined : { external: true }));
    },
};

async function buildProductionPart(entryPoint: string, externalizeWorkerEntry: boolean): Promise<{ raw: number; gzip: number }> {
    const result = await build({
        entryPoints: [entryPoint],
        bundle: true,
        minify: true,
        treeShaking: true,
        format: "esm",
        target: "esnext",
        platform: "browser",
        legalComments: "none",
        splitting: true,
        outdir: resolve(packageDir, "measure", ".out", "size-test"),
        write: false,
        plugins: [...(externalizeWorkerEntry ? [externalizeWorker] : []), jsToTs],
        logLevel: "silent",
    });
    return result.outputFiles.reduce((total, output) => ({ raw: total.raw + output.contents.byteLength, gzip: total.gzip + gzipSync(output.contents, { level: 9 }).byteLength }), {
        raw: 0,
        gzip: 0,
    });
}

// Source-worker values are ceilings; combined production delivery remains an exact shipped-size ratchet.
it.each([
    ["full", "worker-full-client.ts", 44_274, 16_168, 47_003, 17_349],
    ["shapes", "worker-shapes-client.ts", 35_837, 13_268, 38_567, 14_449],
] as const)(
    "keeps the source %s worker within its approved ceiling and combined production delivery at its approved exact size",
    async (variant, clientEntry, workerRawBytes, workerGzipBytes, totalRawBytes, totalGzipBytes) => {
        const client = await buildProductionPart(resolve(packageDir, "measure", clientEntry), true);
        const worker = await buildProductionPart(resolve(packageDir, "src", "worker", `${variant}.worker.ts`), false);
        const rawBytes = client.raw + worker.raw;
        const gzipBytes = client.gzip + worker.gzip;
        expect.soft(worker.raw, `${variant} source worker is ${worker.raw} B raw`).toBeLessThanOrEqual(workerRawBytes);
        expect.soft(worker.gzip, `${variant} source worker is ${worker.gzip} B gzip`).toBeLessThanOrEqual(workerGzipBytes);
        expect.soft(rawBytes, `${variant} production delivery is ${rawBytes} B raw`).toBe(totalRawBytes);
        expect.soft(gzipBytes, `${variant} production delivery is ${gzipBytes} B gzip`).toBe(totalGzipBytes);
    }
);
