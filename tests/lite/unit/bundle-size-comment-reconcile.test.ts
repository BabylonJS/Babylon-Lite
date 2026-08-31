/**
 * The sticky bundle-size comment, from the outside.
 *
 * Issue #627: the bundle-size comment used to be posted by `GitHubComment@0`, which can only
 * create. Every push to a pull request added another comment, and none of them was ever retracted
 * when the regression was fixed — a reviewer scrolling a long pull request could not tell which
 * report was current, or whether the top one still applied.
 *
 * The replacement is a state machine, and it runs on a credentialed agent with a GitHub token that
 * can write to any comment in the repository. So the assertions here are of two kinds, and both
 * matter:
 *
 *   * that it converges — create once, update in place, retract when the regression clears, and
 *     stay silent on pull requests that were never notable;
 *   * that untrusted artifact bytes cannot steer it — cannot forge the marker that decides which
 *     comment is canonical, cannot make it adopt a comment it does not own, and cannot push it into
 *     a state where it refuses to work again.
 *
 * The fake API below is deliberately literal: it stores bodies verbatim, so a test that posts a
 * malicious body and then reconciles *again* is genuinely re-parsing what GitHub would have stored.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
    EXPECTED_REPOSITORY,
    MARKER_PREFIX,
    SUPERSEDED_MARKER_PREFIX,
    MAX_ARTIFACT_BYTES,
    formatMarker,
    parseMarkerLine,
    sanitizeArtifactBody,
    parseBundleCommentState,
    loadStagedArtifact,
    ArtifactContractError,
    selectOwnedComments,
    reconcile,
    nextPageUrl,
    type IssueComment,
    type CommentPage,
    type GitHubCommentApi,
    type MarkerIdentity,
} from "../../../scripts/reconcile-bundle-size-comment";

const IDENTITY: MarkerIdentity = { repo: EXPECTED_REPOSITORY, pr: 42, definitionId: 7, buildId: 1234 };

const BOT_ID = 99;
const HUMAN_ID = 5;

/**
 * A GitHub issue-comments API that stores what it is given.
 *
 * `writes` is the assertion surface for the idempotency tests: "updated nothing" is only meaningful
 * if a no-op is observably distinct from an update that happens to produce the same bytes.
 */
class FakeApi implements GitHubCommentApi {
    public readonly writes: Array<{ kind: "create" | "update"; id?: number; body: string }> = [];
    public complete = true;
    private nextId = 1000;

    public constructor(public comments: IssueComment[] = []) {}

    public viewerId(): Promise<number> {
        return Promise.resolve(BOT_ID);
    }

    public listComments(): Promise<CommentPage> {
        return Promise.resolve({ comments: [...this.comments], complete: this.complete });
    }

    public createComment(_pullRequest: number, body: string): Promise<IssueComment> {
        const comment: IssueComment = { id: this.nextId++, body, user: { id: BOT_ID } };
        this.comments.push(comment);
        this.writes.push({ kind: "create", id: comment.id, body });
        return Promise.resolve(comment);
    }

    public updateComment(commentId: number, body: string): Promise<void> {
        const existing = this.comments.find((comment) => comment.id === commentId);
        if (!existing) {
            throw new Error(`test fake: no comment ${commentId}`);
        }
        existing.body = body;
        this.writes.push({ kind: "update", id: commentId, body });
        return Promise.resolve();
    }
}

/** A canonical comment as this module would have written it. */
function ownedComment(id: number, markdown = "current report", identity: MarkerIdentity = IDENTITY): IssueComment {
    return { id, body: `${formatMarker(identity)}\n${markdown}`, user: { id: BOT_ID } };
}

