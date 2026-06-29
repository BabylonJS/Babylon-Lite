/// <reference types="node" />

/**
 * Generates Markdown changelog content for an @babylonjs/lite release from the
 * Conventional-Commit history, with no committed CHANGELOG file required — git
 * release tags (npm-lite-v*) are the source of truth, so the whole changelog is
 * regenerated deterministically on every release.
 *
 * Two artefacts are produced:
 *   - Release notes: the single section for the version being released
 *     (previous tag..HEAD). Written to RELEASE_NOTES_OUTPUT if set; always
 *     printed to stdout. Used as the GitHub release body.
 *   - Full cumulative changelog: the pending version plus one section per prior
 *     npm-lite-v* tag, newest first. Written to CHANGELOG_OUTPUT if set. Shipped
 *     in the npm tarball (build/CHANGELOG.md) so consumers get the whole history.
 *
 * The pending range mirrors scripts/prepare-npm-release.ts so the top section
 * always covers exactly the commits the resolved version ships.
 *
 * Inputs (all via env):
 *   PACKAGE_VERSION        Version being released (e.g. "1.4.0"). Required for a
 *                          titled release section; falls back to "Unreleased".
 *   PACKAGE_NAME           Published package name. Default "@babylonjs/lite".
 *   PREVIOUS_RELEASE_TAG   Override the auto-detected previous release tag.
 *   RELEASE_TAG_PATTERN    Glob for release tags. Default "npm-lite-v*".
 *   RELEASE_NOTES_OUTPUT   File to write the latest-version notes to.
 *   CHANGELOG_OUTPUT       File to write the full cumulative changelog to.
 *   BUILD_REPOSITORY_URI / GITHUB_REPOSITORY
 *                          Used to build commit/PR links when available.
 */

import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { resolve } from "path";

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "@babylonjs/lite";
const RELEASE_TAG_PATTERN = process.env.RELEASE_TAG_PATTERN ?? "npm-lite-v*";
const RELEASE_TAG_PREFIX = RELEASE_TAG_PATTERN.replace(/\*$/, "");
const NEXT_VERSION = (process.env.PACKAGE_VERSION ?? "").trim();
const CHANGELOG_OUTPUT = process.env.CHANGELOG_OUTPUT?.trim();
const RELEASE_NOTES_OUTPUT = process.env.RELEASE_NOTES_OUTPUT?.trim();

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

function parseSemver(version: string): [number, number, number] | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

// All release tags, newest version first. Each entry pairs the tag with the
// version it represents so the cumulative changelog can render one section per
// tag and link compare ranges. Tags whose version is not strict semver are
// dropped (they cannot be ordered reliably).
function getReleaseTagsDescending(): { tag: string; version: string }[] {
    const raw = run("git", ["tag", "--list", RELEASE_TAG_PATTERN], true);
    if (!raw) {
        return [];
    }
    return raw
        .split("\n")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .map((tag) => ({ tag, version: tag.slice(RELEASE_TAG_PREFIX.length) }))
        .filter((entry): entry is { tag: string; version: string } => parseSemver(entry.version) !== undefined)
        .sort((a, b) => {
            const av = parseSemver(a.version) as [number, number, number];
            const bv = parseSemver(b.version) as [number, number, number];
            return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
        });
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

function readCommits(fromRef: string, toRef: string): ParsedCommit[] {
    const range = fromRef ? `${fromRef}..${toRef}` : toRef;
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
        subject: (header[4] ?? subject).trim(),
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

// Renders one version's section. `version` may be a real semver or "Unreleased".
// `fromTag`/`toRef` define the commit range; `compareTag` is the tag for the
// version being rendered (used for the compare link), or "HEAD" for a pending
// release whose tag does not exist yet.
function buildSection(version: string, fromTag: string, toRef: string, compareTag: string, repoSlug: string | undefined): string {
    const heading = version === "Unreleased" ? `## ${PACKAGE_NAME} (Unreleased)` : `## ${PACKAGE_NAME} v${version}`;
    const lines: string[] = [heading, ""];

    const commits = readCommits(fromTag, toRef);
    const relevant = commits.filter((commit) => !shouldSkip(commit));

    if (relevant.length === 0) {
        lines.push(fromTag ? `_No notable changes since ${fromTag}._` : "_No notable changes._", "");
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
    const breakingHashes = new Set(breaking.map((commit) => commit.hash));
    for (const section of SECTIONS) {
        const entries = relevant.filter((commit) => commit.type !== undefined && section.types.includes(commit.type) && !breakingHashes.has(commit.hash));
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

    if (repoSlug && fromTag) {
        lines.push(`**Full Changelog**: https://github.com/${repoSlug}/compare/${fromTag}...${compareTag}`, "");
    }

    return lines.join("\n").trimEnd() + "\n";
}

function main(): void {
    const repoSlug = getRepoSlug();
    const tags = getReleaseTagsDescending();
    const previousTag = getPreviousReleaseTag() || (tags[0]?.tag ?? "");

    // Top section: the version being released (or "Unreleased" when no version
    // is provided), covering the previous tag..HEAD range.
    const version = NEXT_VERSION || "Unreleased";
    const pendingTag = NEXT_VERSION ? `${RELEASE_TAG_PREFIX}${NEXT_VERSION}` : "HEAD";
    const releaseNotes = buildSection(version, previousTag, "HEAD", pendingTag, repoSlug);

    // Full cumulative changelog: pending section, then one section per existing
    // tag, newest first. Git tags are immutable, so this is fully regenerable.
    const sections = [releaseNotes];
    for (let i = 0; i < tags.length; i++) {
        const { tag, version: tagVersion } = tags[i] as { tag: string; version: string };
        const prevTag = tags[i + 1]?.tag ?? "";
        sections.push(buildSection(tagVersion, prevTag, tag, tag, repoSlug));
    }
    const fullChangelog = `# Changelog\n\n${sections.join("\n").trimEnd()}\n`;

    if (RELEASE_NOTES_OUTPUT) {
        const outPath = resolve(process.cwd(), RELEASE_NOTES_OUTPUT);
        writeFileSync(outPath, releaseNotes, "utf-8");
        console.error(`Wrote release notes to ${outPath}`);
    }
    if (CHANGELOG_OUTPUT) {
        const outPath = resolve(process.cwd(), CHANGELOG_OUTPUT);
        writeFileSync(outPath, fullChangelog, "utf-8");
        console.error(`Wrote full changelog to ${outPath}`);
    }

    process.stdout.write(releaseNotes);
}

main();
