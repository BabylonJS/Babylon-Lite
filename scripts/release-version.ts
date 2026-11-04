/// <reference types="node" />

/**
 * Pure, IO-free version-resolution helpers shared by the npm publish pipeline
 * (`scripts/prepare-npm-release.ts`) and its unit tests. Keeping the decision
 * logic here — separate from the git/npm side effects — makes the release-type
 * policy testable and guards against regressions such as an accidental major.
 */

export type ReleaseType = "auto" | "patch" | "minor" | "major";
export type ResolvedReleaseType = Exclude<ReleaseType, "auto">;

export function parseReleaseType(value: string | undefined): ReleaseType {
    if (value === "patch" || value === "minor" || value === "major" || value === "auto") {
        return value;
    }
    throw new Error(`Unsupported release type '${value}'. Expected auto, patch, minor, or major.`);
}

export function parseExplicitReleaseType(value: unknown): ResolvedReleaseType {
    if (value === "patch" || value === "minor" || value === "major") {
        return value;
    }
    throw new Error(`Unsupported release config type '${String(value)}'. Expected patch, minor, or major.`);
}

export function parseVersion(version: string): [number, number, number] {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) {
        throw new Error(`Unsupported semver version '${version}'. Expected x.y.z.`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) {
            return a[i]! - b[i]!;
        }
    }
    return 0;
}

export function maxVersion(a: string, b: string): string {
    if (!a) {
        return b;
    }
    if (!b) {
        return a;
    }
    return compareVersions(parseVersion(a), parseVersion(b)) >= 0 ? a : b;
}

export function bumpVersion(version: string, releaseType: ResolvedReleaseType): string {
    const [major, minor, patch] = parseVersion(version);
    if (releaseType === "major") {
        return `${major + 1}.0.0`;
    }
    if (releaseType === "minor") {
        return `${major}.${minor + 1}.0`;
    }
    return `${major}.${minor}.${patch + 1}`;
}

export function detectBreakingChanges(commitMessages: string): boolean {
    return /^BREAKING[ -]CHANGE:/m.test(commitMessages) || /^[a-z]+(?:\([^)]+\))?!:/m.test(commitMessages);
}

/**
 * Resolve the concrete release type that will be published.
 *
 * Policy: `auto` (used by the weekly scheduled run and any unattended release)
 * NEVER self-promotes to a major, even when breaking-change markers are present
 * in the commit range. Auto always resolves to `minor`. A major release is a
 * deliberate, human-owned decision that must be requested explicitly — either a
 * manual `major` pipeline run or `config/release.json` `type: "major"`.
 *
 * This is the guard that keeps an accidental breaking commit on master from
 * triggering a surprise major (as happened with the 2.0.0 release). Breaking
 * markers are still surfaced to the operator via a warning at the call site and
 * recorded in the changelog; they simply no longer drive the version bump.
 */
export function resolveReleaseType(requested: ReleaseType): ResolvedReleaseType {
    if (requested === "auto") {
        return "minor";
    }
    return requested;
}

// ---------------------------------------------------------------------------
// ONE-TIME EXCEPTION — the burned 2.0.0 version.
//
// 2.0.0 was published to npm by accident (an unintended major produced by a
// scheduled `auto` run before the auto->major promotion was removed) and has
// since been deprecated. npm forbids reusing a published version number, so the
// first *intentional* major bump — which would naturally compute 2.0.0 — must
// skip the burned version and release 2.0.1 instead. This exception is specific
// to 2.0.0 and exists only to bridge past that accident; it can be deleted once
// the 2.x line has moved beyond 2.0.x.
// ---------------------------------------------------------------------------
export const BURNED_VERSION = "2.0.0";
export const BURNED_VERSION_REPLACEMENT = "2.0.1";

export function applyBurnedVersionException(version: string): string {
    return version === BURNED_VERSION ? BURNED_VERSION_REPLACEMENT : version;
}

