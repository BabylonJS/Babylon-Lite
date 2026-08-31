/**
 * Scheduled reconciliation of PR comments (issue #627).
 *
 * ── WHY A POLLER AT ALL ──────────────────────────────────────────────────────
 *
 * PR CI holds no credential, so it cannot post its own comments; the trusted
 * publisher holds them all, so it must never be reachable from a pull request. The
 * one wiring that would connect them automatically — a `resources.pipelines`
 * completion trigger — is also the one that breaks the isolation, because when both
 * pipelines share a repository Azure runs the triggered pipeline on the *triggering*
 * run's branch, which for a pull-request build is the pull request's own merge ref.
 * The publisher's YAML would then be read from the pull request.
 *
 * So the connection is made from the trusted side: this runs on a schedule from
 * master, works out which publisher runs are missing, and queues them. Each queued
 * run is compiled with exactly one immutable destination triple, and the publisher's
 * own preflight re-derives and re-validates that triple before any credentialed job
 * starts. A compromised poller can therefore only queue *valid* triples that already
 * exist — it cannot invent a destination.
 *
 * ── WHY THERE IS NO WATERMARK AND NO TIME WINDOW ─────────────────────────────
 *
 * The obvious design keeps a cursor, or scans "the last N days". Both lose state: an
 * outage longer than the window hides the runs it spanned forever, and a newly
 * created poller definition never sees an old-but-still-open pull request at all.
 * Instead the desired state is derived directly and completely on every tick — the
 * open pull requests, each one's latest completed CI run, and what the publisher has
 * already done about it. There is no cursor to lose, so a restart, a month-long
 * outage and a first-ever run all converge identically.
 *
 * The cost is a read-only GitHub credential in trusted code, which is a deliberate
 * trade: a repository-scoped token that can read pull-request metadata and nothing
 * else, on a definition no pull request can reach, is much cheaper than silently
 * losing reports.
 */

/** Refuse to run rather than truncate. A repository this busy needs a design review, not a guess. */
export const MAX_OPEN_PULL_REQUESTS = 250;

/** Publisher runs per triple before the failure is escalated instead of retried again. */
export const MAX_ATTEMPTS = 3;

/** Queues per tick, so one pathological pull request cannot starve the rest. */
export const MAX_QUEUE_PER_TICK = 20;

/** Page budgets. Exhausting one is reported as incomplete, never silently accepted. */
export const MAX_PULL_REQUEST_PAGES = 10;
export const MAX_BUILD_PAGES = 10;

/** Publisher runs inspected per triple. The index query is exact, so this is a sanity bound. */
export const MAX_PUBLISHER_RUNS_PER_TRIPLE = 20;

export const EXPECTED_REPOSITORY = "BabylonJS/Babylon-Lite";

export type JobResult = "succeeded" | "failed" | "skipped" | "unknown";

export interface PublisherTriple {
    prNumber: number;
    prCiRunId: number;
    prCiDefinitionId: number;
}

export interface VerifiedBuild {
    id: number;
    prNumber: number;
    definitionId: number;
    finishTime: string;
}

export interface PublisherRunHistory {
    runId: number;
    finished: boolean;
    apiJobResult: JobResult;
    bundleJobResult: JobResult;
}

export type Decision = { kind: "queue"; postApiComment: boolean; postBundleComment: boolean } | { kind: "in-flight" } | { kind: "done" } | { kind: "exhausted"; attempts: number };

export interface QueueRequest extends PublisherTriple {
    postApiComment: boolean;
    postBundleComment: boolean;
}

export interface PollerApi {
    listOpenPullRequests(): Promise<{ numbers: number[]; complete: boolean }>;
    latestCompletedPrCiBuild(prNumber: number): Promise<VerifiedBuild | null>;
    publisherRunsFor(triple: PublisherTriple): Promise<PublisherRunHistory[]>;
    otherPollerRunInProgress(): Promise<boolean>;
    queuePublisher(request: QueueRequest): Promise<number>;
}

