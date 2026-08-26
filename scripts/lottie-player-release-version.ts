export type LottieReleaseType = "auto" | "patch" | "minor" | "major";
export type ResolvedLottieReleaseType = Exclude<LottieReleaseType, "auto">;

export interface LottieReleasePlanInput {
    sourceVersion: string;
    publishedVersion: string | null;
    highestReleasedTagVersion: string;
    requestedReleaseType: LottieReleaseType;
    breakingChangesDetected: boolean;
    hasRelevantChanges: boolean;
}

export interface LottieReleasePlan {
    resolutionBaseVersion: string;
    resolvedReleaseType: ResolvedLottieReleaseType;
    nextVersion: string;
}

export function parseLottieReleaseType(value: string | undefined): LottieReleaseType {
    if (value === "auto" || value === "patch" || value === "minor" || value === "major") {
        return value;
    }
    throw new Error(`Unsupported release type '${value}'. Expected auto, patch, minor, or major.`);
}

export function parseExplicitLottieReleaseType(value: unknown): ResolvedLottieReleaseType {
    if (value === "patch" || value === "minor" || value === "major") {
        return value;
    }
    throw new Error(`Unsupported release config type '${String(value)}'. Expected patch, minor, or major.`);
}

export function parseLottieVersion(version: string): [number, number, number] {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) {
        throw new Error(`Unsupported semver version '${version}'. Expected x.y.z.`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
    for (let index = 0; index < 3; index++) {
        if (left[index] !== right[index]) {
            return left[index]! - right[index]!;
        }
    }
    return 0;
}

export function maxLottieVersion(left: string, right: string): string {
    if (!left) {
        return right;
    }
    if (!right) {
        return left;
    }
    return compareVersions(parseLottieVersion(left), parseLottieVersion(right)) >= 0 ? left : right;
}

export function bumpLottieVersion(version: string, releaseType: ResolvedLottieReleaseType): string {
    const [major, minor, patch] = parseLottieVersion(version);
    if (releaseType === "major") {
        return `${major + 1}.0.0`;
    }
    if (releaseType === "minor") {
        return `${major}.${minor + 1}.0`;
    }
    return `${major}.${minor}.${patch + 1}`;
}

export function detectLottieBreakingChanges(commitMessages: string): boolean {
    return /^BREAKING[ -]CHANGE:/m.test(commitMessages) || /^[a-z]+(?:\([^)]+\))?!:/m.test(commitMessages);
}

export function isNpmPackageNotFound(stderr: string): boolean {
    return /(?:^|\s)E404(?:\s|$)/m.test(stderr) || /404 Not Found\s+-\s+GET\s+/m.test(stderr);
}

export function resolveLottieReleasePlan(input: LottieReleasePlanInput): LottieReleasePlan {
    const sourceVersion = parseLottieVersion(input.sourceVersion);
    if (input.publishedVersion === null) {
        throw new Error("@babylonjs/lottie-player must already exist on npm before the Lite-backed takeover can be prepared.");
    }
    const publishedVersion = parseLottieVersion(input.publishedVersion);
    if (input.highestReleasedTagVersion) {
        parseLottieVersion(input.highestReleasedTagVersion);
    }
    if (!input.hasRelevantChanges) {
        throw new Error("No Lottie-owned commits exist since the previous release. Refusing to publish an unchanged package.");
    }
    if (publishedVersion[0] < sourceVersion[0] && input.requestedReleaseType !== "major") {
        throw new Error(`The takeover from ${input.publishedVersion} to ${input.sourceVersion} requires an explicit major release.`);
    }
    if (input.breakingChangesDetected && (input.requestedReleaseType === "patch" || input.requestedReleaseType === "minor")) {
        throw new Error(`Breaking Lottie changes require a major release; '${input.requestedReleaseType}' was requested.`);
    }

    const resolvedReleaseType = input.requestedReleaseType === "auto" ? (input.breakingChangesDetected ? "major" : "minor") : input.requestedReleaseType;
    const resolutionBaseVersion = maxLottieVersion(input.publishedVersion, input.highestReleasedTagVersion);
    const nextVersion = bumpLottieVersion(resolutionBaseVersion, resolvedReleaseType);
    if (compareVersions(parseLottieVersion(nextVersion), sourceVersion) < 0) {
        throw new Error(`Resolved version ${nextVersion} is below the source version floor ${input.sourceVersion}.`);
    }
    return { resolutionBaseVersion, resolvedReleaseType, nextVersion };
}
