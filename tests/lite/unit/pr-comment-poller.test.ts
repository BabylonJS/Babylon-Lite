/**
 * The scheduled poller, from the outside.
 *
 * This is the piece that replaced a pipeline completion trigger. The trigger was rejected because
 * for two pipelines in the same repository Azure runs the triggered pipeline on the *triggering*
 * run's branch — so a pull-request build would have made the credentialed publisher's YAML come
 * from `refs/pull/<n>/merge`. The poller runs on master instead, reads build metadata, and queues
 * the publisher itself.
 *
 * That buys safety and costs the trigger's one genuine virtue: it could not miss a run. So the two
 * things worth proving here are that the poller cannot miss one either, and that nothing it *reads*
 * can talk it into queueing the wrong thing.
 *
 * The design has no watermark and no time window on purpose. An earlier revision scanned "builds
 * finished in the last seven days", which loses runs across an outage longer than the window and
 * never sees an old-but-still-open pull request at all. What replaced it derives the desired state:
 * for every currently open pull request, find the latest completed CI run, and compare it against
 * what the publisher has already done. A restart, a week of downtime and a brand-new definition all
 * converge on the first tick, so several tests below deliberately start from an empty history.
 */
import { describe, expect, it, vi } from "vitest";

import {
    MAX_ATTEMPTS,
    MAX_OPEN_PULL_REQUESTS,
    MAX_QUEUE_PER_TICK,
    EXPECTED_REPOSITORY,
    verifyPrCiBuild,
    resolveTriple,
    jobResultsFromTimeline,
    AzurePollerApi,
    decideAction,
    poll,
    nextPageUrl,
    type PollerApi,
    type PublisherRunHistory,
    type PublisherTriple,
    type QueueRequest,
    type VerifiedBuild,
} from "../../../scripts/poll-pr-comment-reconcile";

const PR_CI_DEFINITION = 12;

/** A build as the ADO Builds API returns it for a pull-request run of PR CI. */
function adoBuild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 5000,
        definition: { id: PR_CI_DEFINITION },
        reason: "pullRequest",
        status: "completed",
        sourceBranch: "refs/pull/42/merge",
        finishTime: "2024-05-01T10:00:00Z",
        repository: { type: "GitHub", name: EXPECTED_REPOSITORY },
        ...overrides,
    };
}

function verified(prNumber: number, id: number, finishTime = "2024-05-01T10:00:00Z"): VerifiedBuild {
    return { id, prNumber, definitionId: PR_CI_DEFINITION, finishTime };
}

/** A poller API with nothing open and nothing published; each test overrides only what it needs. */
function fakeApi(overrides: Partial<PollerApi> = {}): PollerApi & { queued: QueueRequest[] } {
    const queued: QueueRequest[] = [];
    return {
        queued,
        listOpenPullRequests: () => Promise.resolve({ numbers: [], complete: true }),
        latestCompletedPrCiBuild: () => Promise.resolve(null),
        publisherRunsFor: () => Promise.resolve([]),
        otherPollerRunInProgress: () => Promise.resolve(false),
        queuePublisher: (request: QueueRequest) => {
            queued.push(request);
            return Promise.resolve(9000 + queued.length);
        },
        ...overrides,
    };
}

function history(overrides: Partial<PublisherRunHistory> = {}): PublisherRunHistory {
    return { runId: 1, finished: true, apiJobResult: "succeeded", bundleJobResult: "succeeded", ...overrides };
}

describe("a build is only a candidate if the server says it is this pull request's CI run", () => {
    it("accepts a completed pull-request run of the expected definition", () => {
        expect(verifyPrCiBuild(adoBuild(), { prNumber: 42, definitionId: PR_CI_DEFINITION })).toEqual({
            id: 5000,
            prNumber: 42,
            definitionId: PR_CI_DEFINITION,
            finishTime: "2024-05-01T10:00:00Z",
        });
    });

    it.each([
        ["a different definition", { definition: { id: 999 } }],
        ["a manual queue rather than a pull request", { reason: "manual" }],
        ["a run that has not finished", { status: "inProgress" }],
        ["the head ref instead of the merge ref", { sourceBranch: "refs/pull/42/head" }],
        ["another pull request's merge ref", { sourceBranch: "refs/pull/43/merge" }],
        ["a ref that merely starts with the expected one", { sourceBranch: "refs/pull/42/merge-evil" }],
        ["a ref with a trailing newline", { sourceBranch: "refs/pull/42/merge\n" }],
        ["a non-GitHub repository", { repository: { type: "TfsGit", name: EXPECTED_REPOSITORY } }],
        ["a fork or lookalike repository", { repository: { type: "GitHub", name: "attacker/Babylon-Lite" } }],
        ["no repository at all", { repository: undefined }],
        ["a non-numeric build id", { id: "5000" }],
    ])("rejects %s", (_label, overrides) => {
        expect(verifyPrCiBuild(adoBuild(overrides), { prNumber: 42, definitionId: PR_CI_DEFINITION })).toBeNull();
    });

    it("rejects anything that is not a build object", () => {
        for (const raw of [null, undefined, "build", 42, []]) {
            expect(verifyPrCiBuild(raw, { prNumber: 42, definitionId: PR_CI_DEFINITION })).toBeNull();
        }
    });
});

