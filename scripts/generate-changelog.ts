/// <reference types="node" />

/**
 * Generates a Markdown changelog for an @babylonjs/lite release by scanning the
 * Conventional-Commit history between the previous published release tag and
 * HEAD. The output is suitable for use as GitHub release notes and is also
 * appended to a repository CHANGELOG.md when one is maintained.
 *
 * The commit-range resolution mirrors scripts/prepare-npm-release.ts so the
 * changelog always covers exactly the commits that the resolved version ships.
 *
 * Inputs (all via env):
 *   PACKAGE_VERSION        Version being released (e.g. "1.4.0"). Required for a
 *                          titled release section; falls back to "Unreleased".
 *   PACKAGE_NAME           Published package name. Default "@babylonjs/lite".
 *   PREVIOUS_RELEASE_TAG   Override the auto-detected previous release tag.
 *   RELEASE_TAG_PATTERN    Glob for release tags. Default "npm-lite-v*".
 *   CHANGELOG_OUTPUT       File to write the release-notes Markdown to. When set
 *                          the notes are written there (for the GitHub release).
 *   BUILD_REPOSITORY_URI / GITHUB_REPOSITORY
 *                          Used to build commit/PR links when available.
 *
 * Always prints the generated release-notes Markdown to stdout.
 */

import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { resolve } from "path";

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "@babylonjs/lite";
const RELEASE_TAG_PATTERN = process.env.RELEASE_TAG_PATTERN ?? "npm-lite-v*";
const NEXT_VERSION = (process.env.PACKAGE_VERSION ?? "").trim();
const CHANGELOG_OUTPUT = process.env.CHANGELOG_OUTPUT?.trim();

type ParsedCommit = {
    hash: string;
    shortHash: string;
    type: string | undefined;
    scope: string | undefined;
    breaking: boolean;
    subject: string;
    prNumber: string | undefined;
};

type Section = {
    title: string;
    types: string[];
};

// Order matters: the first matching section wins. Types not listed here land in
// the catch-all "Other Changes" section.
const SECTIONS: Section[] = [
    { title: "✨ Features", types: ["feat"] },
    { title: "🐛 Bug Fixes", types: ["fix"] },
    { title: "⚡ Performance", types: ["perf"] },
    { title: "♻️ Refactors", types: ["refactor"] },
    { title: "📝 Documentation", types: ["docs"] },
    { title: "🧪 Tests", types: ["test"] },
    { title: "🏗️ Build & CI", types: ["build", "ci", "chore"] },
];
const OTHER_SECTION_TITLE = "🔧 Other Changes";

const CONVENTIONAL_HEADER = /^([a-z][a-z0-9-]*)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:\s*(.+)$/im;
const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;

