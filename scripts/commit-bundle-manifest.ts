/**
 * Refresh the tracked per-scene bundle-size manifest on **master**.
 *
 * ## Why
 *
 * `lab/public/bundle/manifest/<scene>.json` records each scene's runtime-fetched
 * bundle size. Nearly every shared-module change moves bytes in most of the ~230
 * scenes, so requiring the *author* to commit the regenerated files made CI
 * structurally unstable in two separate ways:
 *
 *   1. **Red CI** — as soon as any shared-code PR merged, every other open PR's
 *      committed manifest was stale and its Bundle Size job went red through no
 *      fault of its own.
 *   2. **Merge conflicts** — two branches that both regenerated the manifest
 *      rewrote the same ~200 tracked files, so they collided in git. This was the
 *      dominant source of conflicts in the repo: of the 169 conflicting paths in
 *      one representative PR, 168 were manifest files and **zero** were source.
 *
 * The fix for both is the same: give the file exactly one writer. Two properties
 * of the tooling make master the right one —
 *
 *   - the size **gate** reads `scene-config.json` (`maxRawKB`), not this manifest;
 *   - the master **baseline** is reconstructed straight from `origin/master` by
 *     `readMasterBundleManifestFromRef()` in `bundle-scenes-core.ts`, never from
 *     the working tree.
 *
 * So the manifest only ever has to be correct *on master*. On a PR branch it
 * gates nothing and feeds nothing — it only creates conflicts. This script
 * therefore runs solely on master builds, and PR builds never write it at all,
 * which keeps manifest files out of PR diffs entirely.
 *
 * Size *regressions* are still gated, by the per-scene `maxRawKB` ceilings that
 * `pnpm build:bundle-scenes` enforces byte-exactly. This script never touches
 * those ceilings.
 *
 * ## How
 *
 * The build's own checkout is a detached HEAD at the commit that triggered it,
 * and master can move during the ~40 minutes the measurement takes. So rather
 * than committing in place, we fetch the current tip of master, add a detached
 * worktree there, mirror the freshly measured manifest directory into it, and
 * commit only that — leaving the build's working tree untouched. If the push is
 * rejected because master moved again in the meantime, we re-fetch onto the new
 * tip and retry.
 *
 * Loop safety: the pipeline that runs this script excludes the manifest
 * directory from its path trigger, so the bot's own commit cannot re-trigger it
 * (the demos and playground pipelines exclude it too, so the bot commit does not
 * pay for their deploys either). `MAX_CONSECUTIVE_AUTOCOMMITS` is a second,
 * independent guard: each bot commit records the source revision it measured in a
 * `Measured-from:` trailer, and we stop only when that same revision has already
 * produced that many refreshes — i.e. when identical input keeps producing
 * different sizes.
 *
 * Every failure path is a warning: this step must never be the reason a build is red.
 *
 * ## Environment
 *
 *   GITHUB_TOKEN                    PAT with `contents:write` on the repo. Required to push.
 *   GITHUB_REPOSITORY               "owner/repo"; falls back to BUILD_REPOSITORY_NAME.
 *   SYSTEM_PULLREQUEST_SOURCEBRANCH set on PR builds, which must never write the manifest.
 *   BUILD_SOURCEVERSION             source revision measured; falls back to `git rev-parse HEAD`.
 *   BUNDLE_MANIFEST_BRANCH          branch to refresh; defaults to "master".
 *   AUTO_COMMIT_BUNDLE_MANIFEST     set to "false" to disable the push entirely.
 *   DRY_RUN                         "true" to do everything except the push.
 *   GIT_USER_NAME / GIT_USER_EMAIL  bot identity; defaults match the other CI bots.
 *   BUNDLE_MANIFEST_ROOT            repo root override (used by the unit tests).
 *   BUNDLE_MANIFEST_REMOTE_URL      push URL override, bypassing GITHUB_TOKEN/REPOSITORY
 *                                   (used by the unit tests).
 *
 * Usage: npx tsx scripts/commit-bundle-manifest.ts
 */
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

const ROOT = process.env.BUNDLE_MANIFEST_ROOT ? resolve(process.env.BUNDLE_MANIFEST_ROOT) : resolve(__dirname, "..");
const MANIFEST_DIR_REL_PATH = "lab/public/bundle/manifest";