export interface PollSummary {
    skipped: boolean;
    considered: number;
    queued: QueueRequest[];
    exhausted: PublisherTriple[];
}

/**
 * Validate a build the ADO API returned as genuinely being this pull request's CI run.
 *
 * The pull-request number is taken from `sourceBranch`, which Azure assigns for
 * `reason == "pullRequest"` runs and a pull request cannot set. The comparison is exact string
 * equality against the ref we asked for rather than a pattern match, so there is no anchoring
 * subtlety to get wrong — `refs/pull/12/merge\n` and `refs/pull/12/head` both simply fail to
 * equal `refs/pull/12/merge`. The publisher re-derives all of this independently before it does
 * anything with a credential; this check exists so the poller does not queue runs that would
 * only be rejected there.
 */
export function verifyPrCiBuild(raw: unknown, expected: { prNumber: number; definitionId: number }): VerifiedBuild | null {
    if (typeof raw !== "object" || raw === null) {
        return null;
    }

    const build = raw as Record<string, unknown>;
    const definition = build.definition as { id?: unknown } | undefined;
    const repository = build.repository as { type?: unknown; name?: unknown } | undefined;

    if (!Number.isInteger(build.id) || (build.id as number) <= 0) {
        return null;
    }
    if (definition?.id !== expected.definitionId) {
        return null;
    }
    if (build.reason !== "pullRequest" || build.status !== "completed") {
        return null;
    }
    if (build.sourceBranch !== `refs/pull/${expected.prNumber}/merge`) {
        return null;
    }
    if (repository?.type !== "GitHub" || repository?.name !== EXPECTED_REPOSITORY) {
        return null;
    }
    if (typeof build.finishTime !== "string") {
        return null;
    }

    return {
        id: build.id as number,
        prNumber: expected.prNumber,
        definitionId: expected.definitionId,
        finishTime: build.finishTime,
    };
}

function tripleFrom(parameters: unknown): PublisherTriple | undefined {
    if (typeof parameters !== "object" || parameters === null) {
        return undefined;
    }

    const raw = parameters as Record<string, unknown>;
    const values = [raw.prNumber, raw.prCiRunId, raw.prCiDefinitionId].map((value) => (typeof value === "string" ? Number(value) : value));

    if (!values.every((value) => Number.isInteger(value) && (value as number) > 0)) {
        return undefined;
    }

    return { prNumber: values[0] as number, prCiRunId: values[1] as number, prCiDefinitionId: values[2] as number };
}

/**
 * Recover the parameters a publisher run was queued with.
 *
 * These are fixed by the server when the run is created and are not writable afterwards, which is
 * exactly why the poller keys its state on them. Two representations are tried because the two
 * Azure APIs expose them differently and neither is guaranteed across versions:
 *
 *   1. the Pipelines *runs* representation (`templateParameters`), and
 *   2. the Build representation (`templateParameters`, or the legacy stringified `parameters`).
 *
 * If neither yields the triple this returns undefined, and the caller fails the run rather than
 * guessing. Assuming "not yet published" would re-queue a credentialed pipeline on every tick
 * forever; assuming "already published" would silently drop reports. There is deliberately no
 * third fallback onto build tags or the build number: both are writable by identities a
 * pull-request job can reach, so trusting either would let a pull request forge its own state.
 */
export function resolveTriple(runRepresentation: unknown, buildRepresentation: unknown): PublisherTriple | undefined {
    const run = runRepresentation as { templateParameters?: unknown } | null | undefined;
    const fromRun = tripleFrom(run?.templateParameters);
    if (fromRun) {
        return fromRun;
    }

    const build = buildRepresentation as { templateParameters?: unknown; parameters?: unknown } | null | undefined;
    const fromBuild = tripleFrom(build?.templateParameters);
    if (fromBuild) {
        return fromBuild;
    }

    if (typeof build?.parameters === "string") {
        try {
            return tripleFrom(JSON.parse(build.parameters));
        } catch {
            return undefined;
        }
    }

    return undefined;
}

