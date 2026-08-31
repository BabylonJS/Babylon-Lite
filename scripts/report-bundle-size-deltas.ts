/**
 * Compare current bundle sizes vs master baseline and generate a GitHub PR comment.
 *
 * Reads:
 *  - lab/public/bundle/manifest.json (current)
 *  - lab/public/bundle/master-manifest.json (baseline)
 *  - scene-config.json (scene metadata, including the `maxRawKB` ceilings)
 *
 * Outputs:
 *  - Markdown comment listing all changes rounded to nearest whole KB, followed by a
 *    ceiling-headroom section (see `buildHeadroomReport`)
 *  - `bundle-comment-state.json` beside it, declaring which of the three states this run
 *    measured. See `BundleCommentState`.
 *  - Azure DevOps variables for conditional GitHubComment@0 posting. The comment is posted
 *    when a rounded delta is nonzero OR when this PR moved a scene into the tight/critical
 *    headroom band, since sub-KB movement produces no delta rows yet is exactly what puts a
 *    near-ceiling scene over.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import {
    computeSceneHeadroom,
    CRITICAL_HEADROOM_BYTES,
    formatHeadroomThreshold,
    HEADROOM_LIST_LIMIT,
    measuredBytesOf,
    scenesUnderHeadroom,
    TIGHT_HEADROOM_BYTES,
    type SceneHeadroom,
    type SceneHeadroomInput,
} from "./bundle-ceiling-headroom";

interface ManifestEntry {
    rawKB?: number;
    rawBytes?: number;
    gzipKB?: number;
    /**
     * Ceiling that applied when this manifest entry was measured. Published baseline entries carry
     * it; older baselines may not, in which case historical ceiling state is unknown.
     */
    ceilingKB?: number;
}

type Manifest = Record<string, ManifestEntry>;

interface SceneConfig {
    id: number;
    slug: string;
    name: string;
    maxRawKB?: number;
    skipBundleSize?: boolean;
}

interface BundleDelta {
    key: string;
    name: string;
    currentKB: number;
    masterKB: number;
    deltaKB: number;
}

/**
 * What this run measured, as three distinguishable outcomes rather than a boolean.
 *
 * The trusted reconciler that owns the sticky PR comment (issue #627) has to tell "this PR has
 * nothing notable to say" apart from "this run could not tell", because the first retracts a
 * previous comment and the second must leave it alone. A boolean collapses them, and the safe
 * collapse — treat unknown as nothing-to-report — is the one that silently retracts a real
 * regression report the moment a baseline fetch fails.
 *
 * `report`      the comment body is meaningful and should be posted or refreshed
 * `none`        measured successfully, nothing notable; a prior comment should be retracted
 * `unavailable` could not measure; a prior comment must be left exactly as it is
 *
 * This mirrors the `present | absent | unavailable` marker status in `report-api-changes.ts`.
 */
export type BundleCommentState = "report" | "none" | "unavailable";

/** Schema version of `bundle-comment-state.json`. The reader rejects anything else. */
export const BUNDLE_COMMENT_STATE_VERSION = 1;

/** File name the trusted publisher looks for inside the `bundle-comment` artifact. */
export const BUNDLE_COMMENT_STATE_FILE = "bundle-comment-state.json";

/**
 * Write the state file next to the comment body.
 *
 * Written on every successful run, including the runs with nothing to say — that is the whole
 * point. Before #627 a quiet run staged no artifact at all, which is indistinguishable from a
 * crashed run, so the publisher could never safely retract anything.
 */
