/**
 * Reconcile the sticky bundle-size comment on a pull request.
 *
 * This is the trusted half of issue #627. It runs only inside
 * `azure-pipelines-pr-publish.yml`, a master-only definition no pull request can reach, and it is
 * the only place in the repository that holds a GitHub token able to write an issue comment.
 *
 * The problem it solves is not "post a comment" — `GitHubComment@0` already did that. It is that
 * `GitHubComment@0` can *only* create. A bundle-size comment therefore outlived the measurement
 * it described: a PR that added 40 KB and then removed it again kept a comment claiming the
 * regression forever, and every later run stacked another comment beside it. So this script owns
 * a single canonical comment per pull request and drives it through a small state machine.
 *
 * Everything that decides *where* a write lands — repository, pull request, marker, HTTP method —
 * is a compile-time constant or a validated environment value supplied by the publisher's
 * `${{ parameters.* }}`. The artifact staged by PR CI contributes markdown and a three-valued
 * enum, and nothing else. It is never executed, never interpolated into a URL, never echoed to
 * stdout, and cannot introduce a marker of its own (see `sanitizeArtifactBody`).
 *
 * There is deliberately no `DELETE` in this file. The token can delete *any* comment in the
 * repository, including a human's, so a selection bug must not be able to destroy review history.
 * Superseded duplicates are rewritten in place instead, losing the canonical marker.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

/** Repository this publisher is allowed to write to. Fixed; never taken from artifact content. */
export const EXPECTED_REPOSITORY = "BabylonJS/Babylon-Lite";

/**
 * Marker that identifies the one canonical comment. It must be the comment's *first line*.
 *
 * First-line anchoring is what keeps the API-report comment — same bot, same pull request, body
 * assembled from a different untrusted artifact — structurally incapable of being adopted or
 * destroyed by this script: its first line is a heading emitted by trusted master code, so it can
 * never present as a candidate no matter what its artifact contains.
 */
export const MARKER_PREFIX = "<!-- babylon-lite:bundle-size:v1 ";
export const MARKER_SUFFIX = " -->";

/**
 * Marker a demoted duplicate carries. It is deliberately *not* a prefix of `MARKER_PREFIX`, so a
 * tombstone can never be re-adopted as canonical on a later run.
 */
export const SUPERSEDED_MARKER_PREFIX = "<!-- babylon-lite:bundle-size:v1-superseded ";

/** Refuse to rewrite an implausible number of duplicates; something else is wrong. */
export const MAX_DUPLICATE_REWRITES = 10;

/** GitHub rejects comment bodies over 65,536 characters. Leave room for the marker and notice. */
export const MAX_COMMENT_CHARS = 60_000;

/** An artifact larger than this is malformed, not merely long. */
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

export const BUNDLE_COMMENT_STATE_FILE = "bundle-comment-state.json";
export const BUNDLE_COMMENT_BODY_FILE = "bundle-size-comment.md";

export type BundleCommentState = "report" | "none" | "unavailable";

/**
 * Identity written into the marker.
 *
 * It binds the fixed repository, the pull request, the PR CI definition and the exact build whose
 * measurement produced the comment, so a stale re-queue is visibly a no-op and an operator can
 * always tell which run last asserted the current text.
 */
export interface MarkerIdentity {
    repo: string;
    pr: number;
    definitionId: number;
    buildId: number;
}

export interface IssueComment {
    id: number;
    body: string;
    user: { id: number } | null;
}

/**
 * Result of enumerating a pull request's comments.
 *
 * `complete` is not decoration. A create decision is only sound if the enumeration was exhaustive:
 * if a truncated page listing hides the canonical comment, every run takes the create branch and
 * the pull request accumulates a comment per poll tick forever. Any implementation that cannot
 * prove it read every page must report `complete: false`, and this module refuses to create.
 */
export interface CommentPage {
    comments: IssueComment[];
    complete: boolean;
}

