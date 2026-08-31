import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..", "..");

/**
 * Guards the structure that keeps pull-request CI from handing a credential to
 * the code under review.
 *
 * For a pull-request build, Azure reads the pipeline definition from the pull
 * request, not from the target branch. Whatever `azure-pipelines.yml` says about
 * which job holds which secret is therefore written by the author of the change
 * being reviewed. The repository's first answer is to keep nothing in that file:
 * it is a shell that `extends` `config/templates/pr-ci.yml` through a repository
 * resource pinned to `refs/heads/master`, and repository resources resolve from
 * their pinned ref, so the jobs that actually run are the reviewed ones.
 *
 * That is not the load-bearing part, and treating it as though it were is the
 * defect this file now also guards. Pipeline authorization is per *definition*,
 * not per file: a pull request that deletes the `extends` and writes its own
 * jobs can ask for anything the PR CI definition is authorized for. The
 * server-side answer is a Required-template check — which cannot be applied to a
 * resource that master pipelines also consume, because those declare their
 * stages inline and would be refused it outright. `BabylonJS-Deployment`,
 * `BabylonJS-CI-Infrastructure` and `BabylonBotPAT` were consumed by both sides,
 * so the check that was supposed to protect them could never be turned on.
 *
 * So the *resources* are separated rather than the checks argued about, and that
 * separation is what the assertions below are mostly about:
 *
 *   - the entry point stays a shell, pinned to master;
 *   - nothing a pull request can reach — the entry point, the pinned template,
 *     any template they include — names a variable group, a deploy credential or
 *     a write-capable service connection. The one protected resource PR CI
 *     consumes is a read-only GitHub connection whose compromise buys read
 *     access to a repository the attacker is already reading;
 *   - no protected resource is consumed by both a PR-reachable definition and a
 *     master-only one, so no resource needs two incompatible check regimes;
 *   - no job that checks out the pull request holds a credential of any kind —
 *     no variable group, no GITHUB_TOKEN, no System.AccessToken, and no
 *     `persistCredentials`, which leaves the OAuth token in `.git/config` for
 *     every later step including dependency lifecycle scripts;
 *   - authenticated uploads run in jobs that check out nothing, in definitions a
 *     pull request cannot trigger, and pin the destination host to an allowlist
 *     rather than to "it is https".
 *
 * These are invisible in review: a variable group moved back into the pinned
 * template, or a `checkout: self` added to a publish job, looks like a tidy-up
 * and silently restores the whole vulnerability.
 */

/** The pull-request entry point: the only pipeline with a `pr:` trigger. */
const ENTRY_POINT = "azure-pipelines.yml";

/** Where the pull-request stages actually live, read from the pinned ref. */
const PINNED_TEMPLATE = "config/templates/pr-ci.yml";

/**
 * The master-only definition that publishes what a pull-request run staged.
 *
 * The API/bundle-size comments and release-marker label check live here instead.
 * Preview publishing remains disabled until a dedicated untrusted origin exists.
 * It is `trigger: none` / `pr: none`; a `resources.pipelines` completion trigger
 * would run *this* file from the triggering run's branch when the two share a
 * repository — that is, from the pull request, holding every credential below.
 * Manual queueing is an emergency/debug interface until #627 supplies the
 * scheduled master poller.
 */
const PUBLISHER = "azure-pipelines-pr-publish.yml";

/**
 * The only protected resource a pull-request build is allowed to consume.
 *
 * A GitHub service connection scoped to *read* this repository, which is what a
 * repository resource needs in order to resolve the pinned template. It is
 * deliberately not `BabylonBotPAT`: that connection can comment and tag, and is
 * consumed by the master-only publishers, so a required-template check on it
 * would break them — the exact incompatibility this split removes.
 */
const PR_READ_ENDPOINT = "BabylonLite-PRCI-RepoRead";

/**
 * Every protected resource that carries a secret, a write or a deploy.
 *
 * Named as strings rather than as `- group:` patterns because a group import is
 * only one of the ways to reach one: an `endpoint:` on a repository resource, a
 * `gitHubConnection:` on a task and a hand-mapped `env:` are three more, and the
 * assertions below look for the name anywhere in a PR-reachable file.
 */
const MASTER_ONLY_RESOURCES = ["BabylonJS-Deployment", "BabylonJS-CI-Infrastructure", "BabylonJS-BrowserStack", "BabylonJS-NpmPublish", "BabylonBotPAT"];

const UPLOAD_TEMPLATES = ["config/templates/upload-static-site.yml", "config/templates/upload-test-report.yml"];

/** Groups whose secrets can write to, or authenticate against, other systems. */
const PRIVILEGED_GROUPS = ["BabylonJS-Deployment", "BabylonJS-CI-Infrastructure"];

/**
 * The protected variable group that carries the npm registry credential, and the
 * name of the credential inside it.
 *
 * Both were introduced together, and the rename is load-bearing rather than
 * cosmetic. The token used to be `$(NPM_TOKEN)` with no group import at all,
 * which meant it could only ever have come from a **pipeline-level UI variable**
 * — and a UI variable is not a protected resource. No branch-control check, no
 * pipeline-authorization check and no required-template check applies to one;
 * every job in the definition can read it; and because a manually queued run
 * executes the YAML of whatever ref it names, a run from an arbitrary branch
 * could write itself a job that asks for the token and gets it. Importing a
 * group inside the publishing job puts the credential behind checks that YAML
 * cannot edit.
 *
 * Renaming at the same time is what makes the migration fail-closed. Had the
 * group exported `NPM_TOKEN`, a leftover UI variable of that name would keep
 * publishing working whether or not the group was ever created or authorized —
 * the exact configuration error this change exists to make impossible would be
 * invisible, and the credential in use would still be the unprotected one.
 */
const PUBLISH_GROUP = "BabylonJS-NpmPublish";
const PUBLISH_TOKEN = "NPM_PUBLISH_TOKEN";

/**
 * Names the publish path must no longer use.
 *
 * `NPM_TOKEN` is the retired one; the others are the spellings a future edit is
 * most likely to reach for when wiring npm auth from an environment rather than
 * from the group. Any of them appearing in a pipeline means a credential is
 * being taken from somewhere other than `BabylonJS-NpmPublish` — which, since
 * nothing in this repository defines them, means a pipeline UI variable.
 */
const RETIRED_PUBLISH_TOKEN_NAMES = ["NPM_TOKEN", "NPM_AUTH_TOKEN", "NODE_AUTH_TOKEN"];

/**
 * Credentials a job running pull-request code may hold: none.
 *
 * This list used to contain `BabylonJS-BrowserStack`, on the reasoning that a
 * cloud browser test cannot run without the account key and a leaked key only
 * buys browser minutes. That was wrong twice over. The key is long-lived, so a
 * pull request that never merges still walks away with it permanently; and a
 * BrowserStack session is a browser on someone else's network, which is a
 * position to attack from rather than a metered resource. The cloud tests moved
 * to azure-pipelines-cloud-tests.yml, which has no `pr:` trigger and therefore
 * only ever runs reviewed master code.
 *
 * Deliberately empty. Adding an entry here is the change this file exists to
 * make someone argue for.
 */
const ALLOWED_IN_PULL_REQUEST_JOBS: string[] = [];

/** Where the cloud-browser tests live now: master only, never a pull request. */
const CLOUD_PIPELINE = "azure-pipelines-cloud-tests.yml";

/** The cloud-browser credential, banned from anything a pull request reaches. */
const CLOUD_GROUP = "BabylonJS-BrowserStack";
const TESTING_GUIDE = "TESTING.md";

/**
 * Credentials that can write to npm, GitHub or the deployment server.
 *
 * A job holding one of these must not run repository code on the same agent —
 * not the pull request's, and not master's dependency tree either. `pnpm
 * install` alone executes every transitive dependency's install hooks, and
 * `npm publish` of a directory runs the package's own prepack hooks.
 */
const DEPLOYMENT_CREDENTIAL_MARKERS = [
    /^\s*-\s*group:\s*BabylonJS-Deployment\s*$/m,
    /^\s*-\s*group:\s*BabylonJS-CI-Infrastructure\s*$/m,
    /^\s*-\s*group:\s*BabylonJS-NpmPublish\s*$/m,
    /NPM_PUBLISH_TOKEN:/,
    /gitHubConnection:/,
    /GITHUB_TOKEN:/,
    // #627's three. Without them the sticky-comment token, the publisher-queue
    // identity and the pull-request metadata token would each be a credential
    // that *no* suite below selects for — the poller job would have been swept
    // by none of the checkout, install, ref-gate or agent-sharing rules, which
    // is precisely how a new credential quietly escapes an old guard.
    /^\s*-\s*group:\s*BabylonLite-PRComments\s*$/m,
    /^\s*-\s*group:\s*BabylonLite-PRPublishQueue\s*$/m,
    /^\s*-\s*group:\s*BabylonLite-PRMetadata\s*$/m,
    /PR_COMMENT_TOKEN:/,
    /PR_PUBLISH_QUEUE_TOKEN:/,
    /PR_METADATA_TOKEN:/,
];

function read(file: string): string {
    return readFileSync(join(repoRoot, file), "utf8");
}

/**
 * The file with whole-line comments removed.
 *
 * These pipelines explain their own security properties in prose — "No
 * `persistCredentials`", "No GITHUB_TOKEN: this step runs PR-authored source" —
 * so a search of the raw text finds the documentation of a rule and reports it
 * as a violation of that rule. Assertions about what the YAML *does* must read
 * only the YAML.
 */
function withoutComments(source: string): string {
    return source
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
}

/** Every pipeline definition at the repository root. */
function allPipelines(): string[] {
    const files = readdirSync(repoRoot).filter((f) => /^azure-pipelines.*\.ya?ml$/.test(f));

    // Guard the guard: an empty subject makes every assertion below vacuously
    // true, which is precisely the failure this file exists to prevent.
    expect(files.length, "found no azure-pipelines*.yml files to inspect").toBeGreaterThan(0);
    return files.sort();
}

/**
 * Pipelines that build from a pull-request ref, and so run untrusted code.
 *
 * Three cases, and the third is the one that has to fail closed. `pr: none` opts
 * out; a bare `pr:` opens a branch-filter block and opts in; and **omitting the
 * key entirely also opts in** — Microsoft: "If you specify no pull request
 * trigger, pull requests to any branch trigger a build."
 *
 * That third case used to be a gap in coverage. It is now a permission: the
 * complement of this set is what `masterOnlyFiles()` treats as entitled to
 * `BabylonJS-Deployment` and `BabylonBotPAT`. A future pipeline that forgets
 * `pr: none` is genuinely pull-request-triggered, so classifying it as master-only
 * would put a credential behind a definition a pull request can rewrite — the
 * finding this file exists to close, reintroduced by a classifier default.
 */
function prTriggeredPipelines(): string[] {
    return allPipelines().filter((f) => {
        const source = read(f);
        return /^pr:\s*$/m.test(source) || !/^pr:/m.test(source);
    });
}

interface Job {
    name: string;
    /** The job's own lines, from its `- job:` line up to the next job. */
    body: string;
}

/**
 * Splits a pipeline into job blocks.
 *
 * Line-based rather than YAML-parsed, matching the other pipeline guards in
 * this directory (the repo ships no YAML parser as a direct dependency).
 */
function jobsOf(source: string): Job[] {
    const lines = source.split("\n");
    const starts: { line: number; name: string }[] = [];
    lines.forEach((line, index) => {
        const name = /^\s*-\s*job:\s*(\S+)\s*$/.exec(line)?.[1];
        if (name !== undefined) {
            starts.push({ line: index, name });
        }
    });

    return starts.map(({ line, name }, index) => ({
        name,
        body: lines.slice(line, starts[index + 1]?.line ?? lines.length).join("\n"),
    }));
}

