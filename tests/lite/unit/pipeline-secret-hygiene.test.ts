import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..", "..");

function pipelineFiles(): string[] {
    const files = readdirSync(repoRoot).filter((f) => /^azure-pipelines.*\.ya?ml$/.test(f));

    // A zero-match case must never be indistinguishable from an all-pass case,
    // or this file becomes a check that runs and cannot fail.
    expect(files.length, "no azure-pipelines files matched — this suite would be vacuous").toBeGreaterThan(0);
    return files;
}

describe("pipeline secret hygiene", () => {
    // Azure masks secret values in build logs as a run of asterisks. Copying a
    // command out of a log therefore yields a literal mask where the secret
    // reference used to be -- and it is invisible in review, because a diff
    // viewer redacts an Authorization value to asterisks whether the file holds
    // the real reference or the mask. That happened: the bundle-manifest
    // publish step shipped `Authorization: ******` with no token reference at
    // all, which is a second, independent cause of the 401 this PR fixes.
    it("has no log-redaction mask committed in place of a secret", () => {
        const offenders = pipelineFiles().flatMap((file) =>
            readFileSync(join(repoRoot, file), "utf8")
                .split("\n")
                .map((line, index) => ({ file, line, number: index + 1 }))
                .filter(({ line }) => /\*{3,}/.test(line))
                .map(({ file: f, number, line }) => `${f}:${number}: ${line.trim()}`)
        );

        expect(offenders, "A run of asterisks is how Azure prints a masked secret. This looks copied from a build log.").toEqual([]);
    });

    // The mask above passed every check we had precisely because it still
    // looked like a header. Assert the stronger property: an Authorization
    // header must actually reference the token, in either the ADO macro form
    // or the shell form used when the secret is passed through `env:`.
    it("references the deploy token in every Authorization header", () => {
        const headers = pipelineFiles().flatMap((file) =>
            readFileSync(join(repoRoot, file), "utf8")
                .split("\n")
                .map((line, index) => ({ file, line, number: index + 1 }))
                .filter(({ line }) => /Authorization:/.test(line))
        );

        // Print N. An assertion of the form "N things, all correct" is only
        // meaningful if someone can see that N is not zero.
        expect(headers.length, "no Authorization headers found — the assertion below would be vacuous").toBeGreaterThan(0);

        const tokenless = headers.filter(({ line }) => !/\$[({]DEPLOY_TOKEN[)}]/.test(line)).map(({ file, number }) => `${file}:${number}`);

        expect(tokenless, "Authorization header does not reference DEPLOY_TOKEN.").toEqual([]);
    });
});