export interface GitHubCommentApi {
    viewerId(): Promise<number>;
    listComments(pullRequest: number): Promise<CommentPage>;
    createComment(pullRequest: number, body: string): Promise<IssueComment>;
    updateComment(commentId: number, body: string): Promise<void>;
}

export interface ReconcileInput {
    identity: MarkerIdentity;
    state: BundleCommentState;
    /** Sanitized markdown. Required when `state === "report"`, ignored otherwise. */
    body?: string;
}

export type ReconcileAction = "created" | "updated" | "resolved" | "unchanged" | "noop" | "skipped";

export interface ReconcileResult {
    action: ReconcileAction;
    canonicalCommentId?: number;
    demotedCommentIds: number[];
}

export function formatMarker(identity: MarkerIdentity): string {
    return `${MARKER_PREFIX}${JSON.stringify({
        repo: identity.repo,
        pr: identity.pr,
        definitionId: identity.definitionId,
        buildId: identity.buildId,
    })}${MARKER_SUFFIX}`;
}

/**
 * Parse a marker from a comment's first line, or return null if the line is not one.
 *
 * Every rejection returns null rather than throwing, including a line that carries the prefix but
 * unparseable or mis-shaped content. That looks lax and is the deliberate choice: the two failure
 * modes are not symmetric. Treating a corrupted marker as "not ours" costs at most one duplicate
 * comment, which the next run demotes. Throwing on it would let a single malformed body — on a
 * comment only a repository-write token could have produced — disable bundle-size reporting for
 * that pull request permanently, with no way to recover except editing the comment by hand.
 *
 * Tampering is still caught: a candidate carrying more than one marker is a hard failure in
 * `selectOwnedComments`, which is the case where writing could damage something.
 */
export function parseMarkerLine(line: string): MarkerIdentity | null {
    if (!line.startsWith(MARKER_PREFIX) || !line.endsWith(MARKER_SUFFIX)) {
        return null;
    }

    const json = line.slice(MARKER_PREFIX.length, line.length - MARKER_SUFFIX.length);
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }

    const { repo, pr, definitionId, buildId } = parsed as Record<string, unknown>;
    if (typeof repo !== "string" || !Number.isInteger(pr) || !Number.isInteger(definitionId) || !Number.isInteger(buildId)) {
        return null;
    }

    return { repo, pr: pr as number, definitionId: definitionId as number, buildId: buildId as number };
}

function firstLineOf(body: string): string {
    const end = body.indexOf("\n");
    const line = end === -1 ? body : body.slice(0, end);
    return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function countMarkers(body: string): number {
    let count = 0;
    let index = body.indexOf(MARKER_PREFIX);
    while (index !== -1) {
        count += 1;
        index = body.indexOf(MARKER_PREFIX, index + MARKER_PREFIX.length);
    }
    return count;
}

/**
 * A staged artifact that does not meet the contract.
 *
 * Kept distinct from every other failure because the two need opposite handling. A GitHub 500 is
 * transient and must fail the job so the poller retries it. A malformed artifact is deterministic
 * and pull-request-authored: retrying cannot fix it, and failing on it would exhaust the poller's
 * attempts and — since the poller escalates exhaustion by failing its tick — let one pull request
 * permanently red the reconciler for every other pull request.
 *
 * So this is reported loudly and treated as `unavailable`: nothing is written, and no existing
 * comment is disturbed.
 */
export class ArtifactContractError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "ArtifactContractError";
    }
}

/**
 * Turn raw artifact bytes into markdown that cannot act.
 *
 * Three separate things are being prevented, and it is worth keeping them distinct:
 *
 *  1. Agent logging commands. The body is written straight to the GitHub API rather than through
 *     a pipeline variable, so this is defence in depth rather than the primary control, but the
 *     defanging is kept identical to `strip-logging-commands.sh` so the two paths read the same.
 *  2. A second marker. Escaping the HTML-comment delimiters means artifact content *cannot*
 *     produce `<!--` in a posted body at all. That is stronger than detecting a forged marker:
 *     the hard-failure state below becomes unreachable through artifact content rather than
 *     merely caught, so a malicious body cannot park the comment in a permanently failing state.
 *  3. Encoding abuse — NULs, invalid UTF-8, and bodies too large to be a bundle report.
 */
