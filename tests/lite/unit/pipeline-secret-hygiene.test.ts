import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
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

/**
 * Whether a filename is YAML, asked by the enumeration below *and* by the
 * closure walk that certifies it.
 *
 * It was spelled four times as `/\.ya?ml$/`. Identical, so no bug -- but those
 * sites exist precisely to be compared, and a drift between them is the one
 * disagreement nothing downstream can catch, because the comparison *is* the
 * check.
 *
 * The asymmetry is what makes this worth unifying rather than merely tidying.
 * The walk must never recognise *fewer* file kinds than the enumeration:
 *
 *   walk wider than enumeration  -> flags a file the guard never reads: loud.
 *   walk narrower                -> the closure check stops looking at exactly
 *                                   the files it exists to find, passes, and
 *                                   reports on a subject it no longer covers.
 *
 * One ordering is harmless and the other is silent, and until now nothing here
 * recorded which one we had. Sharing the predicate removes the choice; the
 * property below pins the direction.
 */
export function isYamlFile(name: string): boolean {
    return /\.ya?ml$/.test(name);
}

/**
 * What the closure walk below opens: every file kind that can carry a
 * credential, which is deliberately wider than the YAML the guard reads.
 *
 * A mask copied out of a build log is wrong in any CI file, and a shell script
 * invoked by a pipeline step is a CI file -- `azure-pipelines.yml` calls
 * `scripts/browserstack-wait.sh` directly. Discovery keyed on YAML alone was
 * narrower than the risk while the comment above claimed otherwise, which is
 * the same overclaim that caused the bug this suite exists for: TESTING.md
 * listed a subset of the variable groups and read as exhaustive.
 *
 * Measured before widening rather than predicted: one tracked `.sh`, six
 * `package.json`, and **zero** non-YAML files carrying a credential shape
 * today. So this costs nothing now and fails the moment that stops being
 * true -- which is the only point at which anyone would want to know.
 */
export function isDiscoverableFile(name: string): boolean {
    return isYamlFile(name) || name.endsWith(".sh");
}

/**
 * The directories the guard reads, and what it accepts in each.
 *
 * At module scope so the closure check below can assert its own predicate
 * against these rather than against a copy of them.
 *
 * A mask copied out of a build log is wrong in any CI file, so the subject
 * is every YAML file that can carry one -- the walk below is wider still, and
 * flags anything outside these roots. The original glob read the repo root
 * alone: 7 of the repo's 10 `Authorization` headers, while its own doc
 * comment claimed to cover the pipelines. The three it missed are `curl`
 * uploads in the two shared templates -- included by azure-pipelines.yml at
 * four call sites, so they run on every PR -- and one workflow. That is
 * precisely the shape this bug takes.
 */
export const PIPELINE_ROOTS = [
    {
        dir: repoRoot,
        label: "",
        match: (n: string) => n.startsWith("azure-pipelines") && isYamlFile(n),
        atLeast: (n: string) => n.includes("azure-pipelines") && isYamlFile(n),
        requiresDeployToken: true,
    },
    { dir: join(repoRoot, "config", "templates"), label: "config/templates", match: isYamlFile, atLeast: isYamlFile, requiresDeployToken: true },
    { dir: join(repoRoot, ".github", "workflows"), label: ".github/workflows", match: isYamlFile, atLeast: isYamlFile, requiresDeployToken: false },
];

/**
 * One collected file per root, each reachable only by a distinct traversal
 * step: the repo root, a descent into `config/templates`, a descent into
 * `.github/workflows`.
 *
 * Shared by the collector floor and the closure floor, which ask the same
 * question of different sets and would otherwise hold two copies of this list
 * -- the duplication class these guards keep finding elsewhere.
 *
 * Deliberately NOT derived from PIPELINE_ROOTS, which looks like the obvious
 * simplification and destroys the guard: a floor keyed off the list it is
 * certifying cannot watch that list shrink, because deleting an entry deletes
 * its own check. Measured -- delete a root and this list fails by name; derive
 * it from PIPELINE_ROOTS instead and the same deletion is silent. The fixed
 * cardinality is what makes it work, and the growth direction it leaves open
 * is covered by the correspondence test rather than by coupling the lists.
 */
