import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite-compat");
const DIST_DIR = resolve(PACKAGE_DIR, "dist");
const VITE_JS = resolve(ROOT, "node_modules/vite/bin/vite.js");

beforeAll(() => {
    rmSync(DIST_DIR, { recursive: true, force: true });
    const build = spawnSync(process.execPath, [VITE_JS, "build"], {
        cwd: PACKAGE_DIR,
        encoding: "utf-8",
    });
    if (build.status !== 0) {
        throw new Error(`lite-compat build failed:\n${build.stdout ?? ""}${build.stderr ?? ""}`);
    }
}, 300_000);

describe("published compat package", () => {
    it("requires the first Babylon Lite release with vector slerp support", () => {
        const packageJson = JSON.parse(readFileSync(resolve(DIST_DIR, "package.json"), "utf8")) as { peerDependencies?: Record<string, string> };

        expect(packageJson.peerDependencies?.["@babylonjs/lite"]).toBe(">=1.41.0");
    });
});
