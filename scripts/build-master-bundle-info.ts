/**
 * Build Rollup chunk/module contribution info for the master baseline.
 *
 * The regular bundle build writes current-source metadata to
 * lab/public/bundle/bundle-info/. This script builds the same scene entrypoints
 * from a temporary archive of upstream/master (or a fallback master ref) and writes matching
 * metadata to lab/public/bundle/master-bundle-info/ for the lab bundle modal.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { buildLiteSceneBundleInfo, outDir, writeMasterBundleManifest } from "./bundle-scenes-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_DIR = resolve(ROOT, ".bundle-size-tmp/master-bundle-info-src");
const ARCHIVE_PATH = resolve(ROOT, ".bundle-size-tmp/master-bundle-info.tar");
const INFO_DIR = resolve(outDir, "master-bundle-info");

function resolveMasterRef(): string {
    const requested = process.env.MASTER_BUNDLE_REF;
    if (requested) return requested;
    for (const ref of ["upstream/master", "origin/master", "master"]) {
        try {
            execFileSync("git", ["rev-parse", "--verify", ref], { cwd: ROOT, stdio: "ignore" });
            return ref;
        } catch {
            // Try the next fallback.
        }
    }
    throw new Error("Could not resolve upstream/master, origin/master, or master. Fetch master first, or set MASTER_BUNDLE_REF.");
}

function sceneExists(ref: string, scene: string): boolean {
    try {
        execFileSync("git", ["cat-file", "-e", `${ref}:lab/src/lite/${scene}.ts`], { cwd: ROOT, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function getScenes(): string[] {
    if (process.env.BUNDLE_SCENES) {
        return process.env.BUNDLE_SCENES.split(",").map((s) => s.trim()).filter(Boolean);
    }
    const config = JSON.parse(readFileSync(resolve(ROOT, "scene-config.json"), "utf-8")) as Array<{ id: number }>;
    return config.map((s) => `scene${s.id}`);
}

function extractRef(ref: string): void {
    rmSync(TMP_DIR, { recursive: true, force: true });
    rmSync(ARCHIVE_PATH, { force: true });
    mkdirSync(resolve(ROOT, ".bundle-size-tmp"), { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
    execFileSync("git", ["archive", "--format=tar", ref, "-o", ARCHIVE_PATH], { cwd: ROOT, stdio: "inherit" });
    execFileSync("tar", ["-xf", ARCHIVE_PATH, "-C", TMP_DIR], { cwd: ROOT, stdio: "inherit" });
}

async function main(): Promise<void> {
    const ref = resolveMasterRef();
    const scenes = getScenes().filter((scene) => {
        if (sceneExists(ref, scene)) return true;
        console.log(`Skipping ${scene}: not present in ${ref}`);
        return false;
    });
    console.log(`Building master bundle info for ${scenes.length} scene(s) from ${ref}`);

    writeMasterBundleManifest([ref]);
    extractRef(ref);
    rmSync(INFO_DIR, { recursive: true, force: true });
    mkdirSync(INFO_DIR, { recursive: true });

    try {
        for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i]!;
            console.log(`[${i + 1}/${scenes.length}] ${scene}`);
            await buildLiteSceneBundleInfo(scene, TMP_DIR, INFO_DIR);
        }
    } finally {
        rmSync(TMP_DIR, { recursive: true, force: true });
        rmSync(ARCHIVE_PATH, { force: true });
    }

    if (!existsSync(INFO_DIR)) {
        throw new Error(`Expected ${INFO_DIR} to be created`);
    }
    console.log(`✓ Master bundle info written to ${INFO_DIR}`);
}

main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});