export function writeBundleCommentState(directory: string, state: BundleCommentState): string {
    const path = resolve(directory, BUNDLE_COMMENT_STATE_FILE);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ schemaVersion: BUNDLE_COMMENT_STATE_VERSION, state }, null, 2)}\n`, "utf-8");
    return path;
}

export function loadManifest(path: string): Manifest | null {
    if (!existsSync(path)) {
        return null;
    }
    return JSON.parse(readFileSync(path, "utf-8")) as Manifest;
}

export function loadSceneConfig(path: string): SceneConfig[] {
    return JSON.parse(readFileSync(path, "utf-8")) as SceneConfig[];
}

export function roundToWholeKB(kb: number): number {
    return Math.round(kb);
}

export function escapeAzureVariableValue(value: string): string {
    return value.replace(/%/g, "%AZP25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function computeDeltas(current: Manifest, master: Manifest, sceneConfigs: SceneConfig[]): BundleDelta[] {
    const sceneNameMap = new Map(sceneConfigs.map((s) => [`scene${s.id}`, s.name]));
    const allKeys = new Set([...Object.keys(current), ...Object.keys(master)]);
    const deltas: BundleDelta[] = [];

    for (const key of allKeys) {
        const currentEntry = current[key];
        const masterEntry = master[key];

        if (currentEntry?.rawKB == null || masterEntry?.rawKB == null) {
            continue;
        }

        const currentKB = roundToWholeKB(currentEntry.rawKB);
        const masterKB = roundToWholeKB(masterEntry.rawKB);
        const deltaKB = currentKB - masterKB;

        if (deltaKB !== 0) {
            const name = sceneNameMap.get(key) ?? key;
            deltas.push({ key, name, currentKB, masterKB, deltaKB });
        }
    }

    return deltas.sort((a, b) => Math.abs(b.deltaKB) - Math.abs(a.deltaKB));
}

/**
 * Byte-level movement per scene, keyed by manifest key.
 *
 * Deliberately not derived from `computeDeltas`: that rounds to whole KB and drops anything
 * that rounds to zero, which is exactly the movement that matters here. A +400 B change shows
 * up in the delta table as nothing at all, yet it is enough to push a scene with 300 B of
 * headroom over its ceiling.
 *
 * Resolution is whatever `measuredBytesOf` can supply: byte-exact when both manifests recorded
 * `rawBytes`, which is what the current measurement writes, and quantised to 0.1 KB (~±51 B)
 * only for older entries that predate that field. So the values below are reported in whole
 * bytes without promising that every input was measured to the byte.
 */
export function computeMovedBytes(current: Manifest, master: Manifest): Map<string, number> {
    const moved = new Map<string, number>();
    for (const key of Object.keys(current)) {
        const currentBytes = measuredBytesOf(current[key]);
        const masterBytes = measuredBytesOf(master[key]);
        if (currentBytes == null || masterBytes == null) {
            continue;
        }
        const delta = Math.round(currentBytes - masterBytes);
        if (delta !== 0) {
            moved.set(key, delta);
        }
    }
    return moved;
}

/** Headroom inputs for every scene that has both a measured size and a ceiling. */
export function collectHeadroomInputs(current: Manifest, sceneConfigs: SceneConfig[], master: Manifest = {}): SceneHeadroomInput[] {
    const inputs: SceneHeadroomInput[] = [];
    for (const config of sceneConfigs) {
        const key = `scene${config.id}`;
        const measuredBytes = measuredBytesOf(current[key]);
        // Honour the same opt-out as the ceiling test in bundle-size.spec.ts.
        if (measuredBytes == null || config.maxRawKB == null || config.skipBundleSize) {
            continue;
        }
        inputs.push({
            scene: key,
            name: config.name,
            measuredBytes,
            ceilingKB: config.maxRawKB,
            masterBytes: measuredBytesOf(master[key]) ?? undefined,
            masterCeilingKB: master[key]?.ceilingKB,
        });
    }
    return inputs;
}

function sceneLabel(entry: SceneHeadroom): string {
    return `${entry.name ?? entry.scene}<br/>\`${entry.scene}\``;
}

