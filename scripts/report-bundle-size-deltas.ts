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
 *    ceiling-headroom section (see `formatHeadroomSection`)
 *  - Azure DevOps variables for conditional GitHubComment@0 posting
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
 * Exact byte movement per scene, keyed by manifest key.
 *
 * Deliberately not derived from `computeDeltas`: that rounds to whole KB and drops anything
 * that rounds to zero, which is exactly the movement that matters here. A +400 B change shows
 * up in the delta table as nothing at all, yet it is enough to push a scene with 300 B of
 * headroom over its ceiling.
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
export function collectHeadroomInputs(current: Manifest, sceneConfigs: SceneConfig[]): SceneHeadroomInput[] {
    const inputs: SceneHeadroomInput[] = [];
    for (const config of sceneConfigs) {
        const key = `scene${config.id}`;
        const measuredBytes = measuredBytesOf(current[key]);
        // Honour the same opt-out as the ceiling test in bundle-size.spec.ts.
        if (measuredBytes == null || config.maxRawKB == null || config.skipBundleSize) {
            continue;
        }
        inputs.push({ scene: key, name: config.name, measuredBytes, ceilingKB: config.maxRawKB });
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

function formatSizeKB(bytes: number): string {
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function pluralizeScenes(count: number): string {
    return count === 1 ? "1 scene" : `${count} scenes`;
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
 */
export function formatHeadroomSection(inputs: readonly SceneHeadroomInput[], movedBytes: ReadonlyMap<string, number>): string[] {
    if (inputs.length === 0) {
        return [];
    }

    const { over, under } = computeSceneHeadroom(inputs);
    const tight = scenesUnderHeadroom(under, TIGHT_HEADROOM_BYTES);
    const critical = scenesUnderHeadroom(under, CRITICAL_HEADROOM_BYTES);
    const tightLabel = formatHeadroomThreshold(TIGHT_HEADROOM_BYTES);
    const movedAndTight = tight.filter((s) => movedBytes.has(s.scene));
    const movedAndOver = over.filter((s) => movedBytes.has(s.scene));

    const lines = ["### Ceiling headroom", ""];

    if (movedAndOver.length > 0) {
        const named = movedAndOver.map((s) => `\`${s.scene}\` (+${formatBytes(s.headroomBytes)} over its ${s.ceilingKB} KB ceiling)`);
        const verb = movedAndOver.length === 1 ? "now exceeds its ceiling" : "now exceed their ceiling";
        lines.push(`🚨 **${pluralizeScenes(movedAndOver.length)} this PR moved ${verb}:** ${named.join(", ")}`);
        lines.push("");
    }

    if (movedAndTight.length > 0) {
        lines.push(`⚠️ **${pluralizeScenes(movedAndTight.length)} this PR moved ${movedAndTight.length === 1 ? "sits" : "sit"} under ${tightLabel} of headroom.**`);
        lines.push("");
        lines.push("| Scene | Size | Ceiling | Headroom | Δ this PR |");
        lines.push("|-------|------|---------|----------|-----------|");
        for (const scene of movedAndTight) {
            const delta = formatSignedBytes(movedBytes.get(scene.scene) ?? 0);
            lines.push(`| ${sceneLabel(scene)} | ${formatSizeKB(scene.measuredBytes)} | ${scene.ceilingKB} KB | **${formatBytes(scene.headroomBytes)}** | ${delta} |`);
        }
        lines.push("");
    }

    const criticalNote = critical.length > 0 ? `, ${critical.length} under ${formatHeadroomThreshold(CRITICAL_HEADROOM_BYTES)}` : "";
    lines.push("<details>");
    lines.push(`<summary>Tightest scenes repo-wide — ${tight.length} of ${inputs.length} under ${tightLabel}${criticalNote}</summary>`);
    lines.push("");
    lines.push("| Scene | Size | Ceiling | Headroom |");
    lines.push("|-------|------|---------|----------|");
    for (const scene of under.slice(0, HEADROOM_LIST_LIMIT)) {
        const moved = movedBytes.has(scene.scene) ? " ⬅ moved by this PR" : "";
        lines.push(`| ${sceneLabel(scene)}${moved} | ${formatSizeKB(scene.measuredBytes)} | ${scene.ceilingKB} KB | ${formatBytes(scene.headroomBytes)} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
    lines.push(
        "*Headroom is the exact distance to a scene's `maxRawKB` ceiling in `scene-config.json`. " +
            "Two PRs can each measure under a ceiling and still breach it together once both land — and because CI builds the merge commit, " +
            "every later PR's Bundle Size job then fails until the bytes are recovered. If a scene you touched is near zero, consider landing separately.*"
    );

    return lines;
}

export function formatComment(deltas: BundleDelta[], headroomLines: readonly string[] = []): string {
    if (deltas.length === 0) {
        return "**Bundle Size**: No changes detected.";
    }

    const lines = ["## Bundle Size Changes", ""];
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

    if (headroomLines.length > 0) {
        lines.push("");
        lines.push(...headroomLines);
    }

    return lines.join("\n");
}

function main(): void {
    const rootDir = resolve(__dirname, "..");
    const currentPath = process.env.BUNDLE_SIZE_CURRENT_MANIFEST ?? resolve(rootDir, "lab/public/bundle/manifest.json");
    const masterPath = process.env.BUNDLE_SIZE_MASTER_MANIFEST ?? resolve(rootDir, "lab/public/bundle/master-manifest.json");
    const sceneConfigPath = process.env.BUNDLE_SIZE_SCENE_CONFIG ?? resolve(rootDir, "scene-config.json");
    const outputPath = process.env.BUNDLE_SIZE_COMMENT_PATH ?? resolve(rootDir, "test-results/bundle-size-comment.md");

    const current = loadManifest(currentPath);
    const master = loadManifest(masterPath);

    if (!current) {
        console.error(`Error: Current manifest not found at ${currentPath}`);
        process.exit(1);
    }

    if (!master) {
        console.log("Master manifest not found; skipping delta report.");
        console.log("##vso[task.setvariable variable=POST_BUNDLE_COMMENT]false");
        return;
    }

    const sceneConfigs = loadSceneConfig(sceneConfigPath);
    const deltas = computeDeltas(current, master, sceneConfigs);
    const headroomLines = formatHeadroomSection(collectHeadroomInputs(current, sceneConfigs), computeMovedBytes(current, master));
    const comment = formatComment(deltas, headroomLines);

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, comment, "utf-8");
    console.log(`Bundle size comment written to ${outputPath}`);
    console.log("");
    console.log(comment);

    if (deltas.length > 0) {
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