export function sanitizeArtifactBody(raw: Buffer): string {
    if (raw.length > MAX_ARTIFACT_BYTES) {
        throw new ArtifactContractError(`Bundle comment artifact is ${raw.length} bytes, over the ${MAX_ARTIFACT_BYTES}-byte limit.`);
    }

    let decoded: string;
    try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
        throw new ArtifactContractError("Bundle comment artifact is not valid UTF-8.");
    }

    if (decoded.includes("\0")) {
        throw new ArtifactContractError("Bundle comment artifact contains a NUL byte.");
    }

    const escaped = decoded
        .replace(/##vso\[/g, "##vso(")
        .replace(/##\[/g, "##(")
        .replace(/<!--/g, "&lt;!--")
        .replace(/-->/g, "--&gt;");

    // The replacements above are single-pass, so assert the invariant they exist to establish
    // rather than trusting that no input can reassemble a delimiter across a replacement boundary.
    if (escaped.includes("<!--") || escaped.includes("-->")) {
        throw new ArtifactContractError("Bundle comment artifact still contains an HTML comment delimiter after escaping.");
    }

    if (escaped.length <= MAX_COMMENT_CHARS) {
        return escaped;
    }

    return `${escaped.slice(0, MAX_COMMENT_CHARS)}\n\n*Truncated: the bundle-size report exceeded ${MAX_COMMENT_CHARS} characters.*`;
}

/**
 * Read the state file PR CI stages on every successful Bundle Size run.
 *
 * Strict by design: an unrecognised schema version or state throws instead of degrading to a
 * default. "Assume nothing to report" would retract live comments on a malformed artifact, and
 * "assume there is a report" would post an empty one.
 */
export function parseBundleCommentState(json: string): BundleCommentState {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error) {
        throw new ArtifactContractError(`Bundle comment state file is not valid JSON: ${(error as Error).message}`);
    }

    if (typeof parsed !== "object" || parsed === null) {
        throw new ArtifactContractError("Bundle comment state file is not a JSON object.");
    }

    const { schemaVersion, state } = parsed as Record<string, unknown>;
    if (schemaVersion !== 1) {
        throw new ArtifactContractError(`Bundle comment state file has unsupported schemaVersion ${String(schemaVersion)}.`);
    }
    if (state !== "report" && state !== "none" && state !== "unavailable") {
        throw new ArtifactContractError(`Bundle comment state file has unrecognised state ${String(state)}.`);
    }

    return state;
}

/**
 * Load the staged artifact.
 *
 * A missing directory or missing state file means the Bundle Size job did not get far enough to
 * say anything, which is `unavailable` — not `none`. The distinction is the difference between
 * leaving a regression report alone and silently withdrawing it.
 */
export function loadStagedArtifact(directory: string): { state: BundleCommentState; body?: string } {
    let stateJson: string;
    try {
        stateJson = readFileSync(resolve(directory, BUNDLE_COMMENT_STATE_FILE), "utf-8");
    } catch {
        console.log(`No ${BUNDLE_COMMENT_STATE_FILE} under ${directory}; treating this run as unavailable.`);
        return { state: "unavailable" };
    }

    const state = parseBundleCommentState(stateJson);
    if (state !== "report") {
        return { state };
    }

    let raw: Buffer;
    try {
        raw = readFileSync(resolve(directory, BUNDLE_COMMENT_BODY_FILE));
    } catch {
        throw new ArtifactContractError(`${BUNDLE_COMMENT_STATE_FILE} claims a report but ${BUNDLE_COMMENT_BODY_FILE} is missing.`);
    }

    const body = sanitizeArtifactBody(raw);
    if (body.trim().length === 0) {
        throw new ArtifactContractError(`${BUNDLE_COMMENT_BODY_FILE} is empty but the state file claims a report.`);
    }

    return { state, body };
}