const GIT_USER_NAME = process.env.GIT_USER_NAME ?? "Babylon.js CI";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL ?? "bjsplat@gmail.com";

const COMMIT_SUBJECT = "chore(bundle): refresh per-scene bundle-size manifest";

/**
 * Trailer recording which source revision a bot commit measured. This is what
 * makes the loop guard below precise.
 */
const MEASURED_FROM_TRAILER = "Measured-from";

/**
 * Stop pushing once this many leading bot commits measured the *same* source
 * revision we just measured: the same input produced a different manifest, which
 * means the measurement is not deterministic and pushing again would ping-pong.
 *
 * Keying on the revision matters. Master builds take up to two hours and overlap,
 * so consecutive bot commits from *different* revisions are entirely normal — a
 * plain "N bot commits in a row" guard would refuse to record a perfectly good
 * measurement and blame a non-existent non-determinism.
 */
const MAX_CONSECUTIVE_AUTOCOMMITS = 2;

/**
 * Fetch deep enough to see past a run of bot commits from concurrent builds, so
 * the guard can tell that they measured other revisions.
 */
const FETCH_DEPTH = 10;

/** Branch that owns the manifest. The single writer — see the file header. */
const DEFAULT_BRANCH = "master";

/**
 * How many times to re-apply onto a moved tip before giving up. Master can take
 * new commits during the ~40 minutes the measurement runs, which rejects our
 * push; re-fetching and replaying the mirror onto the new tip is cheap and
 * almost always succeeds on the first retry.
 */
const MAX_PUSH_ATTEMPTS = 3;

/**
 * Refuse to mirror a manifest directory that lost more than this fraction of its
 * files. `build:bundle-scenes` seeds from the existing per-scene files and only
 * prunes on a full build, so the working tree normally holds every scene; a much
 * smaller set means the build crashed or was written only part-way, and mirroring
 * would delete live entries. The bar is deliberately low so a PR that legitimately
 * deletes a handful of scenes still refreshes normally.
 */
const MIN_MIRROR_COVERAGE = 0.5;

/** Azure truncates long warning annotations anyway; keep them readable. */
const MAX_LOG_MESSAGE_LENGTH = 800;

function git(args: string[], options: { cwd?: string; allowFailure?: boolean } = {}): string {
    try {
        return execFileSync("git", args, { cwd: options.cwd ?? ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
        if (options.allowFailure) {
            return "";
        }
        throw new Error(redact(error instanceof Error ? error.message : String(error)));
    }
}

/** Keep the push token out of logs — git echoes the remote URL on failure. */
function redact(text: string): string {
    const token = process.env.GITHUB_TOKEN;
    return token && token.length >= 4 ? text.split(token).join("***") : text;
}

/** Azure treats `##vso[...]` at the start of any output line as a command, so untrusted text must never produce one. */
function defuseLogCommands(text: string): string {
    return text.replace(/##vso\[/gi, "##vso(");
}

/**
 * Azure parses logging commands line by line, so a message carrying newlines —
 * git stderr routinely does — would truncate the warning and leave the trailing
 * lines to be interpreted on their own. Flatten to a single bounded line.
 */
export function sanitizeLogMessage(message: string): string {
    return defuseLogCommands(message)
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, MAX_LOG_MESSAGE_LENGTH);
}

function warn(message: string): void {
    // Keep the multi-line detail on the console stream; it is what makes a failed push debuggable.
    console.warn(`⚠ ${defuseLogCommands(message)}`);
    console.log(`##vso[task.logissue type=warning]${sanitizeLogMessage(message)}`);
}

/** Strip a `refs/heads/` prefix from a branch ref. */
export function shortBranchName(ref: string): string {
    return ref.replace(/^refs\/heads\//, "");
}

/** One commit's identity as far as the loop guard is concerned. */
export interface CommitSummary {
    subject: string;
    /** Source revision this bot commit measured, or null for a non-bot commit. */
    measuredFrom: string | null;
}

const LOG_FIELD_SEP = "\u001f";
const LOG_RECORD_SEP = "\u001e";
/** `%s` then `%b`, one record per commit — the shape `parseCommitLog` expects. */
export const COMMIT_LOG_FORMAT = `%s${LOG_FIELD_SEP}%b${LOG_RECORD_SEP}`;

export function parseCommitLog(raw: string): CommitSummary[] {
    return raw
        .split(LOG_RECORD_SEP)
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
            const [subject = "", body = ""] = record.split(LOG_FIELD_SEP);
            const trailer = new RegExp(`^${MEASURED_FROM_TRAILER}:\\s*([0-9a-f]{7,40})\\s*$`, "im").exec(body);
            return { subject: subject.trim(), measuredFrom: trailer?.[1] ?? null };
        });
}

/**
 * How many of the leading commits are bot refreshes that measured this same
 * source revision — the only situation that actually indicates a non-converging
 * measurement.
 *
 * Bot commits from *other* revisions are skipped rather than counted: concurrent
 * master builds routinely stack them, and they say nothing about whether our own
 * measurement is stable.
 */
export function countLeadingAutocommits(commits: readonly CommitSummary[], sourceRevision: string): number {
    let count = 0;
    for (const commit of commits) {
        if (!commit.subject.startsWith(COMMIT_SUBJECT)) break;
        if (commit.measuredFrom && commit.measuredFrom === sourceRevision) count++;
    }
    return count;
}

/** The source revision this build measured. */
function currentSourceRevision(): string {
    return process.env.BUILD_SOURCEVERSION || git(["rev-parse", "HEAD"], { allowFailure: true }) || "unknown";
}

function listJsonFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort();
}