describe("the marker identifies exactly one comment and cannot be forged from artifact content", () => {
    it("round-trips the provenance triple it was built from", () => {
        const parsed = parseMarkerLine(formatMarker(IDENTITY));
        expect(parsed).toEqual(IDENTITY);
    });

    it("reads a marker only on the first line", () => {
        // Anchoring to the first line is what makes the API-report comment — same bot, same pull
        // request, body this repository does not control — structurally unable to be adopted.
        const marker = formatMarker(IDENTITY);
        expect(parseMarkerLine(marker)).not.toBeNull();
        expect(selectOwnedComments([{ id: 1, body: `Some heading\n${marker}\nbody`, user: { id: BOT_ID } }], BOT_ID, IDENTITY)).toEqual([]);
    });

    it("treats a payload it does not recognise as not-ours rather than as a fatal error", () => {
        // Failing soft here is deliberate. A corrupted marker costs one duplicate comment, which
        // the next run demotes; hard-failing on it would let one malformed body disable bundle-size
        // reporting for that pull request until somebody edited the comment by hand.
        for (const payload of ["", "null", "[]", '{"repo":"BabylonJS/Babylon-Lite"}', '{"repo":"x","pr":"1","definitionId":1,"buildId":1}', "not json"]) {
            expect(parseMarkerLine(`${MARKER_PREFIX}${payload} -->`), payload).toBeNull();
        }

        // ...but a well-formed marker for another destination still parses, so the caller can make
        // the ownership decision itself.
        expect(parseMarkerLine(`${MARKER_PREFIX}${JSON.stringify({ repo: "x/y", pr: 1, definitionId: 1, buildId: 1 })} -->`)).toEqual({
            repo: "x/y",
            pr: 1,
            definitionId: 1,
            buildId: 1,
        });
    });

    it("does not treat a superseded marker as canonical", () => {
        // The tombstone prefix is deliberately not a prefix of the canonical one, so a demoted
        // comment can never be re-adopted as the current report.
        expect(SUPERSEDED_MARKER_PREFIX.startsWith(MARKER_PREFIX)).toBe(false);
        const demoted = `${SUPERSEDED_MARKER_PREFIX}${JSON.stringify({ repo: IDENTITY.repo, pr: IDENTITY.pr, definitionId: 7, buildId: 1 })} -->\nsuperseded`;
        expect(selectOwnedComments([{ id: 1, body: demoted, user: { id: BOT_ID } }], BOT_ID, IDENTITY)).toEqual([]);
    });
});

describe("artifact markdown is neutralised before it can become part of a comment", () => {
    it("escapes the HTML comment delimiters a marker is made of", () => {
        const sanitized = sanitizeArtifactBody(Buffer.from(`${MARKER_PREFIX}{"repo":"evil/repo","pr":1,"definitionId":1,"buildId":1} -->\nhi`, "utf8"));
        expect(sanitized).not.toContain("<!--");
        expect(sanitized).not.toContain("-->");
        expect(sanitized).toContain("&lt;!--");
    });

    it("neutralises agent logging commands so artifact text cannot set a variable", () => {
        const sanitized = sanitizeArtifactBody(Buffer.from("##vso[task.setvariable variable=X]y\n##[error]z", "utf8"));
        expect(sanitized).not.toContain("##vso[");
        expect(sanitized).not.toContain("##[");
    });

    it("refuses bytes that are not valid UTF-8, contain NUL, or are absurdly large", () => {
        expect(() => sanitizeArtifactBody(Buffer.from([0xff, 0xfe, 0x41]))).toThrow(/UTF-8/i);
        expect(() => sanitizeArtifactBody(Buffer.from("a\0b", "utf8"))).toThrow(/NUL/i);
        expect(() => sanitizeArtifactBody(Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x61))).toThrow(/large|bytes/i);
    });

    it("truncates visibly rather than letting GitHub reject the whole comment", () => {
        const sanitized = sanitizeArtifactBody(Buffer.from("x".repeat(200_000), "utf8"));
        expect(sanitized.length).toBeLessThan(65_536);
        expect(sanitized).toMatch(/truncated/i);
    });
});

