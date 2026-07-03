/**
 * Compat-layer sync — PR driver (Azure DevOps port of the gh-aw safe-output job).
 *
 * Runs AFTER an agent step has executed the `update-compat-layer` skill (which may
 * have edited files under `packages/babylon-lite-compat/`, plus `scene-config.json`
 * and lab oracle scenes when it lands a new scene). This script is the
 * deterministic, CI-owned half of the job:
 *
 *   1. Re-validate independently (compat unit tests + typecheck) — we never trust
 *      the agent's self-report; the pipeline verifies.
 *   2. Detect whether the agent actually changed anything.
 *   3. If it did, create a branch, commit, push, and open a DRAFT PR via the GitHub
 *      API. The PR is ALWAYS a draft (mirroring the gh-aw `create-pull-request:
 *      draft: true` safe output); the independent validation result is captured in
 *      the body so a reviewer sees whether the guardrails passed before merging.
 *
 * Idempotent: a run with no BJS/Lite changes produces no commit and no PR (the
 * gh-aw `noop` equivalent).
 *
 * Required env (authentication — provide EITHER a GitHub App OR a PAT):
 *   - GITHUB_REPOSITORY   e.g. "BabylonJS/Babylon-Lite"
 *   - GH_APP_ID +         a GitHub App's numeric id and PEM private key. When both
 *     GH_APP_PRIVATE_KEY  are set, the script mints a short-lived installation token
 *                         and the PR is authored by the app's bot identity
 *                         (`<app>[bot]`) — so a human (even the pipeline owner) can
 *                         review/approve it. The App must be installed on the repo
 *                         with `contents: write` + `pull requests: write` (and
 *                         `issues: write` for labels). This is the preferred path.
 *   - GITHUB_TOKEN        Fallback PAT with `contents:write` + `pull_requests:write`,
 *                         used only when GH_APP_ID/GH_APP_PRIVATE_KEY are absent.
 *                         PRs opened this way are authored by the PAT's owner, who
 *                         then cannot review their own PR.
 * Optional env:
 *   - BASE_BRANCH         default "master"
 *   - GIT_USER_NAME       default "Babylon.js CI"
 *   - GIT_USER_EMAIL      default "bjsplat@gmail.com"
 *   - ISSUE_NUMBER        when set, the run was triggered by an issue labeled
 *                         `compat`; referenced in the PR body so it auto-links
 *   - DRY_RUN             when "true", do everything except push + open PR
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { resolveGithubToken, makeRedactor, githubHeaders } from "./compat-sync-auth.js";

const REPO = requireEnv("GITHUB_REPOSITORY");
// The auth token used for `git push` + the GitHub REST API. Resolved at runtime
// (see resolveGithubToken): a GitHub App installation token when GH_APP_ID/
// GH_APP_PRIVATE_KEY are set — so PRs are authored by the app bot and remain
// reviewable — otherwise the GITHUB_TOKEN PAT.
let TOKEN = "";
// Redacts every resolved secret from log/error output. Replaced once the token is
// resolved; until then it is a no-op.
let redactToken: (text: string) => string = (text) => text;
const BASE_BRANCH = process.env.BASE_BRANCH ?? "master";
const GIT_USER_NAME = process.env.GIT_USER_NAME ?? "Babylon.js CI";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL ?? "bjsplat@gmail.com";
// Treat the ADO sentinel "none" (and "0"/empty) as "no triggering issue". ADO marks
// string parameters as required, so manual runs pass "none" rather than an empty string.
const ISSUE_NUMBER = normalizeIssueNumber(process.env.ISSUE_NUMBER);
const DRY_RUN = process.env.DRY_RUN === "true";

/** Labels applied to the opened PR (mirrors the gh-aw safe-output `labels`). */
const PR_LABELS = ["compat", "automation"];

// Scratch file the agent writes a one-line, run-specific PR title summary into
// (see the `update-compat-layer` skill). Consumed and deleted here BEFORE we
// stage anything, so it never lands in the commit. Absent/empty → generic title.
const PR_TITLE_FILE = ".compat-sync-pr-title.txt";

