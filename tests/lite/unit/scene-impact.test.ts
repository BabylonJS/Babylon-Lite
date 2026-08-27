import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createSceneImpactManifest, isSceneImpactManifest, normalizeImpactModulePath, selectAffectedScenes, type SceneImpactManifest } from "../../../scripts/scene-impact";

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "babylon-lite-scene-impact-"));
    tempDirs.push(dir);
    return dir;
}

function impact(files: Record<string, string[]>): SceneImpactManifest {
    return {
        version: 1,
        commit: "base",
        scenes: ["scene1", "scene2", "scene19"],
        files,
    };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("scene impact manifest", () => {
    it("rejects malformed published manifests", () => {
        expect(isSceneImpactManifest(impact({ "packages/babylon-lite/src/engine/engine.ts": ["scene1"] }))).toBe(true);
        expect(isSceneImpactManifest({ version: 1, commit: "base", scenes: ["scene1"], files: { bad: "scene1" } })).toBe(false);
    });

    it("maps built library modules back to source files", () => {
        expect(normalizeImpactModulePath("packages/babylon-lite/build/lib/material/pbr/pbr-renderable.js")).toBe("packages/babylon-lite/src/material/pbr/pbr-renderable.ts");
        expect(normalizeImpactModulePath("node_modules/vite/index.js")).toBeNull();
    });

    it("uses only runtime-loaded chunks and includes local source dependencies", () => {
        const root = makeTempDir();
        const sourceDir = resolve(root, "packages/babylon-lite/src/material/pbr");
        const shaderDir = resolve(root, "packages/babylon-lite/src/shaders");
        const infoDir = resolve(root, "bundle-info");
        mkdirSync(sourceDir, { recursive: true });
        mkdirSync(shaderDir, { recursive: true });
        mkdirSync(infoDir, { recursive: true });
        writeFileSync(resolve(sourceDir, "pbr-renderable.ts"), 'import shader from "../../shaders/pbr.wgsl?raw";\nexport { shader };\n');
        writeFileSync(resolve(shaderDir, "pbr.wgsl"), "@fragment fn main() {}\n");
        writeFileSync(
            resolve(infoDir, "scene1.json"),
            JSON.stringify({
                chunks: [
                    {
                        file: "scene1.js",
                        modules: [{ id: "packages/babylon-lite/build/lib/material/pbr/pbr-renderable.js" }],
                    },
                    {
                        file: "scene1-unused.js",
                        modules: [{ id: "packages/babylon-lite/build/lib/material/pbr/unused.js" }],
                    },
                ],
            })
        );

        const manifest = createSceneImpactManifest(root, "abc123", { scene1: { runtimeChunks: ["scene1.js"] } }, infoDir);

        expect(manifest.files["packages/babylon-lite/src/material/pbr/pbr-renderable.ts"]).toEqual(["scene1"]);
        expect(manifest.files["packages/babylon-lite/src/shaders/pbr.wgsl"]).toEqual(["scene1"]);
        expect(manifest.files["packages/babylon-lite/src/material/pbr/unused.ts"]).toBeUndefined();
    });

    it("resolves generated library chunks through their source maps", () => {
        const root = makeTempDir();
        const sourceDir = resolve(root, "packages/babylon-lite/src/loader-env");
        const chunkDir = resolve(root, "packages/babylon-lite/build/lib/_chunks");
        const infoDir = resolve(root, "bundle-info");
        mkdirSync(sourceDir, { recursive: true });
        mkdirSync(chunkDir, { recursive: true });
        mkdirSync(infoDir, { recursive: true });
        writeFileSync(resolve(sourceDir, "load-env.ts"), "export const loadEnvironment = 1;\n");
        writeFileSync(resolve(chunkDir, "env-helpers-hash.js.map"), JSON.stringify({ sources: ["../../../src/loader-env/load-env.ts"] }));
        writeFileSync(
            resolve(infoDir, "scene1.json"),
            JSON.stringify({
                chunks: [
                    {
                        file: "scene1.js",
                        modules: [{ id: "packages/babylon-lite/build/lib/_chunks/env-helpers-hash.js" }],
                    },
                ],
            })
        );

        const manifest = createSceneImpactManifest(root, "abc123", { scene1: { runtimeChunks: ["scene1.js"] } }, infoDir);

        expect(manifest.files["packages/babylon-lite/src/loader-env/load-env.ts"]).toEqual(["scene1"]);
        expect(Object.keys(manifest.files).some((file) => file.startsWith("packages/babylon-lite/src/_chunks/"))).toBe(false);
    });
});

describe("affected scene selection", () => {
    const allScenes = ["scene1", "scene2", "scene19"];

    it("selects scenes from the published module map", () => {
        const selection = selectAffectedScenes({
            allScenes,
            changedFiles: ["packages/babylon-lite/src/material/pbr/pbr-renderable.ts"],
            impactManifest: impact({ "packages/babylon-lite/src/material/pbr/pbr-renderable.ts": ["scene1", "scene19"] }),
        });

        expect(selection).toMatchObject({ scenes: ["scene1", "scene19"], fullRun: false });
    });

    it("selects a directly changed scene without a published manifest", () => {
        const selection = selectAffectedScenes({
            allScenes,
            changedFiles: ["lab/lite/src/lite/scene19.ts", "tests/lite/parity/scenes/scene19-clearcoat.spec.ts"],
        });

        expect(selection).toMatchObject({ scenes: ["scene19"], fullRun: false });
    });

    it("associates a new runtime file imported by a changed mapped module", () => {
        const importer = "packages/babylon-lite/src/material/pbr/pbr-renderable.ts";
        const dependency = "packages/babylon-lite/src/material/pbr/new-fragment.ts";
        const selection = selectAffectedScenes({
            allScenes,
            changedFiles: [importer, dependency],
            impactManifest: impact({ [importer]: ["scene19"] }),
            dependencies: new Map([[importer, [dependency]]]),
        });

        expect(selection).toMatchObject({ scenes: ["scene19"], fullRun: false });
    });

    it("runs all scenes for an unmapped runtime file", () => {
        const selection = selectAffectedScenes({
            allScenes,
            changedFiles: ["packages/babylon-lite/src/material/pbr/new-fragment.ts"],
            impactManifest: impact({}),
        });

        expect(selection).toMatchObject({ scenes: allScenes, fullRun: true });
    });

    it("skips scene tests for documentation-only changes", () => {
        const selection = selectAffectedScenes({
            allScenes,
            changedFiles: ["docs/lite/architecture/01-scene.md"],
            impactManifest: impact({}),
        });

        expect(selection).toMatchObject({ scenes: [], fullRun: false });
    });

    it("selects only changed scene-config entries", () => {
        const selection = selectAffectedScenes({
            allScenes,
            changedFiles: ["scene-config.json"],
            changedSceneIds: [2],
            impactManifest: impact({}),
        });

        expect(selection).toMatchObject({ scenes: ["scene2"], fullRun: false });
    });
});
