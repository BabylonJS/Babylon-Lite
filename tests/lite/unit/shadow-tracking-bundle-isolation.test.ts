import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..");
const BUNDLE_DIR = join(ROOT, "lab", "public", "bundle");

interface BundleManifest {
    runtimeChunks?: string[];
}

interface BundleInfo {
    chunks: {
        file: string;
        modules: { id: string }[];
    }[];
}

function readManifest(scene: string): BundleManifest {
    return JSON.parse(readFileSync(join(BUNDLE_DIR, "manifest", `${scene}.json`), "utf-8")) as BundleManifest;
}

function runtimeModuleIds(scene: string): string[] {
    const runtimeChunks = new Set(readManifest(scene).runtimeChunks ?? []);
    const info = JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle-info", `${scene}.json`), "utf-8")) as BundleInfo;
    return info.chunks.filter((chunk) => runtimeChunks.has(chunk.file)).flatMap((chunk) => chunk.modules.map((module) => module.id.replace(/\\/g, "/")));
}

describe("shadow deformation tracking bundle isolation", () => {
    it("uses an opt-in hook instead of direct shadow bookkeeping in the shared skeleton updater", () => {
        const updater = readFileSync(join(ROOT, "packages", "babylon-lite", "src", "skeleton", "skeleton-updater.ts"), "utf-8");
        const hook = readFileSync(join(ROOT, "packages", "babylon-lite", "src", "animation", "deformation-change-hooks.ts"), "utf-8");

        expect(updater).not.toMatch(/runtime(?:Skeleton|MorphTargets)\._version\s*=/);
        expect(updater).not.toContain("_onShadowCasterChanged");
        expect(updater).toContain("_deformationChangeNotifier?.(");
        expect(hook).not.toContain("_onShadowCasterChanged");
        expect(hook).not.toContain("_shadowVersion");
    });

    it.skipIf(!existsSync(join(BUNDLE_DIR, "scene4.js")))("keeps shadow tracking out of a no-shadow animation bundle", () => {
        const casterBoundsModule = "/shadow/caster-world-aabb.js";
        const staticShadowModules = runtimeModuleIds("scene4");
        expect(
            staticShadowModules.some((id) => id.endsWith(casterBoundsModule)),
            "Directional-shadow scene must contain shadow caster bounds"
        ).toBe(true);
        expect(
            staticShadowModules.some((id) => id.endsWith("/shadow/skinned-caster-aabb.js") || id.endsWith("/shadow/thin-caster-aabb.js")),
            "Static shadow scene must not load optional caster bounds"
        ).toBe(false);
        expect(
            runtimeModuleIds("scene5").some((id) => id.endsWith(casterBoundsModule)),
            "No-shadow skeleton scene must not contain shadow caster bounds"
        ).toBe(false);
    });
});
