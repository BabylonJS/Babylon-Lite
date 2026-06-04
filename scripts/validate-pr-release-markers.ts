import { execFileSync } from "child_process";

type PullRequestInfo = {
    title: string;
    body: string;
    labels: string[];
};

type GitHubPullRequestResponse = {
    title?: unknown;
    body?: unknown;
    labels?: Array<{ name?: unknown }>;
};

const BREAKING_MARKER = /^(?:BREAKING[ -]CHANGE:|[a-z][a-z0-9-]*(?:\([^)]+\))?!:)/m;
const MALFORMED_BREAKING_CHANGE = /^\s*BREAKING[ -]CHANGE(?!:)/im;

function cleanAzureValue(value: string | undefined): string | undefined {
    if (!value || value.startsWith("$(")) {
        return undefined;
    }
    return value;
}

function runGit(args: string[], allowFailure = false): string {
    try {
        return execFileSync("git", args, {
            cwd: process.cwd(),
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (error) {
        if (allowFailure) {
            return "";
        }
        throw error;
    }
}

function normalizeLabel(label: string): string {
    return label.toLowerCase().replace(/[_-]+/g, " ").trim();
}

function isBreakingLabel(label: string): boolean {
    const normalized = normalizeLabel(label);
    return normalized === "breaking" || normalized === "breaking change" || normalized === "major" || normalized === "semver major";
}

function getPullRequestFromEnv(): PullRequestInfo | undefined {
    const title = cleanAzureValue(process.env.PR_TITLE);
    if (!title) {
        return undefined;
    }

    const body = cleanAzureValue(process.env.PR_BODY) ?? "";
    const labels = (cleanAzureValue(process.env.PR_LABELS) ?? "")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);

    return { title, body, labels };
}

async function getPullRequestFromGitHub(): Promise<PullRequestInfo | undefined> {
    const repository = cleanAzureValue(process.env.GITHUB_REPOSITORY) ?? cleanAzureValue(process.env.BUILD_REPOSITORY_NAME);
    const pullRequestNumber = cleanAzureValue(process.env.PR_NUMBER) ?? cleanAzureValue(process.env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER);
    const githubToken = cleanAzureValue(process.env.GITHUB_TOKEN);

    if (pullRequestNumber && !githubToken) {
        console.warn("GITHUB_TOKEN is not configured; skipping PR label enforcement and checking commit messages only.");
        return undefined;
    }

    if (pullRequestNumber && (!repository || !repository.includes("/"))) {
        fail("PR_NUMBER is set, but GITHUB_REPOSITORY is missing or is not in owner/repo form; refusing to skip breaking-label enforcement.");
    }

    if (!repository || !pullRequestNumber) {
        return undefined;
    }

    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "babylon-lite-release-marker-check",
    };
    headers.Authorization = `Bearer ${githubToken}`;

    const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`, { headers });
    if (!response.ok) {
        fail(`Could not read GitHub PR metadata (${response.status} ${response.statusText}); refusing to skip breaking-label enforcement.`);
    }

    const data = (await response.json()) as GitHubPullRequestResponse;
    const labels = Array.isArray(data.labels) ? data.labels.map((label) => (typeof label.name === "string" ? label.name : "")).filter(Boolean) : [];

    return {
        title: typeof data.title === "string" ? data.title : "",
        body: typeof data.body === "string" ? data.body : "",
        labels,
    };
}

function getCommitMessages(): string {
    const targetBranchRef = cleanAzureValue(process.env.SYSTEM_PULLREQUEST_TARGETBRANCH) ?? "refs/heads/master";
    const targetBranch = targetBranchRef.replace(/^refs\/heads\//, "");
    runGit(["fetch", "origin", `${targetBranch}:refs/remotes/origin/${targetBranch}`], true);

    const rangeMessages = runGit(["log", "--format=%B", `origin/${targetBranch}..HEAD`], true);
    if (rangeMessages) {
        return rangeMessages;
    }

    return runGit(["log", "--format=%B", "-20"], true);
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

async function main(): Promise<void> {
    const pullRequest = getPullRequestFromEnv() ?? (await getPullRequestFromGitHub());
    const pullRequestText = pullRequest ? `${pullRequest.title}\n\n${pullRequest.body}` : "";
    const commitMessages = getCommitMessages();
    const allText = `${pullRequestText}\n\n${commitMessages}`;

    if (MALFORMED_BREAKING_CHANGE.test(allText)) {
        fail("Found a malformed breaking-change footer. Use 'BREAKING CHANGE:' or 'BREAKING-CHANGE:' with a colon.");
    }

    const hasBreakingMarkerInPullRequest = BREAKING_MARKER.test(pullRequestText);
    const hasBreakingMarkerInCommits = BREAKING_MARKER.test(commitMessages);
    const hasBreakingLabel = pullRequest?.labels.some(isBreakingLabel) ?? false;

    if (hasBreakingLabel && !hasBreakingMarkerInPullRequest) {
        fail(
            "This PR is labeled as breaking/major, but its title/body does not contain a release marker that will survive squash merge. " +
                "Add 'type!:' to the PR title or a 'BREAKING CHANGE:' footer to the PR body."
        );
    }

    if (!hasBreakingMarkerInPullRequest && hasBreakingMarkerInCommits) {
        console.warn("Breaking marker found only in individual commit messages. If this PR is squash-merged, make sure the final squash title/body preserves the marker.");
    }

    if (hasBreakingMarkerInPullRequest || hasBreakingMarkerInCommits) {
        console.log("Breaking-change marker detected; weekly auto release will resolve to major if this marker lands on master.");
    } else {
        console.log("No breaking-change marker detected; weekly auto release will resolve to minor unless another merged commit is marked breaking.");
    }
}

void main();
