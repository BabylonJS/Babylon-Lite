/// <reference types="node" />

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

type ReleaseType = "auto" | "patch" | "minor" | "major";
type ResolvedReleaseType = Exclude<ReleaseType, "auto">;
type ReleaseConfig = {
    type?: unknown;
    nonce?: unknown;
};
type PublishPackageJson = {
    name?: string;
    version?: string;
    babylonLiteRelease?: {
        azureBuildId?: string;
        sourceVersion?: string;
    };
};

const PACKAGE_NAME = "@babylonjs/lite";
const DIST_PACKAGE_JSON = resolve(process.cwd(), "packages/babylon-lite/dist/package.json");
const RELEASE_CONFIG_PATH = resolve(process.cwd(), process.env.RELEASE_CONFIG_PATH ?? "config/release.json");
const RELEASE_TAG_PATTERN = "npm-lite-v*";

function run(command: string, args: string[], options: { allowFailure?: boolean } = {}): string {
    try {
        return execFileSync(command, args, {
            cwd: process.cwd(),
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (error) {
        if (options.allowFailure) {
            return "";
        }
        throw error;
    }
}

function parseReleaseType(value: string | undefined): ReleaseType {
    if (value === "patch" || value === "minor" || value === "major" || value === "auto") {
        return value;
    }
    throw new Error(`Unsupported release type '${value}'. Expected auto, patch, minor, or major.`);
}

function parseExplicitReleaseType(value: unknown): ResolvedReleaseType {
    if (value === "patch" || value === "minor" || value === "major") {
        return value;
    }
    throw new Error(`Unsupported release config type '${String(value)}'. Expected patch, minor, or major.`);
}

function readReleaseConfig(): { releaseType: ResolvedReleaseType; nonce: number } {
    const config = JSON.parse(readFileSync(RELEASE_CONFIG_PATH, "utf-8")) as ReleaseConfig;
    const releaseType = parseExplicitReleaseType(config.type);

    if (!Number.isInteger(config.nonce) || Number(config.nonce) < 0) {
        throw new Error(`${RELEASE_CONFIG_PATH} must contain a non-negative integer nonce.`);
    }

    return { releaseType, nonce: Number(config.nonce) };
}

function isReleaseConfigTriggeredRun(): boolean {
    return process.env.BUILD_REASON === "IndividualCI" || process.env.BUILD_REASON === "BatchedCI";
}

function resolveRequestedReleaseType(): { releaseType: ReleaseType; source: string; nonce?: number } {
    if (isReleaseConfigTriggeredRun()) {
        const config = readReleaseConfig();
        return { releaseType: config.releaseType, source: RELEASE_CONFIG_PATH, nonce: config.nonce };
    }

    if (process.env.BUILD_REASON === "Schedule") {
        return { releaseType: "auto", source: "weekly schedule" };
    }

    return { releaseType: parseReleaseType(process.env.RELEASE_TYPE ?? "auto"), source: "RELEASE_TYPE" };
}

function parseVersion(version: string): [number, number, number] {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) {
        throw new Error(`Unsupported semver version '${version}'. Expected x.y.z.`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function bumpVersion(version: string, releaseType: ResolvedReleaseType): string {
    const [major, minor, patch] = parseVersion(version);
    if (releaseType === "major") {
        return `${major + 1}.0.0`;
    }
    if (releaseType === "minor") {
        return `${major}.${minor + 1}.0`;
    }
    return `${major}.${minor}.${patch + 1}`;
}

function getLatestPublishedVersion(fallbackVersion: string): string {
    const publishedVersion = run("npm", ["view", PACKAGE_NAME, "version", "--registry", "https://registry.npmjs.org/"], { allowFailure: true });
    return publishedVersion || fallbackVersion;
}

function getPublishedBuildId(version: string): string {
    return run("npm", ["view", `${PACKAGE_NAME}@${version}`, "babylonLiteRelease.azureBuildId", "--registry", "https://registry.npmjs.org/"], { allowFailure: true });
}

function isVersionPublished(version: string): boolean {
    return run("npm", ["view", `${PACKAGE_NAME}@${version}`, "version", "--registry", "https://registry.npmjs.org/"], { allowFailure: true }) === version;
}

function getPreviousReleaseTag(latestPublishedVersion: string): string {
    const exactTag = `npm-lite-v${latestPublishedVersion}`;
    const exactTagExists = run("git", ["rev-parse", "--verify", `refs/tags/${exactTag}`], { allowFailure: true });
    if (exactTagExists) {
        return exactTag;
    }
    return run("git", ["describe", "--tags", "--abbrev=0", "--match", RELEASE_TAG_PATTERN], { allowFailure: true });
}

function hasBreakingChanges(previousReleaseTag: string): boolean {
    const logRange = previousReleaseTag ? `${previousReleaseTag}..HEAD` : "HEAD";
    const commitMessages = run("git", ["log", "--format=%B", logRange], { allowFailure: true });
    return /^BREAKING[ -]CHANGE:/m.test(commitMessages) || /^[a-z]+(?:\([^)]+\))?!:/m.test(commitMessages);
}

const requested = resolveRequestedReleaseType();
const requestedReleaseType = requested.releaseType;
const pkg = JSON.parse(readFileSync(DIST_PACKAGE_JSON, "utf-8")) as PublishPackageJson;

if (pkg.name !== PACKAGE_NAME) {
    throw new Error(`Refusing to publish '${pkg.name ?? "<missing>"}'. Expected '${PACKAGE_NAME}'.`);
}

if (!pkg.version) {
    throw new Error(`${DIST_PACKAGE_JSON} does not contain a version.`);
}

const latestPublishedVersion = getLatestPublishedVersion(pkg.version);
const currentBuildId = process.env.BUILD_BUILDID;
const latestPublishedBuildId = getPublishedBuildId(latestPublishedVersion);

if (currentBuildId && latestPublishedBuildId === currentBuildId) {
    throw new Error(`Azure build ${currentBuildId} already published ${PACKAGE_NAME}@${latestPublishedVersion}. Refusing to publish another version from the same build rerun.`);
}

const previousReleaseTag = getPreviousReleaseTag(latestPublishedVersion);
const breakingChangesDetected = hasBreakingChanges(previousReleaseTag);
const resolvedReleaseType: ResolvedReleaseType = requestedReleaseType === "auto" ? (breakingChangesDetected ? "major" : "minor") : requestedReleaseType;
const nextVersion = bumpVersion(latestPublishedVersion, resolvedReleaseType);

if (isVersionPublished(nextVersion)) {
    throw new Error(`${PACKAGE_NAME}@${nextVersion} is already published. Refusing to overwrite an existing npm version.`);
}

pkg.version = nextVersion;
pkg.babylonLiteRelease = {
    ...(currentBuildId ? { azureBuildId: currentBuildId } : {}),
    ...(process.env.BUILD_SOURCEVERSION ? { sourceVersion: process.env.BUILD_SOURCEVERSION } : {}),
};
writeFileSync(DIST_PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Package: ${PACKAGE_NAME}`);
console.log(`Latest published version: ${latestPublishedVersion}`);
console.log(`Previous release tag: ${previousReleaseTag || "<none>"}`);
console.log(`Requested release type: ${requestedReleaseType}`);
console.log(`Release type source: ${requested.source}`);
if (requested.nonce !== undefined) {
    console.log(`Release config nonce: ${requested.nonce}`);
}
console.log(`Breaking changes detected: ${breakingChangesDetected ? "yes" : "no"}`);
console.log(`Resolved release type: ${resolvedReleaseType}`);
console.log(`Next version: ${nextVersion}`);
console.log(`##vso[task.setvariable variable=PACKAGE_NAME]${PACKAGE_NAME}`);
console.log(`##vso[task.setvariable variable=PACKAGE_VERSION]${nextVersion}`);
console.log(`##vso[task.setvariable variable=RELEASE_TYPE_RESOLVED]${resolvedReleaseType}`);
console.log(`##vso[task.setvariable variable=BREAKING_CHANGES_DETECTED]${breakingChangesDetected ? "true" : "false"}`);
