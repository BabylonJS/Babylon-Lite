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
    // with no separator (`curl -u ******`) are not detected here, and
    // were not before. They are the subject of `carriesCredentialOnCommandLine`
    // below, which is a different question — not "was a value replaced by a
    // mask" but "is a live credential being passed as an argument" — asked by
    // its own clause and included in the closure walk's union.
    return /(?:authorization|authenticate|token|secret|passw(?:or)?d|credential|api[-_]?key)["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?\*{3,}(?=["'\s]|$)/i.test(code);
}

/**
 * Names that mean "this value is a credential".
 *
 * Shared by the command-line clause below so its two halves — "this is an
 * argument" and "this is a secret" — cannot drift apart.
 */
const CREDENTIAL_NAME = /(?:TOKEN|SECRET|PASSW(?:OR)?D|ACCESS_?KEY|API_?KEY|CREDENTIAL|_PAT\b|AUTH_?KEY)/i;

/**
 * True when a line hands a live credential to a program as a command-line
 * argument.
 *
 * This is the gap the mask guard names and does not cover, and it was a live
 * finding rather than a hypothetical: `scripts/browserstack-wait.sh` polled the
 * BrowserStack plan API with
 *
 *     curl -sf -u "${BROWSERSTACK_USERNAME}:${BROWSERSTACK_ACCESS_KEY}" …
 *
 * in a job holding the account key. An argument is not a secret channel — it is
 * in the process's own `/proc/<pid>/cmdline`, readable by every other process
 * running as the same user on the agent, and it is what `ps` prints for anyone
 * (or anything) sampling the machine. `env:` and stdin are the channels that are
 * not. The script now feeds curl the same setting through `--config -`.
 *
 * Both halves are required, and neither alone would work: a flag with an
 * interpolation is ordinary shell (`sort -u "$FILE"`, `mkdir -p "$WORK"`,
 * `tsc -p "$PROJECT"`), and a credential name on a line is most often the
 * correct `env:` mapping this repository uses everywhere. It is the conjunction
 * — a credential-named value in argument position — that is the defect.
 *
 * The second clause is the one that closes the finding this suite was written
 * around. `-u` is not the only argument that carries a credential, and it was
 * not the form this repository actually used: the four authenticated uploads
 * expanded the deploy token straight into a header argument,
 *
 *     curl … -H "Authorization: ${DEPLOY_TOKEN}"
 *
 * which is byte-for-byte the same exposure as `-u` — same argv, same
 * `/proc/<pid>/cmdline`, same `ps` — while passing every clause here, because
 * the flag-name alternation above simply did not list `-H`. A guard keyed on
 * *which flag* rather than on *what is in argument position* only ever catches
 * the specimen it was written from. So a payload-carrying flag (`-H`, `-d`,
 * `-F` and their long spellings) whose value interpolates a credential — or
 * which is an `Authorization:` header interpolating anything at all — is an
 * argument-position credential too. The correct form, used by all four call
 * sites now, emits `header = "Authorization: …"` into `curl --config -` on
 * stdin, which is not argv and is pinned by its own clause below.
 */