describe("prior publish attempts are matched on the immutable queue-time parameters", () => {
    const triple = { prNumber: 42, prCiRunId: 5000, prCiDefinitionId: PR_CI_DEFINITION };

    it("prefers the Pipelines run representation", () => {
        expect(resolveTriple({ templateParameters: { prNumber: 42, prCiRunId: 5000, prCiDefinitionId: PR_CI_DEFINITION } }, undefined)).toEqual(triple);
    });

    it("falls back to the Build representation when the primary omits the parameters", () => {
        expect(resolveTriple({ templateParameters: {} }, { templateParameters: { prNumber: 42, prCiRunId: 5000, prCiDefinitionId: PR_CI_DEFINITION } })).toEqual(triple);
        // Older API versions return the same values as a JSON *string*.
        expect(resolveTriple(undefined, { parameters: JSON.stringify({ prNumber: 42, prCiRunId: 5000, prCiDefinitionId: PR_CI_DEFINITION }) })).toEqual(triple);
    });

    it("accepts the numbers as strings, which is how Azure echoes them back", () => {
        expect(resolveTriple({ templateParameters: { prNumber: "42", prCiRunId: "5000", prCiDefinitionId: String(PR_CI_DEFINITION) } }, undefined)).toEqual(triple);
    });

    it("returns nothing when neither representation carries the triple", () => {
        // The caller turns this into a visible failure that queues nothing. There is deliberately
        // no third fallback: build *tags* would work, and are writable by the Build Service
        // identities pull-request YAML can reach, so a pull request could forge "already
        // published" and suppress its own report.
        expect(resolveTriple(undefined, undefined)).toBeUndefined();
        expect(resolveTriple({ templateParameters: { prNumber: 42 } }, { templateParameters: { prCiRunId: 5000 } })).toBeUndefined();
        expect(resolveTriple({ templateParameters: { prNumber: 0, prCiRunId: 5000, prCiDefinitionId: 1 } }, undefined)).toBeUndefined();
        expect(resolveTriple({ templateParameters: { prNumber: "4 2", prCiRunId: 5000, prCiDefinitionId: 1 } }, undefined)).toBeUndefined();
        expect(resolveTriple({ templateParameters: null }, { parameters: "not json" })).toBeUndefined();
    });
});