/**
 * True when a job runs code authored by the pull request.
 *
 * `checkout: self` is the whole test, and the absence of any checkout directive
 * counts as well because that is Azure's default. Note what is deliberately no
 * longer a marker: an inline `- script:`. Since the stages moved behind the
 * pinned template, a script body written there comes from master like any other
 * reviewed file — it is the *checkout* that decides whose code runs.
 */
function runsPullRequestCode(body: string): boolean {
    if (/^\s*-\s*checkout:\s*self\b/m.test(body)) {
        return true;
    }
    return !/^\s*-\s*checkout:\s*\S+/m.test(body);
}

/**
 * Names that mean "credential", wherever they appear in a job.
 *
 * The clauses above name the credentials this repository has today —
 * `- group:`, `GITHUB_TOKEN`, `System.AccessToken`, `gitHubConnection`. That is
 * a denylist of known specimens, and the vulnerability being guarded is
 * precisely someone arriving with a new one: the BrowserStack key reached
 * pull-request code as `BROWSERSTACK_ACCESS_KEY:` in an `env:` block, which is
 * none of those four shapes. This pattern is the general form, so a credential
 * added tomorrow is refused by default rather than until somebody remembers to
 * extend a list.
 */
const CREDENTIAL_NAME = /(?:TOKEN|SECRET|PASSW(?:OR)?D|ACCESS_?KEY|API_?KEY|CREDENTIAL|BROWSERSTACK|_PAT\b)/i;

/**
 * Names that match the pattern above but are not credentials.
 *
 * Kept deliberately tiny and explained one by one: an exemption list is how a
 * general rule decays back into a specimen list.
 */
const NOT_A_CREDENTIAL = [
    // Playwright's own knob for where its JUnit file goes.
    "PLAYWRIGHT_JUNIT_OUTPUT_NAME",
];

/**
 * Every name a job introduces or reads that looks like a credential.
 *
 * Reads three shapes, because they are three ways to the same place: an `env:`
 * or `variables:` key (`NPM_TOKEN: $(NPM_TOKEN)`), a `- name:` variable
 * declaration, and a macro dereference (`$(NPM_TOKEN)`, `${{ secrets.X }}`) of
 * a name the job never declares.
 */
function credentialNamesIn(body: string): string[] {
    const found = new Set<string>();
    const consider = (name: string | undefined): void => {
        if (name && CREDENTIAL_NAME.test(name) && !NOT_A_CREDENTIAL.includes(name)) {
            found.add(name);
        }
    };

    for (const line of withoutComments(body).split("\n")) {
        // Two shapes, because they are two different lines: a mapping key
        // (`NPM_TOKEN: $(NPM_TOKEN)`) carries the colon after the name, and an
        // ADO variable declaration (`- name: DEPLOY_TOKEN`) carries it before.
        consider(/^\s*-\s*name:\s*([A-Za-z_][\w.]*)\s*$/.exec(line)?.[1]);
        consider(/^\s*([A-Za-z_][\w.]*)\s*:/.exec(line)?.[1]);
        for (const macro of line.matchAll(/\$\(\s*([A-Za-z_][\w.]*)\s*\)|\$\{\{\s*[\w.]*\.([\w.]+)\s*\}\}/g)) {
            consider(macro[1] ?? macro[2]);
        }
    }

    return [...found].sort();
}

/**
 * A job's own properties: everything above its `steps:`.
 *
 * A job-level `condition:` and a step-level one are the same six letters at
 * different indentation, and only the first decides whether the job runs at
 * all. Slicing at `steps:` is what keeps the ref-gate clause from being
 * satisfied by a condition on some step inside the job.
 */
function jobHeader(body: string): string {
    const lines = body.split("\n");
    const steps = lines.findIndex((line) => /^\s*steps:\s*$/.test(line));
    return lines.slice(0, steps === -1 ? lines.length : steps).join("\n");
}

/** A job's own `condition:`, or "" when it has none. */
function jobCondition(body: string): string {
    return /^\s*condition:\s*(.+)$/m.exec(jobHeader(body))?.[1]?.trim() ?? "";
}

