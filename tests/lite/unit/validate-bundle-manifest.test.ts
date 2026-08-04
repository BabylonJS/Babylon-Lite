import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { collectDrift, diffRawSize, diffRuntimeChunks, stripChunkHash } from "../../../scripts/validate-bundle-manifest";
import { countLeadingAutocommits, shortBranchName } from "../../../scripts/commit-bundle-manifest";

const ROOT = resolve(__dirname, "../../..");
const SCRIPT = resolve(ROOT, "scripts/validate-bundle-manifest.ts");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");

const tempDirs: string[] = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe("stripChunkHash", () => {
    it("removes the rollup content hash from a chunk filename", () => {
        expect(stripChunkHash("scene1-pbr-renderable-BA83HCpm.js")).toBe("scene1-pbr-renderable.js");
        expect(stripChunkHash("scene1-generate-mipmaps-BxsDX3Y-.js")).toBe("scene1-generate-mipmaps.js");
    });

    it("leaves unhashed entry chunks alone", () => {
        expect(stripChunkHash("scene1.js")).toBe("scene1.js");
        expect(stripChunkHash("bjs-scene1.js")).toBe("bjs-scene1.js");
    });
});

describe("diffRuntimeChunks", () => {
    it("ignores pure content-hash churn", () => {
        const committed = ["scene1.js", "scene1-pbr-renderable-BA83HCpm.js"];
        const built = ["scene1.js", "scene1-pbr-renderable-Zq10aaaa.js"];
        expect(diffRuntimeChunks(committed, built)).toBeNull();
    });

    it("still reports a newly loaded module", () => {
        const committed = ["scene1.js"];
        const built = ["scene1.js", "scene1-ibl-fragment-CeRrvT96.js"];
        expect(diffRuntimeChunks(committed, built)).toBe("+scene1-ibl-fragment.js");
    });

    it("still reports a module that stopped loading", () => {
        const committed = ["scene1.js", "scene1-ibl-fragment-CeRrvT96.js"];
        const built = ["scene1.js"];
        expect(diffRuntimeChunks(committed, built)).toBe("-scene1-ibl-fragment.js");
    });

    it("is order independent", () => {
        expect(diffRuntimeChunks(["a-AAAAAAAA.js", "b-BBBBBBBB.js"], ["b-CCCCCCCC.js", "a-DDDDDDDD.js"])).toBeNull();
    });
});

describe("diffRawSize", () => {
    it("compares rawBytes exactly when both sides carry it", () => {
        expect(diffRawSize({ rawBytes: 90550 }, { rawBytes: 90550 })).toBeNull();
        expect(diffRawSize({ rawBytes: 90550 }, { rawBytes: 90562 })).toContain("+12 bytes");
    });

    it("falls back to whole-KB rawKB when rawBytes is missing", () => {
        expect(diffRawSize({ rawKB: 88.4 }, { rawKB: 88.45 })).toBeNull();
        expect(diffRawSize({ rawKB: 88.4 }, { rawKB: 91.2 })).toContain("committed raw=88KB");
    });
});

describe("collectDrift", () => {
    it("returns nothing when only chunk hashes moved", () => {
        const committed = { scene1: { rawBytes: 100, gzipKB: 37.3, runtimeChunks: ["scene1-x-AAAAAAAA.js"] } };
        const built = { scene1: { rawBytes: 100, gzipKB: 37.4, runtimeChunks: ["scene1-x-BBBBBBBB.js"] } };
        expect(collectDrift(committed, built)).toEqual([]);
    });

    it("reports scenes added or removed by the rebuild", () => {
        const drift = collectDrift({ scene1: { rawBytes: 1 } }, { scene2: { rawBytes: 1 } });
        expect(drift).toHaveLength(2);
        expect(drift.join("\n")).toContain("scene1: present in committed manifest but missing after rebuild");
        expect(drift.join("\n")).toContain("scene2: produced by rebuild but missing from committed manifest");
    });
});

describe("commit-bundle-manifest helpers", () => {
    it("shortens a branch ref", () => {
        expect(shortBranchName("refs/heads/my-feature")).toBe("my-feature");
        expect(shortBranchName("my-feature")).toBe("my-feature");
    });

    it("counts only the leading run of bot commits", () => {
        const subject = "chore(bundle): refresh per-scene bundle-size manifest";
        expect(countLeadingAutocommits([subject, subject, "feat: thing"])).toBe(2);
        expect(countLeadingAutocommits(["feat: thing", subject])).toBe(0);
        expect(countLeadingAutocommits([])).toBe(0);
    });
});

/**
 * Drive the CLI against a throwaway git repo so both report mode (the CI default,
 * which must never fail the build) and `--strict` are covered end to end.
 */
function runValidator(args: string[], committed: unknown, built: unknown): string {
    const dir = mkdtempSync(resolve(tmpdir(), "validate-bundle-manifest-"));
    tempDirs.push(dir);

    const manifestDir = resolve(dir, "lab/public/bundle/manifest");
    mkdirSync(manifestDir, { recursive: true });

    const git = (gitArgs: string[]): void => {
        execFileSync("git", gitArgs, { cwd: dir, stdio: "ignore" });
    };
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);

    writeFileSync(resolve(manifestDir, "scene1.json"), JSON.stringify(committed));
    git(["add", "-A"]);
    git(["commit", "-qm", "committed manifest"]);

    // Overwrite with the "freshly measured" values after committing.
    writeFileSync(resolve(manifestDir, "scene1.json"), JSON.stringify(built));

    return execFileSync(process.execPath, [TSX, SCRIPT, ...args], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, BUNDLE_MANIFEST_ROOT: dir, BUNDLE_MANIFEST_STRICT: "" },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

describe("validate-bundle-manifest CLI", () => {
    it("exits 0 and reports drift by default", () => {
        const output = runValidator([], { rawBytes: 100, gzipKB: 37 }, { rawBytes: 400, gzipKB: 37 });
        expect(output).toContain("Bundle manifest drift detected");
        expect(output).toContain("+300 bytes");
        expect(output).toContain("BUNDLE_MANIFEST_STALE]true");
    });

    it("passes cleanly when only the chunk hash moved", () => {
        const output = runValidator(
            [],
            { rawBytes: 100, gzipKB: 37, runtimeChunks: ["scene1-x-AAAAAAAA.js"] },
            { rawBytes: 100, gzipKB: 37, runtimeChunks: ["scene1-x-BBBBBBBB.js"] }
        );
        expect(output).toContain("Bundle manifest is up to date");
        expect(output).toContain("BUNDLE_MANIFEST_STALE]false");
    });

    it("fails under --strict when the manifest is stale", () => {
        expect(() => runValidator(["--strict"], { rawBytes: 100, gzipKB: 37 }, { rawBytes: 400, gzipKB: 37 })).toThrow(/Command failed/);
    });
});