describe("publish outcomes are read per comment path, from the job that owns it", () => {
    function timeline(records: Array<{ type: string; identifier?: string; result?: string | null; state?: string }>): unknown {
        return { records };
    }

    it("reads the two comment jobs independently", () => {
        const results = jobResultsFromTimeline(
            timeline([
                { type: "Job", identifier: "PostApiComment", result: "succeeded", state: "completed" },
                { type: "Job", identifier: "PostBundleComment", result: "failed", state: "completed" },
            ])
        );
        expect(results).toEqual({ api: "succeeded", bundle: "failed" });
    });

    it("ignores tasks and unrelated jobs, so an unrelated failure cannot look like a publish result", () => {
        // `ReleaseMarkerLabels` fails loudly and often — on purpose. It must not be able to make a
        // successful comment publish look unsuccessful, or vice versa.
        const results = jobResultsFromTimeline(
            timeline([
                { type: "Job", identifier: "ReleaseMarkerLabels", result: "failed", state: "completed" },
                { type: "Task", identifier: "PostBundleComment", result: "succeeded", state: "completed" },
                { type: "Job", identifier: "PostApiComment", result: "succeeded", state: "completed" },
            ])
        );
        expect(results).toEqual({ api: "succeeded", bundle: "unknown" });
    });

    it("counts an API job that finished with issues as published, but not a bundle job", () => {
        // `succeededWithIssues` is what Azure reports when a `continueOnError` step fails, and
        // `PostApiComment` lands there on every pull request that does not move the public API:
        // PR CI stages `api-comment` only when there is a diff, so the download warns.
        //
        // Reading it as anything but success is not a corner case. `decideAction` would treat the
        // API comment as unpublished on almost every pull request, re-queue the credentialed
        // publisher until the attempt budget ran out, fail the tick, and — where the comment had
        // in fact been posted — duplicate it through a create-only task.
        // The two axes read the same string oppositely, and both readings are forced.
        //
        // API: `GitHubComment@0` cannot update, so a re-queue duplicates the comment. Its download
        // legitimately warns on every pull request that did not move the public API, because PR CI
        // stages `api-comment` only when there is a diff. Terminal.
        //
        // Bundle: retrying is idempotent and cheap, while accepting a false success freezes a stale
        // comment on the latest build — the #627 defect itself. Not terminal.
        const results = jobResultsFromTimeline(
            timeline([
                { type: "Job", identifier: "PostApiComment", result: "succeededWithIssues", state: "completed" },
                { type: "Job", identifier: "PostBundleComment", result: "succeededWithIssues", state: "completed" },
            ])
        );
        expect(results).toEqual({ api: "succeeded", bundle: "failed" });

        expect(jobResultsFromTimeline(timeline([{ type: "Job", identifier: "PostBundleComment", result: "partiallySucceeded", state: "completed" }])).bundle).toBe("failed");
        expect(jobResultsFromTimeline(timeline([{ type: "Job", identifier: "PostBundleComment", result: "succeeded", state: "completed" }])).bundle).toBe("succeeded");
    });

    it("retries a bundle job that only warned, so a failed artifact download cannot retire as published", () => {
        // The concrete regression: a transient `DownloadPipelineArtifact` failure used to leave the
        // directory absent, the reconciler no-opped, and the warning-level job result marked the
        // bundle axis done forever against the latest build.
        const results = jobResultsFromTimeline(
            timeline([
                { type: "Job", identifier: "PostApiComment", result: "succeeded", state: "completed" },
                { type: "Job", identifier: "PostBundleComment", result: "succeededWithIssues", state: "completed" },
            ])
        );

        expect(decideAction([{ runId: 1, finished: true, apiJobResult: results.api, bundleJobResult: results.bundle }])).toEqual({
            kind: "queue",
            postApiComment: false,
            postBundleComment: true,
        });
    });

    it("requires exactly one job record per axis and refuses to guess between duplicates", () => {
        expect(() =>
            jobResultsFromTimeline(
                timeline([
                    { type: "Job", identifier: "PostBundleComment", result: "succeeded", state: "completed" },
                    { type: "Job", identifier: "PostBundleComment", result: "failed", state: "completed" },
                ])
            )
        ).toThrow(/refusing to guess/i);
    });

    it("tolerates the shapes a timeline response can legitimately take", () => {
        expect(jobResultsFromTimeline({})).toEqual({ api: "unknown", bundle: "unknown" });
        expect(jobResultsFromTimeline({ records: null })).toEqual({ api: "unknown", bundle: "unknown" });
        expect(jobResultsFromTimeline({ records: "nope" })).toEqual({ api: "unknown", bundle: "unknown" });
        expect(jobResultsFromTimeline(null)).toEqual({ api: "unknown", bundle: "unknown" });
        // A phase/stage record sharing the identifier must not be mistaken for the job.
        expect(jobResultsFromTimeline(timeline([{ type: "Phase", identifier: "PostBundleComment", result: "succeeded" }])).bundle).toBe("unknown");
    });

    it("does not queue anything for a build whose API job only warned", () => {
        // The same fact stated where it bites: end to end, through the decision.
        const results = jobResultsFromTimeline(
            timeline([
                { type: "Job", identifier: "PostApiComment", result: "succeededWithIssues", state: "completed" },
                { type: "Job", identifier: "PostBundleComment", result: "succeeded", state: "completed" },
            ])
        );

        expect(decideAction([{ runId: 1, finished: true, apiJobResult: results.api, bundleJobResult: results.bundle }])).toEqual({ kind: "done" });
    });

    it("reports a job that was never scheduled as unknown rather than as done", () => {
        expect(jobResultsFromTimeline(timeline([]))).toEqual({ api: "unknown", bundle: "unknown" });
        expect(jobResultsFromTimeline(undefined)).toEqual({ api: "unknown", bundle: "unknown" });
        expect(jobResultsFromTimeline(timeline([{ type: "Job", identifier: "PostBundleComment", result: null, state: "inProgress" }])).bundle).toBe("unknown");
    });
});

