/**
 * Compare current bundle sizes vs master baseline and generate a GitHub PR comment.
 *
 * Reads:
 *  - lab/public/bundle/manifest.json (current)
 *  - lab/public/bundle/master-manifest.json (baseline)
 *  - scene-config.json (scene metadata)
 *
 * Outputs:
 *  - Markdown comment listing all changes rounded to nearest whole KB
 *  - Azure DevOps variables for conditional GitHubComment@0 posting
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

interface ManifestEntry {
    rawKB?: number;
    gzipKB?: number;
}

type Manifest = Record<string, ManifestEntry>;

interface SceneConfig {
    id: number;
    slug: string;
    name: string;
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

export function formatComment(deltas: BundleDelta[]): string {
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
    const comment = formatComment(deltas);

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
