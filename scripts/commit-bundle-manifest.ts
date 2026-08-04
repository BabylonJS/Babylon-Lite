/**
 * Refresh the tracked per-scene bundle-size manifest on the PR branch.
 *
 * ## Why
 *
 * `lab/public/bundle/manifest/<scene>.json` records each scene's runtime-fetched
 * bundle size. Nearly every shared-module change moves bytes in most of the ~230
 * scenes, so requiring the *author* to commit the regenerated files made CI
 * structurally unstable: as soon as any shared-code PR merged, every other open
 * PR's manifest was stale and its Bundle Size job went red through no fault of
 * its own — curable only by a rebase plus a very slow full local rebuild, then
 * repeated on the next merge to master.
 *
 * CI already measures the sizes, so CI owns the baseline. After
 * `pnpm build:bundle-scenes` has rewritten the working-tree manifest with fresh
 * measurements, this script pushes those files to the PR's source branch as a
 * bot commit. Reviewers still see the size deltas in the PR diff; nobody has to
 * regenerate anything by hand.
 *
 * Size *regressions* are still gated, by the per-scene `maxRawKB` ceilings that
 * `pnpm build:bundle-scenes` enforces byte-exactly. This script never touches
 * those ceilings.
 *
 * ## How
 *
 * An Azure DevOps PR build checks out the **merge commit** of the PR head into the
 * target branch. Committing there and pushing to the source branch would silently
 * merge master into the contributor's branch, so instead we add a detached
 * worktree at the source branch tip, mirror the freshly measured manifest
 * directory into it, and commit only that. The main working tree — which later
 * pipeline steps still build from — is left untouched.
 *
 * Every failure path is a warning: this step must never be the reason a PR is red.
 *
 * ## Environment
 *
 *   GITHUB_TOKEN                    PAT with `contents:write` on the repo. Required to push.
 *   GITHUB_REPOSITORY               "owner/repo"; falls back to BUILD_REPOSITORY_NAME.
 *   SYSTEM_PULLREQUEST_SOURCEBRANCH PR source branch ref. Absent outside PR builds.
 *   SYSTEM_PULLREQUEST_ISFORK       "True" for fork PRs, which we cannot push to.
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

/**
 * Subject line of the bot commit. Also used as the loop guard: a run that finds
 * drift on top of this many consecutive bot commits stops pushing instead of
 * ping-ponging, because that means the measurement is not converging.
 */
const COMMIT_SUBJECT = "chore(bundle): refresh per-scene bundle-size manifest";
const MAX_CONSECUTIVE_AUTOCOMMITS = 2;

/** Fetch deep enough that the loop guard can actually see the recent history. */
const FETCH_DEPTH = MAX_CONSECUTIVE_AUTOCOMMITS + 1;

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

/**
 * How many commits at the tip of `log` (newest first) were produced by this
 * script. Used as the loop guard against a non-converging measurement.
 */
export function countLeadingAutocommits(subjects: readonly string[]): number {
    let count = 0;
    for (const subject of subjects) {
        if (!subject.startsWith(COMMIT_SUBJECT)) break;
        count++;
    }
    return count;
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

/** Resolve the PR branch to push to, or null with an explanation when we cannot. */
function resolvePushTarget(): PushTarget | null {
    if (process.env.AUTO_COMMIT_BUNDLE_MANIFEST === "false") {
        console.log("AUTO_COMMIT_BUNDLE_MANIFEST=false — skipping manifest refresh.");
        return null;
    }

    const sourceBranch = process.env.SYSTEM_PULLREQUEST_SOURCEBRANCH;
    if (!sourceBranch) {
        console.log("Not a pull-request build (no SYSTEM_PULLREQUEST_SOURCEBRANCH) — skipping manifest refresh.");
        return null;
    }
    if (process.env.SYSTEM_PULLREQUEST_ISFORK === "True") {
        warn("Fork pull request — cannot push the refreshed bundle-size manifest. Run 'pnpm build:bundle-scenes' and commit lab/public/bundle/manifest/ yourself.");
        return null;
    }

    const branch = shortBranchName(sourceBranch);
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

function run(): void {
    const target = resolvePushTarget();
    if (!target) return;

    const { remoteUrl } = target;
    const worktreeDir = mkdtempSync(resolve(tmpdir(), "bundle-manifest-"));
    let worktreeAdded = false;

    try {
        // Fetch the PR head itself. The build's own checkout is the PR *merge*
        // commit, which must never be pushed onto the contributor's branch.
        git(["fetch", "--no-tags", `--depth=${FETCH_DEPTH}`, remoteUrl, `refs/heads/${target.branch}`]);
        const headSha = git(["rev-parse", "FETCH_HEAD"]);

        const subjects = git(["log", "--format=%s", `-${FETCH_DEPTH}`, headSha], { allowFailure: true })
            .split("\n")
            .filter(Boolean);
        if (countLeadingAutocommits(subjects) >= MAX_CONSECUTIVE_AUTOCOMMITS) {
            warn(
                `The last ${MAX_CONSECUTIVE_AUTOCOMMITS} commits on ${target.branch} are already bundle-manifest refreshes, ` +
                    `but the measurement still differs. Not pushing again — this suggests a non-deterministic scene measurement rather than a stale manifest.`
            );
            return;
        }

        git(["worktree", "add", "--detach", worktreeDir, headSha]);
        worktreeAdded = true;

        if (!mirrorManifestDir(resolve(ROOT, MANIFEST_DIR_REL_PATH), resolve(worktreeDir, MANIFEST_DIR_REL_PATH))) {
            return;
        }

        git(["add", "--", MANIFEST_DIR_REL_PATH], { cwd: worktreeDir });
        const staged = git(["diff", "--cached", "--name-only", "--", MANIFEST_DIR_REL_PATH], { cwd: worktreeDir });
        if (!staged) {
            console.log(`Bundle-size manifest on ${target.branch} already matches this build — nothing to push.`);
            return;
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
                `Measured by CI build ${process.env.BUILD_BUILDNUMBER ?? "(local)"}. Per-scene bundle sizes are a generated baseline;\nCI refreshes them so they never go stale when another PR merges first.`,
            ],
            { cwd: worktreeDir }
        );

        if (process.env.DRY_RUN === "true") {
            console.log(`[dry-run] Would push the manifest refresh to ${target.branch}.`);
            return;
        }

        // Not --force: a rejected push means the branch moved under us, and the
        // next build will simply measure again and push on top of the new tip.
        try {
            git(["push", remoteUrl, `HEAD:refs/heads/${target.branch}`], { cwd: worktreeDir });
        } catch (error) {
            warn(`Could not push the refreshed bundle-size manifest to ${target.branch} (it likely moved): ${redact(error instanceof Error ? error.message : String(error))}`);
            return;
        }
        console.log(`✓ Pushed refreshed bundle-size manifest to ${target.branch}.`);
    } catch (error) {
        warn(`Bundle-size manifest refresh failed: ${redact(error instanceof Error ? error.message : String(error))}`);
    } finally {
        if (worktreeAdded) git(["worktree", "remove", "--force", worktreeDir], { allowFailure: true });
        rmSync(worktreeDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    run();
}
