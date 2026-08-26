import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    detectLottieBreakingChanges,
    isNpmPackageNotFound,
    maxLottieVersion,
    parseExplicitLottieReleaseType,
    parseLottieReleaseType,
    parseLottieVersion,
    resolveLottieReleasePlan,
    type LottieReleaseType,
} from "./lottie-player-release-version.js";

interface ReleaseConfig {
    type?: unknown;
    nonce?: unknown;
}

interface SourcePackageJson {
    name?: string;
    version?: string;
}

const packageName = "@babylonjs/lottie-player";
const sourcePackageName = "babylon-lottie-player";
const sourcePackageJsonPath = resolve(process.cwd(), "packages/babylon-lottie-player/package.json");
const releaseConfigPath = resolve(process.cwd(), "config/release-lottie-player.json");
const releaseTagPattern = "npm-lottie-player-v*";
const releaseTagPrefix = "npm-lottie-player-v";
const registry = "https://registry.npmjs.org/";
const relevantPaths = [
    "packages/babylon-lottie-player",
    "scripts/lottie-player-release-version.ts",
    "scripts/prepare-lottie-player-release.ts",
    "config/release-lottie-player.json",
    "azure-pipelines-npm-publish-lottie.yml",
];

function run(command: string, args: string[]): string {
    return execFileSync(command, args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runOptionalGit(args: string[]): string {
    try {
        return run("git", args);
    } catch {
        return "";
    }
}

function commandErrorText(error: unknown): string {
    if (error && typeof error === "object" && "stderr" in error) {
        const stderr = error.stderr;
        if (typeof stderr === "string" || Buffer.isBuffer(stderr)) {
            return stderr.toString().trim();
        }
    }
    return error instanceof Error ? error.message : String(error);
}

function npmView(args: string[]): string | null {
    try {
        const npmArgs = [...args, "--registry", registry];
        return process.platform === "win32" ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "npm.cmd", ...npmArgs]) : run("npm", npmArgs);
    } catch (error) {
        const stderr = commandErrorText(error);
        if (isNpmPackageNotFound(stderr)) {
            return null;
        }
        throw new Error(`npm registry query failed: ${stderr}`, { cause: error });
    }
}

function readReleaseConfig(): { releaseType: Exclude<LottieReleaseType, "auto">; nonce: number } {
    const config = JSON.parse(readFileSync(releaseConfigPath, "utf8")) as ReleaseConfig;
    const releaseType = parseExplicitLottieReleaseType(config.type);
    if (!Number.isInteger(config.nonce) || Number(config.nonce) < 0) {
        throw new Error(`${releaseConfigPath} must contain a non-negative integer nonce.`);
    }
    return { releaseType, nonce: Number(config.nonce) };
}

function resolveRequestedReleaseType(): { releaseType: LottieReleaseType; source: string; nonce?: number } {
    if (process.env.BUILD_REASON === "IndividualCI" || process.env.BUILD_REASON === "BatchedCI") {
        const config = readReleaseConfig();
        return { releaseType: config.releaseType, source: releaseConfigPath, nonce: config.nonce };
    }
    if (process.env.BUILD_REASON === "Schedule") {
        throw new Error("Scheduled @babylonjs/lottie-player releases are not supported.");
    }
    return { releaseType: parseLottieReleaseType(process.env.RELEASE_TYPE ?? "auto"), source: "RELEASE_TYPE" };
}

function getLatestPublishedVersion(): string {
    const publishedVersion = npmView(["view", packageName, "version"]);
    if (publishedVersion === null) {
        throw new Error(`${packageName} was not found on npm; the Lite takeover requires the existing experimental package as its SemVer base.`);
    }
    parseLottieVersion(publishedVersion);
    return publishedVersion;
}

function getHighestReleasedTagVersion(): string {
    const tagList = run("git", ["tag", "--list", releaseTagPattern]);
    let highestVersion = "";
    for (const line of tagList.split(/\r?\n/)) {
        const tag = line.trim();
        if (!tag.startsWith(releaseTagPrefix)) {
            continue;
        }
        const version = tag.slice(releaseTagPrefix.length);
        if (/^\d+\.\d+\.\d+$/.test(version)) {
            highestVersion = maxLottieVersion(highestVersion, version);
        }
    }
    return highestVersion;
}

