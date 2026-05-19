import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SCRIPT = resolve(ROOT, "scripts/report-bundle-size-deltas.ts");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");

const tempDirs: string[] = [];

interface RunReporterOptions {
    current?: unknown;
    master?: unknown;
    scenes?: unknown;
}

function runReporter(options: RunReporterOptions): { stdout: string; comment: string | null } {
    const dir = mkdtempSync(resolve(tmpdir(), "bundle-size-deltas-"));
    tempDirs.push(dir);

    const currentPath = resolve(dir, "manifest.json");
    const masterPath = resolve(dir, "master-manifest.json");
    const sceneConfigPath = resolve(dir, "scene-config.json");
    const outputPath = resolve(dir, "comment.md");

    if (options.current !== undefined) {
        writeFileSync(currentPath, JSON.stringify(options.current), "utf-8");
    }
    if (options.master !== undefined) {
        writeFileSync(masterPath, JSON.stringify(options.master), "utf-8");
    }
    writeFileSync(sceneConfigPath, JSON.stringify(options.scenes ?? []), "utf-8");

    const stdout = execFileSync(process.execPath, [TSX, SCRIPT], {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
            ...process.env,
            BUNDLE_SIZE_CURRENT_MANIFEST: currentPath,
            BUNDLE_SIZE_MASTER_MANIFEST: masterPath,
            BUNDLE_SIZE_SCENE_CONFIG: sceneConfigPath,
            BUNDLE_SIZE_COMMENT_PATH: outputPath,
        },
    });

    return {
        stdout,
        comment: existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : null,
    };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("report-bundle-size-deltas", () => {
    it("writes no comment variable when rounded sizes do not change", () => {
        const result = runReporter({
            current: { scene1: { rawKB: 93.4 } },
            master: { scene1: { rawKB: 93.0 } },
            scenes: [{ id: 1, slug: "scene1", name: "Scene 1" }],
        });

        expect(result.comment).toContain("No changes detected");
        expect(result.stdout).toContain("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]false");
    });

    it("reports all nonzero rounded size changes with whole KB values", () => {
        const result = runReporter({
            current: {
                scene1: { rawKB: 95.4 },
                scene2: { rawKB: 40.4 },
                scene3: { rawKB: 12.4 },
                scene4: {},
            },
            master: {
                scene1: { rawKB: 93.0 },
                scene2: { rawKB: 46.4 },
                scene3: { rawKB: 12.0 },
                scene4: { rawKB: 8.0 },
            },
            scenes: [
                { id: 1, slug: "scene1", name: "Scene 1 - BoomBox PBR" },
                { id: 2, slug: "scene2", name: "Scene 2 - Sphere" },
            ],
        });

        expect(result.comment).toContain("| Package | Current | Master | Change |");
        expect(result.comment).toContain("Scene 1 - BoomBox PBR<br/>`scene1` | 95 KB | 93 KB | **+2 KB**");
        expect(result.comment).toContain("Scene 2 - Sphere<br/>`scene2` | 40 KB | 46 KB | -6 KB");
        expect(result.comment).not.toContain("scene3");
        expect(result.comment).not.toContain("scene4");
        expect(result.comment).not.toMatch(/\d+\.\d+ KB/);
        expect(result.comment).not.toMatch(/bytes?/i);
        expect(result.stdout).toContain("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]true");
        expect(result.stdout).toContain("%0A");
    });

    it("skips reporting when the master manifest is unavailable", () => {
        const result = runReporter({
            current: { scene1: { rawKB: 95.0 } },
            scenes: [{ id: 1, slug: "scene1", name: "Scene 1" }],
        });

        expect(result.comment).toBeNull();
        expect(result.stdout).toContain("Master manifest not found; skipping delta report.");
        expect(result.stdout).toContain("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]false");
    });
});