function resolvedBody(identity: MarkerIdentity): string {
    return `**Bundle Size**: no longer notable. The change this comment reported is not present in the latest measured run — build \`${identity.buildId}\` of definition \`${identity.definitionId}\`.`;
}

function supersededBody(identity: MarkerIdentity): string {
    return [
        `${SUPERSEDED_MARKER_PREFIX}${JSON.stringify({ repo: identity.repo, pr: identity.pr })}${MARKER_SUFFIX}`,
        "**Bundle Size**: superseded by the current bundle-size comment on this pull request.",
    ].join("\n");
}

/**
 * Select the comments this script owns.
 *
 * Ownership requires all three of: the marker on the first line, an author whose *numeric* id is
 * the token's own identity, and a marker naming this exact repository and pull request. The id
 * comparison matters — a login is renameable, so an attacker who can free up the bot's old name
 * could otherwise present comments this script would then rewrite.
 */
export function selectOwnedComments(comments: IssueComment[], viewerId: number, identity: MarkerIdentity): IssueComment[] {
    const owned: IssueComment[] = [];

    for (const comment of comments) {
        if (comment.user?.id !== viewerId) {
            continue;
        }

        const marker = parseMarkerLine(firstLineOf(comment.body));
        if (!marker) {
            continue;
        }

        if (marker.repo !== identity.repo || marker.pr !== identity.pr) {
            // A marker for a different destination on this pull request should never exist. Leave
            // it strictly alone rather than guessing at what produced it.
            console.log(`Ignoring comment ${comment.id}: marker names ${marker.repo}#${marker.pr}.`);
            continue;
        }

        if (countMarkers(comment.body) !== 1) {
            // Ignored, not fatal. A comment carrying two markers is ambiguous, and the only safe
            // thing to do with an ambiguous comment is leave it alone.
            //
            // It must not throw. The sibling `api-comment` artifact is PR-authored markdown that
            // is posted by the same bot, and its first line is not generated by trusted code, so a
            // pull request can put whatever it likes there. If that made this script fail, the
            // publisher would fail, the poller would exhaust its retries, and one pull request
            // would permanently red the scheduled reconciler for every other pull request.
            console.log(`Ignoring comment ${comment.id}: it carries more than one bundle-size marker.`);
            continue;
        }

        owned.push(comment);
    }

    return owned.sort((a, b) => a.id - b.id);
}

/**
 * Drive the sticky comment to the state this run measured.
 *
 * | measured      | existing canonical | outcome                                   |
 * | ------------- | ------------------ | ----------------------------------------- |
 * | `report`      | none               | create exactly one                        |
 * | `report`      | one                | update it, or leave it if already current  |
 * | `none`        | one                | rewrite to a concise resolved state        |
 * | `none`        | none               | nothing — silence on never-notable PRs     |
 * | `unavailable` | any                | nothing at all                             |
 */