function run(command: string, args: string[], allowFailure = false): string {
    try {
        return execFileSync(command, args, {
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

function getPreviousReleaseTag(): string {
    const override = process.env.PREVIOUS_RELEASE_TAG?.trim();
    if (override) {
        return override;
    }
    return run("git", ["describe", "--tags", "--abbrev=0", "--match", RELEASE_TAG_PATTERN], true);
}

function getRepoSlug(): string | undefined {
    const direct = process.env.GITHUB_REPOSITORY?.trim();
    if (direct && direct.includes("/")) {
        return direct;
    }
    const uri = (process.env.BUILD_REPOSITORY_URI ?? process.env.BUILD_REPOSITORY_NAME ?? "").trim();
    const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(uri);
    if (match) {
        return match[1];
    }
    if (uri.includes("/") && !uri.includes(" ")) {
        return uri.replace(/\.git$/, "");
    }
    return undefined;
}

function readCommits(previousTag: string): ParsedCommit[] {
    const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
    // Records are separated by a record-separator (0x1e) and fields within a
    // record by a unit-separator (0x1f). We emit these via git's %x1e/%x1f
    // format escapes so the control bytes appear only in git's output, never in
    // the argv we pass to execFileSync (which rejects NUL and is happier without
    // raw control bytes). Commit bodies keep their internal newlines intact.
    const SEP = "\u001f";
    const REC = "\u001e";
    const raw = run("git", ["log", "--format=%H%x1f%s%x1f%b%x1e", range], true);
    if (!raw) {
        return [];
    }

    const commits: ParsedCommit[] = [];
    for (const record of raw.split(REC)) {
        const trimmed = record.replace(/^\s+/, "");
        if (!trimmed) {
            continue;
        }
        const [hash, subjectRaw = "", body = ""] = trimmed.split(SEP);
        if (!hash) {
            continue;
        }
        commits.push(parseCommit(hash, subjectRaw, body));
    }
    return commits;
}

function parseCommit(hash: string, subjectRaw: string, body: string): ParsedCommit {
    let subject = subjectRaw.trim();
    let prNumber: string | undefined;
    const prMatch = PR_SUFFIX.exec(subject);
    if (prMatch) {
        prNumber = prMatch[1];
        subject = subject.replace(PR_SUFFIX, "").trim();
    }

    const header = CONVENTIONAL_HEADER.exec(subject);
    const breaking = Boolean(header?.[3]) || BREAKING_FOOTER.test(body);

    if (!header) {
        return { hash, shortHash: hash.slice(0, 7), type: undefined, scope: undefined, breaking, subject, prNumber };
    }

    return {
        hash,
        shortHash: hash.slice(0, 7),
        type: header[1],
        scope: header[2],
        breaking,
        subject: header[4].trim(),
        prNumber,
    };
}

function shouldSkip(commit: ParsedCommit): boolean {
    // Drop release-tag bump commits and merge commits, which add noise.
    if (/^Merge (pull request|branch|remote-tracking)/i.test(commit.subject)) {
        return true;
    }
    if (commit.type === undefined && /^v?\d+\.\d+\.\d+/.test(commit.subject)) {
        return true;
    }
    return false;
}

function formatEntry(commit: ParsedCommit, repoSlug: string | undefined): string {
    const scope = commit.scope ? `**${commit.scope}:** ` : "";
    let line = `- ${scope}${commit.subject}`;
    if (commit.prNumber) {
        line += repoSlug ? ` ([#${commit.prNumber}](https://github.com/${repoSlug}/pull/${commit.prNumber}))` : ` (#${commit.prNumber})`;
    } else if (repoSlug) {
        line += ` ([${commit.shortHash}](https://github.com/${repoSlug}/commit/${commit.hash}))`;
    } else {
        line += ` (${commit.shortHash})`;
    }
    return line;
}

function buildChangelog(commits: ParsedCommit[], previousTag: string, repoSlug: string | undefined): string {
    const heading = NEXT_VERSION ? `## ${PACKAGE_NAME} v${NEXT_VERSION}` : `## ${PACKAGE_NAME} (Unreleased)`;
    const lines: string[] = [heading, ""];

    const relevant = commits.filter((commit) => !shouldSkip(commit));

    if (relevant.length === 0) {
        lines.push(previousTag ? `_No notable changes since ${previousTag}._` : "_No notable changes._");
        return lines.join("\n").trimEnd() + "\n";
    }

    const breaking = relevant.filter((commit) => commit.breaking);
    if (breaking.length > 0) {
        lines.push("### ⚠️ BREAKING CHANGES", "");
        for (const commit of breaking) {
            lines.push(formatEntry(commit, repoSlug));
        }
        lines.push("");
    }

    const used = new Set<string>();
    for (const section of SECTIONS) {
        const entries = relevant.filter((commit) => commit.type !== undefined && section.types.includes(commit.type));
        if (entries.length === 0) {
            continue;
        }
        lines.push(`### ${section.title}`, "");
        for (const commit of entries) {
            used.add(commit.hash);
            lines.push(formatEntry(commit, repoSlug));
        }
        lines.push("");
    }

    const other = relevant.filter((commit) => !used.has(commit.hash) && !commit.breaking);
    if (other.length > 0) {
        lines.push(`### ${OTHER_SECTION_TITLE}`, "");
        for (const commit of other) {
            lines.push(formatEntry(commit, repoSlug));
        }
        lines.push("");
    }

    if (repoSlug && previousTag && NEXT_VERSION) {
        const newTag = RELEASE_TAG_PATTERN.replace(/\*$/, "") + NEXT_VERSION;
        lines.push(`**Full Changelog**: https://github.com/${repoSlug}/compare/${previousTag}...${newTag}`);
    }

    return lines.join("\n").trimEnd() + "\n";
}

function main(): void {
    const previousTag = getPreviousReleaseTag();
    const repoSlug = getRepoSlug();
    const commits = readCommits(previousTag);
    const changelog = buildChangelog(commits, previousTag, repoSlug);

    if (CHANGELOG_OUTPUT) {
        const outPath = resolve(process.cwd(), CHANGELOG_OUTPUT);
        writeFileSync(outPath, changelog, "utf-8");
        console.error(`Wrote release notes to ${outPath}`);
    }

    process.stdout.write(changelog);
}

main();
