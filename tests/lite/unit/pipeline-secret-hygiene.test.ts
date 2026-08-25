import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

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

    // A credential-bearing key whose value has been replaced by a mask.
    //
    // Two defects were found here, in opposite directions. The first version
    // anchored the asterisk run to the separator, so it matched the bare form
    // but missed the `Bearer` form that 9 of this repo's 10 headers use -- a
    // miss, found by drawing the mutation from the shapes the *bug* takes
    // rather than from the one specimen on hand.
    //
    // Widening that to "a delimited all-asterisk token anywhere in the value"
    // then flagged five shapes of *correct* code, because a decorative banner
    // is an asterisk token in value position too:
    //
    //     displayName: "****** Publish bundle-size baseline ******"
    //     - script: echo "*** building ${SCENE} ***"
    //
    // Neither is a secret and both are ordinary CI. That is the error
    // direction that gets a guard deleted rather than debugged, and no fixture
    // drawn from the bug could have exposed it -- it needs the shapes that
    // correct code takes. So the mask must sit in *value position for a
    // credential*, which is the invariant this guard actually has: a token
    // copied out of a build log lands after an auth header or a secret
    // assignment, never inside a log banner.
    //
    // Known gap, stated rather than implied: forms carrying the credential
    // with no separator (`curl -u ******`) are not detected, and were not before.
    return /(?:authorization|authenticate|token|secret|passw(?:or)?d|credential|api[-_]?key)["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?\*{3,}(?=["'\s]|$)/i.test(code);
}

/**
 * True when a line interpolates a variable in any CI dialect this repo uses.
 *
 * The scope of this suite was widened to `.github/workflows/` before this
 * predicate was: it recognised the Azure macro `$(X)` and the shell forms `$X`
 * and `${X}`, but not `${{ secrets.X }}`, which is the *canonical* GitHub
 * Actions reference. So the guard would have rejected a correct Actions header
 * -- a misfire, on the one file class that was just added to its subject.
 *
 * It passed only because `compat-sync-trigger.yml` happens to use the shell
 * form. Widening a collector does not widen the predicate that reads it, and an
 * all-pass result on newly covered files is exactly what a dialect-blind
 * predicate produces.
 */
export function interpolatesAVariable(line: string): boolean {
    return /\$\{\{[^}]*[A-Za-z_][^}]*\}\}|\$[({]?[A-Za-z_]\w*[)}]?/.test(line);
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
/**
 * True when a line declares an Authorization header.
 *
 * This is the *subject selector* for the two header clauses, and it had no
 * fixtures at all while its partner predicates had eighteen between them. The
 * file read as thoroughly tested because one side of it was: pinning a
 * predicate says nothing about the predicate that decides what it is shown.
 *
 * It was `/Authorization:/` -- case-sensitive, and HTTP header names are not.
 * A hardcoded credential in a lowercase header passed every clause, byte
 * identical to one that failed except for a single letter, and the printed
 * subject count stayed at 10 throughout, because a selector-shaped miss is
 * invisible to the number the selector produces.
 *
 * Comments are stripped so a documented example (`# Authorization: Bearer
 * <token>`) is not read as a live header -- correct prose that the
 * interpolation clause would otherwise reject.
 */
