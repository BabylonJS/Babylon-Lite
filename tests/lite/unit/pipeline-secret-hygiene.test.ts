import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..", "..");

/**
 * True when a line carries a log-redaction mask in value position.
 *
 * Extracted so both directions can be pinned against fixtures below. Verifying
 * only that a guard rejects bad input leaves its false-positive behaviour
 * untested, and a guard that fails on correct code gets deleted rather than
 * debugged -- which for an invariant whose violation is invisible costs
 * everything the guard was protecting.
 */
export function hasMaskedSecret(line: string): boolean {
    return /(?:[:=]\s*"?)\*{3,}/.test(line.replace(/(^|\s)#.*$/, ""));
}

function pipelineFiles(): string[] {
    const files = readdirSync(repoRoot).filter((f) => /^azure-pipelines.*\.ya?ml$/.test(f));

    // A zero-match case must never be indistinguishable from an all-pass case,
    // or this file becomes a check that runs and cannot fail.
    expect(files.length, "no azure-pipelines files matched — this suite would be vacuous").toBeGreaterThan(0);
    return files;
}

describe("mask detection accepts and rejects the right lines", () => {
    // Both directions on the same input shape. The rejections were verified
    // first and the acceptances added afterwards, which is the wrong order --
    // the false positives below were live defects found only by testing the
    // direction that was not the worry.
    it.each([
        ["  # ****** Build stage ******", false],
        ["  # note: glob **/*.spec.ts is excluded", false],
        ['      - script: echo "a***b"', false],
        ["      - script: rm -rf dist/**/*", false],
        ['-H "Authorization: Bearer $(DEPLOY_TOKEN)"', false],
        ['-H "Authorization: Bearer ${DEPLOY_TOKEN}"', false],
        ['-H "Authorization: ******"', true],
        ['-F "token=*******"', true],
        ["  password: ***", true],
    ])("%s -> masked=%s", (line, expected) => {
        expect(hasMaskedSecret(line as string)).toBe(expected);
    });
});

describe("pipeline secret hygiene", () => {
    // Azure masks secret values in build logs as a run of asterisks. Copying a
    // command out of a log therefore yields a literal mask where the secret
    // reference used to be -- and it is invisible in review, because a diff
    // viewer redacts an Authorization value to asterisks whether the file holds
    // the real reference or the mask. That happened: the bundle-manifest
    // publish step shipped `Authorization: ******` with no token reference at
    // all, which is a second, independent cause of the 401 this PR fixes.
    //
    // Matched in *value position* only -- after a `:` or `=` -- and never in a
    // comment. A bare search for three asterisks rejects a `# **** banner ****`
    // and `echo "a***b"`, both of which are fine. That is not harmless
    // over-inclusiveness: a guard that fails on correct code gets deleted
    // rather than debugged, and this invariant is one whose violation is
    // invisible, so losing the guard costs everything it protects.
    it("has no log-redaction mask committed in place of a secret", () => {
        const offenders = pipelineFiles().flatMap((file) =>
            readFileSync(join(repoRoot, file), "utf8")
                .split("\n")
                .map((line, index) => ({ file, line, number: index + 1 }))
                .filter(({ line }) => hasMaskedSecret(line))
                .map(({ file: f, number, line }) => `${f}:${number}: ${line.trim()}`)
        );

        expect(offenders, "A run of asterisks in value position is how Azure prints a masked secret. This looks copied from a build log.").toEqual([]);
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
