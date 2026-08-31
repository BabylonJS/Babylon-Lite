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
 * being reviewed. The repository's answer is to keep nothing in that file: it is
 * a shell that `extends` `config/templates/pr-ci.yml` through a repository
 * resource pinned to `refs/heads/master`, and repository resources resolve from
 * their pinned ref, so the jobs that actually run are the reviewed ones. The
 * server-side Required-template check is what stops a pull request from dropping
 * the `extends` — it is configured on the protected resources, not in YAML, and
 * cannot be asserted from here.
 *
 * What *can* be asserted from here is everything that check is protecting:
 *
 *   - the entry point stays a shell, pinned to master;
 *   - no job that checks out the pull request holds a credential of any kind —
 *     no variable group, no GITHUB_TOKEN, no System.AccessToken, and no
 *     `persistCredentials`, which leaves the OAuth token in `.git/config` for
 *     every later step including dependency lifecycle scripts;
 *   - authenticated uploads run in jobs that check out nothing, and pin the
 *     destination host to an allowlist rather than to "it is https".
 *
 * These are invisible in review: a template call moved back into a build job, or
 * a `checkout: self` added to a publish job, looks like a tidy-up and silently
 * restores the whole vulnerability.
 */

/** The pull-request entry point: the only pipeline with a `pr:` trigger. */
const ENTRY_POINT = "azure-pipelines.yml";

/** Where the pull-request stages actually live, read from the pinned ref. */
const PINNED_TEMPLATE = "config/templates/pr-ci.yml";

const UPLOAD_TEMPLATES = ["config/templates/upload-static-site.yml", "config/templates/upload-test-report.yml"];

/** Groups whose secrets can write to, or authenticate against, other systems. */
const PRIVILEGED_GROUPS = ["BabylonJS-Deployment", "BabylonJS-CI-Infrastructure"];

/**
 * The one credential a job running pull-request code is allowed to hold.
 *
 * A cloud browser test cannot be run without giving the tests the account key,
 * so this exception is structural rather than an oversight. It is contained by
 * keeping those jobs in a stage of their own, holding nothing else: a leaked
 * BrowserStack key buys browser minutes, not a deploy.
 */
const ALLOWED_IN_PULL_REQUEST_JOBS = ["BabylonJS-BrowserStack"];

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