async function main(): Promise<void> {
    // 0a. Resolve the auth token (GitHub App installation token when configured,
    //     else the PAT). Done first so every downstream push/API call is attributed
    //     to the right identity. The PR driver pushes a branch and opens/labels a PR,
    //     so it needs write access.
    const resolved = await resolveGithubToken(REPO, "write");
    TOKEN = resolved.token;
    redactToken = makeRedactor(resolved.secrets);
    console.log(`Auth: ${resolved.source}.`);

    // 0b. Consume the agent's run-specific PR title summary (then delete the file
    //    so it isn't committed). Done before listing/staging changes.
    const titleSummary = readAndConsumePrTitle();

    // 1. Independent validation (does not throw — captured for the PR body).
    const validation = runValidation();

    // 2. Did the agent change anything at all? (compat wrappers, tests, the status
    //    file, and — when a scene is landed — scene-config.json + lab oracle files).
    const changedFiles = listChangedFiles();
    if (changedFiles.length === 0) {
        console.log("No changes this run. Nothing to do (noop).");
        return;
    }
    console.log(`Detected ${changedFiles.length} changed file(s):\n${changedFiles.map((f) => `  ${f}`).join("\n")}`);

    // 3. Branch, commit, push, draft PR.
    const date = new Date().toISOString().slice(0, 10);
    // Suffix the branch with the unique build id so two runs on the same calendar
    // day (e.g. a re-trigger, or two issues labeled `compat` in one day) don't
    // collide on `compat-sync/<date>`. ADO exposes the run id as BUILD_BUILDID;
    // fall back to a timestamp for local/manual invocations. Trim and use `||` so a
    // set-but-empty/whitespace BUILD_BUILDID (common in some shells / pipeline
    // templating) still falls back instead of collapsing to `compat-sync/<date>-`.
    const runId = process.env.BUILD_BUILDID?.trim() || String(Date.now());
    // Encode the run's ORIGIN in the branch so the preflight guard
    // (scripts/check-open-compat-sync-pr.ts) can tell a scheduled/manual PR from an
    // issue-triggered one without depending on labels existing. Issue runs →
    // `compat-sync/issue-<n>-...`; scheduled/manual runs → `compat-sync/scheduled-...`.
    // The guard keys off these exact `issue-`/`scheduled-` segments; keep them in sync.
    const originSegment = ISSUE_NUMBER ? `issue-${ISSUE_NUMBER}` : "scheduled";
    const branch = `compat-sync/${originSegment}-${date}-${runId}`;

    configureGit();
    runGit(["checkout", "-b", branch]);
    runGit(["add", "-A"]);
    runGit(["commit", "-m", commitMessage(date)]);

    if (DRY_RUN) {
        console.log(`[dry-run] Would push ${branch} to ${REPO} and open a draft PR.`);
        return;
    }

    // Push the branch directly to the TARGET repo (REPO) rather than the checkout's
    // `origin`. This decouples "where the pipeline runs" (e.g. a fork) from "where the
    // PR lands" (e.g. upstream BabylonJS/Babylon-Lite) — GITHUB_TOKEN just needs push
    // access to REPO. The PR is then a same-repo PR with head = branch.
    //
    // The branch is unique per run (date + build id), so there is nothing to clobber
    // on a first push. We use plain `--force` (not `--force-with-lease`) only so a
    // build *re-run* — which reuses the same build id and therefore the same branch —
    // can overwrite its own prior attempt. `--force-with-lease` cannot be used here:
    // we push to an ad-hoc authenticated URL with no remote-tracking ref, so the lease
    // has no recorded value to check against and git aborts with "stale info".
    const pushUrl = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
    runGit(["push", "--force", pushUrl, `HEAD:refs/heads/${branch}`]);
    const { url, number } = await openPullRequest(branch, validation, changedFiles, titleSummary);
    await applyLabels(number);
    console.log(`Opened draft PR: ${url}`);
}

interface ValidationResult {
    passed: boolean;
    log: string;
}