function declaredGroups(body: string): string[] {
    return [...body.matchAll(/^\s*-\s*group:\s*(\S+)\s*$/gm)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/** Jobs that perform an authenticated upload via a shared deploy template. */
function callsUploadTemplate(body: string): boolean {
    return /^\s*-\s*template:\s*(config\/templates\/)?upload-[\w-]+\.yml\s*$/m.test(body);
}

/** The `variables:` block at file scope, i.e. before the first stage or job. */
function fileScopedVariables(source: string): string {
    const start = source.search(/^variables:\s*$/m);
    if (start === -1) {
        return "";
    }
    // The block ends at the next line starting in column zero, i.e. the next
    // top-level key.
    const rest = source.slice(start);
    const end = rest.search(/\n(?=\S)/);
    return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Every template a file pulls in, as repo-relative paths.
 *
 * Both shapes, because they are the two ways YAML arrives here: `extends:` with
 * a `template:` under it, and a `- template:` step or stage. A `@alias` suffix
 * names the repository resource the template is read from and is stripped — the
 * file is the same file either way, since the resource is this repository. A
 * reference with no directory is resolved relative to the referring file, which
 * is how `pr-ci.yml` used to reach `upload-static-site.yml`.
 */
function includedTemplates(file: string, source: string): string[] {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    return [...withoutComments(source).matchAll(/^\s*-?\s*template:\s*(\S+?)(?:@\S+)?\s*$/gm)].flatMap((match) => {
        const reference = match[1];
        if (reference === undefined) {
            return [];
        }
        return [reference.includes("/") || dir === "" ? reference : `${dir}/${reference}`];
    });
}

/**
 * Every file a pull-request build can execute, entry point included.
 *
 * Computed by following `extends` and `template:` from the entry point rather
 * than listed, because a list cannot see a new include. This is the set that has
 * to be free of credentials: whatever it names, the PR CI *definition* must be
 * authorized for, and whatever the definition is authorized for, a pull request
 * that rewrites the entry point can ask for.
 */
function prReachableFiles(): string[] {
    const seen = new Set<string>();
    const queue = prTriggeredPipelines();

    while (queue.length > 0) {
        const file = queue.shift();
        if (file === undefined || seen.has(file)) {
            continue;
        }
        seen.add(file);
        queue.push(...includedTemplates(file, read(file)));
    }

    // Guard the guard: a walk that returns nothing makes every assertion about
    // the set vacuously true, which is the failure this file exists to prevent.
    expect(seen.size, "no pull-request-reachable file was discovered").toBeGreaterThan(0);
    return [...seen].sort();
}

/** Every pipeline or template in the repository that a pull request cannot trigger. */
function masterOnlyFiles(): string[] {
    const reachable = new Set(prReachableFiles());
    return allPipelines()
        .concat(
            readdirSync(join(repoRoot, "config", "templates"))
                .filter((f) => /\.ya?ml$/.test(f))
                .map((f) => `config/templates/${f}`)
        )
        .filter((file) => !reachable.has(file))
        .sort();
}

describe("the pull-request entry point defines nothing and pins everything", () => {
    const pipelines = prTriggeredPipelines();

    it("has exactly one pr-triggered pipeline, and it is the known entry point", () => {
        expect(pipelines, "no pipeline declares a `pr:` trigger").not.toHaveLength(0);
        expect(pipelines, "a new pr-triggered pipeline appeared; it must be a shell too, and this guard must be taught about it").toEqual([ENTRY_POINT]);
    });

    it("makes every pipeline state its pull-request trigger explicitly", () => {
        // Absence of the key is not neutral — it enables PR validation on every
        // branch. The classifier above treats a missing `pr:` as PR-triggered so
        // that it fails closed; this clause is the other half, so the ambiguity
        // is fixed at the source rather than compensated for downstream.
        const silent = allPipelines().filter((file) => !/^pr:/m.test(read(file)));
        expect(
            silent,
            "these pipelines declare no `pr:` key, which enables pull-request validation on every branch. Add `pr: none` unless the pipeline is genuinely a PR pipeline:"
        ).toEqual([]);
    });

    it("contains no job, no step and no credential of its own", () => {
        const source = read(ENTRY_POINT);

        // Anything defined here is defined by the pull request under review, so
        // the file must define nothing at all.
        expect(jobsOf(source), `${ENTRY_POINT} defines a job; jobs belong in ${PINNED_TEMPLATE}, which is read from master`).toEqual([]);
        expect(withoutComments(source), `${ENTRY_POINT} defines a step`).not.toMatch(/^\s*-\s*(script|task|checkout|bash|powershell):/m);
        expect(declaredGroups(source), `${ENTRY_POINT} imports a variable group`).toEqual([]);
        expect(withoutComments(source), `${ENTRY_POINT} names a service connection for a task`).not.toMatch(/gitHubConnection:/);
    });

    it("extends the pinned template rather than defining stages inline", () => {
        const source = read(ENTRY_POINT);

        expect(source, `${ENTRY_POINT} declares stages inline instead of extending ${PINNED_TEMPLATE}`).not.toMatch(/^stages:\s*$/m);
        expect(source, `${ENTRY_POINT} does not extend the pinned template`).toMatch(/^extends:\s*$/m);
        expect(source, `${ENTRY_POINT} must extend ${PINNED_TEMPLATE} from a pinned repository resource`).toMatch(/template:\s*config\/templates\/pr-ci\.yml@\w+\s*$/m);
    });

    it("resolves that template through a repository resource pinned to a protected ref", () => {
        const source = read(ENTRY_POINT);

        const alias = /template:\s*config\/templates\/pr-ci\.yml@(\w+)\s*$/m.exec(source)?.[1];
        expect(alias, "could not read the repository alias from the extends line").toBeDefined();

        const resource = new RegExp(`-\\s*repository:\\s*${alias}\\b[\\s\\S]*?(?=\\n\\s*-\\s*repository:|\\n\\S|$)`).exec(source)?.[0];
        expect(resource, `${ENTRY_POINT} extends @${alias} but declares no matching repository resource`).toBeDefined();

        // Without an explicit ref a repository resource follows the default
        // branch — the right branch by accident rather than by instruction, and
        // silently the wrong one if the default ever changes.
        expect(resource, `the ${alias} repository resource must pin an explicit ref`).toMatch(/^\s*ref:\s*refs\/heads\/master\s*$/m);
        expect(resource, `the ${alias} repository resource must name a service connection endpoint`).toMatch(/^\s*endpoint:\s*\S+\s*$/m);
    });
});

describe("the pull-request definition consumes nothing worth stealing", () => {
    // The finding this closes. Job isolation kept PR *code* away from
    // DEPLOY_TOKEN, but the resources still had to be authorized for a
    // definition whose YAML the pull request writes, so a run that deleted the
    // `extends` could ask for them by name. The only fix that holds is for the
    // definition to be authorized for nothing that matters — and the only way to
    // check that from here is that the YAML never names one.
    const reachable = prReachableFiles();

    it("discovers the entry point and the pinned template as reachable", () => {
        // Floor with an upper bound: the set has to contain the two files whose
        // contents every other assertion here depends on, and the reachability
        // walk has to be what found the second one.
        expect(reachable, "the reachability walk lost the entry point").toContain(ENTRY_POINT);
        expect(reachable, `the reachability walk did not follow \`extends\` into ${PINNED_TEMPLATE}`).toContain(PINNED_TEMPLATE);
    });

    it.each(MASTER_ONLY_RESOURCES)("never names %s in a file a pull request can reach", (resource) => {
        for (const file of reachable) {
            // The name anywhere, not a `- group:` line: an `endpoint:` on a
            // repository resource, a `gitHubConnection:` on a task and a
            // hand-written `env:` mapping are all ways to consume the same
            // resource, and only one of them is a group import.
            expect(withoutComments(read(file)), `${file} is reachable from a pull request and names ${resource}`).not.toContain(resource);
        }
    });

    it("imports no variable group anywhere a pull request can reach", () => {
        for (const file of reachable) {
            expect(declaredGroups(read(file)), `${file} is reachable from a pull request and imports a variable group`).toEqual([]);
        }
    });

    it("names no service connection other than the read-only repository endpoint", () => {
        for (const file of reachable) {
            const source = withoutComments(read(file));

            // A service connection is consumed by naming it in one of these
            // keys. `endpoint:` is the only one a pull-request build has any
            // business using, and only for the read-only connection.
            expect(source, `${file} posts to GitHub from a pull-request build`).not.toMatch(/gitHubConnection:/);
            expect(source, `${file} names an Azure subscription from a pull-request build`).not.toMatch(/azureSubscription:/);

            const endpoints = [...source.matchAll(/^\s*endpoint:\s*(\S+)\s*$/gm)].map((match) => match[1]);
            expect(
                endpoints.filter((name) => name !== PR_READ_ENDPOINT),
                `${file} names a service connection other than ${PR_READ_ENDPOINT}`
            ).toEqual([]);
        }
    });

    it("takes the pinned template through the read-only endpoint", () => {
        // The other direction of the clause above: not merely "no other
        // endpoint" but "this one, present". Dropping the resource entirely
        // would satisfy every negative assertion here and leave the template
        // unpinned.
        expect(withoutComments(read(ENTRY_POINT)), `${ENTRY_POINT} does not resolve its pinned template through ${PR_READ_ENDPOINT}`).toMatch(
            new RegExp(`^\\s*endpoint:\\s*${PR_READ_ENDPOINT}\\s*$`, "m")
        );
    });

    it("keeps that endpoint out of every definition a pull request cannot trigger", () => {
        // The whole point of the split. If a master pipeline consumed the same
        // connection, it would inherit the PR definition's check regime — a
        // required-template check it cannot satisfy, because it declares its
        // stages inline — and the incompatibility would be back.
        for (const file of masterOnlyFiles()) {
            expect(withoutComments(read(file)), `${file} is master-only and consumes ${PR_READ_ENDPOINT}, which is the pull-request definition's resource`).not.toContain(
                PR_READ_ENDPOINT
            );
        }
    });

    it("maps no token of any kind into a pull-request build", () => {
        for (const file of reachable) {
            const source = withoutComments(read(file));
            expect(source, `${file} maps System.AccessToken into a pull-request build`).not.toMatch(/System\.AccessToken/);
            expect(source, `${file} persists the checkout credential in a pull-request build`).not.toMatch(/persistCredentials/);
        }
    });
});

describe("no protected resource is shared by a PR-reachable and a master-only definition", () => {
    // A resource consumed by both sides can carry only one set of checks, and
    // the two sides need opposite ones: PR CI runs from `refs/pull/<n>/merge`,
    // so branch control excludes it; the master pipelines declare their stages
    // inline, so a required-template check excludes them. Sharing forces the
    // administrator to pick one, and the resource ends up with neither.
    const reachable = prReachableFiles();
    const master = masterOnlyFiles();

    it("has both sides to compare", () => {
        expect(reachable.length, "no pull-request-reachable file — the comparison would be vacuous").toBeGreaterThan(0);
        expect(master.length, "no master-only file — the comparison would be vacuous").toBeGreaterThan(0);
    });

    it("lists no variable group in both sets", () => {
        const groupsIn = (files: string[]): Set<string> => new Set(files.flatMap((file) => declaredGroups(read(file))));
        const prGroups = groupsIn(reachable);
        const masterGroups = groupsIn(master);

        expect(masterGroups.size, "no master-only file imports a variable group — the intersection below would be vacuous").toBeGreaterThan(0);
        expect(
            [...prGroups].filter((group) => masterGroups.has(group)),
            "these variable groups are consumed by both a pull-request-reachable definition and a master-only one, so no single check regime fits them:"
        ).toEqual([]);
    });

    it("lists no service connection in both sets", () => {
        const connectionsIn = (files: string[]): Set<string> =>
            new Set(
                files.flatMap((file) =>
                    [...withoutComments(read(file)).matchAll(/^\s*(?:endpoint|gitHubConnection|azureSubscription):\s*"?([\w.-]+)"?\s*$/gm)].map((m) => m[1] ?? "")
                )
            );
        const prConnections = connectionsIn(reachable);
        const masterConnections = connectionsIn(master);

        expect(masterConnections.size, "no master-only file names a service connection — the intersection below would be vacuous").toBeGreaterThan(0);
        expect(
            [...prConnections].filter((connection) => masterConnections.has(connection)),
            "these service connections are consumed by both a pull-request-reachable definition and a master-only one, so no single check regime fits them:"
        ).toEqual([]);
    });
});

describe("the trusted publisher exposes a narrow interface for PR CI output", () => {
    // Removing the credential by removing the capability would satisfy every
    // assertion above. The publisher has to exist, has to be unreachable from a
    // pull request, and has to consume exactly the artifacts PR CI stages.
    const publisher = read(PUBLISHER);
    const template = read(PINNED_TEMPLATE);

    it("is a definition no pull request can trigger", () => {
        expect(publisher, `${PUBLISHER} must opt out of pull-request triggers with \`pr: none\``).toMatch(/^pr:\s*none\s*$/m);
        expect(publisher, `${PUBLISHER} must not run automatically on push; #627 supplies the trusted scheduled poller`).toMatch(/^trigger:\s*none\s*$/m);
        expect(prTriggeredPipelines(), `${PUBLISHER} is pull-request triggered`).not.toContain(PUBLISHER);
    });

    it("never subscribes to PR CI completing", () => {
        // A `resources.pipelines` completion trigger is the one wiring that
        // would undo this: when the triggering and triggered pipelines share a
        // repository, Azure runs the triggered pipeline on the triggering run's
        // branch — the pull request's own merge ref — and this file, holding
        // every credential, would then be read from the pull request.
        expect(withoutComments(publisher), `${PUBLISHER} declares a pipeline resource, which can be triggered from a pull-request run of the source pipeline`).not.toMatch(
            /^\s*pipelines:\s*$/m
        );
    });

    it("stages the bundle comment on every run, whatever the scene selection decided", () => {
        // #627 turns on the artifact being unconditional: the run that should
        // withdraw a stale comment is exactly the run with nothing to say, so a
        // condition that suppresses staging suppresses the withdrawal too.
        //
        // The affected-scene selection (#638) is the live threat here, because
        // gating the bundle job's expensive steps on `RUN_BUNDLE_TESTS` reads as
        // an obvious thing to extend to the staging step as well.
        const step = /-\s*task:\s*PublishPipelineArtifact@\d(?:(?!PublishPipelineArtifact@)[\s\S])*?artifact:\s*bundle-comment/.exec(withoutComments(template));
        expect(step, `${PINNED_TEMPLATE} does not stage the bundle comment`).toBeDefined();

        const condition = /condition:\s*([^\n]*)/.exec(step?.[0] ?? "")?.[1]?.trim();
        expect(condition, `${PINNED_TEMPLATE} stages the bundle comment conditionally, so a quiet run cannot retract a stale comment`).toBe("always()");

        // The generator has to survive the same gating, or the directory it is
        // supposed to fill is simply absent and the reconciler reads "leave it
        // alone" — which is the stale comment, restored.
        const generator = /-\s*script:\s*npx tsx scripts\/report-bundle-size-deltas\.ts[\s\S]*?(?=\n\s{16}-\s)/.exec(withoutComments(template));
        expect(generator, `${PINNED_TEMPLATE} does not generate the bundle comment`).toBeDefined();
        expect(/condition:\s*([^\n]*)/.exec(generator?.[0] ?? "")?.[1]?.trim(), `${PINNED_TEMPLATE} skips the bundle-comment generator, so quiet runs stage no state`).toBe(
            "always()"
        );

        // Skipping measurement is only safe to report as `none` because the
        // selector positively said so; the generator must be told which it was.
        expect(generator?.[0], `${PINNED_TEMPLATE} does not tell the generator whether any bundle scene was affected`).toMatch(
            /BUNDLE_SCENES_AFFECTED:\s*"\$\(RUN_BUNDLE_TESTS\)"/
        );
    });

    it("consumes only the inert comment artifacts PR CI stages", () => {
        const staged = new Set(
            jobsOf(template)
                .flatMap((job) => [...withoutComments(job.body).matchAll(/PublishPipelineArtifact@\d[\s\S]*?artifact:\s*(\S+)/g)])
                .map((match) => match[1] ?? "")
        );
        const consumed = new Set([...withoutComments(publisher).matchAll(/DownloadPipelineArtifact@\d[\s\S]*?artifact:\s*(\S+)/g)].map((match) => match[1] ?? ""));

        expect(staged.size, `${PINNED_TEMPLATE} stages no artifact — the publisher would have nothing to publish`).toBeGreaterThan(0);
        expect([...consumed].sort(), `${PUBLISHER} must consume exactly the inert comment artifact contract`).toEqual(["api-comment", "bundle-comment"]);
        expect(
            [...consumed].filter((artifact) => !staged.has(artifact)),
            `${PUBLISHER} downloads artifacts ${PINNED_TEMPLATE} does not stage, so the publish silently produces nothing:`
        ).toEqual([]);
    });

    it("decides every destination at compile time, from a parameter", () => {
        // The values that say which pull request is written to and where the
        // upload lands must be `${{ parameters.* }}`, fixed when the run is
        // compiled. A runtime variable is something a downloaded artifact's
        // content could be talked into moving, and these jobs hold DEPLOY_TOKEN
        // and the GitHub connection.
        for (const job of jobsOf(publisher)) {
            const body = withoutComments(job.body);
            for (const [line] of body.matchAll(/^\s*(?:deployPath|commentId|id|pipelineId|definition):.*$/gm)) {
                expect(line, `${PUBLISHER}: job ${job.name} takes a destination from a runtime macro rather than a compile-time parameter`).not.toMatch(
                    /\$\((?!System\.TeamProject)/
                );
            }
        }
    });

    it("gates every identity input to a number", () => {
        // `type: number` is validated by the server at queue time, so a deploy
        // path built from it cannot carry a traversal or an injection.
        for (const parameter of ["prNumber", "prCiRunId", "prCiDefinitionId"]) {
            expect(publisher, `${PUBLISHER} does not declare ${parameter} as a numeric parameter`).toMatch(
                new RegExp(`-\\s*name:\\s*${parameter}\\b[\\s\\S]{0,200}?type:\\s*number`)
            );
        }
    });

    it("validates build identity, PR ref and fixed repository before protected jobs run", () => {
        const preflight = jobsOf(publisher).find((job) => job.name === "Preflight");
        expect(preflight, `${PUBLISHER} has no Preflight job`).toBeDefined();
        expect(preflight?.body).toContain(".definition.id == $definitionId");
        expect(preflight?.body).toContain('.reason == "pullRequest"');
        expect(preflight?.body).toContain('.status == "completed"');
        expect(preflight?.body).toContain(".sourceBranch == $sourceBranch");
        expect(preflight?.body).toContain('.repository.type == "GitHub"');
        expect(preflight?.body).toContain('.repository.name == "BabylonJS/Babylon-Lite"');
        expect(preflight?.body).toContain('"refs/pull/${PR_NUMBER}/merge"');
    });

    it("fixes every GitHub destination to BabylonJS/Babylon-Lite", () => {
        const uncommented = withoutComments(publisher);
        expect(uncommented).not.toContain("$(Build.Repository.Name)");

        // Three fixed destinations, expressed two ways: `repositoryName:` is the
        // `GitHubComment@0` input, `GITHUB_REPOSITORY:` is what the release-marker
        // check and (since #627) the bundle reconciler read. Both forms are counted
        // and the count is exact, because dropping a form from this pattern — or
        // adding a fourth destination — is how a repository target stops being
        // checked without any test going red.
        const destinations = [...uncommented.matchAll(/(?:repositoryName|GITHUB_REPOSITORY):\s*"([^"]+)"/g)];
        expect(destinations, `${PUBLISHER} has no GitHub repository destinations to inspect`).toHaveLength(3);
        for (const match of destinations) {
            expect(match[1]).toBe("BabylonJS/Babylon-Lite");
        }
    });

    it("keeps PR previews disabled instead of publishing unreviewed code to a production origin", () => {
        const uncommented = withoutComments(publisher);
        expect(uncommented).toContain("- job: PreviewPublishingDisabled");
        expect(uncommented).not.toMatch(/-\s*template:\s*config\/templates\/upload-static-site\.yml/);
        expect(uncommented).not.toMatch(/liteplayground\.babylonjs\.com\/pr|deployPath:\s*(?:lite\/pr-|litePlayground\/pr)/);
        expect(uncommented).not.toMatch(/-\s*name:\s*publish(?:LabSite|Playground)/);
    });

    it("lets untrusted comment content set only the variables the posting steps consume", () => {
        // #627 split `PostPrComments` in two so a bundle retry cannot re-post the
        // create-only API comment. The rule the old single-job assertion encoded —
        // a step that touches downloaded PR CI output runs restricted, and may set
        // only an explicit list of variables — is re-expressed per job rather than
        // relaxed to "some step somewhere is restricted".
        const jobs = jobsOf(publisher).filter((job) => job.name === "PostApiComment" || job.name === "PostBundleComment");
        expect(jobs.map((job) => job.name).sort()).toEqual(["PostApiComment", "PostBundleComment"]);

        const permitted: Record<string, string[]> = {
            // The API path still loads the artifact into variables the
            // `GitHubComment@0` task reads, so it names them.
            PostApiComment: ["API_COMMENT_BODY", "POST_API_COMMENT"],
            // The bundle path reads its artifact from disk inside the reconciler
            // and needs no pipeline variable at all, so it permits none.
            PostBundleComment: [],
        };

        for (const job of jobs) {
            // Every step that reads the downloaded artifact must be restricted:
            // that is where untrusted bytes enter a credentialed agent.
            const steps = job.body
                .split(/\n(?=\s{18}-\s)/)
                .filter((step) => step.includes("$(Pipeline.Workspace)") && !/^\s*-\s*(?:task|download):/m.test(step.split("\n")[0] ?? ""));
            for (const step of steps) {
                expect(step, `${job.name} has an unrestricted step reading downloaded artifacts`).toMatch(/target:\s*\n\s*commands:\s*restricted/);
            }

            const target = /target:\s*\n\s*commands:\s*restricted\s*\n\s*settableVariables:\s*(none\s*$|\n((?:\s*-\s*[A-Z][A-Z_]*\s*\n?)+))/m.exec(job.body);
            expect(target, `${job.name} has no restricted settableVariables target`).toBeDefined();

            const declared = target?.[2] === undefined ? [] : [...target[2].matchAll(/-\s*(\w+)/g)].map((match) => match[1]);
            expect(declared, `${job.name} permits variables its posting step does not consume`).toEqual(permitted[job.name]);
        }
    });
});

describe("the administrator runbook closes the job-token queue path", () => {
    const guide = read(TESTING_GUIDE);

    it("denies both Build Service identities Queue builds on every credentialed definition", () => {
        expect(guide).toContain("Deny Queue builds");
        expect(guide).toContain("<Project> Build Service (<Org>)");
        expect(guide).toContain("Project Collection Build Service (<Org>)");
        expect(guide).toContain("every credentialed definition");
    });

    it("requires an empirical 403 and a separate #627 queue identity", () => {
        expect(guide).toContain("all three** must return\n  403");
        expect(guide).toContain("dedicated queue identity");
        expect(guide).toContain("Do not use `System.AccessToken` to queue the");
    });

    it("also denies the build-metadata writes that could forge publish history", () => {
        // Queue permission alone is not enough. The poller matches prior publish
        // attempts on build numbers and confirms them against queue-time
        // parameters, and build numbers and tags are *mutable* by an identity
        // holding these verbs — both of which are Allow by default. A pull
        // request that can rewrite them cannot publish anything, but it can make
        // the poller believe its comment was already posted, and so suppress its
        // own bundle-size report.
        expect(guide).toContain("Update build information");
        expect(guide).toContain("Edit build quality");
    });
});

describe("no other pull-request-triggered definition holds a secret", () => {
    // The Azure side is covered above by construction; this is the same question
    // asked of the other CI system in the repository, because "PR-reachable" is
    // a property of the trigger rather than of the file format.
    const workflowDir = join(repoRoot, ".github", "workflows");
    const workflows = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));

    it("has workflows to inspect", () => {
        expect(workflows.length, "no GitHub Actions workflow found — the assertion below would be vacuous").toBeGreaterThan(0);
    });

    it.each(workflows)(".github/workflows/%s is not triggered by a pull request", (name) => {
        const source = withoutComments(readFileSync(join(workflowDir, name), "utf8"));

        // The `on:` block, however it is written. GitHub accepts a mapping
        // (`on:\n  pull_request:`), a sequence (`on: [push, pull_request]`) and a
        // bare scalar (`on: pull_request`), and only the first puts the trigger
        // at the start of a line with a colon after it. Anchoring on that shape
        // would pass the other two, which are the same trigger.
        const start = source.search(/^on:/m);
        expect(start, `.github/workflows/${name} declares no \`on:\` block, so this guard has nothing to read`).toBeGreaterThanOrEqual(0);
        const rest = source.slice(start);
        const end = rest.search(/\n(?=\S)/);
        const triggers = end === -1 ? rest : rest.slice(0, end);

        // `pull_request_target` runs with the base repository's secrets, and
        // `pull_request` still exposes whatever the workflow asks for. Either
        // one makes this file a pull-request-reachable definition, which is the
        // category the whole design is about — so it has to be an argued
        // exception rather than an accident.
        expect(triggers, `.github/workflows/${name} triggers on pull_request_target, which runs with the base repository's secrets`).not.toMatch(/\bpull_request_target\b/);
        expect(triggers, `.github/workflows/${name} triggers on pull_request; if that is intended, it must hold no secret and this guard must be taught about it`).not.toMatch(
            /\bpull_request\b/
        );
    });

    it("reads the trigger block in every form GitHub accepts", () => {
        // The clause above is only as good as the block it slices, and the
        // workflow in this repository exercises exactly one of the three forms.
        // Pin the other two against fixtures so a regex that quietly stops
        // matching them is a failure here rather than a silent pass there.
        const triggersOf = (source: string): string => {
            const start = source.search(/^on:/m);
            const rest = source.slice(start);
            const end = rest.search(/\n(?=\S)/);
            return start < 0 ? "" : end === -1 ? rest : rest.slice(0, end);
        };

        expect(triggersOf("name: x\non:\n    pull_request:\n        branches: [master]\njobs:\n")).toMatch(/\bpull_request\b/);
        expect(triggersOf("name: x\non: [push, pull_request]\njobs:\n")).toMatch(/\bpull_request\b/);
        expect(triggersOf("name: x\non: pull_request_target\njobs:\n")).toMatch(/\bpull_request_target\b/);
        expect(triggersOf("name: x\non:\n    issues:\n        types: [labeled]\njobs:\n    pull_request_helper:\n        steps: []\n")).not.toMatch(/\bpull_request\b/);
    });
});

describe("no job that runs pull-request code holds a credential", () => {
    const source = read(PINNED_TEMPLATE);
    const jobs = jobsOf(source);

    it("has jobs to inspect", () => {
        expect(jobs.length, `${PINNED_TEMPLATE} declares no job — every assertion below would be vacuous`).toBeGreaterThan(0);
        expect(
            jobs.filter((job) => runsPullRequestCode(job.body)).length,
            `${PINNED_TEMPLATE} has no job checking out the pull request — the selector has drifted`
        ).toBeGreaterThan(0);
    });

    it("declares no variable group at file scope", () => {
        // A group at file scope is in scope for *every* job, including the ones
        // running PR code, which defeats any per-job care taken below.
        expect(declaredGroups(fileScopedVariables(source)), `${PINNED_TEMPLATE} declares a variable group at file scope; move it to the jobs that need it`).toEqual([]);
    });

    it("never leaves the OAuth token in a checkout's git config", () => {
        // `persistCredentials: true` writes the build's OAuth token into
        // `.git/config`, where any later step in the job can read it —
        // including a dependency's install script.
        expect(withoutComments(source), `${PINNED_TEMPLATE} uses persistCredentials, which leaves the OAuth token readable by every later step`).not.toMatch(/persistCredentials/);
    });

    it.each(PRIVILEGED_GROUPS)("keeps %s out of every job that checks out the pull request", (group) => {
        for (const job of jobs) {
            if (!runsPullRequestCode(job.body)) {
                continue;
            }
            expect(declaredGroups(job.body), `${PINNED_TEMPLATE}: job ${job.name} checks out the pull request with ${group} in scope`).not.toContain(group);
        }
    });

    it("gives a job that checks out the pull request no credential at all", () => {
        // Stated as an allowlist rather than a list of things to exclude: a
        // variable group added tomorrow is denied by default instead of being
        // permitted until someone remembers to name it here.
        for (const job of jobs) {
            if (!runsPullRequestCode(job.body)) {
                continue;
            }
            const unexpected = declaredGroups(job.body).filter((group) => !ALLOWED_IN_PULL_REQUEST_JOBS.includes(group));
            expect(unexpected, `${PINNED_TEMPLATE}: job ${job.name} checks out the pull request and imports a credential`).toEqual([]);
        }
    });

    it("names no credential of any kind in a job that checks out the pull request", () => {
        // The general form of the four clauses above. `BabylonJS-BrowserStack`
        // reached PR code as an `env:` mapping, not as a `- group:` line, and
        // every clause here passed while it did — which is what a denylist of
        // known specimens buys.
        for (const job of jobs) {
            if (!runsPullRequestCode(job.body)) {
                continue;
            }
            expect(
                credentialNamesIn(job.body),
                `${PINNED_TEMPLATE}: job ${job.name} checks out the pull request and names a credential. There is no exception: if the check genuinely needs one, it runs in the Publish stage against the pinned master checkout instead.`
            ).toEqual([]);
        }
    });

    it("keeps GitHub and Azure tokens out of every job that checks out the pull request", () => {
        for (const job of jobs) {
            if (!runsPullRequestCode(job.body)) {
                continue;
            }
            const body = withoutComments(job.body);
            expect(body, `${PINNED_TEMPLATE}: job ${job.name} maps GITHUB_TOKEN into a job running pull-request code`).not.toMatch(/GITHUB_TOKEN:/);
            expect(body, `${PINNED_TEMPLATE}: job ${job.name} maps System.AccessToken into a job running pull-request code`).not.toMatch(/System\.AccessToken/);
            expect(body, `${PINNED_TEMPLATE}: job ${job.name} posts to GitHub from a job running pull-request code`).not.toMatch(/gitHubConnection:/);
        }
    });
});

describe("no cloud-browser credential is reachable from a pull request", () => {
    it("does not name the cloud credential anywhere a pull request can reach", () => {
        // Not "no job holds it" but "the string does not occur": a job that
        // imports the group, a step that maps BROWSERSTACK_USERNAME by hand, and
        // a `variables:` entry pulling it from the pipeline UI are three ways to
        // arrive at the same leak, and only one of them is a `- group:` line.
        for (const file of [ENTRY_POINT, PINNED_TEMPLATE]) {
            const source = withoutComments(read(file));
            expect(source, `${file} names ${CLOUD_GROUP}, which no pull-request build may hold`).not.toContain(CLOUD_GROUP);
            expect(source, `${file} maps a BrowserStack credential into a pull-request build`).not.toMatch(/BROWSERSTACK/i);
        }
    });

    it("kept the cloud tests rather than deleting them", () => {
        // Removing the credential by removing the coverage would satisfy every
        // other assertion in this file. The tests have to still exist, and to
        // still be the thing holding the key.
        const cloud = read(CLOUD_PIPELINE);
        expect(cloud, `${CLOUD_PIPELINE} no longer imports ${CLOUD_GROUP} — the cloud tests have lost their credential`).toContain(CLOUD_GROUP);
        expect(cloud, `${CLOUD_PIPELINE} no longer runs the perf-regression suite`).toMatch(/test:perf/);
        expect(cloud, `${CLOUD_PIPELINE} no longer runs the cloud parity suite`).toMatch(/test:parity/);
    });

    it("runs those tests from master only, never from a pull request", () => {
        const cloud = read(CLOUD_PIPELINE);
        expect(cloud, `${CLOUD_PIPELINE} must opt out of pull-request triggers with \`pr: none\``).toMatch(/^pr:\s*none\s*$/m);
        expect(prTriggeredPipelines(), `${CLOUD_PIPELINE} is pull-request triggered`).not.toContain(CLOUD_PIPELINE);
    });

    it("never combines the cloud credential with a deploy or infrastructure credential", () => {
        // Cloud browser tests cannot run without giving the account key to the
        // tests themselves, so those jobs are where a compromise starts even on
        // master. Nothing else may be reachable from there.
        for (const job of jobsOf(read(CLOUD_PIPELINE))) {
            const groups = declaredGroups(job.body);
            if (!groups.includes(CLOUD_GROUP)) {
                continue;
            }
            for (const privileged of PRIVILEGED_GROUPS) {
                expect(groups, `${CLOUD_PIPELINE}: job ${job.name} holds both the cloud credential and ${privileged}`).not.toContain(privileged);
            }
            expect(withoutComments(job.body), `${CLOUD_PIPELINE}: job ${job.name} holds the cloud credential and also posts to GitHub`).not.toMatch(/gitHubConnection:/);
        }
    });

    it("does not decide anything from the fork system variable", () => {
        // `System.PullRequest.IsFork` is documented read-only, but Microsoft
        // does not document the agent refusing a `task.setvariable` that
        // shadows it for later steps. A control that may or may not hold is not
        // a control.
        for (const file of [ENTRY_POINT, PINNED_TEMPLATE, CLOUD_PIPELINE]) {
            expect(withoutComments(read(file)), `${file} branches on System.PullRequest.IsFork, which may be shadowable at runtime`).not.toMatch(
                /variables\[.System\.PullRequest\.IsFork.\]/
            );
        }
    });
});

describe("a deployment credential never shares an agent with repository code", () => {
    // Repository-wide, not just the pull-request pipeline: a master-only
    // pipeline that runs `pnpm install` and then uploads with DEPLOY_TOKEN in
    // scope is one compromised transitive dependency away from handing the
    // token over, and a pull request can add that dependency.
    const credentialed = allPipelines().flatMap((file) =>
        jobsOf(read(file))
            .filter((job) => DEPLOYMENT_CREDENTIAL_MARKERS.some((marker) => marker.test(withoutComments(job.body))))
            .map((job) => ({ file, job }))
    );

    it("has credentialed jobs to inspect", () => {
        expect(credentialed.length, "no job in any pipeline holds a deployment credential — the selector has drifted").toBeGreaterThan(0);
    });

    it.each(credentialed.map(({ file, job }) => `${file}:${job.name}`))("%s checks out nothing, or only the pinned trusted ref", (id) => {
        const entry = credentialed.find(({ file, job }) => `${file}:${job.name}` === id);
        expect(entry, `job ${id} disappeared between selection and assertion`).toBeDefined();
        const body = entry?.job.body ?? "";
        expect(body, `job ${id} holds a deployment credential without an explicit checkout — Azure defaults to \`self\``).toMatch(/^\s*-\s*checkout:\s*(none|trusted)\s*$/m);
        expect(body, `job ${id} holds a deployment credential and checks out the branch under build`).not.toMatch(/^\s*-\s*checkout:\s*self\b/m);
    });

    it.each(credentialed.map(({ file, job }) => `${file}:${job.name}`))("%s runs no build, test or lifecycle code", (id) => {
        const entry = credentialed.find(({ file, job }) => `${file}:${job.name}` === id);
        expect(entry, `job ${id} disappeared between selection and assertion`).toBeDefined();
        const body = withoutComments(entry?.job.body ?? "");

        // A dependency install is arbitrary third-party code execution unless
        // lifecycle scripts are off. `pnpm install --ignore-scripts` from the
        // pinned trusted ref is the one shape allowed, and it has to say so.
        for (const install of body.match(/^\s*-?\s*script:.*\b(?:pnpm|npm|yarn)\s+(?:install|ci)\b.*$/gm) ?? []) {
            expect(install, `job ${id} installs dependencies with lifecycle scripts enabled while holding a deployment credential`).toMatch(/--ignore-scripts/);
        }

        expect(body, `job ${id} builds the repository while holding a deployment credential`).not.toMatch(/\b(?:pnpm|npm)\s+(?:run\s+)?build\b/);
        expect(body, `job ${id} runs tests while holding a deployment credential`).not.toMatch(/\b(?:pnpm|npm)\s+(?:run\s+)?test[:\s]/);
        expect(body, `job ${id} installs a browser while holding a deployment credential`).not.toMatch(/playwright\s+install/);
    });
});

describe("a credentialed job outside pull-request CI runs only from the protected ref", () => {
    // `pr: none` and a `- master` branch filter describe the pipeline's
    // *automatic* triggers. Neither says anything about a manual queue, and a
    // manual run may name any ref — including one whose YAML is not this YAML,
    // because Azure reads the definition from the ref being built. So the ref
    // gate cannot be the whole control: it is what states the rule for every run
    // still executing master's definition, and TESTING.md records the
    // server-side branch-control check that holds for the rest.
    //
    // Without it, "this pipeline only runs on master" was a property of the
    // trigger block alone — one that a queue-time ref selection sets aside while
    // every guard in this file stays green.
    const REF_CLAUSE = "eq(variables['Build.SourceBranch'], 'refs/heads/master')";
    const REASON_CLAUSE = "ne(variables['Build.Reason'], 'PullRequest')";

    const gated = allPipelines()
        .filter((file) => file !== ENTRY_POINT)
        .flatMap((file) =>
            jobsOf(read(file))
                .filter((job) =>
                    DEPLOYMENT_CREDENTIAL_MARKERS.concat([new RegExp(`^\\s*-\\s*group:\\s*${CLOUD_GROUP}\\s*$`, "m")]).some((marker) => marker.test(withoutComments(job.body)))
                )
                .map((job) => ({ file, job }))
        );

    it("has credentialed non-PR jobs to inspect", () => {
        expect(gated.length, "no job outside the pull-request entry point holds a credential — the selector has drifted").toBeGreaterThan(0);
    });

    it.each(gated.map(({ file, job }) => `${file}:${job.name}`))("%s is gated on the exact full ref and a non-pull-request reason", (id) => {
        const entry = gated.find(({ file, job }) => `${file}:${job.name}` === id);
        expect(entry, `job ${id} disappeared between selection and assertion`).toBeDefined();
        const condition = jobCondition(entry?.job.body ?? "");

        expect(condition, `job ${id} holds a credential with no job-level condition, so any ref this pipeline is queued from reaches it`).not.toBe("");
        // The full ref, not the branch name: `Build.SourceBranchName` is the
        // last path segment, so a branch literally named `heads/master` — or a
        // tag named `master` — satisfies a check written against it.
        expect(condition, `job ${id} does not pin Build.SourceBranch to the full ref refs/heads/master`).toContain(REF_CLAUSE);
        expect(condition, `job ${id} does not exclude pull-request runs by reason`).toContain(REASON_CLAUSE);
    });

    it("gates on the full ref rather than on the branch name anywhere", () => {
        // `Build.SourceBranchName` is `master` for refs/heads/master and for
        // refs/tags/master and for refs/heads/anything/master. It reads as the
        // same check and is not one.
        for (const file of allPipelines().concat([PINNED_TEMPLATE])) {
            expect(withoutComments(read(file)), `${file} gates on Build.SourceBranchName, which is not a ref`).not.toMatch(/condition:.*Build\.SourceBranchName/);
        }
    });
});

describe("npm publishing keeps its registry credential in a job-scoped file", () => {
    // `npm publish` needs the token in a config file, and the obvious place is
    // `~/.npmrc`. That file outlives the step, is 0644 under the default umask,
    // and on a self-hosted agent outlives the *build*. The publish jobs run with
    // `checkout: none`, so nothing repository-authored shares the agent — but
    // the credential still has to leave with the job.
    const publishers = allPipelines().filter((file) => /^\s*npm publish\s/m.test(read(file)));

    it("has publishing pipelines to inspect", () => {
        expect(publishers.length, "no pipeline runs `npm publish` — the selector has drifted").toBeGreaterThan(0);
    });

    it.each(publishers)("%s writes no npmrc into the agent's home directory", (file) => {
        const source = withoutComments(read(file));
        expect(source, `${file} writes an npmrc into $HOME, where it outlives the step that needed it`).not.toMatch(/~\/\.npmrc|\$HOME\/\.npmrc|\$\{HOME\}\/\.npmrc/);
    });

    it.each(publishers)("%s creates the npmrc private before the token reaches it, and removes it", (file) => {
        const source = withoutComments(read(file));

        // Order matters and is asserted by shape: `umask 077` on the creation
        // means the file is 0600 from the moment it exists. Writing the token
        // first and chmod'ing afterwards leaves a window in which it is
        // world-readable, which is the version this replaced.
        expect(source, `${file} does not create its npmrc under a restrictive umask`).toMatch(/umask 077/);
        expect(source, `${file} does not pin the npmrc to 0600`).toMatch(/chmod 600 "\$NPMRC"/);
        expect(source, `${file} does not keep the npmrc in the agent's temp directory`).toMatch(/NPMRC="\$\(Agent\.TempDirectory\)/);
        expect(source, `${file} does not remove the npmrc on every exit path`).toMatch(/trap 'rm -f "\$NPMRC"' EXIT/);

        for (const command of source.match(/^\s*npm publish\s.*$/gm) ?? []) {
            expect(command, `${file}: \`${command.trim()}\` does not name the job-scoped npmrc, so npm falls back to the ambient config`).toMatch(/--userconfig "\$NPMRC"/);
        }
    });
});

/**
 * True when a script refuses to continue unless `name` holds a usable value.
 *
 * Two separate refusals, and the second is the one that is easy to leave out.
 * When a variable is not in scope — the group was never created, was not
 * authorized for this pipeline, was refused by a check, or simply does not
 * define this name — Azure does not substitute an empty string. It passes the
 * macro through as the literal text `$(NAME)`, which is a non-empty value that
 * every `-z` test in the world accepts. The publish step tested only for
 * emptiness, so the misconfiguration this change is about would have sailed past
 * it and failed at the registry instead, as an authentication error that reads
 * like a bad token rather than like missing configuration.
 *
 * Exported so both directions can be pinned against fixtures. A guard that
 * cannot distinguish the shape it accepts from the shape it must reject is a
 * guard that reports success having checked nothing.
 */
export function failsClosedOnUnresolvedMacro(script: string, name: string): boolean {
    if (!new RegExp(String.raw`\$\{${name}:-\}`).test(script)) {
        return false;
    }

    const rejectsEmpty = new RegExp(String.raw`""\s*\||-z\s+"\$\{${name}:-\}"`).test(script);

    // The literal-macro test, written so the script does not contain the macro
    // it is looking for: `*'$('*` as a case pattern. Writing `$(NAME)` in a
    // script body would make Azure substitute it, and the check would compare
    // the value to itself.
    const rejectsUnresolvedMacro = /'\$\('/.test(script);

    return rejectsEmpty && rejectsUnresolvedMacro && /\bexit 1\b/.test(script);
}

describe("the npm registry credential comes from a job-scoped protected group", () => {
    // The finding this closes: both publish pipelines named `$(NPM_TOKEN)` and
    // imported no variable group at all, so the only place that value could come
    // from was a pipeline-level UI variable. A UI variable is not a protected
    // resource — no check is evaluated for it, and every job in the definition
    // can read it, including a job written by a manually queued run of an
    // arbitrary branch, because the YAML that runs is that branch's YAML.
    //
    // The fix is structural and has three parts, each asserted below: the group
    // is imported inside the publishing job and nowhere else, the credential is
    // renamed so a leftover UI variable cannot stand in for the group, and the
    // job refuses to run when the macro did not resolve.
    const publishers = allPipelines().filter((file) => /^\s*npm publish\s/m.test(read(file)));

    /** The job in each publishing pipeline that actually runs `npm publish`. */
    const publishJobs = publishers.flatMap((file) =>
        jobsOf(read(file))
            .filter((job) => /^\s*npm publish\s/m.test(withoutComments(job.body)))
            .map((job) => ({ file, job }))
    );

    it("has publishing pipelines and publishing jobs to inspect", () => {
        expect(publishers.length, "no pipeline runs `npm publish` — the selector has drifted").toBeGreaterThan(0);
        expect(publishJobs.length, "no job runs `npm publish` — the job-block selector has drifted").toBe(publishers.length);
    });

    it.each(publishJobs.map(({ file, job }) => `${file}:${job.name}`))("%s imports the protected group in its own variables block", (id) => {
        const entry = publishJobs.find(({ file, job }) => `${file}:${job.name}` === id);
        expect(entry, `job ${id} disappeared between selection and assertion`).toBeDefined();
        const body = withoutComments(entry?.job.body ?? "");

        expect(
            declaredGroups(body),
            `job ${id} publishes to npm without importing ${PUBLISH_GROUP}, so its credential can only be coming from an unprotected pipeline variable`
        ).toContain(PUBLISH_GROUP);
    });

    it.each(publishJobs.map(({ file, job }) => `${file}:${job.name}`))("%s takes the credential from the renamed variable only", (id) => {
        const entry = publishJobs.find(({ file, job }) => `${file}:${job.name}` === id);
        const body = withoutComments(entry?.job.body ?? "");

        expect(body, `job ${id} never maps ${PUBLISH_TOKEN} into the environment, so the group it imports is not what it publishes with`).toContain(
            `${PUBLISH_TOKEN}: $(${PUBLISH_TOKEN})`
        );
    });

    it.each(publishJobs.map(({ file, job }) => `${file}:${job.name}`))("%s refuses to publish when the macro did not resolve", (id) => {
        const entry = publishJobs.find(({ file, job }) => `${file}:${job.name}` === id);
        const body = withoutComments(entry?.job.body ?? "");

        // Before the first `npm publish`, not merely somewhere in the job: a
        // check that runs after the packages are on npm is not a check.
        const publishAt = body.search(/^\s*npm publish\s/m);
        expect(publishAt, `job ${id} matched the publish selector but has no \`npm publish\` line`).toBeGreaterThan(0);

        expect(
            failsClosedOnUnresolvedMacro(body.slice(0, publishAt), PUBLISH_TOKEN),
            `job ${id} does not refuse an unset or unresolved ${PUBLISH_TOKEN} before publishing. An out-of-scope variable arrives as literal macro text, so testing only for emptiness passes it straight through to npm`
        ).toBe(true);
    });

    // Every YAML in the repository that could name the group or the token, so
    // "only the publish jobs have it" is checked against the files rather than
    // assumed from the two that were edited.
    const everyPipelineFile = allPipelines().concat(
        readdirSync(join(repoRoot, "config", "templates"))
            .filter((f) => /\.ya?ml$/.test(f))
            .sort()
            .map((f) => `config/templates/${f}`)
    );

    it("names the group and the token only inside a job that imports the group", () => {
        const offenders: string[] = [];

        for (const file of everyPipelineFile) {
            const source = withoutComments(read(file));
            const jobs = jobsOf(source);

            // Everything above the first job: a `variables:` block there is
            // pipeline-scoped, which hands the credential to every job in the
            // definition and undoes the entire point of the import.
            const firstBody = jobs[0]?.body;
            const fileScope = firstBody === undefined ? source : source.slice(0, source.indexOf(firstBody));
            if (fileScope.includes(PUBLISH_GROUP) || fileScope.includes(PUBLISH_TOKEN)) {
                offenders.push(`${file}: names ${PUBLISH_GROUP}/${PUBLISH_TOKEN} outside any job, where every job can read it`);
            }

            for (const job of jobs) {
                const body = withoutComments(job.body);
                const namesIt = body.includes(PUBLISH_TOKEN) || body.includes(PUBLISH_GROUP);
                if (namesIt && !declaredGroups(body).includes(PUBLISH_GROUP)) {
                    offenders.push(`${file}:${job.name}: names ${PUBLISH_TOKEN} without importing ${PUBLISH_GROUP}`);
                }
                if (namesIt && !/^\s*npm publish\s/m.test(body)) {
                    offenders.push(`${file}:${job.name}: holds the publish credential without publishing anything`);
                }
            }
        }

        expect(offenders, "the npm publish credential is reachable outside the jobs that publish:").toEqual([]);
    });

    it("uses none of the retired pipeline-variable names anywhere", () => {
        const offenders: string[] = [];

        for (const file of everyPipelineFile) {
            withoutComments(read(file))
                .split("\n")
                .forEach((line, index) => {
                    for (const retired of RETIRED_PUBLISH_TOKEN_NAMES) {
                        // Word-bounded, so `NPM_PUBLISH_TOKEN` is not read as a
                        // hit for `NPM_TOKEN` and vice versa.
                        if (new RegExp(String.raw`(?<![A-Z_])${retired}(?![A-Z_])`).test(line)) {
                            offenders.push(`${file}:${index + 1}: ${retired} — ${line.trim()}`);
                        }
                    }
                });
        }

        expect(
            offenders,
            `these lines name a retired npm credential variable. Nothing in this repository defines those names, so they can only resolve from a pipeline UI variable — which is not a protected resource, and whose continued existence is what would let a missing ${PUBLISH_GROUP} go unnoticed:`
        ).toEqual([]);
    });

    it("keeps the publish credential out of everything a pull request reaches", () => {
        const reachable = [...new Set(prReachableFiles().concat(UPLOAD_TEMPLATES))];

        // Guard the guard: the entry point and the templates are named
        // literally, so this cannot silently empty, but the pr-triggered half
        // can — and that is the half that would discover a new one.
        expect(reachable.length, "no pull-request-reachable file to inspect").toBeGreaterThan(0);

        for (const file of reachable) {
            const source = withoutComments(read(file));
            expect(source, `${file} is reachable from a pull request and names ${PUBLISH_GROUP}`).not.toContain(PUBLISH_GROUP);
            expect(source, `${file} is reachable from a pull request and names ${PUBLISH_TOKEN}`).not.toContain(PUBLISH_TOKEN);
        }
    });
});

describe("the fail-closed selector accepts and rejects the right scripts", () => {
    // The shape both pipelines use, reproduced rather than read out of them, so
    // the fixture states the contract instead of tracking whatever they say.
    const real = ['case "${NPM_PUBLISH_TOKEN:-}" in', "    \"\" | *'$('*)", '        echo "not in scope"', "        exit 1", "        ;;", "esac"].join("\n");

    it("accepts the case form both pipelines use", () => {
        expect(failsClosedOnUnresolvedMacro(real, "NPM_PUBLISH_TOKEN")).toBe(true);
    });

    it("rejects an emptiness-only check, which an unresolved macro passes", () => {
        // The previous version of the publish step, in shape. It is the false
        // negative this guard exists for: an unresolved macro arrives as
        // non-empty literal text, so this accepts a run holding no credential.
        const emptinessOnly = ['if [ -z "${NPM_PUBLISH_TOKEN:-}" ]; then', '  echo "missing"', "  exit 1", "fi"].join("\n");
        expect(failsClosedOnUnresolvedMacro(emptinessOnly, "NPM_PUBLISH_TOKEN")).toBe(false);
    });

    it("rejects a script that reports the problem without stopping", () => {
        const warnsOnly = ['case "${NPM_PUBLISH_TOKEN:-}" in', "    \"\" | *'$('*)", '        echo "not in scope"', "        ;;", "esac"].join("\n");
        expect(failsClosedOnUnresolvedMacro(warnsOnly, "NPM_PUBLISH_TOKEN")).toBe(false);
    });

    it("rejects a script that never reads the value", () => {
        expect(failsClosedOnUnresolvedMacro('npm publish "$GL_TGZ" --ignore-scripts', "NPM_PUBLISH_TOKEN")).toBe(false);
    });

    it("does not accept a check written for a different variable", () => {
        expect(failsClosedOnUnresolvedMacro(real, "SOME_OTHER_TOKEN")).toBe(false);
    });
});

describe("a credentialed job constrains artifact content before it can act as a command", () => {
    // The publishing jobs read a version and a tarball path out of an artifact
    // staged by the job that ran repository code, and echo them into
    // `##vso[task.setvariable]`. The agent obeys any logging command that starts
    // a line of step output, so an unconstrained value there is an instruction
    // channel into the job holding the publish token — `task.prependpath` alone puts an
    // attacker-chosen `npm` ahead of the real one.
    //
    // `grep -Eq '^…$'` is specifically not enough: grep matches when ANY line
    // matches, so it accepts "1.2.3\n##vso[…]". Bash's `[[ =~ ]]` has no
    // multiline mode and rejects it.
    // The subject is narrow on purpose: a job that runs repository code and
    // echoes a value it computed itself is not this hazard — it already had
    // every privilege the echo could reach. What matters is the crossing: a job
    // holding a credential and running none of that code, echoing a value that
    // arrived from a job that did.
    const echoing = allPipelines()
        .concat([PINNED_TEMPLATE])
        .flatMap((file) =>
            jobsOf(read(file))
                .filter((job) => {
                    const body = withoutComments(job.body);
                    return !runsPullRequestCode(body) && /DownloadPipelineArtifact/.test(body) && /##vso\[task\.setvariable[^\]]*\]\$/.test(body);
                })
                .map((job) => ({ file, job }))
        );

    it("has jobs that echo artifact content into a logging command to inspect", () => {
        expect(echoing.length, "no artifact-consuming job echoes an interpolated `##vso[task.setvariable]` — the selector has drifted").toBeGreaterThan(0);
    });

    it.each(echoing.map(({ file, job }) => `${file}:${job.name}`))("%s matches the whole value, not one of its lines", (id) => {
        const entry = echoing.find(({ file, job }) => `${file}:${job.name}` === id);
        expect(entry, `job ${id} disappeared between selection and assertion`).toBeDefined();
        const body = withoutComments(entry?.job.body ?? "");

        expect(body, `job ${id} echoes an artifact-derived value into a logging command without a whole-value match`).toMatch(/\[\[\s*!?\s*\$?\{?\w+\}?\s*=~\s*\^/);
        expect(
            body,
            `job ${id} validates with \`grep -Eq '^…$'\`, which passes a multi-line value on the strength of one good line, and then echoes it into a logging command`
        ).not.toMatch(/grep -Eq\s+'\^/);
    });
});

describe("nothing anywhere persists the checkout credential", () => {
    it.each(allPipelines().concat(UPLOAD_TEMPLATES, [PINNED_TEMPLATE]))("%s does not use persistCredentials", (file) => {
        // `persistCredentials: true` writes the build's OAuth token into
        // `.git/config`, where every later step in the job can read it —
        // including a dependency's install script. The release pipelines used it
        // to `git push` a tag; they create the tag through the GitHub API now.
        expect(withoutComments(read(file)), `${file} uses persistCredentials, leaving the OAuth token readable by every later step`).not.toMatch(/persistCredentials/);
    });
});

describe("npm publishing never executes the package it publishes", () => {
    const publishers = allPipelines().filter((file) => /^\s*npm publish\s/m.test(read(file)));

    it("has publishing pipelines to inspect", () => {
        expect(publishers.length, "no pipeline runs `npm publish` — the selector has drifted").toBeGreaterThan(0);
    });

    it.each(publishers)("%s publishes a validated tarball, not a directory", (file) => {
        const source = withoutComments(read(file));
        for (const command of source.match(/^\s*npm publish\s.*$/gm) ?? []) {
            // Publishing a directory runs that package's prepack and
            // prepublishOnly hooks on the agent holding the publish token. Publishing a
            // tarball still does, unless scripts are off.
            expect(command, `${file}: \`${command.trim()}\` publishes without --ignore-scripts`).toMatch(/--ignore-scripts/);
            expect(command, `${file}: \`${command.trim()}\` publishes a working directory rather than a packed tarball`).not.toMatch(/npm publish\s+\.?\//);
        }
    });
});

describe("authenticated uploads run where no pull-request code has run", () => {
    // Repository-wide, because the upload jobs left the pull-request template:
    // they now live in the master-only publishers, and "PR CI has no upload job"
    // is asserted separately below rather than by an empty subject here.
    const uploaders = allPipelines()
        .concat([PINNED_TEMPLATE])
        .flatMap((file) =>
            jobsOf(read(file))
                .filter((job) => callsUploadTemplate(job.body))
                .map((job) => ({ file, job }))
        );

    it("has upload jobs to inspect", () => {
        expect(uploaders.length, "no pipeline calls an upload template — the selector has drifted").toBeGreaterThan(0);
    });

    it("has none of them in a file a pull request can reach", () => {
        const reachable = new Set(prReachableFiles());
        expect(
            uploaders.filter(({ file }) => reachable.has(file)).map(({ file, job }) => `${file}:${job.name}`),
            "these upload jobs are reachable from a pull request, so the deploy credential must be authorized for a definition the pull request writes:"
        ).toEqual([]);
    });

    it.each(uploaders.map(({ file, job }) => `${file}:${job.name}`))("%s checks out nothing and runs no pull-request code", (id) => {
        const entry = uploaders.find(({ file, job }) => `${file}:${job.name}` === id);
        expect(entry, `job ${id} disappeared between selection and assertion`).toBeDefined();
        expect(entry?.job.body, `job ${id} uploads with a deploy token but does not use \`checkout: none\``).toMatch(/^\s*-\s*checkout:\s*none\s*$/m);
        expect(runsPullRequestCode(entry?.job.body ?? ""), `job ${id} uploads with a deploy token and also runs pull-request code`).toBe(false);
    });

    it("keeps all authenticated upload templates out of the PR publisher while previews are disabled", () => {
        expect(uploaders.filter(({ file }) => file === PUBLISHER)).toEqual([]);
    });

    it("never lets a repository-set variable gate a deploy credential", () => {
        for (const file of allPipelines().concat([PINNED_TEMPLATE])) {
            for (const job of jobsOf(read(file))) {
                if (!declaredGroups(job.body).includes("BabylonJS-Deployment")) {
                    continue;
                }
                // `ArtifactsSafe` is set by a repository-authored script through
                // `##vso[task.setvariable]`, so PR code can set it too. It may
                // gate artifact publication; it must never gate the deploy token.
                expect(job.body, `${file}: job ${job.name} holds the deploy token and gates on ArtifactsSafe, which PR code can set`).not.toContain("ArtifactsSafe");
            }
        }
    });
});

/**
 * The `allowedDeployHosts` default, as written in a template.
 *
 * Returned verbatim so two templates can be compared for equality: the point is
 * that they name the same hosts, and normalising would hide a difference in how
 * one of them is written.
 */
function allowedDeployHostsDefault(source: string): string {
    const block = /^\s*-\s*name:\s*allowedDeployHosts\s*$(?:\n(?!\s*-\s*name:).*)*/m.exec(source)?.[0];
    expect(block, "template declares no allowedDeployHosts parameter").toBeDefined();
    const inline = /^\s*default:\s*(\[.*\])\s*$/m.exec(block ?? "")?.[1];
    if (inline !== undefined) {
        return inline.replace(/\s+/g, "");
    }
    return [...(block ?? "").matchAll(/^\s*-\s*(\S+)\s*$/gm)].map((m) => m[1]).join(",");
}

describe("the upload templates fix their destination at compile time", () => {
    it.each(UPLOAD_TEMPLATES)("%s takes its host allowlist as a parameter, not a variable", (template) => {
        const source = read(template);

        // A parameter is expanded when the run is compiled, before any step
        // executes, so `##vso[task.setvariable]` from repository code cannot
        // reach it and neither can a queue-time variable override. That is the
        // entire difference between this and the DEPLOY_HOST_ALLOWLIST variable
        // it replaced: a variable is something a run can be talked into
        // changing.
        expect(source, `${template} does not declare an allowedDeployHosts parameter`).toMatch(/^\s*-\s*name:\s*allowedDeployHosts\s*$/m);
        expect(source, `${template} does not resolve allowedDeployHosts at compile time`).toMatch(/\$\{\{\s*join\([^)]*parameters\.allowedDeployHosts\s*\)\s*\}\}/);
    });

    it("gives both templates the identical allowlist", () => {
        // Two upload paths to the same deployment server. If one of them can
        // reach a host the other cannot, the tighter one is decorative.
        const [first, second] = UPLOAD_TEMPLATES;
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(allowedDeployHostsDefault(read(first ?? "")), `${first} and ${second} allow different deployment hosts`).toEqual(allowedDeployHostsDefault(read(second ?? "")));
    });

    it.each(UPLOAD_TEMPLATES)("%s exposes and honours requireHostAllowlist", (template) => {
        const source = read(template);

        expect(source, `${template} does not declare a requireHostAllowlist parameter`).toMatch(/^\s*-\s*name:\s*requireHostAllowlist\s*$/m);
        expect(source, `${template} does not fail closed when the allowlist is missing but required`).toMatch(/REQUIRE_HOST_ALLOWLIST/);
        // Redirects and protocol downgrades are how an https-only check gets
        // turned back into a delivery of the Authorization header elsewhere.
        expect(source, `${template} does not pin curl to https`).toMatch(/--proto '=https'/);
        expect(source, `${template} follows redirects, which can move the Authorization header off the allowlisted host`).not.toMatch(/\s(-L|--location)(\s|$)/m);
    });
});

describe("the job-block parser accepts and rejects the right shapes", () => {
    // The assertions above are only as good as the split that feeds them: a
    // parser that returns one giant block would smear a credentialed job's
    // properties across every other job and pass regardless.
    const sample = [
        "stages:",
        "    - stage: CI",
        "      jobs:",
        "          - job: Alpha",
        "            steps:",
        "                - checkout: self",
        "                - script: pnpm install",
        "          - job: Beta",
        "            variables:",
        "                - group: BabylonJS-Deployment",
        "            steps:",
        "                - checkout: none",
    ].join("\n");

    it("separates adjacent jobs", () => {
        expect(jobsOf(sample).map((j) => j.name)).toEqual(["Alpha", "Beta"]);
    });

    it("keeps each job's own content in its own block", () => {
        const blocks = jobsOf(sample);
        const alpha = blocks[0];
        const beta = blocks[1];
        expect(alpha).toBeDefined();
        expect(beta).toBeDefined();
        expect(runsPullRequestCode(alpha?.body ?? "")).toBe(true);
        expect(runsPullRequestCode(beta?.body ?? "")).toBe(false);
        expect(declaredGroups(alpha?.body ?? "")).toEqual([]);
        expect(declaredGroups(beta?.body ?? "")).toEqual(["BabylonJS-Deployment"]);
    });

    it("treats a job with no checkout directive as running pull-request code", () => {
        // Azure checks out `self` when nothing says otherwise, so silence is the
        // dangerous case, not a safe one.
        expect(runsPullRequestCode(["- job: Gamma", "  steps:", "      - script: echo hi"].join("\n"))).toBe(true);
    });

    it("treats a checkout of a pinned repository resource as trusted", () => {
        expect(runsPullRequestCode(["- job: Delta", "  steps:", "      - checkout: trusted", "      - script: pnpm install"].join("\n"))).toBe(false);
    });

    it("reads a job's own condition, not a step's", () => {
        // The two are the same key at different indentation, and only the first
        // decides whether the job runs. A clause that accepted either would be
        // satisfied by `condition: always()` on some publish step while the job
        // itself ran from any ref.
        const job = [
            "          - job: Epsilon",
            "            dependsOn: Build",
            "            condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/master'))",
            "            steps:",
            "                - checkout: none",
            "                - script: echo hi",
            "                  condition: always()",
        ].join("\n");

        expect(jobCondition(job)).toBe("and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/master'))");
        expect(jobCondition(["          - job: Zeta", "            steps:", "                - script: echo hi", "                  condition: always()"].join("\n"))).toBe("");
    });

    it.each([
        ["                      NPM_TOKEN: $(NPM_TOKEN)", ["NPM_TOKEN"]],
        ['                      BROWSERSTACK_ACCESS_KEY: "$(BROWSERSTACK_ACCESS_KEY)"', ["BROWSERSTACK_ACCESS_KEY"]],
        ["                - name: DEPLOY_TOKEN", ["DEPLOY_TOKEN"]],
        ['                      comment: "$(GITHUB_TOKEN)"', ["GITHUB_TOKEN"]],
        ["                      GH: ${{ secrets.DEPLOY_TOKEN }}", ["DEPLOY_TOKEN"]],
        // Correct code, in the shapes this repository actually contains. A
        // clause that fires on any of these gets deleted rather than debugged.
        ["                      PLAYWRIGHT_JUNIT_OUTPUT_NAME: test-results/x.xml", []],
        ["                      LAB_BASE_PATH: /lite/$(Build.BuildNumber)/lab/", []],
        ["                      storageAccount: $(TOOLS_STORAGE_ACCOUNT)", []],
        ["                  # NPM_TOKEN must never appear in this job", []],
    ])("credentialNamesIn(%s) -> %s", (line, expected) => {
        expect(credentialNamesIn(line as string)).toEqual(expected);
    });

    it("recognises an upload template call only when it is a template step", () => {
        expect(callsUploadTemplate("          - template: upload-static-site.yml")).toBe(true);
        expect(callsUploadTemplate("          - template: config/templates/upload-static-site.yml")).toBe(true);
        expect(callsUploadTemplate("# see config/templates/upload-static-site.yml for the contract")).toBe(false);
    });
});

/**
 * Issue #627 restored *automatic* bundle-size comments after this repository's
 * pull-request CI lost every write credential. The mechanism everyone reaches
 * for — a pipeline completion trigger on the publisher — is the one that undoes
 * the split: for two pipelines in the same repository, Azure runs the triggered
 * pipeline on the triggering run's branch, so a pull-request build would make
 * the credentialed publisher's YAML come from `refs/pull/<n>/merge`.
 *
 * The replacement is a scheduled poller on master that reads build metadata and
 * queues the publisher. These assertions pin the properties that make that
 * safe, and each is written so that the obvious convenience shortcut — a
 * completion trigger, a shared token, the ambient job token, a runtime
 * destination — fails rather than works.
 */
describe("the scheduled comment poller cannot be reached or steered from a pull request", () => {
    const POLLER = "azure-pipelines-pr-comment-poller.yml";
    const poller = read(POLLER);
    const uncommented = withoutComments(poller);

    it("is never triggered by a pull request or by another pipeline", () => {
        expect(uncommented).toMatch(/^trigger:\s*none\s*$/m);
        expect(uncommented).toMatch(/^pr:\s*none\s*$/m);

        // The whole point. A `pipelines:` resource here would reintroduce the
        // same-repository completion trigger the design forbids.
        expect(uncommented, `${POLLER} declares a pipeline resource, which would run this credentialed YAML from a pull-request ref`).not.toMatch(/^\s*pipelines:\s*$/m);
    });

    it("schedules itself only on master and checks out master through a read-only connection", () => {
        expect(uncommented).toMatch(/schedules:[\s\S]*?branches:\s*\n\s*include:\s*\n\s*-\s*master/);

        const resource = /-\s*repository:\s*trusted[\s\S]*?ref:\s*(\S+)/.exec(uncommented);
        expect(resource, `${POLLER} has no pinned trusted repository resource`).toBeDefined();
        expect(resource?.[1]).toBe("refs/heads/master");
        expect(uncommented).toMatch(/endpoint:\s*BabylonLite-Trusted-RepoRead/);

        // The connection pull-request CI is authorized for must not also be the
        // one a credentialed definition uses.
        expect(uncommented, `${POLLER} reuses the PR CI checkout connection`).not.toContain("BabylonLite-PRCI-RepoRead");
    });

    it("holds no credential that can write to GitHub", () => {
        // It reads pull-request metadata and it queues a build. Anything that can
        // comment, label, push or deploy belongs in the publisher, behind the
        // preflight, not in the thing that decides *when* to publish.
        for (const forbidden of ["PR_COMMENT_TOKEN", "BabylonLite-PRComments", "gitHubConnection:", "NPM_PUBLISH_TOKEN", "DEPLOY_TOKEN", "BabylonJS-Deployment"]) {
            expect(uncommented, `${POLLER} holds ${forbidden}, a credential the poller has no reason to be able to use`).not.toContain(forbidden);
        }
    });

    it("takes its queue and metadata credentials from protected groups, not from pipeline variables", () => {
        expect(uncommented).toMatch(/^\s*-\s*group:\s*BabylonLite-PRPublishQueue\s*$/m);
        expect(uncommented).toMatch(/^\s*-\s*group:\s*BabylonLite-PRMetadata\s*$/m);

        // A pipeline-level `- name:/value:` variable is not a protected resource,
        // so no branch-control check would apply to it.
        for (const secret of ["PR_PUBLISH_QUEUE_TOKEN", "PR_METADATA_TOKEN"]) {
            expect(uncommented, `${POLLER} defines ${secret} as a plain pipeline variable, which no check protects`).not.toMatch(
                new RegExp(`-\\s*name:\\s*${secret}\\s*\\n\\s*value:`)
            );
        }
    });

    it("runs the reconciler under a restricted agent that can set no variables at all", () => {
        const step = /-\s*script:\s*pnpm poll:pr-comments[\s\S]*?target:\s*\n\s*commands:\s*(\w+)\s*\n\s*settableVariables:\s*(\S+)/.exec(uncommented);
        expect(step, `${POLLER} does not run the poller under a restricted target`).toBeDefined();
        expect(step?.[1]).toBe("restricted");
        expect(step?.[2]).toBe("none");
    });

    it("fixes the repository it inspects at compile time", () => {
        expect(uncommented).toMatch(/GITHUB_REPOSITORY:\s*"BabylonJS\/Babylon-Lite"/);
        expect(uncommented).not.toContain("$(Build.Repository.Name)");
    });

    it("never installs dependency lifecycle scripts on the credentialed agent", () => {
        const install = /-\s*script:\s*pnpm install[^\n]*/.exec(uncommented);
        expect(install, `${POLLER} does not install dependencies`).toBeDefined();
        expect(install?.[0]).toContain("--ignore-scripts");
    });
});

describe("the publisher splits the two comment paths so a retry cannot duplicate a comment", () => {
    const publisher = read(PUBLISHER);
    const uncommented = withoutComments(publisher);

    it("exposes an independent switch per comment path, defaulting to today's behaviour", () => {
        // Both default `true` so a manual, emergency queue keeps behaving exactly
        // as it does today; the poller is what narrows them per axis.
        for (const parameter of ["postApiComment", "postBundleComment"]) {
            const declaration = new RegExp(`-\\s*name:\\s*${parameter}\\b[\\s\\S]{0,240}?type:\\s*boolean[\\s\\S]{0,240}?default:\\s*true`);
            expect(publisher, `${PUBLISHER} does not declare ${parameter} as a boolean defaulting to true`).toMatch(declaration);
        }
    });

    it("keeps the API and bundle comments in separate jobs", () => {
        // `GitHubComment@0` is create-only: re-running it posts a second comment.
        // The bundle path must be retryable, so the two cannot share a job result.
        const names = jobsOf(publisher).map((job) => job.name);
        expect(names).toContain("PostApiComment");
        expect(names).toContain("PostBundleComment");
        expect(names, "PostPrComments still exists, so a bundle retry would re-post the create-only API comment").not.toContain("PostPrComments");
    });

    it("lets the bundle path fail, so the poller can see it and retry", () => {
        const bundle = jobsOf(publisher).find((job) => job.name === "PostBundleComment");
        expect(bundle, `${PUBLISHER} has no PostBundleComment job`).toBeDefined();

        // Nothing in this job may swallow a failure. The job it replaced was
        // tolerant at both the download *and* the task level, which is exactly
        // why a failed bundle post was invisible and stale comments survived.
        //
        // The download in particular must stay intolerant. A tolerant download
        // turns a transient fetch failure into an empty directory, the reconciler
        // reads that as "nothing measured", and the warning-level job result
        // retires the bundle axis as published against the latest build — issue
        // #627 restored in full. "Nothing to download" is established from the
        // server instead, by the condition below.
        expect(withoutComments(bundle?.body ?? ""), "a tolerant step in the bundle job hides the failure the poller retries on").not.toMatch(/continueOnError:\s*true/);

        const step = /-\s*script:\s*pnpm reconcile:bundle-comment[\s\S]*?(?=\n\s{18}-\s|$)/.exec(withoutComments(bundle?.body ?? ""));
        expect(step, `${PUBLISHER} does not run the bundle reconciler`).toBeDefined();
        expect(step?.[0], "the bundle reconciler swallows its own failures, so no retry can ever be triggered").not.toMatch(/continueOnError:\s*true/);
    });

    it("decides whether an artifact exists on the server, not from the agent's filesystem", () => {
        // The two states are indistinguishable on disk and must be handled
        // oppositely, so the answer has to come from somewhere a failed download
        // cannot forge.
        const preflight = jobsOf(publisher).find((job) => job.name === "Preflight");
        const probe = /-\s*script:[\s\S]*?_apis\/build\/builds\/\$\{RUN_ID\}\/artifacts[\s\S]*?(?=\n\s{16}-\s|$)/.exec(withoutComments(preflight?.body ?? ""));
        expect(probe, `${PUBLISHER} never asks the Build API which artifacts the PR CI run published`).toBeDefined();
        expect(probe?.[0]).toMatch(/isOutput=true/);
        expect(probe?.[0], "the probe must name the artifact it is looking for").toContain("bundle-comment");

        // Preflight is the right place for it precisely because it has no GitHub
        // credential: the ADO token and the comment token never share a job.
        expect(preflight?.body, "Preflight must not gain a GitHub credential").not.toMatch(/PR_COMMENT_TOKEN|BabylonLite-PRComments/);
    });

    it("gates the bundle download on the server's answer, sourced from Preflight rather than an artifact", () => {
        const bundle = jobsOf(publisher).find((job) => job.name === "PostBundleComment");
        const body = withoutComments(bundle?.body ?? "");

        const download = /-\s*task:\s*DownloadPipelineArtifact@2[\s\S]*?(?=\n\s{16}-\s|$)/.exec(body);
        expect(download, `${PUBLISHER} does not download the bundle comment`).toBeDefined();
        expect(download?.[0], "the download must be skipped when the server says there is no artifact").toMatch(/condition:[^\n]*BUNDLE_ARTIFACT_PRESENT/);

        // Sourced from the trusted job's output. Anything artifact-derived here
        // would let a pull request decide whether its own stale comment is
        // retracted.
        expect(body).toMatch(/BUNDLE_ARTIFACT_PRESENT[\s\S]{0,120}dependencies\.Preflight\.outputs\['bundleArtifact\.bundleArtifactPresent'\]/);
        expect(body, "the reconciler must be told what the server said").toMatch(/BUNDLE_ARTIFACT_PRESENT:\s*"\$\(BUNDLE_ARTIFACT_PRESENT\)"/);
    });

    it("keeps the API path tolerant, because its task cannot be retried safely", () => {
        // The asymmetry is deliberate and worth pinning: `GitHubComment@0` is
        // create-only, so a retry duplicates the comment. Its download warns on
        // every pull request that did not move the public API.
        const api = jobsOf(publisher).find((job) => job.name === "PostApiComment");
        expect(withoutComments(api?.body ?? ""), "the API path lost its tolerance, so ordinary runs will now be retried and duplicated").toMatch(/continueOnError:\s*true/);
    });

    it("gives every publisher run a build number derived only from compile-time parameters", () => {
        const name = /^name:\s*(.+)$/m.exec(uncommented);
        expect(name, `${PUBLISHER} has no build number format`).toBeDefined();

        // The poller finds prior attempts for a triple by build number, so the
        // format must be fixed at compile time from the parameters themselves.
        const format = name?.[1] ?? "";
        expect(format).toContain("${{ parameters.prNumber }}");
        expect(format).toContain("${{ parameters.prCiRunId }}");
        expect(format.replace(/\$\{\{[^}]*\}\}/g, "")).not.toMatch(/\$\((?!Rev:)/);
    });

    it("reconciles the bundle comment with trusted code rather than a create-only task", () => {
        const bundle = withoutComments(jobsOf(publisher).find((job) => job.name === "PostBundleComment")?.body ?? "");
        expect(bundle).toContain("pnpm reconcile:bundle-comment");

        // The sticky comment needs update and list permissions, which the
        // `GitHubComment@0` service connection does not expose to a script.
        expect(bundle, "the bundle path still posts through the create-only comment task").not.toContain("GitHubComment@");
        expect(bundle).toContain("PR_COMMENT_TOKEN");
    });
});
