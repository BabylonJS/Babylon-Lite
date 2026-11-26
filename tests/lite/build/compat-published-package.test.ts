import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite-compat");
const DIST_DIR = resolve(PACKAGE_DIR, "dist");
const LITE_PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite");
const LITE_BUILD_DIR = resolve(LITE_PACKAGE_DIR, "build");
const VITE_JS = resolve(ROOT, "node_modules/vite/bin/vite.js");
const MINIMUM_LITE_VERSION = "1.43.0";
const LITE_PEER_RANGE = `>=${MINIMUM_LITE_VERSION} <2.0.0 || >=2.0.1`;

function resolveNpmCli(): string {
    const executableDir = dirname(process.execPath);
    const candidates = [resolve(executableDir, "../lib/node_modules/npm/bin/npm-cli.js"), resolve(executableDir, "node_modules/npm/bin/npm-cli.js")];
    const npmCli = candidates.find(existsSync);
    if (!npmCli) {
        throw new Error(`Could not locate npm's JavaScript CLI. Checked:\n${candidates.join("\n")}`);
    }
    return npmCli;
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
    const result = spawnSync(command, args, { cwd, encoding: "utf-8", env: env ? { ...process.env, ...env } : undefined });
    if (result.error) {
        throw new Error(`${command} ${args.join(" ")} failed to launch: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
    return result.stdout.trim();
}

function pack(packageDir: string, outputDir: string): string {
    const output = run(process.execPath, [resolveNpmCli(), "pack", packageDir, "--json", "--pack-destination", outputDir], ROOT);
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

        expect(packageJson.peerDependencies?.["@babylonjs/lite"]).toBe(LITE_PEER_RANGE);
    });

    it("loads the packed root against the declared minimum Lite release candidate", () => {
        run(process.execPath, [VITE_JS, "build", "--mode", "lib"], LITE_PACKAGE_DIR, { PACKAGE_VERSION: MINIMUM_LITE_VERSION });

        const root = mkdtempSync(join(tmpdir(), "lite-compat-published-"));
        try {
            const litePackage = resolve(root, "lite-package");
            const compatPackage = resolve(root, "compat-package");
            mkdirSync(litePackage);
            cpSync(resolve(LITE_BUILD_DIR, "package.json"), resolve(litePackage, "package.json"));
            cpSync(resolve(LITE_BUILD_DIR, "lib"), resolve(litePackage, "lib"), { recursive: true });
            cpSync(DIST_DIR, compatPackage, { recursive: true });

            const litePackageJson = JSON.parse(readFileSync(resolve(litePackage, "package.json"), "utf8")) as { version: string };
            expect(litePackageJson.version).toBe(MINIMUM_LITE_VERSION);

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
