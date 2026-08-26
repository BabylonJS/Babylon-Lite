import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(packageDir, "dist");

type PackResult = { files: { path: string }[] };
type SourceMap = { sources: string[]; sourcesContent?: (string | null)[] };

function npmPackDryRun(): PackResult {
    const npmArgs = ["pack", "--dry-run", "--json", distDir];
    const output =
        process.platform === "win32"
            ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "npm.cmd", ...npmArgs], { cwd: packageDir, encoding: "utf8" })
            : execFileSync("npm", npmArgs, { cwd: packageDir, encoding: "utf8" });
    const results = JSON.parse(output) as PackResult[];
    const result = results[0];
    if (!result) {
        throw new Error("npm pack --dry-run returned no package result.");
    }
    return result;
}

describe("published package", () => {
    it("emits the canonical v10 manifest without a workspace dependency", () => {
        const sourceManifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as Record<string, unknown>;
        const manifestText = readFileSync(resolve(distDir, "package.json"), "utf8");
        const manifest = JSON.parse(manifestText) as Record<string, unknown>;
        expect(sourceManifest).toMatchObject({ dependencies: { "@babylonjs/lite-gl": "workspace:babylon-lite-gl@*" } });
        expect(manifest).toMatchObject({
            name: "@babylonjs/lottie-player",
            version: "10.0.0",
            dependencies: { "@babylonjs/lite-gl": "^1.7.0" },
            exports: {
                ".": { import: "./index.js", types: "./index.d.ts" },
                "./shapes": { import: "./shapes.js", types: "./shapes.d.ts" },
                "./standalone": { import: "./standalone.js", types: "./standalone.d.ts" },
                "./standalone.min.js": "./standalone.min.js",
                "./fixed-shapes-splash/client.min.js": "./fixed-shapes-splash/client.min.js",
                "./fixed-shapes-splash/worker.min.js": "./fixed-shapes-splash/worker.min.js",
                "./workers/full.worker.js": "./workers/full.worker.js",
                "./workers/shapes.worker.js": "./workers/shapes.worker.js",
            },
        });
        expect(manifestText).not.toContain("workspace:");
        expect(manifestText).not.toContain("lite-lottie");
    });

    it("publishes source maps with their package sources embedded", () => {
        const sourceMapPaths = npmPackDryRun()
            .files.map((file) => file.path.replaceAll("\\", "/"))
            .filter((path) => path.endsWith(".js.map"));
        expect(sourceMapPaths).not.toHaveLength(0);
        for (const sourceMapPath of sourceMapPaths) {
            const sourceMap = JSON.parse(readFileSync(resolve(distDir, sourceMapPath), "utf8")) as SourceMap;
            expect(sourceMap.sourcesContent, sourceMapPath).toHaveLength(sourceMap.sources.length);
            expect(
                sourceMap.sourcesContent?.every((source) => typeof source === "string"),
                sourceMapPath
            ).toBe(true);
            expect(
                sourceMap.sources.every((source) => /(^|\/)src\//.test(source.replaceAll("\\", "/"))),
                sourceMapPath
            ).toBe(true);
            expect(
                sourceMap.sources.some((source) => /(^|\/)(tests|demo|measure|anims)(\/|$)/.test(source.replaceAll("\\", "/"))),
                sourceMapPath
            ).toBe(false);
        }
    });

    it("packs runtime artifacts and package documentation only", () => {
        const packedFiles = npmPackDryRun().files.map((file) => file.path.replaceAll("\\", "/"));
        expect(packedFiles).toEqual(
            expect.arrayContaining([
                "README.md",
                "license.md",
                "package.json",
                "index.js",
                "index.js.map",
                "index.d.ts",
                "shapes.js",
                "shapes.d.ts",
                "standalone.js",
                "standalone.d.ts",
                "standalone.min.js",
                "fixed-shapes-splash/client.min.js",
                "fixed-shapes-splash/worker.min.js",
                "workers/full.worker.js",
                "workers/shapes.worker.js",
            ])
        );
        expect(packedFiles.some((path) => /^(tests|demo|measure|anims|docs|reference)\//.test(path))).toBe(false);
        expect(packedFiles.some((path) => /\.(?:test|spec)\.[cm]?[jt]s$/.test(path))).toBe(false);
    });
});
