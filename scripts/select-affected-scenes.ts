import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { isSceneImpactManifest, localDependencies, requiredBundleScenesForChanges, selectAffectedScenes, type SceneImpactManifest } from "./scene-impact";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_IMPACT_URL = "https://snapshots-cvgtc2eugrd3cgfd.z01.azurefd.net/lite/bundle-baseline/impact-manifest.json";

interface SceneConfigEntry {
    id: number;
    maxRawKB?: number;
    skipBundleSize?: boolean;
    skipPerf?: boolean;
    [key: string]: unknown;
}

function git(args: string[]): string {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();
}

function targetRef(): string {
    const configured = process.env.SCENE_IMPACT_BASE_REF?.trim();
    if (configured) {
        return configured;
    }
    const pipelineTarget = process.env.SYSTEM_PULLREQUEST_TARGETBRANCH?.trim().replace(/^refs\/heads\//, "");
    return pipelineTarget ? `origin/${pipelineTarget}` : "origin/master";
}

function changedSceneConfigIds(baseCommit: string, current: SceneConfigEntry[]): number[] {
    let base: SceneConfigEntry[];
    try {
        base = JSON.parse(git(["show", `${baseCommit}:scene-config.json`])) as SceneConfigEntry[];
    } catch {
        return current.map((entry) => entry.id);
    }
    const baseById = new Map(base.map((entry) => [entry.id, JSON.stringify(entry)]));
    const currentById = new Map(current.map((entry) => [entry.id, JSON.stringify(entry)]));
    return [...new Set([...baseById.keys(), ...currentById.keys()])].filter((id) => baseById.get(id) !== currentById.get(id));
}

function perCommitImpactUrl(url: string, commit: string): string {
    const parsed = new URL(url);
    const slash = parsed.pathname.lastIndexOf("/");
    parsed.pathname = `${parsed.pathname.slice(0, slash)}/${commit}/${parsed.pathname.slice(slash + 1)}`;
    return parsed.toString();
}

async function fetchImpactManifest(baseCommit: string): Promise<SceneImpactManifest | null> {
    const configuredUrl = (process.env.SCENE_IMPACT_MANIFEST_URL ?? DEFAULT_IMPACT_URL).trim();
    if (!configuredUrl) {
        return null;
    }
    const url = perCommitImpactUrl(configuredUrl, baseCommit);
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) {
            console.warn(`Scene impact manifest unavailable for ${baseCommit.slice(0, 8)} (${response.status}); affected runtime changes will run all scenes.`);
            return null;
        }
        const value: unknown = await response.json();
        if (!isSceneImpactManifest(value) || value.commit !== baseCommit) {
            console.warn(`Scene impact manifest at ${url} does not match base commit ${baseCommit}; affected runtime changes will run all scenes.`);
            return null;
        }
        return value;
    } catch (error) {
        console.warn(`Could not fetch scene impact manifest for ${baseCommit.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

function setAzureVariable(name: string, value: string): void {
    console.log(`##vso[task.setvariable variable=${name}]${value}`);
}

function selectionHash(scenes: readonly string[]): string {
    return createHash("sha256").update(scenes.join(",")).digest("hex").slice(0, 16);
}

function setAzureSceneGroup(name: string, scenes: readonly string[]): void {
    setAzureVariable(`RUN_${name}_TESTS`, scenes.length > 0 ? "true" : "false");
    setAzureVariable(`AFFECTED_${name}_SCENES`, scenes.join(","));
    setAzureVariable(
        `AFFECTED_${name}_SCENE_IDS`,
        scenes.map((scene) => scene.slice("scene".length)).join(",")
    );
    setAzureVariable(`AFFECTED_${name}_SCENES_HASH`, selectionHash(scenes));
}

async function main(): Promise<void> {
    const sceneConfig = JSON.parse(readFileSync(resolve(ROOT, "scene-config.json"), "utf-8")) as SceneConfigEntry[];
    const allScenes = sceneConfig.map((entry) => `scene${entry.id}`);
    const paritySceneSet = new Set(
        readdirSync(resolve(ROOT, "tests/lite/parity/scenes"))
            .map((file) => file.match(/^scene(\d+)-.*\.spec\.ts$/)?.[1])
            .filter((id): id is string => id !== undefined)
            .map((id) => `scene${id}`)
    );
    let changedFiles: string[] = [];
    let selection;
    try {
        const baseCommit = git(["merge-base", "HEAD", targetRef()]);
        changedFiles = git(["diff", "--name-only", "--diff-filter=ACDMRTUXB", baseCommit, "HEAD"])
            .split("\n")
            .map((file) => file.trim())
            .filter(Boolean);
        const impactManifest = await fetchImpactManifest(baseCommit);
        const dependencies = new Map(changedFiles.map((file) => [file, localDependencies(ROOT, file)]));
        selection = selectAffectedScenes({
            allScenes,
            changedFiles,
            changedSceneIds: changedFiles.includes("scene-config.json") ? changedSceneConfigIds(baseCommit, sceneConfig) : [],
            impactManifest,
            dependencies,
        });
    } catch (error) {
        selection = {
            scenes: allScenes,
            fullRun: true,
            reasons: [`could not determine the PR merge base: ${error instanceof Error ? error.message : String(error)}`],
        };
    }
    const sceneIds = selection.scenes.map((scene) => scene.slice("scene".length));
    const sceneConfigByName = new Map(sceneConfig.map((entry) => [`scene${entry.id}`, entry]));
    const bundleSceneSet = new Set([...selection.scenes, ...requiredBundleScenesForChanges(changedFiles)]);
    const bundleScenes = allScenes.filter((scene) => {
        const config = sceneConfigByName.get(scene);
        return bundleSceneSet.has(scene) && !config?.skipBundleSize && config?.maxRawKB != null;
    });
    const parityScenes = selection.scenes.filter((scene) => paritySceneSet.has(scene));
    const perfScenes = selection.scenes.filter((scene) => !sceneConfigByName.get(scene)?.skipPerf);

    console.log(`Scene selection: ${selection.scenes.length}/${allScenes.length}${selection.fullRun ? " (full fallback)" : ""}`);
    console.log(`Reason: ${selection.reasons.join("; ")}`);
    if (selection.scenes.length > 0) {
        console.log(`Scenes: ${selection.scenes.join(",")}`);
    }
    console.log(`Checks: bundle-size=${bundleScenes.length}, parity=${parityScenes.length}, performance=${perfScenes.length}`);

    if (process.argv.includes("--azure")) {
        setAzureVariable("RUN_SCENE_TESTS", selection.scenes.length > 0 ? "true" : "false");
        setAzureVariable("AFFECTED_SCENES", selection.scenes.join(","));
        setAzureVariable("AFFECTED_SCENE_IDS", sceneIds.join(","));
        setAzureVariable("AFFECTED_SCENES_HASH", selectionHash(selection.scenes));
        setAzureSceneGroup("BUNDLE", bundleScenes);
        setAzureSceneGroup("PARITY", parityScenes);
        setAzureSceneGroup("PERF", perfScenes);
    }
}

void main();