/**
 * Make `destDir` an exact copy of `sourceDir`. Returns false when the source is
 * missing too many files to be a full build, in which case nothing is written.
 */
function mirrorManifestDir(sourceDir: string, destDir: string): boolean {
    const sourceFiles = listJsonFiles(sourceDir);
    const destFiles = listJsonFiles(destDir);

    if (sourceFiles.length === 0) {
        warn(`No per-scene manifest files found in ${sourceDir}; skipping manifest refresh.`);
        return false;
    }
    if (destFiles.length > 0 && sourceFiles.length < destFiles.length * MIN_MIRROR_COVERAGE) {
        warn(`Freshly built manifest has ${sourceFiles.length} scenes vs ${destFiles.length} on the branch — looks like an incomplete build; skipping manifest refresh.`);
        return false;
    }

    mkdirSync(destDir, { recursive: true });
    const sourceSet = new Set(sourceFiles);
    for (const file of destFiles) {
        if (!sourceSet.has(file)) rmSync(resolve(destDir, file), { force: true });
    }
    for (const file of sourceFiles) {
        copyFileSync(resolve(sourceDir, file), resolve(destDir, file));
    }
    return true;
}

interface PushTarget {
    remoteUrl: string;
    branch: string;
}

/** Resolve the branch to push to, or null with an explanation when we cannot. */
function resolvePushTarget(): PushTarget | null {
    if (process.env.AUTO_COMMIT_BUNDLE_MANIFEST === "false") {
        console.log("AUTO_COMMIT_BUNDLE_MANIFEST=false — skipping manifest refresh.");
        return null;
    }

    // A PR build must never write the manifest. Doing so is what created the
    // ~200-file conflicts between branches; master is the single writer.
    if (process.env.SYSTEM_PULLREQUEST_SOURCEBRANCH) {
        console.log("Pull-request build — the manifest is refreshed on master only, so PR diffs stay free of generated bundle data. Skipping.");
        return null;
    }

    const branch = shortBranchName(process.env.BUNDLE_MANIFEST_BRANCH ?? DEFAULT_BRANCH);
    const override = process.env.BUNDLE_MANIFEST_REMOTE_URL;
    if (override) {
        return { remoteUrl: override, branch };
    }

    const repo = process.env.GITHUB_REPOSITORY ?? process.env.BUILD_REPOSITORY_NAME;
    if (!repo) {
        warn("Neither GITHUB_REPOSITORY nor BUILD_REPOSITORY_NAME is set — skipping manifest refresh.");
        return null;
    }
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        warn("GITHUB_TOKEN is not available — skipping manifest refresh.");
        return null;
    }

    return { remoteUrl: `https://x-access-token:${token}@github.com/${repo}.git`, branch };
}

/**
 * One fetch → mirror → commit → push cycle against the current tip of the target
 * branch. Returns "retry" when the push was rejected because the branch moved.
 */