describe("the per-axis decision never re-posts a create-only comment and never gives up quietly", () => {
    it("queues both paths for a build nothing has published yet", () => {
        expect(decideAction([])).toEqual({ kind: "queue", postApiComment: true, postBundleComment: true });
    });

    it("retries only the path that failed", () => {
        // This is the whole reason the publisher's single comment job was split. `GitHubComment@0`
        // is create-only, so retrying a failed bundle post in the same job as the API post would
        // add a second API comment every time.
        expect(decideAction([history({ apiJobResult: "succeeded", bundleJobResult: "failed" })])).toEqual({ kind: "queue", postApiComment: false, postBundleComment: true });
        expect(decideAction([history({ apiJobResult: "failed", bundleJobResult: "succeeded" })])).toEqual({ kind: "queue", postApiComment: true, postBundleComment: false });
    });

    it("counts a success from any earlier attempt", () => {
        const attempts = [history({ runId: 1, apiJobResult: "succeeded", bundleJobResult: "failed" }), history({ runId: 2, apiJobResult: "skipped", bundleJobResult: "failed" })];
        expect(decideAction(attempts)).toEqual({ kind: "queue", postApiComment: false, postBundleComment: true });
    });

    it("treats only an actual success as done", () => {
        // A job that was switched off is `skipped`, not `succeeded`. Reading it as done would drop
        // the comment silently.
        for (const result of ["failed", "skipped", "unknown", "canceled"] as const) {
            expect(decideAction([history({ bundleJobResult: result as PublisherRunHistory["bundleJobResult"] })]).kind).toBe("queue");
        }
        expect(decideAction([history()])).toEqual({ kind: "done" });
    });

    it("waits rather than racing a run that is still going", () => {
        expect(decideAction([history({ finished: false, apiJobResult: "unknown", bundleJobResult: "unknown" })])).toEqual({ kind: "in-flight" });
    });

    it("stops after a bounded number of attempts, and says so", () => {
        const failures = Array.from({ length: MAX_ATTEMPTS }, (_, index) => history({ runId: index + 1, apiJobResult: "failed", bundleJobResult: "failed" }));
        expect(decideAction(failures)).toEqual({ kind: "exhausted", attempts: MAX_ATTEMPTS });
    });
});

