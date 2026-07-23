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
    it("keeps deformable shadow tracking out of shared runtime modules", () => {
        const sharedModules = [
            join("animation", "weighted-gltf-mixer.ts"),
            join("frame-graph", "shadow-task.ts"),
            join("morph", "create-morph-targets.ts"),
            join("shadow", "shadow-base.ts"),
            join("skeleton", "skeleton-updater.ts"),
            join("skeleton", "update-skeleton-bone-matrices.ts"),
        ];
        for (const file of sharedModules) {
            const source = readFileSync(join(ROOT, "packages", "babylon-lite", "src", file), "utf-8");
            expect(source).not.toContain("deformable-shadow-casters");
            expect(source).not.toContain("enable-morph-target-shadows");
            expect(source).not.toContain("enable-skeleton-shadows");
        }
    });

    it.skipIf(!existsSync(join(BUNDLE_DIR, "scene4.js")))("keeps deformation support out of non-opted bundles", () => {
        const optionalModule = /\/(?:shadow\/(?:deformable-shadow-casters|enable-(?:morph-target|skeleton)-shadows)|mesh\/aabb-corners)\.js$/;
        expect(
            runtimeModuleIds("scene4").some((id) => optionalModule.test(id)),
            "Static shadow scene must not contain deformable shadow support"
        ).toBe(false);
        expect(
            runtimeModuleIds("scene5").some((id) => optionalModule.test(id)),
            "No-shadow skeleton scene must not contain deformable shadow support"
        ).toBe(false);
    });

    it.skipIf(!existsSync(join(BUNDLE_DIR, "scene140.js")))("keeps skeletal bounds out of a morph-only shadow bundle", () => {
        const modules = runtimeModuleIds("scene140");
        expect(modules.some((id) => id.endsWith("/shadow/enable-morph-target-shadows.js"))).toBe(true);
        expect(modules.some((id) => id.endsWith("/shadow/enable-skeleton-shadows.js") || id.endsWith("/mesh/aabb-corners.js"))).toBe(false);
    });

    it("keeps morph-target implementation out of the skeleton-only dependency path", () => {
        const skeletonSource = readFileSync(join(ROOT, "packages", "babylon-lite", "src", "shadow", "enable-skeleton-shadows.ts"), "utf-8");
        const cornerSource = readFileSync(join(ROOT, "packages", "babylon-lite", "src", "mesh", "aabb-corners.ts"), "utf-8");

        expect(skeletonSource).not.toContain("updateMorphedBoneCorners");
        expect(cornerSource).not.toContain("morphTargets");
    });
});