function normalizeResult(result: unknown): JobResult {
    // `succeededWithIssues` is a *success*. Azure returns it whenever a step with
    // `continueOnError: true` fails, and `PostApiComment` reaches that state on
    // every pull request that did not move the public API: PR CI stages the
    // `api-comment` artifact only when there is a diff, so the download step
    // warns and the job finishes with issues.
    //
    // Reading it as anything else is not a small mistake. `decideAction` would
    // see the API axis as unpublished, re-queue the credentialed publisher three
    // times per PR CI build, and then fail the tick — permanently, on almost
    // every pull request. Where the API comment *was* posted, the re-queue would
    // also re-run a create-only task and duplicate it, which is the exact failure
    // this change exists to remove.
    if (result === "succeeded" || result === "succeededWithIssues" || result === "partiallySucceeded") {
        return "succeeded";
    }
    if (result === "failed" || result === "canceled" || result === "abandoned") {
        return "failed";
    }
    if (result === "skipped") {
        return "skipped";
    }
    return "unknown";
}

/**
 * Read the two comment jobs' outcomes out of a publisher run's timeline.
 *
 * Job-level rather than run-level, and that is the point of splitting the publisher's comment
 * job in two. The run also contains the release-marker label check, which is a real control that
 * is supposed to fail loudly on a mislabelled pull request. Keying retries on the run result
 * would tie comment reconciliation to that check — either retrying comments forever because
 * labels are wrong, or having to disable the label check to make comments work.
 */
export function jobResultsFromTimeline(timeline: unknown): { api: JobResult; bundle: JobResult } {
    const records = (timeline as { records?: unknown } | null)?.records;
    const list = Array.isArray(records) ? (records as Array<Record<string, unknown>>) : [];

    const find = (identifier: string): JobResult => {
        const record = list.find((entry) => entry.type === "Job" && entry.identifier === identifier);
        return record ? normalizeResult(record.result) : "unknown";
    };

    return { api: find("PostApiComment"), bundle: find("PostBundleComment") };
}

/**
 * Decide what, if anything, to queue for one PR CI build.
 *
 * Success is per axis and is only ever recorded by an actual `succeeded` job result, so a run
 * that was queued with an axis switched off leaves that axis exactly as it was.
 */
export function decideAction(history: PublisherRunHistory[]): Decision {
    if (history.some((run) => !run.finished)) {
        return { kind: "in-flight" };
    }

    const apiDone = history.some((run) => run.apiJobResult === "succeeded");
    const bundleDone = history.some((run) => run.bundleJobResult === "succeeded");

    if (apiDone && bundleDone) {
        return { kind: "done" };
    }

    if (history.length >= MAX_ATTEMPTS) {
        return { kind: "exhausted", attempts: history.length };
    }

    return { kind: "queue", postApiComment: !apiDone, postBundleComment: !bundleDone };
}

/**
 * One tick.
 *
 * Ordering is oldest-finished-first so that when the per-tick cap bites, the backlog drains in
 * the order it accumulated rather than by pull-request number.
 */
