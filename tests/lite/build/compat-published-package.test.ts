import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite-compat");
const DIST_DIR = resolve(PACKAGE_DIR, "dist");
const LITE_PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite");
const LITE_BUILD_DIR = resolve(LITE_PACKAGE_DIR, "build");
const VITE_JS = resolve(ROOT, "node_modules/vite/bin/vite.js");
const MINIMUM_LITE_VERSION = "1.42.0";

function run(command: string, args: string[], cwd: string): string {
    const result = spawnSync(command, args, { cwd, encoding: "utf-8" });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
    return result.stdout.trim();
}

function pack(packageDir: string, outputDir: string): string {
    const output = run("npm", ["pack", packageDir, "--json", "--pack-destination", outputDir], ROOT);
    const [{ filename }] = JSON.parse(output) as [{ filename: string }];
    return resolve(outputDir, filename);
}

function extractPackage(tarball: string, destination: string): void {
    mkdirSync(destination, { recursive: true });
    run("tar", ["-xzf", tarball, "-C", destination, "--strip-components=1"], ROOT);
}

beforeAll(() => {
    rmSync(DIST_DIR, { recursive: true, force: true });
    run(process.execPath, [VITE_JS, "build"], PACKAGE_DIR);
}, 300_000);

describe("published compat package", () => {
    it("requires the first Babylon Lite release with quaternion ToRef helpers", () => {
        const packageJson = JSON.parse(readFileSync(resolve(DIST_DIR, "package.json"), "utf8")) as { peerDependencies?: Record<string, string> };

        expect(packageJson.peerDependencies?.["@babylonjs/lite"]).toBe(`>=${MINIMUM_LITE_VERSION}`);
    });

    it("loads the packed root against the declared minimum Lite package", () => {
        rmSync(LITE_BUILD_DIR, { recursive: true, force: true });
        run(process.execPath, [VITE_JS, "build", "--mode", "lib"], LITE_PACKAGE_DIR);

        const root = mkdtempSync(join(tmpdir(), "lite-compat-published-"));
        try {
            const litePackage = resolve(root, "lite-package");
            const compatPackage = resolve(root, "compat-package");
            cpSync(LITE_BUILD_DIR, litePackage, { recursive: true });
            cpSync(DIST_DIR, compatPackage, { recursive: true });

            const litePackageJsonPath = resolve(litePackage, "package.json");
            const litePackageJson = JSON.parse(readFileSync(litePackageJsonPath, "utf8")) as { version: string };
            litePackageJson.version = MINIMUM_LITE_VERSION;
            writeFileSync(litePackageJsonPath, `${JSON.stringify(litePackageJson, null, 2)}\n`);

            const tarballs = resolve(root, "tarballs");
            mkdirSync(tarballs);
            const liteTarball = pack(litePackage, tarballs);
            const compatTarball = pack(compatPackage, tarballs);

            const nodeModules = resolve(root, "consumer/node_modules/@babylonjs");
            extractPackage(liteTarball, resolve(nodeModules, "lite"));
            extractPackage(compatTarball, resolve(nodeModules, "lite-compat"));

            const consumer = resolve(root, "consumer");
            const loaded = run(process.execPath, ["--input-type=module", "--eval", 'await import("@babylonjs/lite-compat");'], consumer);
            expect(loaded).toBe("");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 300_000);
});