/** Bytes below 1 KB stay bytes; above it, one decimal of KB is enough to compare at a glance. */
function formatBytes(bytes: number): string {
    const magnitude = Math.abs(bytes);
    return magnitude < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function formatSignedBytes(bytes: number): string {
    return bytes > 0 ? `+${formatBytes(bytes)}` : formatBytes(bytes);
}

/**
 * Decimal places shared by the size and ceiling columns of the headroom tables.
 *
 * These two columns MUST render at the same precision, and the reason is a correctness one rather
 * than a cosmetic one. Ceilings are authored as free-form decimals in `scene-config.json` (`16.56`,
 * `103.4`, `39.1`), so printing the ceiling verbatim while rounding the measured size to one decimal
 * compares two numbers at different precisions — and rounding is only order-preserving between
 * values rounded the *same* way. The real case that exposed it: `scene117` measures 16948 B against a
 * 16.56 KB ceiling and is 9 B *under*, yet rendered as `16.6 KB` vs `16.56 KB`, which reads as
 * already over. A reporter whose job is to flag scenes near their ceiling must never make a
 * compliant scene look breaching; that is the one misread that would send an author chasing bytes
 * they do not owe. Rounding both sides identically restores monotonicity — if size < ceiling then
 * the rendered size can never exceed the rendered ceiling, at worst tying — and the exact remaining
 * bytes live in their own column, so a tie is never ambiguous.
 */
const KB_DECIMALS = 2;

function formatSizeKB(bytes: number): string {
    return `${(bytes / 1024).toFixed(KB_DECIMALS)} KB`;
}

/** Ceilings come from config as raw decimals; render them at {@link KB_DECIMALS} to match sizes. */
function formatCeilingKB(ceilingKB: number): string {
    return `${ceilingKB.toFixed(KB_DECIMALS)} KB`;
}

function pluralizeScenes(count: number): string {
    return count === 1 ? "1 scene" : `${count} scenes`;
}

export interface HeadroomReport {
    /** Rendered markdown lines, empty when no scene has a ceiling to report against. */
    lines: string[];
    /**
     * Whether this PR grew a scene that is now tight, critical, or over its ceiling.
     *
     * Growth specifically, not movement: a scene this PR shrank gained headroom and cannot have
     * been pushed toward its ceiling by this PR, so it is not a reason to post.
     *
     * This is the signal that makes the comment worth posting on its own. Repo-wide tightness
     * deliberately does not count: it is true on almost every PR, so triggering on it would put
     * a comment on everything and train people to ignore it.
     */
    movedIntoDangerZone: boolean;
    /**
     * Whether any scene was *already* over its ceiling on the baseline — an inherited breach.
     *
     * Determined from the baseline measurement, not from movement. Movement gets this wrong in
     * both directions: a scene this branch adds has no baseline entry and so no delta, and a
     * scene already breached has a delta as soon as the branch touches it at all. The question
     * is whether the baseline was over the ceiling, so that is what this asks.
     *
     * This is a separate trigger from {@link movedIntoDangerZone} because it is not the author's
     * doing. It still has to be posted, and posted on PRs that moved nothing, because it is the
     * exact state this whole section exists for. Master over a ceiling fails the Bundle Size job
     * on *every* open PR, so the author whose build just went red needs the comment to say why —
     * otherwise the only explanation lives in a ~42-minute log, which is the problem we started
     * from. Unlike repo-wide tightness this does not fire on almost every PR; it fires only while
     * master is actually breached, which is a loud, short-lived emergency by construction, since
     * it blocks everyone until it is fixed.
     */
    inheritedCeilingBreach: boolean;
}

/**
 * Render the ceiling-headroom section of the PR comment.
 *
 * The absolute ceiling check is pass/fail with no early warning, and the ceilings sit close
 * enough to current sizes that roughly half the scenes have under a kilobyte of room. That
 * makes a specific concurrency failure easy to hit: two PRs each measure under a ceiling
 * against a master that lacks the other, then breach it together once both land. Because CI
 * builds the merge commit, master being over a ceiling fails *every* later PR's Bundle Size
 * job until the bytes are recovered, and raising a ceiling needs explicit approval.
 *
 * The build log already computed this, but a ~42-minute job's log is not where anyone looks.
 * Putting it in the comment is what turns it into something an author acts on — so the scenes
 * *this PR moved* are called out uncollapsed, and the repo-wide picture is folded away.
 *
 * "Moved" means moved *toward* the ceiling. Direction matters and the first run against a real
 * baseline is what proved it: a branch that had merged a size-reducing master change showed 94
 * scenes in the uncollapsed block, every one of them shrinking (many by 46 B), because presence
 * in the moved set was tested with `has()` rather than by sign. A scene that got smaller gained
 * headroom — it cannot be pushed over its ceiling by this PR, and it was already tight before it
 * was touched. Reporting it as actionable inverts the signal: it asks the author to look hardest
 * at the changes that helped. Only increases can consume headroom, so only increases are called
 * out here; shrinking scenes still appear in the collapsed repo-wide list if they are tight.
 *
 * Scenes *already* over their ceiling are reported whether or not this PR touched them. Filtering
 * the over-ceiling set by direction the way the tight set is filtered would have made this section
 * silent in the one situation it was built for: once master is breached, the Bundle Size job fails
 * on every open PR, and none of those authors grew the offending scene. The delta-comment step
 * runs `condition: always()`, so it is still generated on exactly those failing builds — it just
 * had nothing to say about the failure. An inherited breach is therefore called out separately
 * from one this PR caused, so the author can tell "you did this" from "this was already broken".
 *
 * That attribution is made from the *baseline measurement*, not from a movement delta, because
 * movement answers a different question and gets both edges wrong. A scene this branch adds is
 * absent from the baseline, so it has no delta at all and reads as inherited — asserting it was
 * already over on master, of a scene that does not exist there. A scene that is genuinely
 * inherited acquires a delta the moment the branch grows it by a single byte, which a shared-path
 * change does across many scenes at once — and then the whole overage is attributed to the author
 * and the "rebasing will not clear this" note disappears, in the middle of the repo-wide stall
 * that note exists for. Only the baseline can distinguish the two, so only the baseline is asked.
 */
export function buildHeadroomReport(inputs: readonly SceneHeadroomInput[], movedBytes: ReadonlyMap<string, number>): HeadroomReport {
    if (inputs.length === 0) {
        return { lines: [], movedIntoDangerZone: false, inheritedCeilingBreach: false };
    }

    const { over, under } = computeSceneHeadroom(inputs);
    const tight = scenesUnderHeadroom(under, TIGHT_HEADROOM_BYTES);
    const critical = scenesUnderHeadroom(under, CRITICAL_HEADROOM_BYTES);
    const tightLabel = formatHeadroomThreshold(TIGHT_HEADROOM_BYTES);
    // Only growth consumes headroom. See the note on direction in this function's doc comment.
    const grewBy = (scene: SceneHeadroom): number => movedBytes.get(scene.scene) ?? 0;
    // A scene missing from the baseline is one this branch adds. It has no delta at all, so every
    // movement-based test answers "no" for it — which is the wrong answer to "is this PR
    // responsible for this scene?", the question the callouts below are actually asking. Without
    // this, a PR that lands a brand-new scene a few hundred bytes under its ceiling produces no
    // comment whatsoever: no delta rows, no danger-zone flag, nothing to post. That is silence in
    // exactly the case this report exists for, aimed at the author best placed to act on it, and
    // it is the same mistake as attributing a breach by movement — corrected there, missed here.
    const isAddedHere = (scene: SceneHeadroom): boolean => scene.masterBytes == null;
    const movedAndTight = tight.filter((s) => grewBy(s) > 0 || isAddedHere(s));
    // Attribution is a question about the *baseline*, not about movement, and the two answer
    // differently in both directions. A scene this branch adds has no baseline entry, so it has no
    // delta and movement calls it inherited — while claiming it was "already over on master" and
    // that rebasing will not clear it, of a scene that does not exist on master. A scene already
    // over its ceiling that this branch grows by one byte — what a shared-path change does across
    // many scenes at once — has a positive delta, so movement blames the author for the whole
    // overage and drops the note explaining that rebasing will not help. Ask the baseline instead,
    // using the ceiling published with those bytes rather than this branch's current ceiling.
    //
    // Older baselines carry bytes but no ceiling. That is "unknown", not "not over": substituting
    // the branch ceiling recreates #628, while treating it as unlimited silently asserts master
    // was healthy. Such scenes remain visible in the repo-wide current-state table, but neither
    // attribution callout makes a historical claim that the available data cannot support.
    type SceneWithKnownMasterCeiling = SceneHeadroom & { masterBytes: number; masterCeilingKB: number };
    const hasKnownMasterCeiling = (scene: SceneHeadroom): scene is SceneWithKnownMasterCeiling => scene.masterBytes != null && scene.masterCeilingKB != null;
    const wasOverOnMaster = (scene: SceneHeadroom): scene is SceneWithKnownMasterCeiling => hasKnownMasterCeiling(scene) && scene.masterBytes > scene.masterCeilingKB * 1024;
    const inheritedOver = over.filter((s) => wasOverOnMaster(s));
    const movedAndOver = over.filter((s) => isAddedHere(s) || (hasKnownMasterCeiling(s) && !wasOverOnMaster(s)));

    const lines = ["### Ceiling headroom", ""];

    if (movedAndOver.length > 0) {
        const named = movedAndOver.map((s) => `\`${s.scene}\` (+${formatBytes(s.headroomBytes)} over its ${formatCeilingKB(s.ceilingKB)} ceiling)`);
        // "puts over" rather than "grew": this set now also holds scenes the branch *added*, which
        // have no baseline size to have grown from, and saying they grew would be false of them.
        const verb = movedAndOver.length === 1 ? "its ceiling" : "their ceiling";
        lines.push(`🚨 **${pluralizeScenes(movedAndOver.length)} put over ${verb} by this PR:** ${named.join(", ")}`);
        lines.push("");
    }

    if (movedAndTight.length > 0) {
        // "added or grew" rather than "grew": this set now also holds scenes the branch created,
        // which have no baseline size to have grown from.
        lines.push(`⚠️ **${pluralizeScenes(movedAndTight.length)} this PR added or grew now ${movedAndTight.length === 1 ? "sits" : "sit"} under ${tightLabel} of headroom.**`);
        lines.push("");
        lines.push("| Scene | Size | Ceiling | Headroom | Δ this PR |");
        lines.push("|-------|------|---------|----------|-----------|");
        for (const scene of movedAndTight.slice(0, HEADROOM_LIST_LIMIT)) {
            // A new scene has no baseline to subtract, so a signed delta would render as "0 B" and
            // read as "this PR did not touch it" — the opposite of why it is in this table.
            const delta = isAddedHere(scene) ? "new scene" : formatSignedBytes(movedBytes.get(scene.scene) ?? 0);
            lines.push(
                `| ${sceneLabel(scene)} | ${formatSizeKB(scene.measuredBytes)} | ${formatCeilingKB(scene.ceilingKB)} | **${formatBytes(scene.headroomBytes)}** | ${delta} |`
            );
        }
        if (movedAndTight.length > HEADROOM_LIST_LIMIT) {
            // Cap the uncollapsed block so its length is bounded no matter how many scenes qualify.
            // The tightest are listed first, so the overflow is always the least urgent tail, and a
            // fixed-height block stays readable in the case that matters — a wall of rows is
            // skimmed past exactly like the build log this section exists to replace.
            lines.push("");
            lines.push(`…and ${movedAndTight.length - HEADROOM_LIST_LIMIT} more, listed tightest first.`);
        }
        lines.push("");
    }

    if (inheritedOver.length > 0) {
        const named = inheritedOver.slice(0, HEADROOM_LIST_LIMIT).map((s) => {
            // A scene can be over on master *and* grown here. Report the branch's contribution
            // separately from the total rather than folding them together: the author can act on
            // the bytes they added, and cannot act on the ones that were already there.
            const added = movedBytes.get(s.scene) ?? 0;
            const addedNote = added > 0 ? `, ${formatBytes(added)} of it added here` : "";
            const masterOverage = Math.ceil(s.masterBytes - s.masterCeilingKB * 1024);
            return `\`${s.scene}\` (+${formatBytes(masterOverage)} over its ${formatCeilingKB(s.masterCeilingKB)} baseline ceiling${addedNote})`;
        });
        const overflow = inheritedOver.length > HEADROOM_LIST_LIMIT ? `, and ${inheritedOver.length - HEADROOM_LIST_LIMIT} more` : "";
        const verb = inheritedOver.length === 1 ? "was" : "were";
        lines.push(`🛑 **${pluralizeScenes(inheritedOver.length)} ${verb} already over ceiling on master:** ${named.join(", ")}${overflow}`);
        lines.push("");
        lines.push(
            "This fails the Bundle Size job on every open PR, including ones that changed no bundle bytes, " +
                "until the bytes are recovered on master. The breach did not originate on this branch and rebasing will not clear it."
        );
        lines.push("");
    }

    const criticalNote = critical.length > 0 ? `, ${critical.length} under ${formatHeadroomThreshold(CRITICAL_HEADROOM_BYTES)}` : "";
    // Name the breach count in the summary too. Without it a reader sees "0 of 2 under 1.0 KB"
    // heading a table whose first row is over its ceiling: the tight band counts only scenes still
    // *under* theirs, so a breached scene is excluded from the count while still being listed.
    const overNote = over.length > 0 ? `${pluralizeScenes(over.length)} over ceiling, ` : "";
    lines.push("<details>");
    lines.push(`<summary>Tightest scenes repo-wide — ${overNote}${tight.length} of ${inputs.length} under ${tightLabel}${criticalNote}</summary>`);
    lines.push("");
    lines.push("| Scene | Size | Ceiling | Headroom |");
    lines.push("|-------|------|---------|----------|");
    // Over-ceiling scenes lead the list: negative headroom is tighter than any positive amount, so
    // omitting them would head a "tightest scenes" table with something that is not the tightest.
    // They are labelled rather than printed bare, because `computeSceneHeadroom` stores an overage
    // as a *positive* number — an unlabelled `909 B` would read as a comfortable margin in a column
    // where every other row means the opposite.
    const rankedRows = [
        ...over.map((scene) => ({ scene, headroom: `⚠️ ${formatBytes(scene.headroomBytes)} over` })),
        ...under.map((scene) => ({ scene, headroom: formatBytes(scene.headroomBytes) })),
    ];
    for (const { scene, headroom } of rankedRows.slice(0, HEADROOM_LIST_LIMIT)) {
        // Mark the branch's own scenes in the repo-wide list so an author can find theirs among
        // rows that are mostly other people's. A scene this branch adds belongs to it just as much
        // as one it grew, but has no delta entry, so `movedBytes` alone would leave it unmarked.
        const attribution = isAddedHere(scene) ? " ⬅ added by this PR" : movedBytes.has(scene.scene) ? " ⬅ moved by this PR" : "";
        lines.push(`| ${sceneLabel(scene)}${attribution} | ${formatSizeKB(scene.measuredBytes)} | ${formatCeilingKB(scene.ceilingKB)} | ${headroom} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
    lines.push(
        "*Headroom is the distance to a scene's `maxRawKB` ceiling in `scene-config.json`. " +
            "Two PRs can each measure under a ceiling and still breach it together once both land — and because CI builds the merge commit, " +
            "every later PR's Bundle Size job then fails until the bytes are recovered. If a scene you touched is near zero, consider landing separately.*"
    );

    return {
        lines,
        movedIntoDangerZone: movedAndTight.length > 0 || movedAndOver.length > 0,
        inheritedCeilingBreach: inheritedOver.length > 0,
    };
}

/**
 * Render the comment, or the "nothing to say" placeholder.
 *
 * A headroom-only comment is a real case, not a degenerate one. The delta tables round to whole
 * KB, so a PR whose only effect is a few hundred bytes produces no rows at all — and that is
 * exactly the change this feature exists to catch, because a few hundred bytes is enough to
 * consume the headroom of the ~44% of scenes that have under 1 KB of it. Suppressing the comment
 * whenever the tables are empty would make the report inert in its most important case.
 *
 * An inherited ceiling breach counts too, and it is the case with no delta rows at all by
 * construction: the scene went over on master, so a PR that touched nothing still gets a red
 * Bundle Size job and needs to be told why.
 */
export function formatComment(deltas: BundleDelta[], headroom: HeadroomReport = { lines: [], movedIntoDangerZone: false, inheritedCeilingBreach: false }): string {
    if (deltas.length === 0 && !headroom.movedIntoDangerZone && !headroom.inheritedCeilingBreach) {
        return "**Bundle Size**: No changes detected.";
    }

    const lines = ["## Bundle Size Changes", ""];

    if (deltas.length === 0) {
        // Pick the sentence from the flag that actually fired. The movement wording predates the
        // inherited-breach trigger, which reaches this branch with nothing moved at all — so on a
        // PR that touched no bundle bytes it asserted movement, and pointed the author at their
        // own diff immediately above a block saying the breach came from master.
        lines.push(
            headroom.movedIntoDangerZone
                ? "No changes at whole-KB resolution — but this PR put a scene close to its ceiling."
                : "No bundle-size changes on this branch — but a scene is over its ceiling on master, which fails this job on every open PR."
        );
        lines.push("");
        lines.push(...headroom.lines);
        return lines.join("\n");
    }

    const increases = deltas.filter((d) => d.deltaKB > 0);
    const decreases = deltas.filter((d) => d.deltaKB < 0);

    if (increases.length > 0) {
        lines.push("### Increases");
        lines.push("");
        lines.push("| Package | Current | Master | Change |");
        lines.push("|---------|---------|--------|--------|");
        for (const { name, key, currentKB, masterKB, deltaKB } of increases) {
            lines.push(`| ${name}<br/>\`${key}\` | ${currentKB} KB | ${masterKB} KB | **+${deltaKB} KB** |`);
        }
        lines.push("");
    }

    if (decreases.length > 0) {
        lines.push("### Decreases");
        lines.push("");
        lines.push("| Package | Current | Master | Change |");
        lines.push("|---------|---------|--------|--------|");
        for (const { name, key, currentKB, masterKB, deltaKB } of decreases) {
            lines.push(`| ${name}<br/>\`${key}\` | ${currentKB} KB | ${masterKB} KB | ${deltaKB} KB |`);
        }
        lines.push("");
    }

    lines.push("*Sizes rounded to nearest KB. Run `pnpm build:bundle-scenes` locally to verify.*");

    if (headroom.lines.length > 0) {
        lines.push("");
        lines.push(...headroom.lines);
    }

    return lines.join("\n");
}