describe("a tick reconciles every open pull request, or fails without acting", () => {
    it("queues the latest completed run of each open pull request", async () => {
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers: [7, 9], complete: true }),
            latestCompletedPrCiBuild: (pr: number) => Promise.resolve(verified(pr, pr === 7 ? 100 : 200, pr === 7 ? "2024-05-01T09:00:00Z" : "2024-05-01T10:00:00Z")),
        });

        const summary = await poll(api);

        expect(summary.skipped).toBe(false);
        expect(api.queued.map((request) => request.prNumber)).toEqual([7, 9]);
        expect(api.queued.every((request) => request.postApiComment && request.postBundleComment)).toBe(true);
    });

    it("needs no watermark: a brand-new poller picks up an old pull request's latest run", async () => {
        // The case the seven-day window got wrong. The pull request was opened months ago and its
        // last push was weeks ago; a window-based scan would never see it.
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers: [3], complete: true }),
            latestCompletedPrCiBuild: () => Promise.resolve(verified(3, 42, "2023-01-01T00:00:00Z")),
        });

        await poll(api);

        expect(api.queued).toHaveLength(1);
        expect(api.queued[0]?.prCiRunId).toBe(42);
    });

    it("skips a pull request that has no completed CI run", async () => {
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers: [1, 2], complete: true }),
            latestCompletedPrCiBuild: (pr: number) => Promise.resolve(pr === 1 ? verified(1, 10) : null),
        });

        const summary = await poll(api);

        expect(summary.considered).toBe(1);
        expect(api.queued.map((request) => request.prNumber)).toEqual([1]);
    });

    it("queues nothing when it cannot prove it saw every open pull request", async () => {
        // Acting on a partial listing is how a pull request silently stops being reconciled.
        const api = fakeApi({ listOpenPullRequests: () => Promise.resolve({ numbers: [1], complete: false }) });

        await expect(poll(api)).rejects.toThrow(/every open pull request|partial/i);
        expect(api.queued).toEqual([]);
    });

    it("fails visibly rather than truncating when there are more open pull requests than it will handle", async () => {
        const numbers = Array.from({ length: MAX_OPEN_PULL_REQUESTS + 1 }, (_, index) => index + 1);
        const api = fakeApi({ listOpenPullRequests: () => Promise.resolve({ numbers, complete: true }) });

        await expect(poll(api)).rejects.toThrow(new RegExp(String(MAX_OPEN_PULL_REQUESTS)));
        expect(api.queued).toEqual([]);
    });

    it("exits without queueing when another tick is still running", async () => {
        const api = fakeApi({
            otherPollerRunInProgress: () => Promise.resolve(true),
            listOpenPullRequests: () => Promise.resolve({ numbers: [1], complete: true }),
        });

        const summary = await poll(api);

        expect(summary.skipped).toBe(true);
        expect(api.queued).toEqual([]);
    });

    it("drains the backlog oldest-first when the per-tick cap bites", async () => {
        const numbers = Array.from({ length: MAX_QUEUE_PER_TICK + 5 }, (_, index) => index + 1);
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers, complete: true }),
            // Higher pull-request numbers finished earlier, so ordering by number would be wrong.
            latestCompletedPrCiBuild: (pr: number) => Promise.resolve(verified(pr, 1000 + pr, `2024-05-${String(30 - pr).padStart(2, "0")}T00:00:00Z`)),
        });

        await poll(api);

        expect(api.queued).toHaveLength(MAX_QUEUE_PER_TICK);
        expect(api.queued[0]?.prNumber).toBe(numbers.length);
    });

    it("does not queue a build both paths have already published", async () => {
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers: [4], complete: true }),
            latestCompletedPrCiBuild: () => Promise.resolve(verified(4, 400)),
            publisherRunsFor: () => Promise.resolve([history()]),
        });

        await poll(api);

        expect(api.queued).toEqual([]);
    });

    it("is idempotent: a second tick over unchanged state queues nothing new", async () => {
        const published = new Map<number, PublisherRunHistory[]>();
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers: [4], complete: true }),
            latestCompletedPrCiBuild: () => Promise.resolve(verified(4, 400)),
            publisherRunsFor: (triple: PublisherTriple) => Promise.resolve(published.get(triple.prCiRunId) ?? []),
        });

        await poll(api);
        expect(api.queued).toHaveLength(1);
        published.set(400, [history()]);

        await poll(api);
        expect(api.queued).toHaveLength(1);
    });

    it("fails the tick when a pull request has exhausted its attempts, after queueing everything else", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const failures = Array.from({ length: MAX_ATTEMPTS }, (_, index) => history({ runId: index + 1, apiJobResult: "failed", bundleJobResult: "failed" }));
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers: [1, 2], complete: true }),
            latestCompletedPrCiBuild: (pr: number) => Promise.resolve(verified(pr, pr * 100, `2024-05-0${pr}T00:00:00Z`)),
            publisherRunsFor: (triple: PublisherTriple) => Promise.resolve(triple.prNumber === 1 ? failures : []),
        });

        // Escalating at the end rather than on the spot: the healthy pull request still gets its
        // comment, and the broken one is still loud.
        await expect(poll(api)).rejects.toThrow(/#1/);
        expect(api.queued.map((request) => request.prNumber)).toEqual([2]);
        error.mockRestore();
    });

    it("propagates a queue failure instead of recording a phantom publish", async () => {
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers: [1], complete: true }),
            latestCompletedPrCiBuild: () => Promise.resolve(verified(1, 100)),
            queuePublisher: () => Promise.reject(new Error("ADO POST /pipelines/9/runs failed: 403")),
        });

        await expect(poll(api)).rejects.toThrow(/could not be evaluated/i);
    });
});

describe("pagination stops where the server says it stops", () => {
    it("follows rel=next and nothing else", () => {
        expect(nextPageUrl('<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=5>; rel="last"')).toBe(
            "https://api.github.com/repositories/1/pulls?page=2"
        );
        expect(nextPageUrl('<https://api.github.com/repositories/1/pulls?page=1>; rel="prev"')).toBeUndefined();
        expect(nextPageUrl("")).toBeUndefined();
        expect(nextPageUrl(null)).toBeUndefined();
    });
});