describe("the state machine converges on exactly one current comment", () => {
    it("creates exactly one comment when there is a report and nothing marked", async () => {
        const api = new FakeApi([{ id: 1, body: "unrelated human comment", user: { id: HUMAN_ID } }]);

        const result = await reconcile(api, { identity: IDENTITY, state: "report", body: "bundle grew" });

        expect(result.action).toBe("created");
        expect(api.writes).toHaveLength(1);
        expect(api.writes[0]?.kind).toBe("create");
        expect(api.writes[0]?.body.split("\n")[0]).toBe(formatMarker(IDENTITY));
        // The unrelated comment is untouched: this token can write to any comment in the repo, so
        // "left everything else alone" is a security property, not a nicety.
        expect(api.comments.find((c) => c.id === 1)?.body).toBe("unrelated human comment");
    });

    it("updates the existing comment instead of adding a second one", async () => {
        const api = new FakeApi([ownedComment(1, "old report")]);

        const result = await reconcile(api, { identity: IDENTITY, state: "report", body: "new report" });

        expect(result.action).toBe("updated");
        expect(result.canonicalCommentId).toBe(1);
        expect(api.writes.map((w) => w.kind)).toEqual(["update"]);
        expect(api.comments).toHaveLength(1);
    });

    it("writes nothing when the comment already says exactly this", async () => {
        // Re-running the same publisher build must be a true no-op: an update would bump the
        // comment's edited timestamp and re-notify every subscriber on every poll tick.
        const api = new FakeApi();
        await reconcile(api, { identity: IDENTITY, state: "report", body: "same" });
        api.writes.length = 0;

        const result = await reconcile(api, { identity: IDENTITY, state: "report", body: "same" });

        expect(result.action).toBe("unchanged");
        expect(api.writes).toEqual([]);
    });

    it("retracts the report when the regression clears", async () => {
        const api = new FakeApi([ownedComment(1, "bundle grew by 4 KB")]);

        const result = await reconcile(api, { identity: IDENTITY, state: "none" });

        expect(result.action).toBe("resolved");
        const body = api.comments[0]?.body ?? "";
        expect(body.split("\n")[0]).toBe(formatMarker(IDENTITY));
        expect(body).not.toContain("bundle grew by 4 KB");
        // Still traceable to the run that retracted it.
        expect(body).toContain(String(IDENTITY.buildId));
    });

    it("stays silent on a pull request that was never notable", async () => {
        const api = new FakeApi([{ id: 1, body: "just a review comment", user: { id: HUMAN_ID } }]);

        const result = await reconcile(api, { identity: IDENTITY, state: "none" });

        expect(result.action).toBe("noop");
        expect(api.writes).toEqual([]);
    });

    it("touches nothing at all when the measurement is unavailable", async () => {
        // A failed baseline fetch must never be read as "the regression is gone".
        const api = new FakeApi([ownedComment(1, "bundle grew"), ownedComment(2, "duplicate")]);

        const result = await reconcile(api, { identity: IDENTITY, state: "unavailable" });

        expect(result.action).toBe("skipped");
        expect(api.writes).toEqual([]);
    });
});