export async function reconcile(api: GitHubCommentApi, input: ReconcileInput): Promise<ReconcileResult> {
    const { identity, state } = input;

    if (state === "unavailable") {
        console.log("Bundle size was not measured on this run; leaving any existing comment untouched.");
        return { action: "skipped", demotedCommentIds: [] };
    }

    const viewerId = await api.viewerId();
    const page = await api.listComments(identity.pr);
    if (!page.complete) {
        throw new Error(`Could not enumerate every comment on PR ${identity.pr}; refusing to act on a partial listing.`);
    }

    const owned = selectOwnedComments(page.comments, viewerId, identity);
    const [canonical, ...duplicates] = owned;

    if (duplicates.length > MAX_DUPLICATE_REWRITES) {
        throw new Error(`Found ${duplicates.length} duplicate bundle-size comments on PR ${identity.pr}, over the ${MAX_DUPLICATE_REWRITES} rewrite cap.`);
    }

    const marker = formatMarker(identity);
    let action: ReconcileAction;
    let canonicalCommentId = canonical?.id;

    if (state === "report") {
        if (input.body === undefined) {
            throw new Error("Bundle comment state is 'report' but no body was supplied.");
        }
        const desired = `${marker}\n${input.body}`;
        if (!canonical) {
            const created = await api.createComment(identity.pr, desired);
            canonicalCommentId = created.id;
            action = "created";
        } else if (canonical.body === desired) {
            // Re-running the same build is a no-op rather than a redundant write. The marker
            // carries the build id, so an identical body means an identical measurement.
            action = "unchanged";
        } else {
            await api.updateComment(canonical.id, desired);
            action = "updated";
        }
    } else if (!canonical) {
        // Never notable, still silent. Creating a "nothing to report" comment here would put a
        // comment on every pull request in the repository, which is the behaviour this feature
        // was explicitly built to avoid.
        action = "noop";
    } else {
        const desired = `${marker}\n${resolvedBody(identity)}`;
        if (canonical.body === desired) {
            action = "unchanged";
        } else {
            await api.updateComment(canonical.id, desired);
            action = "resolved";
        }
    }

    const demotedCommentIds: number[] = [];
    for (const duplicate of duplicates) {
        await api.updateComment(duplicate.id, supersededBody(identity));
        demotedCommentIds.push(duplicate.id);
    }

    return { action, canonicalCommentId, demotedCommentIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const FETCH_ATTEMPTS = 3;
const MAX_COMMENT_PAGES = 50;

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value || value.startsWith("$(")) {
        throw new Error(`${name} is not set; refusing to run without it.`);
    }
    return value;
}

function requirePositiveInteger(name: string): number {
    const raw = requireEnv(name);
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
    }
    return value;
}

class GitHubRestApi implements GitHubCommentApi {
    constructor(
        private readonly token: string,
        private readonly repository: string
    ) {}

    private async request(method: string, url: string, body?: unknown): Promise<Response> {
        let response: Response | undefined;
        for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
            response = await fetch(url, {
                method,
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${this.token}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "babylon-lite-bundle-size-reconciler",
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });

            if (response.ok || (response.status !== 429 && response.status < 500) || attempt === FETCH_ATTEMPTS) {
                break;
            }
            await response.body?.cancel();
            console.warn(`GitHub ${method} returned ${response.status}; retrying (${attempt}/${FETCH_ATTEMPTS}).`);
            await new Promise((done) => setTimeout(done, attempt * 500));
        }

        if (!response!.ok) {
            // Explicit and loud. There is no success-shaped fallback anywhere in this path: a
            // failed reconcile has to fail the job so the poller retries it, because the
            // alternative is a pull request that silently keeps a wrong comment.
            throw new Error(`GitHub ${method} ${url.replace(this.token, "***")} failed with ${response!.status} ${response!.statusText}.`);
        }