function runValidation(): ValidationResult {
    const steps: Array<{ name: string; cmd: string; args: string[] }> = [
        { name: "compat unit tests", cmd: "npx", args: ["vitest", "run", "--project", "compat"] },
        { name: "compat typecheck", cmd: "npx", args: ["tsc", "-p", "packages/babylon-lite-compat/tsconfig.json", "--noEmit"] },
    ];

    let passed = true;
    const log: string[] = [];
    for (const step of steps) {
        try {
            execFileSync(step.cmd, step.args, { cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
            log.push(`- ✅ ${step.name}`);
        } catch (error) {
            passed = false;
            const message = error instanceof Error ? error.message : String(error);
            log.push(`- ❌ ${step.name}\n\n\`\`\`\n${message.slice(0, 2000)}\n\`\`\``);
        }
    }
    return { passed, log: log.join("\n") };
}

function listChangedFiles(): string[] {
    const out = runGit(["status", "--porcelain"]);
    return out
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
}

function commitMessage(date: string): string {
    // Conventional-commit "chore" so the npm release pipeline never mistakes a
    // compat sync for a feature/breaking change in @babylonjs/lite.
    return `chore(compat): Babylon.js compat-layer sync (${date})`;
}

/**
 * Read the agent's run-specific PR title summary from PR_TITLE_FILE (a scratch
 * file written by the `update-compat-layer` skill), then delete the file so it
 * never gets staged into the commit. Returns the first non-empty line, collapsed
 * to a single line and length-capped. Returns undefined when the file is absent
 * or empty (older runs, or a run that produced no summary) so the caller falls
 * back to the generic title.
 */
function readAndConsumePrTitle(): string | undefined {
    if (!existsSync(PR_TITLE_FILE)) {
        return undefined;
    }
    let raw = "";
    try {
        raw = readFileSync(PR_TITLE_FILE, "utf-8");
    } catch {
        return undefined;
    } finally {
        // Always remove the scratch file, even if reading failed, so a stale or
        // unreadable artifact can never be committed.
        try {
            rmSync(PR_TITLE_FILE, { force: true });
        } catch {
            /* best-effort */
        }
    }
    const firstLine = raw
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (!firstLine) {
        return undefined;
    }
    // Collapse internal whitespace and cap length so the title stays concise.
    const collapsed = firstLine.replace(/\s+/g, " ").trim();
    const MAX = 72;
    return collapsed.length > MAX ? `${collapsed.slice(0, MAX - 1).trimEnd()}…` : collapsed;
}

/**
 * Build the PR title. The `[compat-sync]` prefix is ALWAYS added here so it is
 * deterministic and the skill never has to (the skill writes only the bare
 * summary). Any pre-existing prefix on the summary is stripped first to guard
 * against double-prefixing. With no summary, falls back to the generic title.
 */
function composePrTitle(summary?: string): string {
    const PREFIX = "[compat-sync]";
    const fallback = `${PREFIX} Babylon.js compat-layer sync`;
    if (!summary) {
        return fallback;
    }
    // Strip any prefix the summary may already carry (case-insensitive, with any
    // trailing whitespace) so we never emit "[compat-sync] [compat-sync] ...". If
    // that leaves nothing (the summary was only the prefix/whitespace), fall back to
    // the generic title rather than emitting a bare "[compat-sync] ".
    const bare = summary.replace(/^\s*\[compat-sync\]\s*/i, "").trim();
    if (!bare) {
        return fallback;
    }
    return `${PREFIX} ${bare}`;
}

function bjsSha(): string {
    const out = runGit(["grep", "-hoE", "Last synced BJS commit:\\** `[0-9a-f]{7,40}`", "--", "packages/babylon-lite-compat/COMPAT-STATUS.md"], true);
    const match = out.match(/`([0-9a-f]{7,40})`/);
    return match ? match[1]! : "(unknown)";
}

async function openPullRequest(branch: string, validation: ValidationResult, changedFiles: string[], titleSummary?: string): Promise<{ url: string; number: number }> {
    const title = composePrTitle(titleSummary);
    const body = [
        "Automated sync of `@babylonjs/lite-compat` against the latest Babylon.js and Babylon Lite changes,",
        "produced by the [`update-compat-layer`](.github/copilot/skills/update-compat-layer.md) skill.",
        "",
        // `Addresses #N` both auto-links the issue and serves as the guard's fallback
        // origin marker for legacy PRs whose branch predates origin encoding. Keep the
        // literal "Addresses #<number>" shape in sync with check-open-compat-sync-pr.ts.
        ...(ISSUE_NUMBER ? [`Addresses #${ISSUE_NUMBER}.`, ""] : []),
        `**Synced against BJS commit:** \`${bjsSha()}\``,
        "",
        "### Validation (run independently by the pipeline)",
        validation.log,
        "",
        "### Changed files",
        changedFiles.map((f) => `- \`${f}\``).join("\n"),
        "",
        validation.passed
            ? "> Validation passed. Please review the wrapper changes and the updated `COMPAT-STATUS.md` before merging."
            : "> ⚠️ Validation did **not** fully pass (see above). Opened as a draft for a maintainer to resolve before merging.",
        "",
        "> Opened as a **draft** by the compat-sync pipeline. Review and mark ready when satisfied.",
    ].join("\n");

    const response = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
        method: "POST",
        headers: { ...githubHeaders(TOKEN), "Content-Type": "application/json" },
        body: JSON.stringify({ title, head: branch, base: BASE_BRANCH, body, draft: true }),
    });

    if (!response.ok) {
        throw new Error(`Failed to open PR (${response.status}): ${await response.text()}`);
    }
    const json = (await response.json()) as { html_url?: string; number?: number };
    return { url: json.html_url ?? "(unknown URL)", number: json.number ?? 0 };
}

/** Apply the automation labels to the freshly-opened PR (best-effort). */
async function applyLabels(prNumber: number): Promise<void> {
    if (!prNumber) {
        return;
    }
    const response = await fetch(`https://api.github.com/repos/${REPO}/issues/${prNumber}/labels`, {
        method: "POST",
        headers: { ...githubHeaders(TOKEN), "Content-Type": "application/json" },
        body: JSON.stringify({ labels: PR_LABELS }),
    });
    if (!response.ok) {
        // Non-fatal: labels may not exist in the repo. Log and continue.
        console.warn(`Could not apply labels (${response.status}): ${await response.text()}`);
    }
}

function configureGit(): void {
    runGit(["config", "user.name", GIT_USER_NAME]);
    runGit(["config", "user.email", GIT_USER_EMAIL]);
}

function runGit(args: string[], allowFailure = false): string {
    try {
        return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
        if (allowFailure) {
            return "";
        }
        throw new Error(redactToken(error instanceof Error ? error.message : String(error)));
    }
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/** Resolve the triggering issue number, treating "none"/"0"/empty as no issue. */
function normalizeIssueNumber(raw: string | undefined): string | undefined {
    const value = raw?.trim();
    if (!value || value.toLowerCase() === "none" || value === "0") {
        return undefined;
    }
    return value;
}

main().catch((error: unknown) => {
    console.error(redactToken(error instanceof Error ? error.message : String(error)));
    process.exit(1);
});