describe("duplicates are reduced without destroying history", () => {
    it("keeps the oldest canonical comment and demotes the rest in place", async () => {
        const api = new FakeApi([ownedComment(1, "first"), ownedComment(2, "second"), ownedComment(3, "third")]);

        const result = await reconcile(api, { identity: IDENTITY, state: "report", body: "current" });

        expect(result.canonicalCommentId).toBe(1);
        expect(result.demotedCommentIds).toEqual([2, 3]);

        const canonical = api.comments.filter((comment) => comment.body.startsWith(MARKER_PREFIX));
        expect(canonical.map((comment) => comment.id)).toEqual([1]);

        for (const id of [2, 3]) {
            const body = api.comments.find((comment) => comment.id === id)?.body ?? "";
            expect(body.startsWith(SUPERSEDED_MARKER_PREFIX)).toBe(true);
            expect(body.length).toBeLessThan(500);
        }
    });

    it("never deletes a comment", async () => {
        // The token can delete any comment in the repository, including a reviewer's. The absence
        // of a delete path is the mitigation, so nothing here may grow one.
        const api = new FakeApi([ownedComment(1), ownedComment(2)]);
        await reconcile(api, { identity: IDENTITY, state: "report", body: "current" });
        expect(api.comments.map((comment) => comment.id)).toEqual([1, 2]);
        expect(Object.keys(api)).not.toContain("deleteComment");
    });

    it("is idempotent across repeated runs of the same build", async () => {
        const api = new FakeApi([ownedComment(1, "a"), ownedComment(2, "b")]);
        await reconcile(api, { identity: IDENTITY, state: "report", body: "current" });
        const afterFirst = api.comments.map((comment) => comment.body);
        api.writes.length = 0;

        const second = await reconcile(api, { identity: IDENTITY, state: "report", body: "current" });

        expect(second.action).toBe("unchanged");
        expect(api.writes).toEqual([]);
        expect(api.comments.map((comment) => comment.body)).toEqual(afterFirst);
    });
});

describe("ownership is decided by the token's own identity, not by anything a body can claim", () => {
    it("ignores a marked comment written by somebody else", async () => {
        // A login is renameable; a numeric id is not. A contributor who posts the exact marker text
        // must not get their comment rewritten — or be able to suppress the real report.
        const impostor: IssueComment = { id: 1, body: `${formatMarker(IDENTITY)}\nnot from the bot`, user: { id: HUMAN_ID } };
        const api = new FakeApi([impostor]);

        const result = await reconcile(api, { identity: IDENTITY, state: "report", body: "real report" });

        expect(result.action).toBe("created");
        expect(api.comments.find((comment) => comment.id === 1)?.body).toBe(impostor.body);
    });

    it("ignores a marker naming a different repository or pull request", () => {
        const foreign = ownedComment(1, "x", { ...IDENTITY, repo: "attacker/repo" });
        const otherPr = ownedComment(2, "x", { ...IDENTITY, pr: 999 });
        expect(selectOwnedComments([foreign, otherPr], BOT_ID, IDENTITY)).toEqual([]);
    });

    it("ignores a candidate carrying two markers instead of failing on it", () => {
        // An ambiguous comment is left alone, not treated as a fatal condition.
        //
        // Ownership is "posted by this bot, with our marker on line one", and the sibling API
        // report satisfies both halves: same bot, and a first line this repository authors. So a
        // pull request can reach this branch. If it threw, the publish job would fail, the poller
        // would exhaust its retries and fail its tick, and one pull request would stop bundle-size
        // reconciliation for every other pull request. Skipping costs a duplicate at worst.
        const doubled: IssueComment = { id: 1, body: `${formatMarker(IDENTITY)}\nbody\n${formatMarker(IDENTITY)}`, user: { id: BOT_ID } };
        const genuine = ownedComment(2, "the real report", IDENTITY);

        expect(selectOwnedComments([doubled, genuine], BOT_ID, IDENTITY).map((comment) => comment.id)).toEqual([2]);
    });

    it("still reconciles normally when an ambiguous comment sits beside the canonical one", async () => {
        const doubled: IssueComment = { id: 1, body: `${formatMarker(IDENTITY)}\nx\n${formatMarker(IDENTITY)}`, user: { id: BOT_ID } };
        const api = new FakeApi([doubled, ownedComment(2, "old")]);

        const result = await reconcile(api, { identity: IDENTITY, state: "report", body: "new" });

        expect(result.action).toBe("updated");
        expect(result.canonicalCommentId).toBe(2);
        // Untouched, not demoted: the script does not claim comments it cannot parse.
        expect(api.comments.find((comment) => comment.id === 1)?.body).toBe(doubled.body);
    });
});