export const ONE_FILE_PER_ROOT = ["azure-pipelines-bundle-manifest.yml", "config/templates/upload-static-site.yml", ".github/workflows/compat-sync-trigger.yml"];

function pipelineFiles(): PipelineFile[] {
    const files: PipelineFile[] = [];
    for (const { dir, label, match, requiresDeployToken } of PIPELINE_ROOTS) {
        const names = readdirSync(dir).filter((f) => match(f));

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
 * True when `text` contains the unescaped close of a quoted scalar.
 *
 * Used at both ends -- deciding whether the opening line closes, and whether a
 * continuation line closes -- so the two cannot disagree about where a scalar
 * ends. They previously did: the opening test asked whether the value *ended*
 * with the quote, the continuation test whether the line *contained* one. Two
 * questions about the same thing, in one function, four lines apart.
 *
 * YAML escapes a quote inside a single-quoted scalar by doubling it, so an
 * apostrophe reads as a close to any containment test. That is not exotica:
 * `description:` is where English lives, and an apostrophe is ordinary English.
 * Earlier fixtures used prose without contractions -- not a decision, just how
 * the examples came out, which is what kept the hole invisible.
 */
export function closesQuotedScalar(text: string, quote: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const character = text[index];

        if (quote === '"') {
            if (character === "\\") {
                index++;
                continue;
            }
            if (character === '"') {
                return true;
            }
            continue;
        }

        if (character === "'") {
            if (text[index + 1] === "'") {
                index++;
                continue;
            }
            return true;
        }
    }

    return false;
}

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
                if (closesQuotedScalar(line, openQuote)) {
                    openQuote = null;
                }
                out.push("");
                continue;
            }
        }

        const match = DOCUMENTATION_KEY.exec(line);
        if (match) {
            const [, indent = "", key = "", rest = ""] = match;
            const value = rest.trim();
            const quote = value[0];
            if (/^[|>]/.test(value)) {
                blockIndent = indent.length;
            } else if ((quote === '"' || quote === "'") && !closesQuotedScalar(value.slice(1), quote)) {
                // A quoted scalar that does not close on its own line continues
                // onto the next. YAML folds those lines into a single string, so
                // a `run:` or an `Authorization:` header inside one is prose by
                // the grammar -- settled by the key plus the quote, with no
                // block scalar marker anywhere to signal it.
                openQuote = quote;
                quoteIndent = indent.length;
            }
            out.push(`${indent}${key}:`);
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
        // This clause had no floor at all: it asserts an empty offender list,
        // which an empty *input* satisfies perfectly. Every collected file must
        // contribute at least one line, or the strip has blanked a whole file
        // and the assertion below reports success over something never read.
        const contributing = new Set(pipelineLines().map(({ location }) => location));
        const silent = pipelineFiles()
            .map(({ location }) => location)
            .filter((location) => !contributing.has(location))
            .sort();
        expect(silent, "these files were collected but contributed no line to scan — the assertion below would pass over a file it never read").toEqual([]);

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
        // This floor catches nothing the named floors below miss: a named floor
        // requires a member, so it fires on collapse first. Measured -- delete
        // this line, collapse the collector, and the named floors still fail.
        // It is kept for the clearer message on that path, not for coverage.
        expect(headers.length, "no Authorization headers found — the assertions below would be vacuous").toBeGreaterThan(0);

        // Shrinkage, not collapse, is the direction that matters: a strip that
        // blanks one file too many, or a collector that stops reaching one
        // root, leaves both assertions below passing over a subject that
        // quietly lost a location. Name one file per root.
        const locations = headers.map(({ location }) => location);
        for (const required of ONE_FILE_PER_ROOT) {
            expect(locations, `no Authorization header collected from ${required} — the assertions below cover less than they claim`).toContain(required);
        }

        // Named floors ask "any", never "how many", so within-file loss is
        // invisible to them: measured, headers 10 -> 3 with the three named
        // files intact passes 68/68. The floor that sees it cannot be a count,
        // which would be a hand-maintained inventory, so compare the *same*
        // predicate across two substrates -- raw text and stripped text. The
        // difference is exactly what the strip removed.
        for (const file of pipelineFiles()) {
            const raw = readFileSync(file.path, "utf8").split("\n").filter(isAuthorizationHeader).length;
            const kept = headers.filter(({ location }) => location === file.location).length;

            expect(
                kept,
                `the strip removed ${raw - kept} Authorization header line(s) from ${file.location} before the assertions below ran. A header inside a documentation block is where a copied mask hides, so this needs reading rather than silencing`
            ).toBe(raw);
        }

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
function allYamlCarryingACredentialShape(root: string = repoRoot): string[] {
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
                isDiscoverableFile(name) &&
                stripDocumentationText(readFileSync(full, "utf8"))
                    .split("\n")
                    .some((l) => isAuthorizationHeader(l) || hasMaskedSecret(l))
            ) {
                found.push(relative(root, full).split(sep).join("/"));
            }
        }
    };
    walk(root);

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

    it.each([
        ["plain close", "abc'", "'", true],
        ["no close", "abc", "'", false],
        // A doubled quote is an escaped apostrophe, not the end of the scalar.
        // Ordinary English in the one key that holds English.
        ["doubled quote is an escape", "it''s here", "'", false],
        ["escape then real close", "it''s here'", "'", true],
        ["backslash escape in double quotes", String.raw`say \" more`, String.raw`"`, false],
        ["real close in double quotes", String.raw`say \" more"`, String.raw`"`, true],
    ])("closesQuotedScalar: %s", (_label, text, quote, expected) => {
        expect(closesQuotedScalar(text as string, quote as string)).toBe(expected);
    });

    it("stops the strip at a genuine close so real configuration is not blanked", () => {
        // The direction that would be worse than the misfire: running on past
        // the end of the scalar blanks live configuration and the suite stays
        // green, because every count here is computed after the strip.
        const text = ["      description: 'prose", "        ends here'", '      script: curl -H "Authorization: Bearer ******"'].join("\n");
        expect(stripDocumentationText(text).split("\n")[2]).toContain("Authorization");
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

describe("the walk recognises every file kind the enumeration collects", () => {
    // The relation, not the members. A fixture list would need me to guess
    // which extension drifts next, and the drift is by definition the one
    // nobody thought of -- so this asserts the containment that must hold for
    // *any* name, over candidates chosen to straddle the boundary.
    //
    // Direction matters and is the whole point: a walk narrower than the
    // enumeration stops discovering exactly the files it exists to find, and
    // then passes. Only `enumeration => walk` is asserted; the converse is
    // deliberately free, because the walk is meant to be the wider of the two.
    it("collects every file a deliberately wider predicate finds under each root", () => {
        // Named floors ask "any", never "how many", so they cannot see a root
        // that keeps working while losing a file. Measured: narrowing the root
        // matcher to require a dash drops azure-pipelines.yml -- the largest
        // pipeline in the repo -- and every assertion in this file passes,
        // because that file carries neither an Authorization header nor a
        // credential shape, so neither the header clause nor the closure walk
        // is positioned to notice.
        //
        // `atLeast` is deliberately wider than `match` and exists only to be
        // compared against it. Narrowing both together defeats this, which is
        // stated rather than prevented: the point is that one edit can no
        // longer shrink the subject in silence.
        for (const { dir, label, match, atLeast } of PIPELINE_ROOTS) {
            const lost = readdirSync(dir)
                .filter((name) => atLeast(name) && !match(name))
                .sort();

            expect(lost, `${label || "the repo root"} stopped collecting these files — the clauses above would report success over a subject that quietly lost them`).toEqual([]);
        }
    });

    it("names a floor file for every root, so a root added later cannot arrive unfloored", () => {
        // ONE_FILE_PER_ROOT is a fixed-cardinality list checked against a set
        // of roots that grows. Adding a fourth root leaves the floors covering
        // three of four: that root's descent can then be lost in silence,
        // because no named floor mentions it and every count stays healthy on
        // the strength of the roots that still work. The comment above the list
        // claims "one per root" -- this is that claim, in behaviour.
        // The directory must match exactly, not by prefix: `config/templates`
        // starts with `config/`, so a prefix test would report a `config` root
        // as floored on the strength of a name belonging to a different root.
        // That is this test's own failure mode, and it survived until the
        // control ran -- a fourth root passed 67/67 before this line said
        // `===` instead of `startsWith`.
        const unfloored = PIPELINE_ROOTS.filter(({ label }) => !ONE_FILE_PER_ROOT.some((file) => file.slice(0, file.lastIndexOf("/") + 1).replace(/\/$/, "") === label)).map(
            ({ label }) => label || "the repo root"
        );

        expect(unfloored, "these roots are collected but no floor names a file under them — losing their descent would be silent").toEqual([]);
    });

    it.each([
        "azure-pipelines.yml",
        "azure-pipelines-demos.yaml",
        "upload-static-site.yml",
        "compat-sync-trigger.yaml",
        "azure-pipelines.txt",
        "notes.md",
        "azure-pipelines",
        "Dockerfile",
    ])("any root that collects %s is a file the walk would also read", (name) => {
        for (const { label, match } of PIPELINE_ROOTS) {
            if (match(name)) {
                expect(
                    isDiscoverableFile(name),
                    `${label || "the repo root"} collects ${name}, but the closure walk would skip it — the walk would then certify a subject it no longer covers`
                ).toBe(true);
            }
        }
    });

    it("the walk accepts both extensions and reads only credential-bearing files, through the real walk", () => {
        // The property above pins `roots => isYamlFile`, which is silent about
        // whether the *walk* asks isYamlFile at all. A future edit inlining a
        // narrower literal at the call site satisfies every assertion above
        // while discovering less -- the call site is itself an untested
        // predicate. This runs the real walk over a fixture tree instead.
        const dir = mkdtempSync(join(tmpdir(), "hygiene-walk-"));
        try {
            writeFileSync(join(dir, "a.yaml"), '  - script: curl -H "Authorization: ******" https://x\n');
            writeFileSync(join(dir, "b.yml"), "  password: ******\n");
            writeFileSync(join(dir, "c.txt"), "  password: ******\n");
            // A pipeline step invokes scripts/browserstack-wait.sh directly, so
            // a shell script is CI configuration and can carry a credential.
            // Discovery has to be wider than the guard reads, or the closure
            // check certifies a subject the risk does not stay inside.
            writeFileSync(join(dir, "d.sh"), 'curl -H "Authorization: ******" https://x\n');
            // Discoverable, and deliberately carrying no credential shape.
            //
            // Without this file every fixture here satisfies *both* of the
            // walk's predicates, so the expected list is reachable by extension
            // alone: defeating the content check entirely left this test green
            // and was caught by a neighbouring guard, for a reason -- files
            // appearing outside the configured roots -- that has nothing to do
            // with the property this test owns. A fixture set needs a negative
            // per predicate, not one negative for the walk.
            writeFileSync(join(dir, "e.yml"), "  - script: echo hello\n");
            expect(allYamlCarryingACredentialShape(dir).sort()).toEqual(["a.yaml", "b.yml", "d.sh"]);
        } finally {
            // Asserted more strictly than the check needs, because a delete is
            // the one step whose failure re-running cannot undo -- an earlier
            // probe here removed 47 tracked fixtures through a path it had not
            // established was its own.
            expect(dir.startsWith(tmpdir()) && dir.includes("hygiene-walk-")).toBe(true);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("the candidates actually exercise both sides of the boundary", () => {
        // Without this the block above passes vacuously if every candidate is
        // rejected by every root -- the same empty-subject failure the
        // per-collector floors exist to catch.
        const collected = ["azure-pipelines.yml", "azure-pipelines-demos.yaml", "azure-pipelines.txt", "notes.md"].filter((n) => PIPELINE_ROOTS.some(({ match }) => match(n)));
        expect(collected).toEqual(["azure-pipelines.yml", "azure-pipelines-demos.yaml"]);
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

        // As with the header floor: this catches nothing the named floor below
        // misses, since a named floor fires on collapse first. Kept for the
        // clearer message, not for coverage.
        expect(carrying.length, "walked the repo and found no credential-shaped line at all — the assertion below would compare two empty sets").toBeGreaterThan(0);

        // A bare non-empty floor is not enough, and the mutation proving it is
        // one already run here: narrowing the walk to `.yml` left this check
        // green, because `length > 0` survives *shrinkage* and only catches
        // collapse. A walk that quietly stops reaching one kind of location
        // still certifies the guard's coverage -- over a subject that no
        // longer includes the place a credential would hide.
        //
        // One name per root, chosen because each is reachable only by a
        // distinct traversal step: the repo root, a descent into
        // config/templates, and a descent into .github/workflows. A floor
        // rather than an exact set on purpose -- an exact set would have to be
        // edited whenever any pipeline gains a header, which is drift, and it
        // would rebuild the hand-maintained inventory this walk exists to
        // replace. These three only need revisiting when a named file stops
        // carrying a credential shape at all, which is a deliberate act.
        for (const required of ONE_FILE_PER_ROOT) {
            expect(carrying, `the walk no longer reaches ${required}, so it is certifying a smaller subject than the guard reads`).toContain(required);
        }

        const unread = carrying.filter((file) => !scanned.has(file)).sort();

        // Split three ways, because one remediation is wrong for the others and
        // a false instruction is worse than none.
        //
        // Two different failures reach the YAML message, needing opposite
        // repairs. A file under a directory nobody listed wants the directory
        // added. A file under a directory that IS listed, excluded by that
        // root's `match` -- the repo root only collects the `azure-pipelines`
        // prefix -- is told to add a directory that is already entry #1.
        // Measured: a root-level ci-checks.yml with a credential shape fired
        // the add-the-directory advice, and following it literally widens the
        // repo root and hands pnpm-lock.yaml to the pipeline parser. Advice
        // that deepens the bug it reports.
        const listedDirectories = new Set(PIPELINE_ROOTS.map(({ label }) => label));
        const directoryOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
        const unreadYaml = unread.filter((file) => isYamlFile(file));

        expect(
            unreadYaml.filter((file) => listedDirectories.has(directoryOf(file))),
            "these files carry a credential shape and sit in a directory the guard already collects, but that root's `match` excludes them. Widen that root's `match` and `atLeast` in PIPELINE_ROOTS — do NOT add the directory again, which would hand every unrelated YAML in it to the pipeline parser:"
        ).toEqual([]);

        expect(
            unreadYaml.filter((file) => !listedDirectories.has(directoryOf(file))),
            "these files carry an Authorization header or a masked value, but the guard never reads them, so a credential in them is invisible. Add the directory to the roots list in pipelineFiles():"
        ).toEqual([]);

        expect(
            unread.filter((file) => !isYamlFile(file)),
            "these non-YAML files carry a credential shape. The guard parses pipeline YAML, so do NOT add them to the roots list — remove the credential instead, or mask it at the source rather than pasting a redacted build log:"
        ).toEqual([]);
    });
});