export function isAuthorizationHeader(line: string): boolean {
    return /\bauthorization\s*:/i.test(line.replace(/(^|\s)#.*$/, ""));
}

/**
 * Keys whose value is text shown to a human: never executed, never sent.
 *
 * `value` is deliberately absent. In an Azure Pipelines `variables:` block it
 * holds a real value that may be a real secret; in a GitHub issue form it holds
 * prose. The same key carries opposite provenance depending on the file it sits
 * in, which is why documentation keys alone cannot settle this and issue
 * templates are excluded by category instead.
 */
const DOCUMENTATION_KEY = /^(\s*)(?:-\s*)?(description|displayName|label|placeholder|title|summary)\s*:(.*)$/;

/**
 * Blanks documentation text, including block scalar bodies, before either
 * predicate reads a line.
 *
 * Both clauses were reading prose as configuration. A `description:` explaining
 * that a token "appears as Authorization: Bearer ******" is correct content in
 * a file the guard must read, and it tripped the mask clause and the header
 * selector at once -- the line was in scope, was collected, and matched
 * correctly; it simply was not a header. Scope was never wrong, provenance was.
 *
 * Applied once, above both questions, for the reason the union fix taught: two
 * predicates learning separately about what counts as configuration is how they
 * drift into disagreeing about it.
 *
 * Line count is preserved so reported line numbers stay true.
 */
export function stripDocumentationText(content: string): string {
    const out: string[] = [];
    let blockIndent: number | null = null;
    let openQuote: string | null = null;
    let quoteIndent = 0;

    for (const line of content.split("\n")) {
        if (blockIndent !== null) {
            const indent = line.search(/\S/);
            if (line.trim() === "" || indent > blockIndent) {
                out.push("");
                continue;
            }
            blockIndent = null;
        }

        if (openQuote !== null) {
            const indent = line.search(/\S/);
            // A dedent always ends the region, even with the quote still open.
            // Without this an unterminated quote blanks every line below it and
            // silences the guard for the rest of the file -- silently, which is
            // the direction that matters when extending a strip.
            if (line.trim() !== "" && indent <= quoteIndent) {
                openQuote = null;
            } else {
                if (line.includes(openQuote)) {
                    openQuote = null;
                }
                out.push("");
                continue;
            }
        }

        const match = DOCUMENTATION_KEY.exec(line);
        if (match) {
            const value = match[3].trim();
            if (/^[|>]/.test(value)) {
                blockIndent = match[1].length;
            } else if (/^["']/.test(value) && !(value.length > 1 && value.endsWith(value[0]))) {
                // A quoted scalar that does not close on its own line continues
                // onto the next. YAML folds those lines into a single string, so
                // a `run:` or an `Authorization:` header inside one is prose by
                // the grammar -- settled by the key plus the quote, with no
                // block scalar marker anywhere to signal it.
                openQuote = value[0];
                quoteIndent = match[1].length;
            }
            out.push(`${match[1]}${match[2]}:`);
            continue;
        }

        out.push(line);
    }

    return out.join("\n");
}

function pipelineLines(): { location: string; line: string; number: number; requiresDeployToken: boolean }[] {
    return pipelineFiles().flatMap((file) =>
        stripDocumentationText(readFileSync(file.path, "utf8"))
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
        // Correct code that a delimited-token rule flagged. Decorative
        // asterisks are ordinary in CI, and the comment banner already in this
        // table passed only because comments are stripped -- never because the
        // predicate rejected it. These are the uncommented forms.
        [`    displayName: "***** Publish bundle-size baseline *****"`, false],
        [`      - script: echo "*** building ${"$"}{SCENE} ***"`, false],
        [`      - script: echo "*** done"`, false],
        [`    banner: "**********"`, false],
        // A masked response header pasted from a build log: not a credential
        // in the file, but the shape that gets copied, so it still fails.
        [`WWW-Authenticate: ******"BabylonDeploymentServer"`, true],
    ])("%s -> masked=%s", (line, expected) => {
        expect(hasMaskedSecret(line as string)).toBe(expected);
    });
});

describe("the Authorization selector accepts and rejects the right lines", () => {
    // The clauses these feed were pinned; this was not. Both directions,
    // including the shapes *correct* code takes -- a documented example must
    // not be read as a live header, or the interpolation clause rejects prose.
    it.each([
        [`-H "Authorization: Bearer \${DEPLOY_TOKEN}"`, true],
        [`-H "authorization: Bearer \${DEPLOY_TOKEN}"`, true],
        [`-H "AUTHORIZATION: Bearer \${DEPLOY_TOKEN}"`, true],
        [`-H "Authorization : Bearer \${DEPLOY_TOKEN}"`, true],
        [`-H "Proxy-Authorization: Bearer \${DEPLOY_TOKEN}"`, true],
        // A 401 challenge is a different header and not a credential.
        [`WWW-Authenticate: Basic realm="BabylonDeploymentServer"`, false],
        [`  # Authorization: Bearer <token>  -- example, not a live header`, false],
        [`  - script: echo "no header here"`, false],
    ])("%s -> isAuthorizationHeader=%s", (line, expected) => {
        expect(isAuthorizationHeader(line as string)).toBe(expected);
    });
});

describe("variable interpolation is recognised in every CI dialect", () => {
    // Pinned as a population, not a specimen. Each row is a dialect this repo
    // can contain; a predicate fitted to one of them reports a plausible count
    // while being blind to a whole file class.
    it.each([
        ['-H "Authorization: Bearer ${{ secrets.DEPLOY_TOKEN }}"', true],
        ['-H "Authorization: Bearer ${{ env.TOKEN }}"', true],
        ['-H "Authorization: Bearer $(DEPLOY_TOKEN)"', true],
        ['-H "Authorization: Basic ${AUTH}"', true],
        ['-H "Authorization: Bearer ******"', false],
        ['-H "Authorization: Bearer hunter2"', false],
    ])("%s -> interpolates=%s", (line, expected) => {
        expect(interpolatesAVariable(line as string)).toBe(expected);
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
        const headers = pipelineLines().filter(({ line }) => isAuthorizationHeader(line));

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
        const literal = headers.filter(({ line }) => !interpolatesAVariable(line)).map(({ location, number }) => `${location}:${number}`);

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

/**
 * Directories the credential walk does not enter.
 *
 * Created in passing while writing the walk and left unpinned, which is the
 * sibling case: a collector inherits none of the scrutiny the thing it was
 * written for received, and looks finished because it is new.
 *
 * `tests` is a *category* exclusion, not a convenience one. A fixture holding
 * a masked credential is correct code -- it is test data, not CI
 * configuration -- and flagging it would misfire while advising the reader to
 * add a test directory to the roots list, which would then make the guard scan
 * fixtures and fail on the mask itself. Measured before narrowing rather than
 * predicted: zero tracked YAML under `tests/` today, so this costs nothing
 * now and only ever excludes test data.
 */
export function isWalkableDir(name: string): boolean {
    return !new Set(["node_modules", ".git", "dist", "build", "coverage", "out", ".turbo", "tests", "ISSUE_TEMPLATE"]).has(name);
}

/**
 * Walks the repo for YAML carrying anything the clauses examine, so the
 * collector above can be compared against reality rather than against itself.
 *
 * Keyed on the union of the clause predicates, not on file shape. The first
 * version discovered `Authorization` headers only -- but the mask clause reads
 * *every line* of a collected file, so its subject is strictly larger. A
 * masked credential with no Authorization header, in a directory outside the
 * roots, was invisible: 33 passed, nothing named. Discovering by a narrower
 * category than the guards read is a closure check that certifies part of its
 * subject and reports on all of it.
 */
function allYamlCarryingACredentialShape(): string[] {
    const found: string[] = [];

    const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) {
                // Asked only about directories, which is the sole thing the
                // predicate is named for and reasons about. Testing it against
                // every entry first also skipped *files* whose name matched --
                // inert here, because no tracked file is named `build` or
                // `dist`, but the fixtures below cannot see this either way:
                // they pin what the predicate answers, never where it is asked.
                if (isWalkableDir(name)) {
                    walk(full);
                }
            } else if (
                /\.ya?ml$/.test(name) &&
                stripDocumentationText(readFileSync(full, "utf8"))
                    .split("\n")
                    .some((l) => isAuthorizationHeader(l) || hasMaskedSecret(l))
            ) {
                found.push(relative(repoRoot, full).split(sep).join("/"));
            }
        }
    };
    walk(repoRoot);

    return found;
}

describe("documentation text is not read as configuration", () => {
    // Both directions. Stripping too much is the dangerous side here: it
    // silences the guard on real credentials, and every count in this file is
    // computed downstream of it, so the inventory would agree with the loss.
    it("blanks a documentation value that mentions a header", () => {
        expect(stripDocumentationText("        description: 'shown as Authorization: Bearer ******'")).toBe("        description:");
    });

    it("blanks a block scalar body under a documentation key", () => {
        const stripped = stripDocumentationText(["  placeholder: |", '    curl -H "Authorization: Bearer ******" x', "  next: keep"].join("\n"));
        expect(stripped.split("\n")).toEqual(["  placeholder:", "", "  next: keep"]);
    });

    it("preserves line count so reported numbers stay true", () => {
        const input = ["a: 1", "  description: |", "    body", "b: 2"].join("\n");
        expect(stripDocumentationText(input).split("\n")).toHaveLength(4);
    });

    it("leaves a real credential in a script line alone", () => {
        const line = '    - script: curl -H "Authorization: Bearer ******" https://x';
        expect(stripDocumentationText(line)).toBe(line);
    });

    it("leaves an ADO variables value alone, where the same key is not prose", () => {
        const line = "      - name: token\n        value: $(DEPLOY_TOKEN)";
        expect(stripDocumentationText(line)).toBe(line);
    });

    it("blanks a quoted scalar that continues onto the next line", () => {
        // Settled by the key plus the quote, with no block scalar marker to
        // signal it. YAML folds these lines into one string, so a header
        // inside is prose by the grammar -- confirmed against a parser rather
        // than reasoned about.
        const prose = ["      description: 'redacted in logs as", "        Authorization: Bearer ******'", "      other: keep"].join("\n");
        expect(stripDocumentationText(prose).split("\n")).toEqual(["      description:", "", "      other: keep"]);
    });

    it("stops an unterminated quote at a dedent instead of blanking the rest of the file", () => {
        // The silent direction, and the only way extending this strip could be
        // worse than the misfire it fixes: one stray quote would otherwise
        // silence every clause below it for the remainder of the file.
        const prose = ["      description: 'never closed", "      script: curl -H 'Authorization: Bearer ******'"].join("\n");
        expect(stripDocumentationText(prose).split("\n")[1]).toContain("Authorization");
    });

    it("leaves a script block scalar body intact, which is where the real shell lives", () => {
        // The load-bearing direction. Blanking a script body hides every
        // credential inside it and leaves the suite green -- the silent side,
        // and the only way this strip could be worse than the bug it fixes.
        // 41 of these bodies across the ten pipeline files, so this is the
        // dominant shape rather than a corner: the single-line fixture above
        // says nothing about it.
        const body = ["    - script: |", "        set -euo pipefail", '        curl -H "Authorization: Bearer ******" https://x', "        echo done"].join("\n");
        expect(stripDocumentationText(body)).toBe(body);
    });

    it("ends the block at a dedent", () => {
        const input = ["  description: |", "    prose", "  script: curl -H 'Authorization: Bearer ******'"].join("\n");
        expect(stripDocumentationText(input).split("\n")[2]).toContain("Authorization");
    });
});

describe("the credential walk enters the right directories", () => {
    // Both directions on the collector itself. A walk that silently stops
    // entering a directory produces a smaller subject and a set of diagnostics
    // that agree with it perfectly, so no count in this file can detect it.
    it.each([
        ["config", true],
        [".github", true],
        ["packages", true],
        ["node_modules", false],
        ["dist", false],
        [".git", false],
        // Test data is not CI configuration. A fixture carrying a mask is
        // correct code, and flagging it would advise adding a test directory
        // to the roots list -- which would make the guard scan fixtures and
        // then fail on the mask it was told to go and read.
        ["tests", false],
    ])("isWalkableDir(%s) -> %s", (name, expected) => {
        expect(isWalkableDir(name as string)).toBe(expected);
    });
});

describe("the mask guard reads every file carrying anything its clauses examine", () => {
    // The sibling variable-groups guard got a closure check and this one did
    // not, on the reasoning that its three roots were already known correct.
    // That is coverage by *placement*: true of the tree as it stands, and with
    // no structural reason behind it -- unlike the step templates, which cannot
    // declare a variable group under any edit, nothing stops a new directory
    // from carrying a credential. The per-root floors below cannot see this;
    // they prove each configured root is non-empty, never that the configured
    // roots are all of them.
    //
    // It also repairs a claim that a *merge* falsifies rather than an edit.
    // TESTING.md said "add its directory to that list", singular, which stops
    // being unambiguous the moment a second guard ships its own root list. An
    // instruction that a reader follows correctly and is still wrong afterwards
    // cannot be fixed by rewording it -- so the enforcement is a test that
    // names the offending file, which stays true however many lists exist.
    it("has no credential-shaped line outside its configured roots", () => {
        const scanned = new Set(pipelineFiles().map(({ location }) => location));
        const carrying = allYamlCarryingACredentialShape();

        expect(carrying.length, "walked the repo and found no credential-shaped line at all — the assertion below would compare two empty sets").toBeGreaterThan(0);

        const unread = carrying.filter((file) => !scanned.has(file)).sort();

        expect(
            unread,
            "these files carry an Authorization header or a masked value, but the guard never reads them, so a credential in them is invisible. Add the directory to the roots list in pipelineFiles():"
        ).toEqual([]);
    });
});