describe("a malicious bundle report cannot poison the canonical comment", () => {
    /**
     * The attack this rules out, end to end: a pull request edits the bundle report so its markdown
     * contains a second marker. If that reached the comment verbatim, the *next* run would see two
     * markers in its own canonical comment and hard-fail — a pull request would have permanently
     * disabled bundle-size reporting for itself, and arguably for whoever debugged it next.
     *
     * Escaping happens before the create, so the second marker never exists to be found.
     */
    const hostile = [
        `${MARKER_PREFIX}{"repo":"evil/evil","pr":1,"definitionId":1,"buildId":1} -->`,
        "<!-- bare open",
        "bare close -->",
        `${SUPERSEDED_MARKER_PREFIX}{"repo":"x","pr":1,"definitionId":1,"buildId":1} -->`,
        "##vso[task.setvariable variable=PR_COMMENT_TOKEN]stolen",
    ].join("\n");

    it("survives a second pass over the stored body without hard-failing or duplicating", async () => {
        const api = new FakeApi();
        const body = sanitizeArtifactBody(Buffer.from(hostile, "utf8"));

        const first = await reconcile(api, { identity: IDENTITY, state: "report", body });
        expect(first.action).toBe("created");

        // Exactly what GitHub now stores, re-read by the next run.
        const stored = api.comments[0]?.body ?? "";
        expect(stored.split("\n").filter((line) => line.startsWith(MARKER_PREFIX))).toHaveLength(1);
        expect(selectOwnedComments(api.comments, BOT_ID, IDENTITY).map((comment) => comment.id)).toEqual([first.canonicalCommentId]);

        const second = await reconcile(api, { identity: IDENTITY, state: "report", body });
        expect(second.action).toBe("unchanged");
        expect(api.comments).toHaveLength(1);

        // And the retraction path still works on a poisoned body.
        const third = await reconcile(api, { identity: IDENTITY, state: "none" });
        expect(third.action).toBe("resolved");
    });
});

describe("an incomplete view of the comments never becomes a new comment", () => {
    it("refuses to create when the listing could not be proven exhaustive", async () => {
        // The failure this prevents is unbounded: if a truncated listing hides the canonical
        // comment, every tick creates another one.
        const api = new FakeApi();
        api.complete = false;

        await expect(reconcile(api, { identity: IDENTITY, state: "report", body: "x" })).rejects.toThrow(/enumerate|complete|exhaustive|truncat/i);
        expect(api.writes).toEqual([]);
    });

    it("follows pagination links and stops at the last page", () => {
        expect(nextPageUrl('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"')).toBe("https://api.github.com/x?page=2");
        expect(nextPageUrl('<https://api.github.com/x?page=9>; rel="last"')).toBeUndefined();
        expect(nextPageUrl(null)).toBeUndefined();
    });
});

