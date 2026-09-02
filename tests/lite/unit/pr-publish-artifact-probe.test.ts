import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// The publisher asks the Build API whether the pull request's CI run actually
// published a `bundle-comment` artifact, and the bundle job trusts that answer
// to decide whether an empty download directory is "nothing to say" or "the
// download failed". A wrong answer in the absent direction is not a warning:
// the reconciler no-ops, the job goes green, and the bundle axis is retired for
// the latest build with a stale comment still on the pull request — issue #627,
// reopened on a path nothing else guards.
//
// So this suite runs the *actual* shell out of the pipeline rather than a
// restatement of it. A copied expectation would keep passing after the step it
// describes had drifted away from it, which is precisely the failure mode worth
// spending a process launch on.

const repoRoot = resolve(__dirname, "../../..");
const PUBLISHER = "azure-pipelines-pr-publish.yml";
const RUN_ID = "4242";

function probeScript(temporaryDirectory: string): string {
    const pipeline = readFileSync(resolve(repoRoot, PUBLISHER), "utf8");

    // The step is identified by the output-variable name it publishes, which is
    // also the contract the bundle job consumes, so the two cannot drift apart
    // without this lookup failing loudly.
    const marker = "\n                  name: bundleArtifact\n";
    const end = pipeline.indexOf(marker);
    expect(end, `${PUBLISHER} has no step named bundleArtifact`).toBeGreaterThan(-1);

    const opening = "- script: |\n";
    const start = pipeline.slice(0, end).lastIndexOf(opening);
    expect(start, `the bundleArtifact step in ${PUBLISHER} is not an inline script`).toBeGreaterThan(-1);

    const raw = pipeline.slice(start + opening.length, end);
    const indent = /^ */.exec(raw)?.[0].length ?? 0;
    const body = raw
        .split("\n")
        .map((line) => line.slice(indent))
        .join("\n");

    const substituted = body.replace(/\$\{\{ parameters\.prCiRunId \}\}/g, RUN_ID).replace(/\$\(Agent\.TempDirectory\)/g, temporaryDirectory);

    // Anything left is a pipeline macro this harness does not model, which would
    // silently reach bash as literal text and make the run meaningless.
    expect(substituted, "the probe grew a pipeline expression this test does not substitute").not.toMatch(/\$\{\{|\$\([A-Z]/);

    return substituted;
}

/**
 * Runs the real probe with `curl` replaced by a stub that serves `response` as
 * the artifact listing, so the shell under test is unmodified.
 */
function runProbe(response: string): { status: number; stdout: string; stderr: string } {
    const workspace = mkdtempSync(join(tmpdir(), "artifact-probe-"));
    const temporaryDirectory = join(workspace, "temp");
    mkdirSync(temporaryDirectory);

    const fixture = join(workspace, "response.body");
    writeFileSync(fixture, response);

    const stubDirectory = join(workspace, "bin");
    mkdirSync(stubDirectory);
    // `curl --config -` reads its arguments from stdin, so the stub has to drain
    // it or the pipeline that feeds it dies of SIGPIPE before the probe runs.
    writeFileSync(
        join(stubDirectory, "curl"),
        [
            "#!/bin/bash",
            "cat >/dev/null",
            'while test "$#" -gt 0; do',
            '    if test "$1" = "--output"; then',
            `        cp ${JSON.stringify(fixture)} "$2"`,
            "        exit 0",
            "    fi",
            "    shift",
            "done",
            "exit 1",
            "",
        ].join("\n")
    );
    chmodSync(join(stubDirectory, "curl"), 0o755);

    const script = join(workspace, "probe.sh");
    writeFileSync(script, probeScript(temporaryDirectory));

    const result = spawnSync("bash", [script], {
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: `${stubDirectory}:${process.env.PATH ?? ""}`,
            SYSTEM_ACCESSTOKEN: "token",
            SYSTEM_COLLECTIONURI: "https://dev.azure.com/example/",
            SYSTEM_TEAMPROJECTID: "project",
        },
    });

    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const OUTPUT = /##vso\[task\.setvariable variable=bundleArtifactPresent;isOutput=true\](true|false)/;

function decision(stdout: string): string | undefined {
    return OUTPUT.exec(stdout)?.[1];
}

describe("the publisher's bundle-artifact probe", () => {
    it("reports the artifact when the listing contains it", () => {
        const result = runProbe(JSON.stringify({ count: 2, value: [{ name: "api-comment" }, { name: "bundle-comment" }] }));

        expect(result.status, result.stderr).toBe(0);
        expect(decision(result.stdout)).toBe("true");
    });

    it("reports absence for a listing that parses and genuinely has no bundle artifact", () => {
        // A pull request whose CI predates the artifact, which must stay a green
        // no-op rather than a retry that can only ever fail again.
        const result = runProbe(JSON.stringify({ count: 1, value: [{ name: "api-comment" }] }));

        expect(result.status, result.stderr).toBe(0);
        expect(decision(result.stdout)).toBe("false");
    });

    it("reports absence for an empty listing", () => {
        const result = runProbe(JSON.stringify({ count: 0, value: [] }));

        expect(result.status, result.stderr).toBe(0);
        expect(decision(result.stdout)).toBe("false");
    });

    it("fails instead of reporting absence when the response is not JSON", () => {
        // Azure DevOps answers an unauthenticated or interstitial request with a
        // sign-in page at HTTP 200/203, which `curl --fail` cannot reject. Read
        // as "no artifact", it would permanently retire the bundle axis.
        const result = runProbe("<!DOCTYPE html>\n<html><head><title>Sign In</title></head><body>Sign in to continue.</body></html>\n");

        expect(result.status, "a sign-in page was accepted as an artifact listing").not.toBe(0);
        expect(decision(result.stdout), "a decision was published from an unparseable response").toBeUndefined();
        expect(result.stdout + result.stderr).toMatch(/did not return an artifact listing/);
    });

    it("fails instead of reporting absence when the response is empty", () => {
        const result = runProbe("");

        expect(result.status, "an empty response was accepted as an artifact listing").not.toBe(0);
        expect(decision(result.stdout)).toBeUndefined();
    });

    it("fails instead of reporting absence when the JSON is valid but the wrong shape", () => {
        // API drift, or an error envelope served with a success status.
        for (const response of [
            JSON.stringify({ message: "TF400813: The user is not authorized.", typeKey: "UnauthorizedRequestException" }),
            JSON.stringify({ count: 0, value: { name: "bundle-comment" } }),
            JSON.stringify([{ name: "bundle-comment" }]),
            JSON.stringify(null),
            '"bundle-comment"',
        ]) {
            const result = runProbe(response);

            expect(result.status, `${response} was accepted as an artifact listing`).not.toBe(0);
            expect(decision(result.stdout), `${response} produced a decision`).toBeUndefined();
        }
    });

    it("never lets a listing-shaped body decide anything by name alone", () => {
        // The string is present in the response, but not as an artifact name.
        const result = runProbe(JSON.stringify({ count: 1, value: [{ name: "api-comment", resource: { data: "bundle-comment" } }] }));

        expect(result.status, result.stderr).toBe(0);
        expect(decision(result.stdout)).toBe("false");
    });

    it("keeps the jq status meaningful by restoring strict mode around each probe", () => {
        // `set -e` would abort on the very jq call whose status has to be read,
        // so the status capture must be explicit, and strict mode must come back
        // afterwards or every later failure in the step is silently ignored.
        const script = probeScript("/tmp");

        expect(script, "the probe must run under strict mode").toMatch(/set -euo pipefail/);
        expect(script.match(/set \+e/g)?.length, "each status capture needs its own relaxation").toBe(2);
        expect(script.match(/^\s*set -e$/gm)?.length, "strict mode is not restored after every status capture").toBe(2);
        expect(script, "a status is captured but never inspected").toMatch(/shape_status=\$\?/);
        expect(script, "a status is captured but never inspected").toMatch(/match_status=\$\?/);

        // The distinction this whole suite exists for: jq's "false" and jq's
        // "could not read that" must not land in the same branch.
        expect(script, "the probe collapses jq's error statuses into a decision").not.toMatch(/if jq -e[\s\S]*?else[\s\S]*?bundleArtifactPresent;isOutput=true\]false/);
    });
});