        return response!;
    }

    async viewerId(): Promise<number> {
        const user = (await (await this.request("GET", `${GITHUB_API}/user`)).json()) as { id?: unknown };
        if (!Number.isInteger(user.id)) {
            throw new Error("GitHub /user did not return a numeric id.");
        }
        return user.id as number;
    }

    async listComments(pullRequest: number): Promise<CommentPage> {
        const comments: IssueComment[] = [];
        let url: string | undefined = `${GITHUB_API}/repos/${this.repository}/issues/${pullRequest}/comments?per_page=100`;

        for (let page = 0; page < MAX_COMMENT_PAGES && url; page++) {
            const response: Response = await this.request("GET", url);
            const batch = (await response.json()) as Array<{ id?: unknown; body?: unknown; user?: { id?: unknown } | null }>;
            if (!Array.isArray(batch)) {
                throw new Error("GitHub comment listing did not return an array.");
            }

            for (const raw of batch) {
                if (!Number.isInteger(raw.id)) {
                    throw new Error("GitHub comment listing contained a comment without a numeric id.");
                }
                comments.push({
                    id: raw.id as number,
                    body: typeof raw.body === "string" ? raw.body : "",
                    user: Number.isInteger(raw.user?.id) ? { id: raw.user!.id as number } : null,
                });
            }

            url = nextPageUrl(response.headers.get("link"));
        }

        // Exhausting the page budget is reported rather than silently accepted. `reconcile`
        // refuses to create from an incomplete listing, which is the only decision that a hidden
        // canonical comment could corrupt into an unbounded series of new comments.
        return { comments, complete: url === undefined };
    }

    async createComment(pullRequest: number, body: string): Promise<IssueComment> {
        const response = await this.request("POST", `${GITHUB_API}/repos/${this.repository}/issues/${pullRequest}/comments`, { body });
        const created = (await response.json()) as { id?: unknown };
        if (!Number.isInteger(created.id)) {
            throw new Error("GitHub comment creation did not return a numeric id.");
        }
        return { id: created.id as number, body, user: null };
    }

    async updateComment(commentId: number, body: string): Promise<void> {
        await this.request("PATCH", `${GITHUB_API}/repos/${this.repository}/issues/comments/${commentId}`, { body });
    }
}

export function nextPageUrl(linkHeader: string | null): string | undefined {
    if (!linkHeader) {
        return undefined;
    }
    for (const part of linkHeader.split(",")) {
        const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
        if (match) {
            return match[1];
        }
    }
    return undefined;
}

async function main(): Promise<void> {
    const repository = requireEnv("GITHUB_REPOSITORY");
    if (repository !== EXPECTED_REPOSITORY) {
        throw new Error(`Refusing to write comments to ${repository}; this publisher only writes to ${EXPECTED_REPOSITORY}.`);
    }

    const identity: MarkerIdentity = {
        repo: repository,
        pr: requirePositiveInteger("PR_NUMBER"),
        definitionId: requirePositiveInteger("PR_CI_DEFINITION_ID"),
        buildId: requirePositiveInteger("PR_CI_RUN_ID"),
    };

    // A pull request controls every byte of the staged artifact, so a malformed one must not be
    // able to fail this job. Failing would exhaust the poller's retries for this build, and the
    // poller escalates exhaustion by failing its tick — one pull request would stop the scheduled
    // reconciler for all of them. The contract violation is reported and the run does nothing,
    // which is the same outcome as an unmeasured build.
    let artifact: { state: BundleCommentState; body?: string };
    try {
        artifact = loadStagedArtifact(requireEnv("BUNDLE_COMMENT_DIR"));
    } catch (error) {
        if (!(error instanceof ArtifactContractError)) {
            throw error;
        }
        console.error(`Staged bundle-size artifact is unusable, so no comment was changed: ${error.message}`);
        return;
    }

    const api = new GitHubRestApi(requireEnv("PR_COMMENT_TOKEN"), repository);
    const result = await reconcile(api, {
        identity,
        state: artifact.state,
        body: artifact.body,
    });

    // Never logs the body. Artifact-derived bytes must not reach stdout, because the agent parses
    // step output and this job holds a GitHub connection.
    console.log(`Bundle-size comment on PR ${identity.pr}: ${result.action}${result.canonicalCommentId ? ` (comment ${result.canonicalCommentId})` : ""}.`);
    if (result.demotedCommentIds.length > 0) {
        console.log(`Demoted duplicate comments: ${result.demotedCommentIds.join(", ")}.`);
    }
}

if (require.main === module) {
    void main().catch((error: Error) => {
        console.error(error.message);
        process.exit(1);
    });
}