export function carriesCredentialOnCommandLine(line: string): boolean {
    const code = line.replace(/(^|\s)#.*$/, "");

    // The value alternation has to know each dialect's idea of "one argument":
    // a GitHub Actions expression contains spaces, so `\S+` alone captures
    // `${{` and reads as no interpolation at all. Found by the fixture below
    // rather than by review.
    for (const match of code.matchAll(/(?:^|\s)(?:-u|-p|--user|--proxy-user|--password|--api-key|--auth|--token)(?:=|\s+)("[^"]*"|'[^']*'|\$\{\{[^}]*\}\}|\S+)/g)) {
        const value = match[1] ?? "";
        // An interpolation in any of this repo's CI dialects, naming a secret.
        if (interpolatesAVariable(value) && CREDENTIAL_NAME.test(value)) {
            return true;
        }
    }

    for (const match of code.matchAll(/(?:^|\s)(?:-H|--header|-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form)(?:=|\s+)("[^"]*"|'[^']*'|\$\{\{[^}]*\}\}|\S+)/g)) {
        const value = match[1] ?? "";
        if (!interpolatesAVariable(value)) {
            // A literal header is not a credential channel. `-H "Content-Type:
            // multipart/form-data"` is on three of the four call sites and must
            // stay correct, or this clause is deleted the first time it runs.
            continue;
        }
        if (CREDENTIAL_NAME.test(value) || isAuthorizationHeader(value)) {
            return true;
        }
    }

    return false;
}

/**
 * A shell line that emits an `Authorization` header into a curl config file.
 *
 * This is the *correct* shape — the value goes to curl on stdin via
 * `--config -`, never through argv — and it has to be recognisable so the
 * clause below can require that the curl consuming it actually reads a config.
 * An emitter whose curl lost `--config` sends no credential at all and gets a
 * 401 that reads like a server problem; an emitter that quietly became an `-H`
 * again is the original finding.
 */
export function emitsCurlConfigHeader(line: string): boolean {
    return /header\s*=\s*"[^"]*authorization\s*:/i.test(line.replace(/(^|\s)#.*$/, ""));
}

/**
 * Physical lines folded into the logical shell commands they form.
 *
 * A curl invocation in these pipelines spans six or seven physical lines joined
 * by trailing backslashes, and the credential now arrives from a `printf` on
 * the other side of a trailing `|`. Every interesting property here — "this
 * header is consumed by a curl", "that curl reads `--config`" — is a property
 * of the whole command and is invisible to any single line of it, which is how
 * a line-at-a-time guard could watch `-H "Authorization: ${DEPLOY_TOKEN}"` for
 * as long as it did.
 *
 * The reported number is the line the command starts on, so a failure points at
 * something a reader can open.
 */
export function logicalCommands(text: string): { command: string; number: number; lines: number[] }[] {
    const out: { command: string; number: number; lines: number[] }[] = [];
    const lines = text.split("\n");

    for (let index = 0; index < lines.length; index++) {
        const first = lines[index] ?? "";
        if (first.trim() === "" || /^\s*#/.test(first)) {
            continue;
        }

        let command = first;
        const number = index + 1;
        const covered = [number];
        // A trailing `\` or `|` means the command continues. Comment-only
        // continuation lines are skipped rather than joined, so a comment
        // between a printf and its curl does not split the pair.
        while (/(\\|\|)\s*$/.test(command) && index + 1 < lines.length) {
            index++;
            const next = lines[index] ?? "";
            covered.push(index + 1);
            if (/^\s*#/.test(next)) {
                continue;
            }
            command = `${command.replace(/(\\)\s*$/, " ")} ${next.trim()}`;
        }

        out.push({ command, number, lines: covered });
    }

    return out;
}

/**
 * True when a line interpolates a variable in any CI dialect this repo uses.
 *
 * The scope of this suite was widened to `.github/workflows/` before this
 * predicate was: it recognised the Azure macro `$(X)` and the shell forms `$X`
 * and `${X}`, but not `${{ secrets.X }}`, which is the *canonical* GitHub
 * Actions reference. So the guard would have rejected a correct Actions header
 * -- a misfire, on the one file class that was just added to its subject.
 * Widening a collector does not widen the predicate that reads it, and an
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
     *
     * This flag is keyed on the root, but what it stands for is a property of
     * a file's content, and the two only coincide while the exempt root holds
     * a single file. `the deploy-token exemption is granted for its reason`
     * below holds the exempt headers to the property the flag is shorthand
     * for, so a workflow that authenticates some third way is not exempted by
     * where it happens to live.
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
export const ONE_FILE_PER_ROOT = ["azure-pipelines-bundle-manifest.yml", "config/templates/upload-static-site.yml", ".github/workflows/agent-approval.yml"];

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

describe("the command-line credential selector accepts and rejects the right lines", () => {
    // Both directions, and the rejections are the load-bearing half here. The
    // acceptances come from one real defect; the rejections come from ordinary
    // shell this repository is full of, and they are what decides whether this
    // clause survives its first false positive.
    it.each([
        ['        response=$(curl -sf -u "${BROWSERSTACK_USERNAME}:${BROWSERSTACK_ACCESS_KEY}" "$API_URL")', true],
        ['curl --user "$DEPLOY_TOKEN" https://deploy.invalid/upload', true],
        ["docker login -u ci -p ${{ secrets.REGISTRY_PASSWORD }} registry.invalid", true],
        ["npm publish --token=$NPM_TOKEN", true],
        // Ordinary shell: a flag with an interpolation, and no credential.
        ['sort -u "$JUNIT_FILES"', false],
        ['mkdir -p "$WORK"', false],
        ["npx tsc -p $PROJECT --noEmit", false],
        // The correct forms. A credential named in an `env:` mapping, read from
        // the environment, or fed to curl on stdin is the shape this repository
        // uses deliberately -- flagging it would delete the guard.
        ["          DEPLOY_TOKEN: $(DEPLOY_TOKEN)", false],
        ['printf \'user = "%s:%s"\\n\' "$user_escaped" "$key_escaped" | curl -sf --config - "$API_URL"', false],
        ["    # curl -u $BROWSERSTACK_USERNAME:$BROWSERSTACK_ACCESS_KEY -- do not do this", false],
    ])("%s -> carriesCredentialOnCommandLine=%s", (line, expected) => {
        expect(carriesCredentialOnCommandLine(line as string)).toBe(expected);
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
        //
        // Traced rather than matched on the line. The headers are no longer
        // `-H "Authorization: ${DEPLOY_TOKEN}"` -- that form put the secret in
        // argv -- so the reference is one escaping hop away, and the old
        // single-line pattern would have called the fix a violation.
        const bodies = new Map(pipelineFiles().map((file) => [file.location, readFileSync(file.path, "utf8")]));
        const tokenless = headers
            .filter(({ requiresDeployToken }) => requiresDeployToken)
            .filter(({ location, line }) => !credentialTracesToDeployToken(bodies.get(location) ?? "", line))
            .map(({ location, number }) => `${location}:${number}`);

        expect(tokenless, "Authorization header in an Azure pipeline does not reference DEPLOY_TOKEN, directly or through an assignment in its own file.").toEqual([]);
    });
});

/**
 * Names a text interpolates, in any dialect this repo uses.
 *
 * Extracted from the secret-store tracer when the deploy-token tracer below
 * needed the same two questions asked the same way. Two tracers with private
 * copies of "what does this line reference" is the duplication class these
 * guards keep finding in the pipelines they read.
 *
 * The extraction immediately paid for itself: the original omitted the Azure
 * macro `$(NAME)` -- the form `DEPLOY_TOKEN: $(DEPLOY_TOKEN)` takes in every
 * `env:` block in this repository -- while `interpolatesAVariable` two hundred
 * lines above already knew it. One of the two tracers would have been blind to
 * the repo's most common dialect, which is precisely the drift a shared
 * predicate removes.
 */
export function identifiersIn(text: string): string[] {
    return [
        ...[...text.matchAll(/\$(?:\{\{\s*(?:secrets\.)?|\{|\()?([A-Za-z_]\w*)/g)].map(([, name]) => name ?? ""),
        ...[...text.matchAll(/\bprocess\.env\.([A-Za-z_]\w*)/g)].map(([, name]) => name ?? ""),
    ];
}

/**
 * Every same-file assignment of `name`, as the text right of the separator.
 *
 * Both spellings of "this name gets a value": a shell assignment and a YAML
 * `env:` key. The exempt workflow uses one of each in the same chain, and the
 * upload templates use the shell form to escape the token for curl's config
 * parser.
 */
export function assignmentsOf(fileText: string, name: string): string[] {
    return fileText
        .split("\n")
        .filter((line) => new RegExp(`(^|\\s)${name}\\s*[:=]`).test(line))
        .map((line) => line.slice(line.search(/[:=]/) + 1));
}

/**
 * Whether a header's credential can be traced, through assignments in its own
 * file, to the hosting platform's secret store.
 *
 * This is the *reason* the `requiresDeployToken: false` roots are exempt from
 * the clause above, made executable. That exemption was keyed on the directory
 * while its justification was a property of one file's content -- and the
 * directory holds exactly one file today, so scope and reason coincide by
 * population size rather than by construction. The second workflow to be added
 * inherits an exemption it may not have earned, and nothing fires.
 *
 * Deliberately not "must say DEPLOY_TOKEN", which is the Azure convention and
 * would reject correct Actions code. The property asserted here is the one both
 * conventions share: a credential in a header came from the secret store, not
 * from the file. A workflow that authenticates some third way still passes, as
 * long as its secret is a secret.
 *
 * The trace is needed because the binding is rarely direct. A two-hop fixture
 * below builds `AUTH` from `ADO_PAT`, which is `${{ secrets.ADO_PAT }}`; a
 * one-level check would report that correct chain as unbound.
 */
export function credentialTracesToASecretStore(fileText: string, headerLine: string): boolean {
    const secretExpression = String.raw`\$\{\{\s*(?:secrets\.[A-Za-z_]\w*|github\.token)\s*\}\}`;
    const mentionsSecretStore = (text: string): boolean => new RegExp(secretExpression).test(text);
    const isSecretStoreValue = (text: string): boolean => new RegExp(`^\\s*["']?${secretExpression}["']?\\s*(?:#.*)?$`).test(text);

    if (mentionsSecretStore(headerLine)) {
        return true;
    }

    const pending = identifiersIn(headerLine);
    const seen = new Set<string>();

    // Bounded because assignments can be mutually referential; a cycle must end
    // the search rather than hang the suite.
    while (pending.length > 0 && seen.size < 64) {
        const name = pending.shift() ?? "";
        if (name === "" || seen.has(name)) {
            continue;
        }
        seen.add(name);

        const assignments = assignmentsOf(fileText, name);

        if (assignments.some(isSecretStoreValue)) {
            return true;
        }
        pending.push(...assignments.flatMap(identifiersIn));
    }

    return false;
}

/**
 * True when a header's credential is `DEPLOY_TOKEN`, directly or through
 * same-file assignments.
 *
 * The Azure clause used to ask this of a single line, with
 * `/\$[({]DEPLOY_TOKEN[)}]/` -- correct only while every header interpolated
 * the secret in place, which is exactly what the argv fix had to stop doing.
 * The header now reads `"$token_escaped"`, one hop from `DEPLOY_TOKEN`, and a
 * one-line test calls that correct chain tokenless. That is the failure
 * direction this file keeps warning about: a guard that rejects the fix it was
 * written to require gets deleted rather than debugged.
 *
 * The hop is not incidental and cannot be removed to satisfy a simpler check --
 * a curl config value is a quoted string, so the token has to be escaped before
 * it is written into one, and an escape is an assignment.
 *
 * Written as a trace rather than as "mentions DEPLOY_TOKEN anywhere in the
 * file", which every one of these files does in prose and in its `env:` block,
 * and which would therefore pass on a header wired to nothing at all.
 */
export function credentialTracesToDeployToken(fileText: string, headerLine: string): boolean {
    const pending = identifiersIn(headerLine);
    const seen = new Set<string>();

    while (pending.length > 0 && seen.size < 64) {
        const name = pending.shift() ?? "";
        if (name === "" || seen.has(name)) {
            continue;
        }
        seen.add(name);

        if (name === "DEPLOY_TOKEN") {
            return true;
        }
        pending.push(...assignmentsOf(fileText, name).flatMap(identifiersIn));
    }

    return false;
}

describe("no credential is passed to a program as an argument", () => {
    // Separate from the mask and header clauses because it reads a different
    // property of a line, and separate from the credential-isolation guards
    // because those decide *which job* may hold a secret at all: this one is
    // about how a job that legitimately holds one hands it to a process.
    //
    // A command line is not private. `/proc/<pid>/cmdline` is world-readable on
    // Linux, `ps` prints it, and agent diagnostics collect it -- so an argument
    // exposes the value to everything else running on the box for the lifetime
    // of the call, which no amount of log masking touches. `env:` and stdin do
    // not have that property, and every credential in this repository now uses
    // one of them.
    it("has no credential in argument position in any file the guard reads", () => {
        const contributing = new Set(pipelineLines().map(({ location }) => location));
        const silent = pipelineFiles()
            .map(({ location }) => location)
            .filter((location) => !contributing.has(location))
            .sort();
        expect(silent, "these files were collected but contributed no line to scan — the assertion below would pass over a file it never read").toEqual([]);

        const offenders = pipelineLines()
            .filter(({ line }) => carriesCredentialOnCommandLine(line))
            .map(({ location, number }) => `${location}:${number}`);

        expect(
            offenders,
            "a credential is being passed as a command-line argument, where every process on the agent can read it out of /proc. Pass it through `env:` (an ADO `env:` block, a GitHub `env:` key) or on stdin — `curl --config -` takes the same `user =` setting that `-u` does. Locations only; the line is not printed because it holds the value."
        ).toEqual([]);
    });
});

describe("the argument-position selector sees a header, not just a flag name", () => {
    // The rows that matter here are the `-H` ones. Every one of them passed the
    // flag-name-only version of this predicate while putting a live deploy
    // token in argv, which is the whole finding: `-u` was the specimen, not the
    // property. The rejections are what keeps the widened clause alive -- three
    // of the four call sites carry a literal `Content-Type` header, and a
    // clause that fails on those gets deleted the day it lands.
    it.each([
        // The four uploads as they were.
        ['            -H "Authorization: ${DEPLOY_TOKEN}" \\', true],
        ['                          -H "Authorization: Bearer ${DEPLOY_TOKEN}" \\', true],
        ['-H "Authorization: $(DEPLOY_TOKEN)"', true],
        ['-H "Authorization: Bearer ${{ secrets.DEPLOY_TOKEN }}"', true],
        ["--header=Authorization:${DEPLOY_TOKEN}", true],
        // Not a header, but the same mistake in a body.
        ['-d "token=${DEPLOY_TOKEN}"', true],
        ['-F "apiKey=${API_KEY}"', true],
        // Correct code on the very lines this clause reads.
        ['            -H "Content-Type: multipart/form-data" \\', false],
        ['            -F "path=${DEPLOY_PATH}" \\', false],
        ['            -F "storageAccount=${STORAGE_ACCOUNT}" \\', false],
        ['            -F "zip=@${ARCHIVE}"', false],
        // A literal header with no interpolation cannot be carrying a secret
        // that came from anywhere but the file, which the mask clause owns.
        ['-H "Authorization: Bearer static-text"', false],
        // The fix itself. The header exists, the token is in it, and neither is
        // an argument: `printf` is a bash builtin and curl reads it on stdin.
        ['          printf \'header = "Authorization: %s"\\n\' "$token_escaped" |', false],
        ['          curl "${DEPLOYMENT_SERVER}/${DEPLOY_ENDPOINT_UPLOAD}" --config - --fail-with-body --silent --show-error -X POST \\', false],
        // A documented example of the mistake is prose, not a mistake.
        ['          # -H "Authorization: ${DEPLOY_TOKEN}" -- do not do this', false],
    ])("%s -> carriesCredentialOnCommandLine=%s", (line, expected) => {
        expect(carriesCredentialOnCommandLine(line as string)).toBe(expected);
    });
});

describe("the curl-config emitter selector accepts and rejects the right lines", () => {
    it.each([
        ['printf \'header = "Authorization: %s"\\n\' "$token_escaped" |', true],
        ['printf \'header = "Authorization: Bearer %s"\\n\' "$token_escaped" |', true],
        ['printf \'header = "authorization: %s"\\n\' "$t" |', true],
        // A different setting in the same config dialect is not this one.
        ['printf \'user = "%s:%s"\\n\' "$user_escaped" "$key_escaped" | curl -sf --config - "$API_URL"', false],
        // The argv form is precisely what this must not accept, or the clause
        // below would certify the bug as the fix.
        ['-H "Authorization: ${DEPLOY_TOKEN}"', false],
        ["# printf 'header = \"Authorization: %s\"\\n' -- example", false],
    ])("%s -> emitsCurlConfigHeader=%s", (line, expected) => {
        expect(emitsCurlConfigHeader(line as string)).toBe(expected);
    });
});

describe("logical commands fold the lines a curl invocation is spread over", () => {
    it("joins a stdin emitter to the curl that consumes it", () => {
        const script = [
            "token_escaped=${DEPLOY_TOKEN//\\\\/\\\\\\\\}",
            'printf \'header = "Authorization: %s"\\n\' "$token_escaped" |',
            "# a comment between the two must not split the pair",
            'curl "${SERVER}/upload" --config - --fail-with-body \\',
            '  -F "zip=@${ARCHIVE}"',
        ].join("\n");

        const commands = logicalCommands(script);
        const authenticated = commands.filter(({ command }) => isAuthorizationHeader(command));

        expect(authenticated.length, "the emitter and its curl did not fold into one command, so the clause below cannot see the pair").toBe(1);
        const [folded] = authenticated;
        expect(folded?.command).toContain("--config -");
        expect(folded?.command).toContain("zip=@");
        // The reported line is where a reader should open the file, and the
        // covered set is what maps a header line back to its command.
        expect(folded?.number).toBe(2);
        expect(folded?.lines).toEqual([2, 3, 4, 5]);
    });

    it("does not fold two unrelated commands into one", () => {
        const commands = logicalCommands(['curl "$A/one" --config -', 'curl "$B/two" --config -'].join("\n"));
        expect(commands.length).toBe(2);
    });
});

describe("the deploy-token trace follows the escaping hop", () => {
    // The escaping hop is mandatory -- a curl config value is a quoted string --
    // so a check that cannot see through one assignment rejects the only
    // correct way to write this.
    const escaped = ["          token_escaped=${DEPLOY_TOKEN//\\\\/\\\\\\\\}", '          token_escaped=${token_escaped//\\"/\\\\\\"}'].join("\n");

    it("traces a header through the escape assignment to DEPLOY_TOKEN", () => {
        expect(credentialTracesToDeployToken(escaped, 'printf \'header = "Authorization: %s"\\n\' "$token_escaped" |')).toBe(true);
    });

    it("still accepts the direct interpolation", () => {
        expect(credentialTracesToDeployToken("", '-H "Authorization: ${DEPLOY_TOKEN}"')).toBe(true);
        expect(credentialTracesToDeployToken("", '-H "Authorization: $(DEPLOY_TOKEN)"')).toBe(true);
    });

    it("rejects a header wired to something that is not the deploy token", () => {
        // The counterfactual. A file that mentions DEPLOY_TOKEN in prose and in
        // its env: block -- as all three of these files do -- must not thereby
        // certify a header that never reaches it.
        const decoy = ["# DEPLOY_TOKEN comes from the BabylonJS-Deployment group", "          DEPLOY_TOKEN: $(DEPLOY_TOKEN)", "          other_escaped=${SOME_OTHER_VALUE}"].join(
            "\n"
        );
        expect(credentialTracesToDeployToken(decoy, 'printf \'header = "Authorization: %s"\\n\' "$other_escaped" |')).toBe(false);
    });

    it("terminates on a cycle", () => {
        const cyclic = ["          a=${b}", "          b=${a}"].join("\n");
        expect(credentialTracesToDeployToken(cyclic, '-H "Authorization: ${a}"')).toBe(false);
    });
});

describe("every authenticated curl takes its credential from a config on stdin", () => {
    // The positive counterpart to the argument-position clause. That one says
    // where the token must not be; this one says where it must be, and the two
    // fail on different mutations: reverting a call site to `-H` trips both,
    // but hoisting the emitter into a shell function -- which keeps the token
    // out of argv and silently detaches it from the request -- trips only this.
    //
    // A detached emitter is not a theoretical concern. It sends no credential
    // at all, and the deployment server answers 401, which reads like a server
    // problem rather than a pipeline one. That is the exact failure this branch
    // already spent a fix on.
    it("consumes every Azure-pipeline Authorization header through curl --config", () => {
        const offenders: string[] = [];
        const consumed: string[] = [];

        for (const file of pipelineFiles().filter(({ requiresDeployToken }) => requiresDeployToken)) {
            const text = stripDocumentationText(readFileSync(file.path, "utf8"));
            const byLine = new Map<number, string>();
            for (const { command, lines } of logicalCommands(text)) {
                for (const number of lines) {
                    byLine.set(number, command);
                }
            }

            text.split("\n").forEach((line, index) => {
                if (!isAuthorizationHeader(line)) {
                    return;
                }
                const at = `${file.location}:${index + 1}`;
                const command = byLine.get(index + 1) ?? line;
                const readsConfig = /(^|\s)--config(=|\s)/.test(command);
                const invokesCurl = /(^|[\s|])curl\s/.test(command);

                if (!emitsCurlConfigHeader(command) || !invokesCurl || !readsConfig) {
                    offenders.push(at);
                    return;
                }
                consumed.push(at);
            });
        }

        expect(
            offenders,
            'an Authorization header in an Azure pipeline is not being fed to a curl through `--config`. Emit it as `printf \'header = "Authorization: %s"\\n\' "$token_escaped" |` directly into the `curl … --config -` that sends it: an `-H` argument is world-readable in /proc/<pid>/cmdline, and an emitter separated from its curl sends no credential at all. Locations only; the line is not printed because it holds the value.'
        ).toEqual([]);

        // Floors, because the assertion above is satisfied by an empty input.
        // Named per file rather than counted in total: a total floor cannot see
        // one file stop contributing while the others hold the number up, which
        // is the same within-file shrinkage the header clause guards against.
        for (const required of ["azure-pipelines-bundle-manifest.yml", "config/templates/upload-static-site.yml", "config/templates/upload-test-report.yml"]) {
            expect(
                consumed.filter((at) => at.startsWith(`${required}:`)).length,
                `no config-fed Authorization header found in ${required} — its authenticated upload either lost its credential or stopped being read here`
            ).toBeGreaterThan(0);
        }

        // The static-site template authenticates twice, an upload and a CDN
        // purge, and the purge is the one inside a conditional -- the shape a
        // line-at-a-time reader is most likely to lose.
        expect(
            consumed.filter((at) => at.startsWith("config/templates/upload-static-site.yml:")).length,
            "the static-site template has two authenticated requests; only one was seen"
        ).toBe(2);

        console.log(`config-fed Authorization headers: ${consumed.length}`);
        for (const at of consumed) {
            console.log(`  ${at}`);
        }
    });
});

describe("the deploy-token exemption is granted for its reason", () => {
    it("binds every exempt Authorization header to the platform secret store", () => {
        const unbound = pipelineFiles()
            .filter(({ requiresDeployToken }) => !requiresDeployToken)
            .flatMap((file) => {
                const text = readFileSync(file.path, "utf8");
                return stripDocumentationText(text)
                    .split("\n")
                    .map((line, index) => ({ location: file.location, line, number: index + 1, text }))
                    .filter(({ line }) => isAuthorizationHeader(line))
                    .filter(({ line, text: body }) => !credentialTracesToASecretStore(body, line))
                    .map(({ location, number }) => `${location}:${number}`);
            });

        expect(
            unbound,
            "Authorization header in a root exempt from the DEPLOY_TOKEN convention, whose credential does not trace to the secret store. The exemption is not the directory's -- it is granted to headers that authenticate with a platform secret under a different convention. A header that authenticates some other way has not earned it."
        ).toEqual([]);
    });

    it("keeps both halves of the repo-root predicates doing work", () => {
        // The repo root is the only root whose `match` and `atLeast` are
        // compound, and the pair exists so the clause about near-misses can ask
        // for files that *look* collected and are not: `atLeast` is loose on
        // the name, `match` is strict. Every control before this one mutated a
        // predicate whole, and per-conjunct arms found that on today's tree
        // each conjunction is carried by one half -- in opposite halves:
        //
        //   match loses startsWith("azure-pipelines")   77 passed, and the root
        //                                               silently began collecting
        //                                               pnpm-lock.yaml
        //   atLeast loses isYamlFile                    77 passed
        //
        // Neither is decorative by design; both are decorative against this
        // tree, because it contains no near-miss. It has no reason to -- nobody
        // adds `ci-azure-pipelines.yml` to prove a guard works. So the
        // separating cases are specimens here rather than files in the tree.
        const root = PIPELINE_ROOTS.find(({ label }) => label === "");
        expect(root, "the repo root is no longer among PIPELINE_ROOTS, so this pins nothing").toBeDefined();

        const { match, atLeast } = root ?? { match: () => false, atLeast: () => false };
        const cases: Array<[string, boolean, boolean, string]> = [
            ["azure-pipelines.yml", true, true, "a real pipeline: both halves of both predicates"],
            ["ci-azure-pipelines.yml", false, true, "the near-miss the pair exists to expose: named like a pipeline, not collected"],
            ["azure-pipelines-notes.txt", false, false, "prefix without the extension: only isYamlFile separates it"],
            ["pnpm-lock.yaml", false, false, "yaml at the root that is not a pipeline: only the name test separates it"],
        ];

        for (const [name, expectedMatch, expectedAtLeast, why] of cases) {
            expect(match(name), `${name}: ${why} (match)`).toBe(expectedMatch);
            expect(atLeast(name), `${name}: ${why} (atLeast)`).toBe(expectedAtLeast);
        }

        // The pair's whole purpose, stated as a property rather than left to
        // the rows: atLeast must be strictly looser, or the near-miss clause is
        // comparing a set against itself.
        const looser = cases.filter(([name]) => atLeast(name) && !match(name));
        expect(
            looser.length,
            "no specimen is accepted by atLeast and refused by match, so the two predicates are interchangeable and the near-miss clause below can never report anything"
        ).toBeGreaterThan(0);
    });

    it("has an exempt header to say that about", () => {
        // Without this the clause above passes on zero headers, which is the
        // state it would be in if the exempt root were emptied or the flag
        // stopped selecting anything -- indistinguishable from compliance.
        //
        // That second condition is the one this used to claim and not deliver.
        // A bare `length > 0` is a presence floor, and both halves of the
        // filter feeding it only ever *widen* the set, so deleting either is
        // invisible: dropping `!requiresDeployToken` admits every header in the
        // repo, dropping `isAuthorizationHeader` admits every line of the
        // exempt file, and both mutations left 77 passing. The floor could see
        // its subject become empty and never see it become the wrong subject.
        //
        // So assert the members rather than the count. Each property below is
        // the observable contribution of one conjunct, which is what makes
        // deleting that conjunct fail here.
        const exempt = pipelineLines().filter(({ requiresDeployToken, line }) => !requiresDeployToken && isAuthorizationHeader(line));

        expect(
            exempt.length,
            "no exempt Authorization header remains, so the clause above is asserting nothing. If the last one is genuinely gone, delete the exemption and the requiresDeployToken flag with it rather than keeping a branch nothing travels."
        ).toBeGreaterThan(0);

        const notHeaders = exempt.filter(({ line }) => !isAuthorizationHeader(line)).map(({ location, number }) => `${location}:${number}`);
        expect(notHeaders, "the exempt set contains lines that are not Authorization headers, so it is no longer the set the clause above reasons about").toEqual([]);

        const tokenRequiring = exempt.filter(({ requiresDeployToken }) => requiresDeployToken).map(({ location, number }) => `${location}:${number}`);
        expect(tokenRequiring, "the exempt set contains headers from a root that does require DEPLOY_TOKEN, so the exemption flag is not what selected them").toEqual([]);

        // And the distinction has to distinguish. If every header in the repo
        // were exempt, `!requiresDeployToken` would be selecting everything and
        // the flag would carry no information -- non-empty, correct in every
        // member, and still vacuous.
        const governed = pipelineLines().filter(({ requiresDeployToken, line }) => requiresDeployToken && isAuthorizationHeader(line));
        expect(
            governed.length,
            "every Authorization header in the repo is exempt, so the DEPLOY_TOKEN convention governs nothing and the clause above is comparing a set against itself"
        ).toBeGreaterThan(0);
    });

    it("withdraws the exemption when the credential stops coming from a secret", () => {
        // The counterfactual, which is the whole point: an exclusion that
        // cannot be reversed by changing the thing it depends on is a name,
        // whatever the comment beside it says. Run against the real exempt
        // file, in memory, so it measures the convention actually in use.
        const exempt = pipelineFiles().filter(({ requiresDeployToken }) => !requiresDeployToken);
        expect(exempt.length, "the exempt root selects no file, so the mutation below would measure nothing").toBeGreaterThan(0);

        const [file] = exempt;
        const text = readFileSync(file?.path ?? "", "utf8");
        const header = text.split("\n").find(isAuthorizationHeader) ?? "";
        expect(header, "the exempt file carries no Authorization header to withdraw the exemption from").not.toBe("");

        expect(credentialTracesToASecretStore(text, header), "the real exempt header does not trace to a secret, so this guard is red on a correct tree").toBe(true);

        // Same file, same header, secret provenance removed.
        expect(
            credentialTracesToASecretStore(text.replace(/\$\{\{\s*(?:secrets\.[^}]*|github\.token\s*)\}\}/g, "'a-literal-value'"), header),
            "the exemption survived its own justification being removed"
        ).toBe(false);
    });
});

describe("credential tracing accepts and rejects the right chains", () => {
    it("follows a multi-hop chain to the secret store", () => {
        const text = ["                  ADO_PAT: ${{ secrets.ADO_PAT }}", '                  AUTH=$(printf ":%s" "$ADO_PAT" | base64 -w0)'].join("\n");

        expect(credentialTracesToASecretStore(text, '                    -H "Authorization: Basic ${AUTH}" \\')).toBe(true);
    });

    it("accepts a header that names the secret store directly", () => {
        expect(credentialTracesToASecretStore("", '  -H "Authorization: Bearer ${{ secrets.API_TOKEN }}"')).toBe(true);
    });

    it("accepts the ephemeral GitHub Actions token and no other GitHub context value", () => {
        const expression = (property: string): string => "$" + `{{ github.${property} }}`;

        expect(credentialTracesToASecretStore(`GITHUB_TOKEN: ${expression("token")}`, 'Authorization: "Bearer ${GITHUB_TOKEN}"')).toBe(true);
        expect(credentialTracesToASecretStore(`GITHUB_TOKEN: ${expression("token")}`, "Authorization: `Bearer ${process.env.GITHUB_TOKEN}`")).toBe(true);
        expect(credentialTracesToASecretStore(`GITHUB_TOKEN: ${expression("actor")}`, 'Authorization: "Bearer ${GITHUB_TOKEN}"')).toBe(false);
        expect(credentialTracesToASecretStore(`GITHUB_TOKEN: "documentation mentions ${expression("token")}"`, 'Authorization: "Bearer ${GITHUB_TOKEN}"')).toBe(false);
    });

    it("rejects a chain that terminates in a literal", () => {
        const text = ['                  ADO_PAT: "hunter2"', '                  AUTH=$(printf ":%s" "$ADO_PAT" | base64 -w0)'].join("\n");

        expect(credentialTracesToASecretStore(text, '                    -H "Authorization: Basic ${AUTH}" \\')).toBe(false);
    });

    it("rejects a variable the file never binds at all", () => {
        expect(credentialTracesToASecretStore("unrelated: true\n", '  -H "Authorization: Bearer ${MYSTERY}"')).toBe(false);
    });

    it("terminates on a cycle instead of hanging the suite", () => {
        expect(credentialTracesToASecretStore("A=$B\nB=$A\n", '  -H "Authorization: Bearer ${A}"')).toBe(false);
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
 *
 * `carriesCredentialOnCommandLine` joined the union with the clause that reads
 * it, for the same reason and in the same edit: a predicate added to the guard
 * and not to the walk leaves the walk certifying the smaller of the two.
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
                    .some((l) => isAuthorizationHeader(l) || hasMaskedSecret(l) || carriesCredentialOnCommandLine(l))
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
        // The repo root's label. `component !== ""` in the reachability clause
        // guards against this being false; that guard is redundant only for as
        // long as this row holds, and deleting the guard is invisible without
        // it. Pinned so the redundancy is a stated fact rather than a
        // coincidence nothing measures.
        ["", true],
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

    it("keeps every configured root reachable by the walk that certifies it", () => {
        // The skip list is the cheapest way to defeat this whole file. Break a
        // root's collector, delete its floor entry, delete the root, then add
        // its directory to the skip list: four edits, each one resolving a real
        // failure, ending with the directory unguarded and the suite green.
        //
        // Measured. That chain currently dies at `isWalkableDir(config) -> true`
        // -- a fixture, not a floor, which is the right shape for stopping it:
        // the only way past a fixture is to assert in plain text that `config`
        // is not walkable, and a visibly false statement is a much harder edit
        // to make quietly than deleting a name from a list.
        //
        // But that table pins today's directories. A root added under a new one
        // has no fixture, so for it the chain would run to the end. This clause
        // is what a future root gets instead: it is derived, so it arrives with
        // the root rather than being remembered.
        //
        // It does not close the four-edit chain, and does not pretend to --
        // deleting the root removes this check along with its subject. That
        // collapse is the reason the isWalkableDir fixtures are separate from
        // the roots list and must stay that way.
        const configured = PIPELINE_ROOTS.map(({ label }) => label).filter((label) => label !== "");

        expect(configured.length, "no root has a directory component, so this clause is checking nothing").toBeGreaterThan(0);

        const blocked = configured.flatMap((label) =>
            label
                .split("/")
                // The empty component is the repo root's own label, which is not a
                // directory to descend into. Redundant while isWalkableDir("") is
                // true -- pinned in the fixture table above, because a per-conjunct
                // arm showed removing this guard changes nothing today.
                .filter((component) => component !== "" && !isWalkableDir(component))
                .map((component) => `${label} (the walk stops at "${component}")`)
        );

        expect(
            blocked,
            "a configured root cannot be reached by the walk that certifies it, so the closure check silently stops covering it. Remove the directory from the skip list in isWalkableDir. Do not resolve this by deleting the root from PIPELINE_ROOTS: that turns this clause and the closure check green together, which is the exact state -- a CI directory nothing reads -- that the two of them exist to make unreachable."
        ).toEqual([]);
    });

    it.each([
        "azure-pipelines.yml",
        "azure-pipelines-demos.yaml",
        "upload-static-site.yml",
        "agent-approval.yaml",
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
            // Discoverable, credential-bearing, and masked-free -- the negative
            // for `isAuthorizationHeader`, which the comment above claimed to
            // have covered and did not.
            //
            // "The content check" is one name for two independent disjuncts,
            // and `e.yml` is a negative for their disjunction, not for either
            // of them. Every header fixture here spells its value `******`,
            // because that is the obvious way to write a masked header -- so
            // each one satisfies `hasMaskedSecret` by the notation of its own
            // subject, and dropping `isAuthorizationHeader` from the walk left
            // this test green. A neighbour caught it, correctly, for an
            // unrelated reason, which is the same accidental coverage the
            // paragraph above was written about.
            //
            // The unmasked `Bearer` form is not a contrivance to make an arm
            // fire: it is what these headers look like before someone masks
            // them, which is the state this guard exists to notice.
            writeFileSync(join(dir, "f.yml"), '  - script: curl -H "Authorization: Bearer $(DEPLOY_TOKEN)" https://x\n');
            expect(allYamlCarryingACredentialShape(dir).sort()).toEqual(["a.yaml", "b.yml", "d.sh", "f.yml"]);
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
            expect(
                carrying,
                `the walk no longer reaches ${required}, so it is certifying a smaller subject than the guard reads. Repair the walk. Deleting ${required} from ONE_FILE_PER_ROOT also turns this green, in one edit, and leaves the walk permanently blind to that root -- this constant is both the floor and the cheapest way to remove it.`
            ).toContain(required);
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
            "these non-YAML files carry a credential shape. The guard parses pipeline YAML, so do NOT add them to the roots list — remove the credential instead. For a mask, mask it at the source rather than pasting a redacted build log; for a credential in argument position, pass it through the environment or on stdin:"
        ).toEqual([]);
    });
});
