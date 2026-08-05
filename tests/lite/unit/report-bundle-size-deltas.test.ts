import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
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
        // No ceilings are configured in this fixture, so the delta tables are the whole comment
        // and must stay free of sub-KB precision.
        expect(result.comment).not.toContain("Ceiling headroom");
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

    describe("ceiling headroom", () => {
        // scene1 moves enough to round to a whole KB (so a comment is posted at all) and keeps
        // plenty of room. scene2 moves by 400 B — invisible in the rounded delta table — and
        // lands 100 B under its ceiling. scene3 is tight but untouched by this PR.
        const headroomFixture = {
            current: {
                scene1: { rawKB: 97.7, rawBytes: 100000 },
                scene2: { rawKB: 49.9, rawBytes: 51100 },
                scene3: { rawKB: 39.6, rawBytes: 40500 },
            },
            master: {
                scene1: { rawKB: 95.0, rawBytes: 97280 },
                scene2: { rawKB: 49.5, rawBytes: 50700 },
                scene3: { rawKB: 39.6, rawBytes: 40500 },
            },
            scenes: [
                { id: 1, slug: "scene1", name: "Scene 1 - BoomBox PBR", maxRawKB: 100 },
                { id: 2, slug: "scene2", name: "Scene 2 - Sphere", maxRawKB: 50 },
                { id: 3, slug: "scene3", name: "Scene 3 - Grid", maxRawKB: 40 },
            ],
        };

        it("emphasises a scene this PR moved that now sits under the tight threshold", () => {
            const comment = runReporter(headroomFixture).comment ?? "";

            expect(comment).toContain("### Ceiling headroom");
            expect(comment).toContain("⚠️ **1 scene this PR moved sits under 1.0 KB of headroom.**");
            expect(comment).toContain("| Scene | Size | Ceiling | Headroom | Δ this PR |");
            expect(comment).toContain("Scene 2 - Sphere<br/>`scene2` | 49.9 KB | 50 KB | **100 B** | +400 B");
            // scene3 is tight too, but this PR did not touch it — it belongs in the collapsed
            // repo-wide list, not in the actionable block.
            expect(comment).not.toContain("Scene 3 - Grid<br/>`scene3` | 39.6 KB | 40 KB | **460 B**");
        });

        it("reports movement the rounded delta table cannot show", () => {
            const comment = runReporter(headroomFixture).comment ?? "";

            // 400 B rounds to a 0 KB change, so scene2 is absent from the delta tables entirely.
            expect(comment).not.toContain("`scene2` | 50 KB | 50 KB");
            expect(comment).toContain("+400 B");
        });

        it("folds the repo-wide picture into a banded details block", () => {
            const comment = runReporter(headroomFixture).comment ?? "";

            expect(comment).toContain("<details>");
            expect(comment).toContain("<summary>Tightest scenes repo-wide — 2 of 3 under 1.0 KB, 1 under 256 B</summary>");
            expect(comment).toContain("Scene 2 - Sphere<br/>`scene2` ⬅ moved by this PR | 49.9 KB | 50 KB | 100 B |");
            expect(comment).toContain("Scene 3 - Grid<br/>`scene3` | 39.6 KB | 40 KB | 460 B |");
            // Tightest first.
            expect(comment.indexOf("`scene2` ⬅")).toBeLessThan(comment.indexOf("`scene3` |"));
        });

        it("calls out a moved scene that exceeds its ceiling", () => {
            const comment =
                runReporter({
                    current: { scene1: { rawKB: 97.7, rawBytes: 100000 }, scene2: { rawKB: 50.3, rawBytes: 51512 } },
                    master: { scene1: { rawKB: 95.0, rawBytes: 97280 }, scene2: { rawKB: 49.5, rawBytes: 50700 } },
                    scenes: [
                        { id: 1, slug: "scene1", name: "Scene 1 - BoomBox PBR", maxRawKB: 100 },
                        { id: 2, slug: "scene2", name: "Scene 2 - Sphere", maxRawKB: 50 },
                    ],
                }).comment ?? "";

            expect(comment).toContain("🚨 **1 scene this PR moved now exceeds its ceiling:** `scene2` (+312 B over its 50 KB ceiling)");
        });

        it("omits the headroom section for scenes that opt out of the ceiling check", () => {
            const comment =
                runReporter({
                    current: { scene1: { rawKB: 97.7, rawBytes: 100000 } },
                    master: { scene1: { rawKB: 95.0, rawBytes: 97280 } },
                    scenes: [{ id: 1, slug: "scene1", name: "Scene 1", maxRawKB: 100, skipBundleSize: true }],
                }).comment ?? "";

            expect(comment).toContain("## Bundle Size Changes");
            expect(comment).not.toContain("Ceiling headroom");
        });
    });
});