/** Pipelines that build from a pull-request ref, and so run untrusted code. */
function prTriggeredPipelines(): string[] {
    const files = readdirSync(repoRoot).filter((f) => /^azure-pipelines.*\.ya?ml$/.test(f));

    // Guard the guard: an empty subject makes every assertion below vacuously
    // true, which is precisely the failure this file exists to prevent.
    expect(files.length, "found no azure-pipelines*.yml files to inspect").toBeGreaterThan(0);

    // `pr: none` opts out; a bare `pr:` opens a branch-filter block and opts in.
    return files.filter((f) => /^pr:\s*$/m.test(read(f)));
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

describe("the pull-request entry point defines nothing and pins everything", () => {
    const pipelines = prTriggeredPipelines();

    it("has exactly one pr-triggered pipeline, and it is the known entry point", () => {
        expect(pipelines, "no pipeline declares a `pr:` trigger").not.toHaveLength(0);
        expect(pipelines, "a new pr-triggered pipeline appeared; it must be a shell too, and this guard must be taught about it").toEqual([ENTRY_POINT]);
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

    it("gives a job that checks out the pull request no credential beyond the cloud browser key", () => {
        // Stated as an allowlist rather than a list of things to exclude: a
        // variable group added tomorrow is denied by default instead of being
        // permitted until someone remembers to name it here.
        for (const job of jobs) {
            if (!runsPullRequestCode(job.body)) {
                continue;
            }
            const unexpected = declaredGroups(job.body).filter((group) => !ALLOWED_IN_PULL_REQUEST_JOBS.includes(group));
            expect(unexpected, `${PINNED_TEMPLATE}: job ${job.name} checks out the pull request and imports a credential that is not the cloud browser key`).toEqual([]);
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

describe("the cloud stage is the only place a credential meets pull-request code", () => {
    const jobs = jobsOf(read(PINNED_TEMPLATE));

    it("has a job importing the cloud credential", () => {
        const cloud = jobs.filter((job) => declaredGroups(job.body).includes("BabylonJS-BrowserStack"));
        expect(cloud.length, "no job imports BabylonJS-BrowserStack — the selector has drifted").toBeGreaterThan(0);
    });

    it("never combines the cloud credential with a deploy or infrastructure credential", () => {
        for (const job of jobs) {
            const groups = declaredGroups(job.body);
            if (!groups.includes("BabylonJS-BrowserStack")) {
                continue;
            }
            // Cloud browser tests cannot be run without giving the account key
            // to the tests themselves, so these jobs are where a compromise
            // starts. Nothing else may be reachable from there.
            for (const privileged of PRIVILEGED_GROUPS) {
                expect(groups, `job ${job.name} holds both the cloud credential and ${privileged}`).not.toContain(privileged);
            }
            expect(withoutComments(job.body), `job ${job.name} holds the cloud credential and also posts to GitHub`).not.toMatch(/gitHubConnection:/);
        }
    });

    it("does not decide anything from the fork system variable", () => {
        // `System.PullRequest.IsFork` is documented read-only, but Microsoft
        // does not document the agent refusing a `task.setvariable` that
        // shadows it for later steps. A control that may or may not hold is not
        // a control; the cloud jobs detect the absence of the key itself.
        expect(withoutComments(read(PINNED_TEMPLATE)), "pipeline logic branches on System.PullRequest.IsFork, which may be shadowable at runtime").not.toMatch(
            /variables\[.System\.PullRequest\.IsFork.\]/
        );
    });
});

describe("authenticated uploads run where no pull-request code has run", () => {
    const source = read(PINNED_TEMPLATE);
    const uploaders = jobsOf(source).filter((job) => callsUploadTemplate(job.body));

    it("has upload jobs to inspect", () => {
        expect(uploaders.length, `${PINNED_TEMPLATE} calls no upload template — the selector has drifted`).toBeGreaterThan(0);
    });

    it.each(uploaders.map((job) => job.name))("%s checks out nothing and runs no pull-request code", (name) => {
        const job = uploaders.find((candidate) => candidate.name === name);
        expect(job, `job ${name} disappeared between selection and assertion`).toBeDefined();
        expect(job?.body, `job ${name} uploads with a deploy token but does not use \`checkout: none\``).toMatch(/^\s*-\s*checkout:\s*none\s*$/m);
        expect(runsPullRequestCode(job?.body ?? ""), `job ${name} uploads with a deploy token and also runs pull-request code`).toBe(false);
    });

    it.each(uploaders.map((job) => job.name))("%s requires the destination host allowlist", (name) => {
        const job = uploaders.find((candidate) => candidate.name === name);
        expect(job, `job ${name} disappeared between selection and assertion`).toBeDefined();
        // An https URL is not a destination check: an attacker's host serves
        // https too. Only the allowlist names the host this token may reach.
        expect(job?.body, `job ${name} calls an upload template without requireHostAllowlist: true`).toMatch(/requireHostAllowlist:\s*true/);
    });

    it("never lets a repository-set variable gate a deploy credential", () => {
        for (const job of jobsOf(source)) {
            if (!declaredGroups(job.body).includes("BabylonJS-Deployment")) {
                continue;
            }
            // `ArtifactsSafe` is set by a repository-authored script through
            // `##vso[task.setvariable]`, so PR code can set it too. It may gate
            // artifact publication; it must never gate the deploy token.
            expect(job.body, `job ${job.name} holds the deploy token and gates on ArtifactsSafe, which PR code can set`).not.toContain("ArtifactsSafe");
        }
    });
});

describe("the upload templates enforce the destination host themselves", () => {
    it.each(UPLOAD_TEMPLATES)("%s exposes and honours requireHostAllowlist", (template) => {
        const source = read(template);

        expect(source, `${template} does not declare a requireHostAllowlist parameter`).toMatch(/^\s*-\s*name:\s*requireHostAllowlist\s*$/m);
        expect(source, `${template} does not read DEPLOY_HOST_ALLOWLIST`).toMatch(/DEPLOY_HOST_ALLOWLIST/);
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

    it("recognises an upload template call only when it is a template step", () => {
        expect(callsUploadTemplate("          - template: upload-static-site.yml")).toBe(true);
        expect(callsUploadTemplate("          - template: config/templates/upload-static-site.yml")).toBe(true);
        expect(callsUploadTemplate("# see config/templates/upload-static-site.yml for the contract")).toBe(false);
    });
});
