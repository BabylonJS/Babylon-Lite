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
    const code = line.replace(/(^|\s)#.*$/, "");
    const separator = code.search(/[:=]/);
    if (separator === -1) {
        return false;
    }

    // A *whole token* of three or more asterisks, anywhere in the value. The
    // first version anchored the run directly to the separator, so it matched
    // `Authorization: ***` but not `Authorization: Bearer ***` -- and `Bearer`
    // is the form 9 of this repo's 10 headers use. The bug was caught only
    // because that one instance happened to omit it. Requiring a delimited,
    // all-asterisk token is what keeps `echo "a***b"` and `dist/**/*` out.
    return /(?:^|[\s"'=:])\*{3,}(?=[\s"']|$)/.test(code.slice(separator + 1));
}

interface PipelineFile {
    /** Path relative to the repo root, used in failure messages. */
    location: string;
    /** Absolute path, for reading. */
    path: string;
    /**
     * True for Azure DevOps pipelines and the step templates they include,
     * where `DEPLOY_TOKEN` is the established convention. GitHub Actions
     * workflows authenticate differently, so requiring `DEPLOY_TOKEN` of them
     * would fail on correct code.
     */
    requiresDeployToken: boolean;
}

function pipelineFiles(): PipelineFile[] {
    // A mask copied out of a build log is wrong in any CI file, so the subject
    // is every file that can carry one. The original glob read the repo root
    // alone: 7 of the repo's 10 `Authorization` headers, while its own doc
    // comment claimed to cover the pipelines. The three it missed are `curl`
    // uploads in the two shared templates -- included by azure-pipelines.yml at
    // four call sites, so they run on every PR -- and one workflow. That is
    // precisely the shape this bug takes.
    const roots = [
        { dir: repoRoot, label: "", match: /^azure-pipelines.*\.ya?ml$/, requiresDeployToken: true },
        { dir: join(repoRoot, "config", "templates"), label: "config/templates", match: /\.ya?ml$/, requiresDeployToken: true },
        { dir: join(repoRoot, ".github", "workflows"), label: ".github/workflows", match: /\.ya?ml$/, requiresDeployToken: false },
    ];

    const files: PipelineFile[] = [];
    for (const { dir, label, match, requiresDeployToken } of roots) {
        const names = readdirSync(dir).filter((f) => match.test(f));

        // A floor per collector, not one for the function. A per-function floor
        // cannot detect a single root that stops matching, because the others
        // keep the total comfortably above zero -- yielding a check that is
        // non-vacuous and narrower than its stated subject at the same time.
        expect(names.length, `no YAML matched under ${label || "the repo root"} — that collector would contribute nothing`).toBeGreaterThan(0);

        for (const name of names) {
            files.push({ location: label ? `${label}/${name}` : name, path: join(dir, name), requiresDeployToken });
        }
    }
    return files;
}

/** Every line of every collected file, tagged with its origin. */
function pipelineLines(): { location: string; line: string; number: number; requiresDeployToken: boolean }[] {
    return pipelineFiles().flatMap((file) =>
        readFileSync(file.path, "utf8")
            .split("\n")
            .map((line, index) => ({ location: file.location, line, number: index + 1, requiresDeployToken: file.requiresDeployToken }))
    );
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
        ['-H "Authorization: Basic ${AUTH}"', false],
        ['-H "Authorization: Bearer ******"', true],
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
        const offenders = pipelineLines()
            .filter(({ line }) => hasMaskedSecret(line))
            .map(({ location, number, line }) => `${location}:${number}: ${line.trim()}`);

        expect(offenders, "A run of asterisks in value position is how Azure prints a masked secret. This looks copied from a build log.").toEqual([]);
    });

    // The mask above passed every check we had precisely because it still
    // looked like a header. Assert the stronger property: an Authorization
    // header must actually reference the token, in either the ADO macro form
    // or the shell form used when the secret is passed through `env:`.
    it("references the deploy token in every Authorization header", () => {
        const headers = pipelineLines().filter(({ line }) => /Authorization:/.test(line));

        // Print N, and where. An assertion of the form "N things, all correct"
        // is only meaningful if someone can see what N was and that the set is
        // the one intended. Locations only -- never the line, which holds the
        // value under test.
        console.log(`Authorization headers: ${headers.length}`);
        for (const { location, number } of headers) {
            console.log(`  ${location}:${number}`);
        }
        expect(headers.length, "no Authorization headers found — the assertions below would be vacuous").toBeGreaterThan(0);

        // The universal property: the header must interpolate *something*. A
        // copied mask is a bare literal, so this catches the bug in any CI
        // dialect, including files that legitimately never touch DEPLOY_TOKEN.
        const literal = headers.filter(({ line }) => !/\$[({]?[A-Za-z_]\w*[)}]?/.test(line)).map(({ location, number }) => `${location}:${number}`);

        expect(literal, "Authorization header interpolates no variable at all — this looks copied from a build log.").toEqual([]);

        // The stronger property, only where it is actually the convention.
        // Applying it repo-wide would fail the Actions workflow's correct
        // `Basic ${AUTH}` -- and a guard that rejects correct code gets deleted
        // rather than debugged, which for an invariant whose violation is
        // invisible costs everything the guard protects.
        const tokenless = headers
            .filter(({ requiresDeployToken }) => requiresDeployToken)
            .filter(({ line }) => !/\$[({]DEPLOY_TOKEN[)}]/.test(line))
            .map(({ location, number }) => `${location}:${number}`);

        expect(tokenless, "Authorization header in an Azure pipeline does not reference DEPLOY_TOKEN.").toEqual([]);
    });
});