describe("the concurrency guard asks the server about every run that has not finished yet", () => {
    /**
     * Exercised through the real `AzurePollerApi` against a recording fetcher, because the
     * behaviour under test *is* the query string. A hand-written boolean fake would assert only
     * that the poller calls a method it was always going to call.
     */
    function recordingApi(response: unknown = { value: [] }): { api: AzurePollerApi; urls: string[] } {
        const urls: string[] = [];
        const config = {
            collectionUri: "https://dev.azure.com/babylonjs/",
            projectId: "proj",
            repository: "BabylonJS/Babylon-Lite",
            prCiDefinitionId: 48,
            publisherDefinitionId: 60,
            pollerDefinitionId: 61,
            selfBuildId: 777,
            readAuth: { scheme: "Bearer", token: "r" } as const,
            queueAuth: { scheme: "Basic", token: "q" } as const,
            metadataAuth: { scheme: "Bearer", token: "m" } as const,
        };
        const api = new AzurePollerApi(config, (_method: string, url: string) => {
            urls.push(url);
            return Promise.resolve({ json: response, link: null });
        });
        return { api, urls };
    }

    it("filters on every pre-completion status, not just inProgress", async () => {
        // A tick that is still queued is the likeliest overlap of all: on a busy pool a run can sit
        // in `notStarted` longer than it spends running. Two ticks that each believe they are alone
        // queue the same publisher twice.
        const { api, urls } = recordingApi();
        await api.otherPollerRunInProgress();

        expect(urls).toHaveLength(1);
        const query = new URL(urls[0] ?? "").searchParams;
        expect(query.get("statusFilter")?.split(",").sort()).toEqual(["cancelling", "inProgress", "notStarted", "postponed"]);
        expect(query.get("definitions")).toBe("61");
    });

    it("ignores itself and yields to an older run only", async () => {
        const older = recordingApi({ value: [{ id: 100 }] });
        expect(await older.api.otherPollerRunInProgress()).toBe(true);

        const itself = recordingApi({ value: [{ id: 777 }] });
        expect(await itself.api.otherPollerRunInProgress()).toBe(false);

        const newer = recordingApi({ value: [{ id: 999 }] });
        expect(await newer.api.otherPollerRunInProgress(), "a newer run must defer to this one, not the other way round").toBe(false);
    });
});

describe("one unreadable pull request does not decide anything for the others", () => {
    it("queues the healthy pull requests, queues nothing for the broken one, and still fails the tick", async () => {
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers: [1, 2, 3], complete: true }),
            latestCompletedPrCiBuild: (prNumber: number) => Promise.resolve(verified(prNumber, 100 + prNumber)),
            publisherRunsFor: (triple) => {
                if (triple.prNumber === 2) {
                    // The shape the fail-closed rule exists for: a candidate whose immutable
                    // queue-time triple neither API representation will confirm.
                    return Promise.reject(new Error("Publisher run 500 exposes no queue-time parameters."));
                }
                return Promise.resolve([]);
            },
        });

        await expect(poll(api)).rejects.toThrow(/#2/);

        // Fail-closed for #2 specifically: nothing queued for it, because without confirmed history
        // the poller cannot tell an unpublished build from a published one, and guessing would
        // duplicate the create-only API comment.
        expect(api.queued.map((request) => request.prNumber).sort()).toEqual([1, 3]);
    });

    it("reports an exhausted pull request and an unreadable one in the same tick", async () => {
        const api = fakeApi({
            listOpenPullRequests: () => Promise.resolve({ numbers: [1, 2], complete: true }),
            latestCompletedPrCiBuild: (prNumber: number) => Promise.resolve(verified(prNumber, 100 + prNumber)),
            publisherRunsFor: (triple) => {
                if (triple.prNumber === 1) {
                    return Promise.reject(new Error("timeline unreadable"));
                }
                return Promise.resolve([history({ bundleJobResult: "failed" }), history({ bundleJobResult: "failed" }), history({ bundleJobResult: "failed" })]);
            },
        });

        await expect(poll(api)).rejects.toThrow(/exceeded 3 publish attempts.*could not be evaluated/s);
        expect(api.queued).toEqual([]);
    });
});