describe("the staged artifact is a contract, and a broken one is not silently a clean bill of health", () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "bundle-comment-"));
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it("reads the three states PR CI can stage", () => {
        for (const state of ["report", "none", "unavailable"] as const) {
            expect(parseBundleCommentState(JSON.stringify({ schemaVersion: 1, state }))).toBe(state);
        }
    });

    it("rejects a state file it does not understand rather than guessing", () => {
        for (const json of ['{"schemaVersion":2,"state":"none"}', '{"schemaVersion":1,"state":"clean"}', '{"state":"none"}', "[]", "null", "{", ""]) {
            expect(() => parseBundleCommentState(json), json).toThrow();
        }
    });

    it("treats a missing artifact directory as unavailable, never as resolved", () => {
        // A pull request whose CI never reached the bundle-size job has nothing to say. Reading
        // that as "no regression" would retract a real, still-accurate report.
        expect(loadStagedArtifact(join(directory, "absent")).state).toBe("unavailable");
    });

    it("fails when the state claims a report but no markdown was staged", () => {
        writeFileSync(join(directory, "bundle-comment-state.json"), JSON.stringify({ schemaVersion: 1, state: "report" }));
        expect(() => loadStagedArtifact(directory)).toThrow(/bundle-size-comment\.md|missing/i);
    });

    it("classifies every artifact-shaped failure as a contract error rather than an outage", () => {
        // The distinction decides whether the poller retries. A pull request authors these bytes,
        // so retrying a malformed one cannot help: it would just burn the attempt budget for this
        // build, and the poller escalates an exhausted budget by failing its tick — which would let
        // one pull request stop bundle-size reconciliation for all of them.
        writeFileSync(join(directory, "bundle-comment-state.json"), '{"schemaVersion":9,"state":"none"}');
        expect(() => loadStagedArtifact(directory)).toThrow(ArtifactContractError);

        writeFileSync(join(directory, "bundle-comment-state.json"), "not json");
        expect(() => loadStagedArtifact(directory)).toThrow(ArtifactContractError);

        writeFileSync(join(directory, "bundle-comment-state.json"), JSON.stringify({ schemaVersion: 1, state: "report" }));
        expect(() => loadStagedArtifact(directory), "an absent markdown body").toThrow(ArtifactContractError);

        writeFileSync(join(directory, "bundle-size-comment.md"), "   \n");
        expect(() => loadStagedArtifact(directory), "an empty markdown body").toThrow(ArtifactContractError);

        writeFileSync(join(directory, "bundle-size-comment.md"), Buffer.from([0x68, 0x00, 0x69]));
        expect(() => loadStagedArtifact(directory), "a NUL byte").toThrow(ArtifactContractError);

        writeFileSync(join(directory, "bundle-size-comment.md"), Buffer.from([0xff, 0xfe, 0xfd]));
        expect(() => loadStagedArtifact(directory), "invalid UTF-8").toThrow(ArtifactContractError);

        writeFileSync(join(directory, "bundle-size-comment.md"), "x".repeat(1024 * 1024 + 1));
        expect(() => loadStagedArtifact(directory), "an oversized body").toThrow(ArtifactContractError);
    });

    it("carries the sanitized markdown through when the state says report", () => {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "bundle-comment-state.json"), JSON.stringify({ schemaVersion: 1, state: "report" }));
        writeFileSync(join(directory, "bundle-size-comment.md"), "### Bundle size\n<!-- sneaky -->");

        const loaded = loadStagedArtifact(directory);

        expect(loaded.state).toBe("report");
        expect(loaded.body).toContain("### Bundle size");
        expect(loaded.body).not.toContain("<!--");
    });
});

describe("API failures surface instead of being smoothed over", () => {
    it("propagates a create failure rather than reporting success", async () => {
        const api = new FakeApi();
        vi.spyOn(api, "createComment").mockRejectedValue(new Error("GitHub POST /issues/42/comments failed: 403"));

        await expect(reconcile(api, { identity: IDENTITY, state: "report", body: "x" })).rejects.toThrow(/403/);
    });

    it("propagates an update failure so the poller can retry it", async () => {
        const api = new FakeApi([ownedComment(1, "old")]);
        vi.spyOn(api, "updateComment").mockRejectedValue(new Error("GitHub PATCH /comments/1 failed: 500"));

        await expect(reconcile(api, { identity: IDENTITY, state: "report", body: "new" })).rejects.toThrow(/500/);
    });

    it("never writes artifact-derived bytes to stdout", async () => {
        // The agent parses step output, and this job holds a GitHub token.
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const api = new FakeApi();

        await reconcile(api, { identity: IDENTITY, state: "report", body: "SECRET-MARKER-TEXT" });

        for (const call of log.mock.calls) {
            expect(String(call[0])).not.toContain("SECRET-MARKER-TEXT");
        }
        log.mockRestore();
    });
});