function main(): void {
    const rootDir = resolve(__dirname, "..");
    const currentPath = process.env.BUNDLE_SIZE_CURRENT_MANIFEST ?? resolve(rootDir, "lab/public/bundle/manifest.json");
    const masterPath = process.env.BUNDLE_SIZE_MASTER_MANIFEST ?? resolve(rootDir, "lab/public/bundle/master-manifest.json");
    const sceneConfigPath = process.env.BUNDLE_SIZE_SCENE_CONFIG ?? resolve(rootDir, "scene-config.json");
    const outputPath = process.env.BUNDLE_SIZE_COMMENT_PATH ?? resolve(rootDir, "test-results/bundle-comment/bundle-size-comment.md");
    const stateDir = dirname(outputPath);

    // PR CI measures bundle sizes only for the scenes a pull request can actually
    // reach (#638). When it reaches none, nothing is built and nothing is measured
    // — but this is a *measured* nothing rather than an unknown one: the selector
    // proved no bundle scene is downstream of the diff, so sizes cannot have moved.
    //
    // That distinction is the entire point of the tri-state. `none` retracts the
    // comment an earlier push left behind when it did touch bundle code;
    // `unavailable` would strand it there forever, which is the #627 bug. The
    // variable is only ever the selector's own answer, and anything other than a
    // definite "false" falls through to the measuring path, so a selector that
    // failed to run degrades to `unavailable` rather than to a silent retraction.
    if (process.env.BUNDLE_SCENES_AFFECTED === "false") {
        console.log("No bundle scene is affected by this pull request; bundle sizes cannot have moved.");
        writeBundleCommentState(stateDir, "none");
        console.log("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]false");
        return;
    }

    const current = loadManifest(currentPath);
    const master = loadManifest(masterPath);

    if (!current) {
        console.error(`Error: Current manifest not found at ${currentPath}`);
        process.exit(1);
    }

    if (!master) {
        // Bail entirely rather than falling back to a headroom-only report. Headroom is absolute
        // and would be computable from the current manifest alone, which makes "report headroom
        // anyway" a tempting change — but movement is not computable without a baseline, and
        // movement is the sole reason this comment is not posted on every single PR. Roughly half
        // the scenes sit inside the tight band at any moment, so a baseline-free headroom report
        // would hand every PR a warning about scenes it never touched. Silence is the correct
        // degraded behaviour here.
        //
        // Silence, though, is not retraction. This is the case the tri-state exists for: the run
        // could not measure, so the sticky comment must be left exactly as the last run that
        // *could* measure left it. Reporting `none` here would let a transient baseline-fetch
        // failure quietly withdraw a live regression report.
        console.log("Master manifest not found; skipping delta report.");
        writeBundleCommentState(stateDir, "unavailable");
        console.log("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]false");
        return;
    }

    const sceneConfigs = loadSceneConfig(sceneConfigPath);
    const deltas = computeDeltas(current, master, sceneConfigs);
    const headroom = buildHeadroomReport(collectHeadroomInputs(current, sceneConfigs, master), computeMovedBytes(current, master));
    const comment = formatComment(deltas, headroom);

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, comment, "utf-8");
    console.log(`Bundle size comment written to ${outputPath}`);
    console.log("");
    console.log(comment);

    // Post on a whole-KB delta OR on a move into the danger zone OR on an inherited breach. The
    // second disjunct is not a nicety: a sub-KB change produces no delta rows at all, so gating on
    // the tables alone would silence the report in precisely the case it was built for — a few
    // hundred bytes landing on a scene that had a few hundred bytes of room. The third covers the
    // author who changed nothing and still has a red Bundle Size job because master is breached.
    // Repo-wide *tightness* remains deliberately not a trigger; without the "this PR moved it"
    // requirement every PR would get a comment.
    const notable = deltas.length > 0 || headroom.movedIntoDangerZone || headroom.inheritedCeilingBreach;

    // Staged unconditionally, unlike the variable below. The variable still gates the legacy
    // create-only posting path; the state file is what lets the trusted reconciler retract a
    // comment that a *later* quiet run has made obsolete, which is issue #627 itself.
    writeBundleCommentState(stateDir, notable ? "report" : "none");

    if (notable) {
        console.log("");
        console.log("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]true");
        const escapedComment = escapeAzureVariableValue(comment);
        console.log(`##vso[task.setvariable variable=BUNDLE_COMMENT_BODY]${escapedComment}`);
    } else {
        console.log("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]false");
    }
}

if (require.main === module) {
    main();
}