function getPreviousReleaseTag(baseVersion: string): string {
    const exactTag = `${releaseTagPrefix}${baseVersion}`;
    if (runOptionalGit(["rev-parse", "--verify", `refs/tags/${exactTag}`])) {
        return exactTag;
    }
    return runOptionalGit(["describe", "--tags", "--abbrev=0", "--match", releaseTagPattern]);
}

function getRelevantCommitMessages(previousReleaseTag: string): string {
    const range = previousReleaseTag ? `${previousReleaseTag}..HEAD` : "HEAD";
    return run("git", ["log", "--format=%B", range, "--", ...relevantPaths]);
}

function getPublishedBuildId(version: string): string {
    return npmView(["view", `${packageName}@${version}`, "babylonLiteRelease.azureBuildId"]) ?? "";
}

function isVersionPublished(version: string): boolean {
    return npmView(["view", `${packageName}@${version}`, "version"]) === version;
}

const sourcePackage = JSON.parse(readFileSync(sourcePackageJsonPath, "utf8")) as SourcePackageJson;
if (sourcePackage.name !== sourcePackageName || !sourcePackage.version) {
    throw new Error(`Refusing to publish from '${sourcePackage.name ?? "<missing>"}'. Expected versioned source package '${sourcePackageName}'.`);
}

const requested = resolveRequestedReleaseType();
const latestPublishedVersion = getLatestPublishedVersion();
const highestReleasedTagVersion = getHighestReleasedTagVersion();
const resolutionBaseVersion = maxLottieVersion(latestPublishedVersion, highestReleasedTagVersion);
const previousReleaseTag = getPreviousReleaseTag(resolutionBaseVersion);
const commitMessages = getRelevantCommitMessages(previousReleaseTag);
const breakingChangesDetected = detectLottieBreakingChanges(commitMessages);
const hasRelevantChanges = commitMessages.trim().length > 0;
const plan = resolveLottieReleasePlan({
    sourceVersion: sourcePackage.version,
    publishedVersion: latestPublishedVersion,
    highestReleasedTagVersion,
    requestedReleaseType: requested.releaseType,
    breakingChangesDetected,
    hasRelevantChanges,
});

const currentBuildId = process.env.BUILD_BUILDID;
if (currentBuildId && getPublishedBuildId(latestPublishedVersion) === currentBuildId) {
    throw new Error(`Azure build ${currentBuildId} already published ${packageName}@${latestPublishedVersion}. Refusing a same-build rerun.`);
}
if (isVersionPublished(plan.nextVersion)) {
    throw new Error(`${packageName}@${plan.nextVersion} is already published. Refusing to overwrite an npm version.`);
}

console.log(`Package: ${packageName}`);
console.log(`Latest published version: ${latestPublishedVersion}`);
console.log(`Highest released tag version: ${highestReleasedTagVersion || "<none>"}`);
console.log(`Resolution base version: ${plan.resolutionBaseVersion}`);
console.log(`Previous release tag: ${previousReleaseTag || "<none>"}`);
console.log(`Relevant path changes: ${hasRelevantChanges ? "yes" : "no"}`);
console.log(`Requested release type: ${requested.releaseType}`);
console.log(`Release type source: ${requested.source}`);
if (requested.nonce !== undefined) {
    console.log(`Release config nonce: ${requested.nonce}`);
}
console.log(`Breaking changes detected: ${breakingChangesDetected ? "yes" : "no"}`);
console.log(`Resolved release type: ${plan.resolvedReleaseType}`);
console.log(`Next version: ${plan.nextVersion}`);
console.log(`##vso[task.setvariable variable=PACKAGE_NAME]${packageName}`);
console.log(`##vso[task.setvariable variable=PACKAGE_VERSION]${plan.nextVersion}`);
console.log(`##vso[task.setvariable variable=RELEASE_TYPE_RESOLVED]${plan.resolvedReleaseType}`);
console.log(`##vso[task.setvariable variable=BREAKING_CHANGES_DETECTED]${breakingChangesDetected ? "true" : "false"}`);
