/**
 * Compat-layer sync — preflight guard.
 *
 * Runs BEFORE the (expensive) agent step. Its job is to keep at most one
 * **scheduled/manual-origin** compat-sync PR open at a time: if the previous
 * scheduled run's PR is still open (not yet merged or closed), a new scheduled run
 * should do nothing. Issue-triggered PRs are explicit user requests and do NOT
 * count toward this limit — a scheduled run still proceeds when the only open
 * compat-sync PRs were created in response to issues.
 *
 * It detects a compat-sync PR by the deterministic signals the PR driver
 * (open-compat-sync-pr.ts) stamps on every PR it opens:
 *   - head branch starts with `compat-sync/`, OR
 *   - the PR carries both the `compat` and `automation` labels.
 *
 * It classifies each one's ORIGIN (scheduled/manual vs issue) primarily from the
 * branch segment the driver encodes (`compat-sync/issue-<n>-...` vs
 * `compat-sync/scheduled-...`), falling back to the body's `Addresses #N` marker for
 * legacy branches. Only **scheduled-origin** PRs block a scheduled run.
 *
 * Output: when a blocking (scheduled-origin) compat-sync PR is found, it emits the
 * Azure DevOps logging command
 * `##vso[task.setvariable variable=skipCompatSync]true`, which the pipeline uses to
 * skip the agent + PR-driver steps (the run still succeeds — it is a noop). When
 * none is found, it sets the variable to `false` and the run proceeds.
 *
 * Genuine errors (auth/network) throw (exit 1) so they are loud and visible rather
 * than silently skipping or silently proceeding.
 *
 * Required env:
 *   - GITHUB_REPOSITORY   e.g. "BabylonJS/Babylon-Lite"
 *   - PR auth — same as the PR driver: GH_APP_ID + GH_APP_PRIVATE_KEY (preferred),
 *     or GITHUB_TOKEN. Only read access to pull requests is needed here.
 * Optional env:
 *   - ISSUE_NUMBER        when set to a real issue number, the run was triggered by
 *                         a `compat`-labelled issue (an explicit user request). Such
 *                         runs BYPASS the guard and always proceed, even if a
 *                         compat-sync PR is already open. "none"/"0"/empty (the ADO
 *                         sentinel for scheduled/manual runs) does not bypass.
 */

import { resolveGithubToken, makeRedactor, githubHeaders } from "./compat-sync-auth.js";

const REPO = requireEnv("GITHUB_REPOSITORY");
const ISSUE_NUMBER = normalizeIssueNumber(process.env.ISSUE_NUMBER);
const BRANCH_PREFIX = "compat-sync/";
// Origin-encoding branch segments the PR driver writes (keep in sync with it).
const ISSUE_BRANCH_PREFIX = "compat-sync/issue-";
const REQUIRED_LABELS = ["compat", "automation"];

type PrOrigin = "issue" | "scheduled";

interface PullRequestSummary {
    number: number;
    html_url: string;
    body: string | null;
    head: { ref: string };
    labels: Array<{ name: string }>;
}

async function main(): Promise<void> {
    // Issue-triggered runs are explicit user requests and always proceed, even with
    // a compat-sync PR already open. Decided before any API call so the bypass works
    // regardless of auth/network state.
    if (ISSUE_NUMBER) {
        console.log(`Issue-triggered run (#${ISSUE_NUMBER}); bypassing the open-PR guard and proceeding.`);
        setSkip(false);
        return;
    }

    const resolved = await resolveGithubToken(REPO, "read");
    const redact = makeRedactor(resolved.secrets);
    console.log(`Auth: ${resolved.source}.`);

    try {
        const open = await listOpenPulls(resolved.token);
        const compatSyncPrs = open.filter(isCompatSyncPr);
        const blocking = compatSyncPrs.filter((pr) => prOrigin(pr) === "scheduled");

        if (blocking.length > 0) {
            const list = blocking.map((pr) => `  #${pr.number} (${pr.head.ref}) — ${pr.html_url}`).join("\n");
            console.log(`An open scheduled compat-sync PR already exists; skipping this scheduled run until it is merged or closed:\n${list}`);
            setSkip(true);
            return;
        }

        const issueOnly = compatSyncPrs.length;
        const note = issueOnly > 0 ? ` (${issueOnly} open compat-sync PR(s) are issue-origin and do not block scheduled runs)` : "";
        console.log(`No open scheduled compat-sync PR found. Proceeding with the run.${note}`);
        setSkip(false);
    } catch (error) {
        throw new Error(redact(error instanceof Error ? error.message : String(error)));
    }
}

/** Whether a PR was opened by the compat-sync automation (branch prefix or labels). */
function isCompatSyncPr(pr: PullRequestSummary): boolean {
    if (pr.head?.ref?.startsWith(BRANCH_PREFIX)) {
        return true;
    }
    const names = new Set((pr.labels ?? []).map((l) => l.name));
    return REQUIRED_LABELS.every((label) => names.has(label));
}

/**
 * Classify a compat-sync PR's origin. Primary signal is the branch segment the
 * driver encodes (`compat-sync/issue-...`); for legacy branches that predate origin
 * encoding, fall back to the body's `Addresses #N` marker. Anything not identifiable
 * as issue-origin is treated as scheduled (conservative — it can block a scheduled
 * run).
 */
function prOrigin(pr: PullRequestSummary): PrOrigin {
    if (pr.head?.ref?.startsWith(ISSUE_BRANCH_PREFIX)) {
        return "issue";
    }
    if (/Addresses #\d+/i.test(pr.body ?? "")) {
        return "issue";
    }
    return "scheduled";
}

/** List every open PR in the repo, following pagination. */
async function listOpenPulls(token: string): Promise<PullRequestSummary[]> {
    const all: PullRequestSummary[] = [];
    const perPage = 100;
    for (let page = 1; ; page++) {
        const response = await fetch(`https://api.github.com/repos/${REPO}/pulls?state=open&per_page=${perPage}&page=${page}`, {
            headers: githubHeaders(token),
        });
        if (!response.ok) {
            throw new Error(`Failed to list open pull requests for ${REPO} (${response.status}): ${await response.text()}`);
        }
        const batch = (await response.json()) as PullRequestSummary[];
        all.push(...batch);
        if (batch.length < perPage) {
            break;
        }
    }
    return all;
}

/** Emit the Azure DevOps logging command that gates subsequent steps. */
function setSkip(skip: boolean): void {
    console.log(`##vso[task.setvariable variable=skipCompatSync]${skip ? "true" : "false"}`);
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