function attemptRefresh(target: PushTarget, attempt: number, sourceRevision: string): "done" | "retry" {
    const { remoteUrl } = target;
    const worktreeDir = mkdtempSync(resolve(tmpdir(), "bundle-manifest-"));
    let worktreeAdded = false;

    try {
        // Commit onto the branch tip rather than the build's own checkout: that
        // checkout is a detached HEAD at the triggering commit, and master may
        // have moved during the measurement.
        git(["fetch", "--no-tags", `--depth=${FETCH_DEPTH}`, remoteUrl, `refs/heads/${target.branch}`]);
        const headSha = git(["rev-parse", "FETCH_HEAD"]);

        const commits = parseCommitLog(git(["log", `--format=${COMMIT_LOG_FORMAT}`, `-${FETCH_DEPTH}`, headSha], { allowFailure: true }));
        if (countLeadingAutocommits(commits, sourceRevision) >= MAX_CONSECUTIVE_AUTOCOMMITS) {
            warn(
                `${target.branch} already carries ${MAX_CONSECUTIVE_AUTOCOMMITS} bundle-manifest refreshes measured from ${sourceRevision}, ` +
                    `yet this build measured something different again. Not pushing — the same source is producing different sizes, ` +
                    `which points at a non-deterministic scene measurement rather than a stale manifest.`
            );
            return "done";
        }

        git(["worktree", "add", "--detach", worktreeDir, headSha]);
        worktreeAdded = true;

        if (!mirrorManifestDir(resolve(ROOT, MANIFEST_DIR_REL_PATH), resolve(worktreeDir, MANIFEST_DIR_REL_PATH))) {
            return "done";
        }

        git(["add", "--", MANIFEST_DIR_REL_PATH], { cwd: worktreeDir });
        const staged = git(["diff", "--cached", "--name-only", "--", MANIFEST_DIR_REL_PATH], { cwd: worktreeDir });
        if (!staged) {
            console.log(`Bundle-size manifest on ${target.branch} already matches this build — nothing to push.`);
            return "done";
        }

        const changed = staged.split("\n").filter(Boolean);
        console.log(`Refreshing ${changed.length} per-scene manifest file(s) on ${target.branch}.`);

        git(["config", "user.name", GIT_USER_NAME], { cwd: worktreeDir });
        git(["config", "user.email", GIT_USER_EMAIL], { cwd: worktreeDir });
        git(
            [
                "commit",
                "--no-verify",
                "-m",
                COMMIT_SUBJECT,
                "-m",
                `Measured by CI build ${process.env.BUILD_BUILDNUMBER ?? "(local)"}. Per-scene bundle sizes are a generated\n` +
                    `baseline owned by master, so PR branches never carry them and never conflict on them.\n\n` +
                    `${MEASURED_FROM_TRAILER}: ${sourceRevision}`,
            ],
            { cwd: worktreeDir }
        );

        if (process.env.DRY_RUN === "true") {
            console.log(`[dry-run] Would push the manifest refresh to ${target.branch}.`);
            return "done";
        }

        // Never --force: master is a shared branch, and a rejection means real
        // commits landed under us that we must not discard.
        try {
            git(["push", remoteUrl, `HEAD:refs/heads/${target.branch}`], { cwd: worktreeDir });
        } catch (error) {
            if (attempt < MAX_PUSH_ATTEMPTS) {
                console.log(`${target.branch} moved while this build was measuring; re-applying onto the new tip (attempt ${attempt + 1}/${MAX_PUSH_ATTEMPTS}).`);
                return "retry";
            }
            warn(
                `Could not push the refreshed bundle-size manifest to ${target.branch} after ${MAX_PUSH_ATTEMPTS} attempts: ${redact(error instanceof Error ? error.message : String(error))}`
            );
            return "done";
        }
        console.log(`✓ Pushed refreshed bundle-size manifest to ${target.branch}.`);
        return "done";
    } finally {
        if (worktreeAdded) git(["worktree", "remove", "--force", worktreeDir], { allowFailure: true });
        rmSync(worktreeDir, { recursive: true, force: true });
    }
}

function run(): void {
    const target = resolvePushTarget();
    if (!target) return;

    try {
        const sourceRevision = currentSourceRevision();
        for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
            if (attemptRefresh(target, attempt, sourceRevision) === "done") return;
        }
    } catch (error) {
        warn(`Bundle-size manifest refresh failed: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
}

if (require.main === module) {
    run();
}
