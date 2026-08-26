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
            expect(comment).toContain("⚠️ **1 scene this PR grew now sits under 1.0 KB of headroom.**");
            expect(comment).toContain("| Scene | Size | Ceiling | Headroom | Δ this PR |");
            expect(comment).toContain("Scene 2 - Sphere<br/>`scene2` | 49.90 KB | 50.00 KB | **100 B** | +400 B");
            // scene3 is tight too, but this PR did not touch it — it belongs in the collapsed
            // repo-wide list, not in the actionable block.
            expect(comment).not.toContain("Scene 3 - Grid<br/>`scene3` | 39.55 KB | 40.00 KB | **460 B**");
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
            expect(comment).toContain("Scene 2 - Sphere<br/>`scene2` ⬅ moved by this PR | 49.90 KB | 50.00 KB | 100 B |");
            expect(comment).toContain("Scene 3 - Grid<br/>`scene3` | 39.55 KB | 40.00 KB | 460 B |");
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

            expect(comment).toContain("🚨 **1 scene put over its ceiling by this PR:** `scene2` (+312 B over its 50.00 KB ceiling)");
        });

        // The scenario this whole section exists for. Once master is over a ceiling, the Bundle
        // Size job fails on every open PR — and none of those authors grew the offending scene.
        // Filtering the over-ceiling set by direction the way the tight set is filtered made the
        // report silent on exactly those builds, which still generate a comment because the step
        // runs `condition: always()`. These fixtures pin the un-filtered path.
        const inheritedBreachFixture = {
            // scene2 is 312 B over its ceiling and identical on both sides: this PR did not touch it.
            current: { scene1: { rawKB: 97.7, rawBytes: 100000 }, scene2: { rawKB: 50.3, rawBytes: 51512 } },
            master: { scene1: { rawKB: 95.0, rawBytes: 97280 }, scene2: { rawKB: 50.3, rawBytes: 51512 } },
            scenes: [
                { id: 1, slug: "scene1", name: "Scene 1 - BoomBox PBR", maxRawKB: 100 },
                { id: 2, slug: "scene2", name: "Scene 2 - Sphere", maxRawKB: 50 },
            ],
        };

        it("reports a scene already over its ceiling that this PR did not grow", () => {
            const comment = runReporter(inheritedBreachFixture).comment ?? "";

            expect(comment).toContain("🛑 **1 scene was already over ceiling on master:** `scene2` (+312 B over its 50.00 KB ceiling)");
            expect(comment).toContain("This fails the Bundle Size job on every open PR");
            // It is not the author's doing, so it must not be reported as something they caused.
            expect(comment).not.toContain("put over its ceiling by this PR");
        });

        it("ranks an over-ceiling scene above every scene still under its ceiling", () => {
            const comment = runReporter(inheritedBreachFixture).comment ?? "";

            // A breached scene is tighter than any positive margin, so it heads the list. And its
            // overage is stored positive, so it is labelled — a bare "312 B" in a headroom column
            // would read as a comfortable margin, the exact inverse of what it means.
            expect(comment).toContain("`scene2` | 50.30 KB | 50.00 KB | ⚠️ 312 B over |");
            // Scope the ordering check to the repo-wide table — scene1 also appears earlier in the
            // Increases delta table, so searching the whole comment answers a different question.
            const details = comment.slice(comment.indexOf("<details>"), comment.indexOf("</details>"));
            expect(details).toContain("1 scene over ceiling, 0 of 2 under 1.0 KB");
            // Match without a trailing pipe: scene1 carries the "⬅ moved by this PR" marker here.
            expect(details.indexOf("`scene2`")).toBeLessThan(details.indexOf("`scene1`"));
        });

        it("caps the inherited-breach callout so it cannot become a wall of scene names", () => {
            // Same failure mode as the uncollapsed-block cap: a repo-wide stall can breach many
            // scenes at once, and an uncapped inline list is skimmed past exactly like the build
            // log this section replaces. 12 breached scenes, none of them touched by this PR.
            const breached = Array.from({ length: 12 }, (_, i) => i + 1);
            const manifest = Object.fromEntries(breached.map((id) => [`scene${id}`, { rawKB: 50.3, rawBytes: 51512 }]));
            const result = runReporter({
                current: manifest,
                master: manifest,
                scenes: breached.map((id) => ({ id, slug: `scene${id}`, name: `Scene ${id}`, maxRawKB: 50 })),
            });
            const comment = result.comment ?? "";

            expect(comment).toContain("🛑 **12 scenes were already over ceiling on master:**");
            expect(comment).toContain(", and 2 more");
            // The callout names at most HEADROOM_LIST_LIMIT scenes, and the table is capped too.
            const callout = comment.slice(comment.indexOf("🛑"), comment.indexOf("This fails the Bundle Size job"));
            expect(callout.match(/over its 50\.00 KB ceiling/g) ?? []).toHaveLength(10);
            const details = comment.slice(comment.indexOf("<details>"), comment.indexOf("</details>"));
            expect(details.match(/⚠️ \d+ B over/g) ?? []).toHaveLength(10);
            expect(details).toContain("12 scenes over ceiling");
        });

        // Attribution is a question about the baseline, not about movement. These two fixtures
        // cover the regions where the two answers diverge — both were rendering false statements.
        it("attributes a scene this PR adds over its ceiling to this PR, not to master", () => {
            // A new scene is absent from the baseline, so it has no delta at all. Classifying by
            // movement called that "inherited" and asserted the scene was already over on master
            // and that rebasing would not clear it — of a scene that does not exist on master.
            const comment =
                runReporter({
                    current: { scene1: { rawKB: 50.3, rawBytes: 51512 }, scene2: { rawKB: 40, rawBytes: 40960 } },
                    master: { scene2: { rawKB: 40, rawBytes: 40960 } },
                    scenes: [
                        { id: 1, slug: "scene1", name: "Scene 1 - New", maxRawKB: 50 },
                        { id: 2, slug: "scene2", name: "Scene 2", maxRawKB: 50 },
                    ],
                }).comment ?? "";

            expect(comment).toContain("🚨 **1 scene put over its ceiling by this PR:** `scene1` (+312 B over its 50.00 KB ceiling)");
            expect(comment).not.toContain("already over ceiling on master");
            expect(comment).not.toContain("rebasing will not clear it");
        });

        it("keeps a breach inherited when this PR only adds bytes on top of it", () => {
            // Master is already 300 B over; this branch adds 12 B, which is what a shared-path
            // change does across many scenes at once. Classifying by movement blamed the author
            // for the whole 312 B and dropped the note saying rebasing will not help — in the
            // middle of the repo-wide stall that note exists for.
            const comment =
                runReporter({
                    current: { scene1: { rawKB: 50.3, rawBytes: 51512 } },
                    master: { scene1: { rawKB: 50.3, rawBytes: 51500 } },
                    scenes: [{ id: 1, slug: "scene1", name: "Scene 1", maxRawKB: 50 }],
                }).comment ?? "";

            // The branch's contribution is reported separately from the total: the author can act
            // on the 12 B they added and cannot act on the 300 B that were already there.
            expect(comment).toContain("🛑 **1 scene was already over ceiling on master:** `scene1` (+312 B over its 50.00 KB ceiling, 12 B of it added here)");
            expect(comment).toContain("rebasing will not clear it");
            expect(comment).not.toContain("put over its ceiling by this PR");
        });

        it("does not claim movement in the header when the only finding is an inherited breach", () => {
            // The headroom-only header predates the inherited-breach trigger, which reaches it
            // with nothing moved — so it asserted movement and pointed the author at their own
            // diff directly above a block saying the breach came from master.
            const identical = { scene1: { rawKB: 50.3, rawBytes: 51512 } };
            const comment =
                runReporter({
                    current: identical,
                    master: identical,
                    scenes: [{ id: 1, slug: "scene1", name: "Scene 1", maxRawKB: 50 }],
                }).comment ?? "";

            expect(comment).toContain("No bundle-size changes on this branch — but a scene is over its ceiling on master");
            expect(comment).not.toContain("this PR moved a scene close to its ceiling");
        });

        it("posts a comment for an inherited breach even when this PR moves no bundle bytes", () => {
            // Identical manifests on both sides: zero deltas, nothing moved, tables empty. The
            // author still has a red Bundle Size job and this comment is the only explanation.
            const result = runReporter({
                current: { scene1: { rawKB: 50.3, rawBytes: 51512 } },
                master: { scene1: { rawKB: 50.3, rawBytes: 51512 } },
                scenes: [{ id: 1, slug: "scene1", name: "Scene 1 - Sphere", maxRawKB: 50 }],
            });

            expect(result.stdout).toContain("POST_BUNDLE_COMMENT]true");
            expect(result.comment ?? "").not.toBe("**Bundle Size**: No changes detected.");
            expect(result.comment ?? "").toContain("🛑 **1 scene was already over ceiling on master:**");
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

        it("posts a headroom-only comment when the sole change is sub-KB movement into the tight band", () => {
            // Every rounded delta is zero here, so the delta tables are empty. Gating the comment
            // on those tables alone would silence the report in exactly the case it exists for.
            const result = runReporter({
                current: {
                    scene1: { rawKB: 97.7, rawBytes: 100000 },
                    scene2: { rawKB: 49.9, rawBytes: 51100 },
                },
                master: {
                    scene1: { rawKB: 97.6, rawBytes: 99900 },
                    scene2: { rawKB: 49.5, rawBytes: 50700 },
                },
                scenes: [
                    { id: 1, slug: "scene1", name: "Scene 1 - BoomBox PBR", maxRawKB: 100 },
                    { id: 2, slug: "scene2", name: "Scene 2 - Sphere", maxRawKB: 50 },
                ],
            });
            const comment = result.comment ?? "";

            expect(result.stdout).toContain("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]true");
            expect(comment).toContain("No changes at whole-KB resolution");
            expect(comment).not.toContain("### Increases");
            expect(comment).not.toContain("### Decreases");
            expect(comment).toContain("### Ceiling headroom");
            expect(comment).toContain("⚠️ **1 scene this PR grew now sits under 1.0 KB of headroom.**");
            expect(comment).toContain("Scene 2 - Sphere<br/>`scene2` | 49.90 KB | 50.00 KB | **100 B** | +400 B");
            // scene1 moved by 100 B too, but it has 2400 B of room — not a reason to warn.
            expect(comment).not.toContain("Scene 1 - BoomBox PBR<br/>`scene1` | 97.7 KB");
        });

        it("posts a headroom-only comment when sub-KB movement pushes a scene over its ceiling", () => {
            const result = runReporter({
                current: { scene1: { rawKB: 50.3, rawBytes: 51512 } },
                master: { scene1: { rawKB: 50.0, rawBytes: 51200 } },
                scenes: [{ id: 1, slug: "scene1", name: "Scene 1 - Sphere", maxRawKB: 50 }],
            });

            expect(result.stdout).toContain("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]true");
            expect(result.comment).toContain("🚨 **1 scene put over its ceiling by this PR:** `scene1` (+312 B over its 50.00 KB ceiling)");
        });

        it("never renders a compliant scene as if it were over its ceiling (precision monotonicity)", () => {
            // Regression guard for a misread found by rendering the real published baseline rather
            // than a fixture. `scene117` measures 16948 B against a 16.56 KB ceiling and is 9 B
            // UNDER it, but the size column rounded to one decimal while the ceiling printed
            // verbatim from config, giving "16.6 KB" vs "16.56 KB" — a scene that is passing,
            // displayed as breaching.
            //
            // Comparing at two precisions is what breaks it: rounding only preserves order between
            // values rounded the same way. This asserts the rendered pair, not the formatter, so it
            // still fails if someone reintroduces the mismatch through a different code path.
            const result = runReporter({
                current: { scene117: { rawKB: 16.6, rawBytes: 16948 } },
                master: { scene117: { rawKB: 16.4, rawBytes: 16800 } },
                scenes: [{ id: 117, slug: "scene117", name: "Scene 117 — 2D Sprite Picking", maxRawKB: 16.56 }],
            });

            expect(result.comment).toContain("| 16.55 KB | 16.56 KB |");
            expect(result.comment).toContain("**9 B**");
            expect(result.comment).not.toContain("16.6 KB | 16.56 KB");
        });

        it("does not flag a tight scene this PR made smaller (direction — do not remove)", () => {
            // Found on the first run against a real published baseline: the uncollapsed block came
            // back with 94 rows, every one of them a scene that had SHRUNK (most by 46 B), because
            // membership in the moved set was tested with `has()` and ignored the sign.
            //
            // A scene that got smaller gained headroom. It cannot be pushed over its ceiling by this
            // PR, and it was already tight before this PR touched it — so calling it actionable
            // points the author at the changes that helped. That is worse than silence: it is the
            // wallpaper failure this section was specifically designed to avoid.
            //
            // scene1 shrinks by 300 B and is still only 400 B from its ceiling. It must not be
            // called out, and it must not trigger a post on its own.
            const result = runReporter({
                current: { scene1: { rawKB: 49.6, rawBytes: 50800 } },
                master: { scene1: { rawKB: 49.9, rawBytes: 51100 } },
                scenes: [{ id: 1, slug: "scene1", name: "Scene 1 - Sphere", maxRawKB: 50 }],
            });

            expect(result.comment ?? "").not.toContain("sits under 1.0 KB of headroom");
            expect(result.stdout).toContain("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]false");
        });

        it("does not treat a scene absent from master as having grown by its whole size", () => {
            // A scene added by this PR has no baseline to move from. If the null guard in
            // computeMovedBytes were dropped, its delta would come out as its entire size, which
            // would then read as the largest growth in the PR and, if the scene were tight, flag it
            // as freshly pushed into the danger zone. Both claims would be false: a new scene did
            // not "move", and its size is whatever it was authored at.
            //
            // This is live rather than hypothetical — scene186 was added to scene-config.json by
            // #610 while this PR was open, and appeared in the current manifest before any baseline
            // contained it. The behaviour is already correct; this pins it.
            const result = runReporter({
                current: {
                    scene1: { rawKB: 49.9, rawBytes: 51100 },
                    scene2: { rawKB: 97.7, rawBytes: 100000 },
                },
                master: { scene1: { rawKB: 49.9, rawBytes: 51100 } },
                scenes: [
                    { id: 1, slug: "scene1", name: "Scene 1 - Sphere", maxRawKB: 50 },
                    { id: 2, slug: "scene2", name: "Scene 2 - Brand New", maxRawKB: 98 },
                ],
            });

            // scene2 is 355 B from its ceiling, but this PR did not move it there.
            expect(result.comment ?? "").not.toContain("sits under 1.0 KB of headroom");
            expect(result.stdout).toContain("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]false");
        });

        it("caps the uncollapsed block so it cannot become a wall of rows", () => {
            // Length must be bounded by the limit, not by how many scenes happen to qualify. The
            // same real-baseline run that exposed the direction bug also printed every qualifying
            // row, which is unreadable for the same reason the build log is.
            const scenes = [];
            const current: Record<string, unknown> = {};
            const master: Record<string, unknown> = {};
            for (let id = 1; id <= 14; id++) {
                // Each scene grows 200 B and lands 100+id B short of a 50 KB ceiling.
                const headroom = 100 + id;
                current[`scene${id}`] = { rawKB: 49.9, rawBytes: 51200 - headroom };
                master[`scene${id}`] = { rawKB: 49.7, rawBytes: 51200 - headroom - 200 };
                scenes.push({ id, slug: `scene${id}`, name: `Scene ${id}`, maxRawKB: 50 });
            }

            const comment = runReporter({ current, master, scenes }).comment ?? "";
            const actionable = comment.slice(comment.indexOf("### Ceiling headroom"), comment.indexOf("<details>"));

            expect(comment).toContain("⚠️ **14 scenes this PR grew now sit under 1.0 KB of headroom.**");
            expect(actionable).toContain("…and 4 more, listed tightest first.");
            // 10 data rows plus the header and separator.
            expect(actionable.split("\n").filter((l) => l.startsWith("| ")).length).toBe(11);
            // Tightest first, so the overflow is the least urgent tail.
            expect(actionable).toContain("`scene1`");
            expect(actionable).not.toContain("`scene14`");
        });

        it("stays silent when tight scenes this PR did not move are the only tight scenes (noise bound — do not remove)", () => {
            // This is the guard that keeps the headroom report off every PR, and it is the one
            // case here that looks redundant from the outside: it asserts an absence, so a
            // refactor can delete it and every other test still passes. It must not be deleted.
            //
            // Roughly half of all scenes sit inside the tight band at any given moment. If the
            // posting gate ever drops the "this PR moved it" requirement, the report degrades
            // from an actionable signal into a warning attached to every PR about scenes the
            // author never touched — which is how a check stops being read at all.
            //
            // scene2 is 100 B from its ceiling but is byte-identical to master; scene1 moved
            // 100 B but has 2400 B of room. Neither is actionable, so nothing should post.
            const result = runReporter({
                current: {
                    scene1: { rawKB: 97.7, rawBytes: 100000 },
                    scene2: { rawKB: 49.9, rawBytes: 51100 },
                },
                master: {
                    scene1: { rawKB: 97.6, rawBytes: 99900 },
                    scene2: { rawKB: 49.9, rawBytes: 51100 },
                },
                scenes: [
                    { id: 1, slug: "scene1", name: "Scene 1 - BoomBox PBR", maxRawKB: 100 },
                    { id: 2, slug: "scene2", name: "Scene 2 - Sphere", maxRawKB: 50 },
                ],
            });

            expect(result.stdout).toContain("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]false");
            expect(result.comment).toContain("No changes detected");
        });
    });
});