export async function poll(api: PollerApi): Promise<PollSummary> {
    if (await api.otherPollerRunInProgress()) {
        console.log("Another poller run is already in progress; exiting so the two cannot race.");
        return { skipped: true, considered: 0, queued: [], exhausted: [] };
    }

    const open = await api.listOpenPullRequests();
    if (!open.complete) {
        throw new Error("Could not enumerate every open pull request; refusing to act on a partial listing.");
    }
    if (open.numbers.length > MAX_OPEN_PULL_REQUESTS) {
        throw new Error(`${open.numbers.length} open pull requests exceeds the ${MAX_OPEN_PULL_REQUESTS} cap; refusing to truncate the reconciliation set.`);
    }

    const candidates: VerifiedBuild[] = [];
    for (const prNumber of open.numbers) {
        const build = await api.latestCompletedPrCiBuild(prNumber);
        if (build) {
            candidates.push(build);
        }
    }
    candidates.sort((a, b) => (a.finishTime === b.finishTime ? a.id - b.id : a.finishTime < b.finishTime ? -1 : 1));

    const queued: QueueRequest[] = [];
    const exhausted: PublisherTriple[] = [];

    for (const candidate of candidates) {
        const triple: PublisherTriple = { prNumber: candidate.prNumber, prCiRunId: candidate.id, prCiDefinitionId: candidate.definitionId };

        if (queued.length >= MAX_QUEUE_PER_TICK) {
            console.log(`Reached the ${MAX_QUEUE_PER_TICK}-queue cap for this tick; PR ${candidate.prNumber} will be picked up next tick.`);
            break;
        }

        const decision = decideAction(await api.publisherRunsFor(triple));
        if (decision.kind === "queue") {
            const request: QueueRequest = { ...triple, postApiComment: decision.postApiComment, postBundleComment: decision.postBundleComment };
            const runId = await api.queuePublisher(request);
            queued.push(request);
            console.log(`Queued publisher run ${runId} for PR ${triple.prNumber} build ${triple.prCiRunId} (api=${request.postApiComment}, bundle=${request.postBundleComment}).`);
        } else if (decision.kind === "exhausted") {
            console.error(`PR ${triple.prNumber} build ${triple.prCiRunId} has failed to publish ${decision.attempts} times; not retrying.`);
            exhausted.push(triple);
        }
    }

    if (exhausted.length > 0) {
        // Reported by failing the tick, not by a log line nobody reads. Everything above has
        // already been queued, so escalating here costs no progress.
        throw new Error(`${exhausted.length} pull request(s) exceeded ${MAX_ATTEMPTS} publish attempts: ${exhausted.map((t) => `#${t.prNumber}`).join(", ")}.`);
    }

    return { skipped: false, considered: candidates.length, queued, exhausted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

export type Auth = { scheme: "Bearer"; token: string } | { scheme: "Basic"; token: string };

export type JsonFetcher = (method: string, url: string, auth: Auth, body?: unknown) => Promise<{ json: unknown; link: string | null }>;

const GITHUB_API = "https://api.github.com";
const API_VERSION = "api-version=7.1";
const FETCH_ATTEMPTS = 3;

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

export const httpJson: JsonFetcher = async (method, url, auth, body) => {
    let response: Response | undefined;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
        response = await fetch(url, {
            method,
            headers: {
                Accept: "application/json",
                Authorization: auth.scheme === "Bearer" ? `Bearer ${auth.token}` : `Basic ${Buffer.from(`:${auth.token}`).toString("base64")}`,
                "User-Agent": "babylon-lite-pr-comment-poller",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        if (response.ok || (response.status !== 429 && response.status < 500) || attempt === FETCH_ATTEMPTS) {
            break;
        }
        await response.body?.cancel();
        console.warn(`${method} returned ${response.status}; retrying (${attempt}/${FETCH_ATTEMPTS}).`);
        await new Promise((done) => setTimeout(done, attempt * 500));
    }

    if (!response!.ok) {
        throw new Error(`${method} ${url} failed with ${response!.status} ${response!.statusText}.`);
    }

    return { json: await response!.json(), link: response!.headers.get("link") };
};

export interface PollerConfig {
    collectionUri: string;
    projectId: string;
    repository: string;
    prCiDefinitionId: number;
    publisherDefinitionId: number;
    pollerDefinitionId: number;
    selfBuildId: number;
    readAuth: Auth;
    queueAuth: Auth;
    metadataAuth: Auth;
}

export class AzurePollerApi implements PollerApi {
    constructor(
        private readonly config: PollerConfig,
        private readonly fetchJson: JsonFetcher = httpJson
    ) {}

    private buildsUrl(query: string): string {
        return `${this.config.collectionUri}${this.config.projectId}/_apis/build/builds?${query}&${API_VERSION}`;
    }

    async listOpenPullRequests(): Promise<{ numbers: number[]; complete: boolean }> {
        const numbers: number[] = [];
        let url: string | undefined = `${GITHUB_API}/repos/${this.config.repository}/pulls?state=open&per_page=100`;

        for (let page = 0; page < MAX_PULL_REQUEST_PAGES && url; page++) {
            const { json, link } = await this.fetchJson("GET", url, this.config.metadataAuth);
            if (!Array.isArray(json)) {
                throw new Error("GitHub pull-request listing did not return an array.");
            }
            for (const entry of json as Array<{ number?: unknown }>) {
                if (!Number.isInteger(entry.number) || (entry.number as number) <= 0) {
                    throw new Error("GitHub pull-request listing contained an entry without a positive numeric number.");
                }
                numbers.push(entry.number as number);
            }
            url = nextPageUrl(link);
        }

        return { numbers, complete: url === undefined };
    }

    async latestCompletedPrCiBuild(prNumber: number): Promise<VerifiedBuild | null> {
        const query = [
            `definitions=${this.config.prCiDefinitionId}`,
            `branchName=${encodeURIComponent(`refs/pull/${prNumber}/merge`)}`,
            "statusFilter=completed",
            "queryOrder=finishTimeDescending",
            "$top=1",
        ].join("&");

        const { json } = await this.fetchJson("GET", this.buildsUrl(query), this.config.readAuth);
        const [build] = ((json as { value?: unknown })?.value as unknown[]) ?? [];
        if (build === undefined) {
            return null;
        }

        return verifyPrCiBuild(build, { prNumber, definitionId: this.config.prCiDefinitionId });
    }

    async publisherRunsFor(triple: PublisherTriple): Promise<PublisherRunHistory[]> {
        // `buildNumber` is an index, not evidence. Every hit is re-confirmed below against the
        // run's queue-time parameters, so a rewritten build number can only cost an extra queue.
        const query = [`definitions=${this.config.publisherDefinitionId}`, `buildNumber=${encodeURIComponent(`blp-${triple.prNumber}-${triple.prCiRunId}-*`)}`].join("&");
        const { json } = await this.fetchJson("GET", this.buildsUrl(query), this.config.readAuth);
        const builds = ((json as { value?: unknown })?.value as Array<Record<string, unknown>>) ?? [];

        const history: PublisherRunHistory[] = [];
        for (const build of builds.slice(0, MAX_PUBLISHER_RUNS_PER_TRIPLE)) {
            if (!Number.isInteger(build.id)) {
                continue;
            }
            const runId = build.id as number;

            // The primary representation is tried first and its failure is reported rather than
            // hidden, but it is not fatal on its own: the Build representation below carries the
            // same server-owned values, and only the loss of *both* is unrecoverable.
            let runRepresentation: unknown;
            try {
                runRepresentation = (
                    await this.fetchJson(
                        "GET",
                        `${this.config.collectionUri}${this.config.projectId}/_apis/pipelines/${this.config.publisherDefinitionId}/runs/${runId}?${API_VERSION}`,
                        this.config.readAuth
                    )
                ).json;
            } catch (error) {
                console.warn(`Pipelines run representation unavailable for publisher run ${runId}: ${(error as Error).message}`);
            }

            const resolved = resolveTriple(runRepresentation, build);
            if (!resolved) {
                throw new Error(
                    `Publisher run ${runId} exposes no queue-time parameters through either the Pipelines run or Build representation; ` +
                        "refusing to guess at publish state. See TESTING.md, \u201cPR comment poller\u201d."
                );
            }

            if (resolved.prNumber !== triple.prNumber || resolved.prCiRunId !== triple.prCiRunId || resolved.prCiDefinitionId !== triple.prCiDefinitionId) {
                console.log(`Ignoring publisher run ${runId}: its parameters name a different build.`);
                continue;
            }

            const finished = build.status === "completed";
            const timeline = finished
                ? await this.fetchJson(
                      "GET",
                      `${this.config.collectionUri}${this.config.projectId}/_apis/build/builds/${runId}/timeline?${API_VERSION}`,
                      this.config.readAuth
                  ).then((response) => response.json)
                : undefined;
            const results = finished ? jobResultsFromTimeline(timeline) : { api: "unknown" as JobResult, bundle: "unknown" as JobResult };

            history.push({ runId, finished, apiJobResult: results.api, bundleJobResult: results.bundle });
        }

        return history;
    }

    async otherPollerRunInProgress(): Promise<boolean> {
        const query = [`definitions=${this.config.pollerDefinitionId}`, "statusFilter=inProgress"].join("&");
        const { json } = await this.fetchJson("GET", this.buildsUrl(query), this.config.readAuth);
        const builds = ((json as { value?: unknown })?.value as Array<{ id?: unknown }>) ?? [];
        return builds.some((build) => Number.isInteger(build.id) && (build.id as number) < this.config.selfBuildId);
    }

    async queuePublisher(request: QueueRequest): Promise<number> {
        const { json } = await this.fetchJson(
            "POST",
            `${this.config.collectionUri}${this.config.projectId}/_apis/pipelines/${this.config.publisherDefinitionId}/runs?${API_VERSION}`,
            this.config.queueAuth,
            {
                // Pinned explicitly. The publisher's credentials are branch-controlled to master,
                // and a run compiled from any other ref would be refused them anyway — but saying
                // so here means the queue call cannot be quietly repointed by a default.
                resources: { repositories: { self: { refName: "refs/heads/master" } } },
                templateParameters: {
                    prNumber: request.prNumber,
                    prCiRunId: request.prCiRunId,
                    prCiDefinitionId: request.prCiDefinitionId,
                    postComments: true,
                    postApiComment: request.postApiComment,
                    postBundleComment: request.postBundleComment,
                },
            }
        );

        const runId = (json as { id?: unknown })?.id;
        if (!Number.isInteger(runId)) {
            throw new Error("Queueing the publisher did not return a numeric run id.");
        }
        return runId as number;
    }
}

async function main(): Promise<void> {
    const repository = requireEnv("GITHUB_REPOSITORY");
    if (repository !== EXPECTED_REPOSITORY) {
        throw new Error(`Refusing to poll ${repository}; this definition only reconciles ${EXPECTED_REPOSITORY}.`);
    }

    const config: PollerConfig = {
        collectionUri: requireEnv("SYSTEM_COLLECTIONURI"),
        projectId: requireEnv("SYSTEM_TEAMPROJECTID"),
        repository,
        prCiDefinitionId: requirePositiveInteger("PR_CI_DEFINITION_ID"),
        publisherDefinitionId: requirePositiveInteger("PUBLISHER_DEFINITION_ID"),
        pollerDefinitionId: requirePositiveInteger("POLLER_DEFINITION_ID"),
        selfBuildId: requirePositiveInteger("BUILD_BUILDID"),
        readAuth: { scheme: "Bearer", token: requireEnv("SYSTEM_ACCESSTOKEN") },
        queueAuth: { scheme: "Basic", token: requireEnv("PR_PUBLISH_QUEUE_TOKEN") },
        metadataAuth: { scheme: "Bearer", token: requireEnv("PR_METADATA_TOKEN") },
    };

    const summary = await poll(new AzurePollerApi(config));
    console.log(`Considered ${summary.considered} pull request(s); queued ${summary.queued.length} publisher run(s).`);
}

if (require.main === module) {
    void main().catch((error: Error) => {
        console.error(error.message);
        process.exit(1);
    });
}
