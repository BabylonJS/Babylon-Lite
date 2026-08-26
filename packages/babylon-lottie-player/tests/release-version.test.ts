import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLottieBreakingChanges, isNpmPackageNotFound, resolveLottieReleasePlan } from "../../../scripts/lottie-player-release-version.js";

function releasedPlan(overrides: Partial<Parameters<typeof resolveLottieReleasePlan>[0]> = {}) {
    return resolveLottieReleasePlan({
        sourceVersion: "10.0.0",
        publishedVersion: "10.0.0",
        highestReleasedTagVersion: "10.0.0",
        requestedReleaseType: "patch",
        breakingChangesDetected: false,
        hasRelevantChanges: true,
        ...overrides,
    });
}

describe("@babylonjs/lottie-player release version resolution", () => {
    it("resolves the explicit breaking takeover from 9.22.2 to 10.0.0", () => {
        expect(
            resolveLottieReleasePlan({
                sourceVersion: "10.0.0",
                publishedVersion: "9.22.2",
                highestReleasedTagVersion: "",
                requestedReleaseType: "major",
                breakingChangesDetected: true,
                hasRelevantChanges: true,
            })
        ).toEqual({
            resolutionBaseVersion: "9.22.2",
            resolvedReleaseType: "major",
            nextVersion: "10.0.0",
        });
    });

    it("requires the incumbent npm package and an explicit initial major", () => {
        expect(() =>
            resolveLottieReleasePlan({
                sourceVersion: "10.0.0",
                publishedVersion: null,
                highestReleasedTagVersion: "",
                requestedReleaseType: "major",
                breakingChangesDetected: true,
                hasRelevantChanges: true,
            })
        ).toThrow("must already exist on npm");
        expect(() => releasedPlan({ publishedVersion: "9.22.2", highestReleasedTagVersion: "", requestedReleaseType: "auto", breakingChangesDetected: true })).toThrow(
            "requires an explicit major release"
        );
    });

    it("bumps from the newer of npm and the release tags", () => {
        expect(releasedPlan({ highestReleasedTagVersion: "10.0.2" })).toMatchObject({ resolutionBaseVersion: "10.0.2", nextVersion: "10.0.3" });
    });

    it("uses minor for a non-breaking auto release and major for a breaking auto release", () => {
        expect(releasedPlan({ requestedReleaseType: "auto" })).toMatchObject({ resolvedReleaseType: "minor", nextVersion: "10.1.0" });
        expect(releasedPlan({ requestedReleaseType: "auto", breakingChangesDetected: true })).toMatchObject({ resolvedReleaseType: "major", nextVersion: "11.0.0" });
    });

    it("rejects explicit patch and minor releases containing breaking changes", () => {
        expect(() => releasedPlan({ requestedReleaseType: "patch", breakingChangesDetected: true })).toThrow("Breaking Lottie changes require a major release");
        expect(() => releasedPlan({ requestedReleaseType: "minor", breakingChangesDetected: true })).toThrow("Breaking Lottie changes require a major release");
        expect(releasedPlan({ requestedReleaseType: "major", breakingChangesDetected: true })).toMatchObject({ nextVersion: "11.0.0" });
    });

    it("rejects a release with no Lottie-owned commits since the previous release", () => {
        expect(() => releasedPlan({ hasRelevantChanges: false })).toThrow("No Lottie-owned commits exist");
    });

    it("detects supported breaking-change commit markers", () => {
        expect(detectLottieBreakingChanges("feat(player)!: change the public input\n")).toBe(true);
        expect(detectLottieBreakingChanges("feat: change input\n\nBREAKING CHANGE: migrate callers\n")).toBe(true);
        expect(detectLottieBreakingChanges("fix: preserve image URLs\n")).toBe(false);
    });

    it("distinguishes an npm E404 from authentication and network failures", () => {
        expect(isNpmPackageNotFound("npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@babylonjs%2flottie-player")).toBe(true);
        expect(isNpmPackageNotFound("npm error code E401\nnpm error Incorrect or missing password.")).toBe(false);
        expect(isNpmPackageNotFound("npm error code EAI_AGAIN\nnpm error request to registry failed")).toBe(false);
    });

    it("keeps live publication dry-run-first, manual, and master-only", () => {
        const pipeline = readFileSync(resolve(process.cwd(), "azure-pipelines-npm-publish-lottie.yml"), "utf8");
        expect(pipeline).toMatch(/- name: dryRun[\s\S]*?default: true/);
        expect(pipeline).toContain('if [ "$(Build.SourceBranch)" != "refs/heads/master" ]; then');
        expect(pipeline).toContain('if [ "$(Build.Reason)" != "Manual" ]; then');
    });

    it("builds artifacts before type-checking the visual app", () => {
        const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
        const lottieTestsTypecheck = "tsc -p packages/babylon-lottie-player/tests/tsconfig.json --noEmit";
        expect(manifest.scripts.lint).not.toContain(lottieTestsTypecheck);
        expect(manifest.scripts["typecheck:lottie-player"]).toContain(lottieTestsTypecheck);
        expect(manifest.scripts["lint:lottie-player:built"]).toBe("eslint packages/babylon-lottie-player && pnpm typecheck:lottie-player");
        expect(manifest.scripts["lint:lottie-player"]).toBe("pnpm build:lottie-player && pnpm lint:lottie-player:built");
        expect(manifest.scripts["test:build:lottie-player:built"]).toBe("vitest run --project lottie-build");
        expect(manifest.scripts["test:build:lottie-player"]).toBe("pnpm build:lottie-player && pnpm test:build:lottie-player:built");
        expect(manifest.scripts["test:visual:lottie-player:built"]).toBe("node packages/babylon-lottie-player/tests/visual/run.mjs");
        expect(manifest.scripts["test:visual:lottie-player"]).toBe("pnpm build:lottie-player && pnpm test:visual:lottie-player:built");
    });

    it("keeps explicit builds ahead of PR and publish type-check and visual validation", () => {
        const prPipeline = readFileSync(resolve(process.cwd(), "azure-pipelines.yml"), "utf8");
        const prBuild = prPipeline.indexOf("- script: pnpm build:lottie-player");
        const prLint = prPipeline.indexOf("- script: pnpm lint:lottie-player:built");
        const prVisual = prPipeline.indexOf("- script: pnpm test:visual:lottie-player:built");
        expect(prBuild).toBeGreaterThan(-1);
        expect(prLint).toBeGreaterThan(prBuild);
        expect(prVisual).toBeGreaterThan(prLint);

        const publishPipeline = readFileSync(resolve(process.cwd(), "azure-pipelines-npm-publish-lottie.yml"), "utf8");
        const buildCommand = "- script: pnpm build:lottie-player";
        const initialBuild = publishPipeline.indexOf(buildCommand);
        const lint = publishPipeline.indexOf("- script: pnpm lint:lottie-player:built");
        const resolveVersion = publishPipeline.indexOf("- script: pnpm exec tsx scripts/prepare-lottie-player-release.ts");
        const releaseBuild = publishPipeline.indexOf(buildCommand, initialBuild + buildCommand.length);
        const visual = publishPipeline.indexOf("- script: pnpm test:visual:lottie-player:built");
        expect(initialBuild).toBeGreaterThan(-1);
        expect(lint).toBeGreaterThan(initialBuild);
        expect(resolveVersion).toBeGreaterThan(lint);
        expect(releaseBuild).toBeGreaterThan(resolveVersion);
        expect(visual).toBeGreaterThan(releaseBuild);
        expect(publishPipeline.slice(releaseBuild, visual)).toContain("PACKAGE_VERSION: $(PACKAGE_VERSION)");
        expect(publishPipeline.indexOf(buildCommand, releaseBuild + buildCommand.length)).toBe(-1);
        expect(publishPipeline.slice(releaseBuild + buildCommand.length)).not.toMatch(/^\s*- script: pnpm test:(?:build|visual):lottie-player\s*$/m);
    });
});
