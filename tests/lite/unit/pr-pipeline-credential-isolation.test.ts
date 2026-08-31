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
    /NPM_TOKEN:/,
    /gitHubConnection:/,
    /GITHUB_TOKEN:/,
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

/** Pipelines that build from a pull-request ref, and so run untrusted code. */
function prTriggeredPipelines(): string[] {
    const files = allPipelines();

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
            // prepublishOnly hooks on the agent holding NPM_TOKEN. Publishing a
            // tarball still does, unless scripts are off.
            expect(command, `${file}: \`${command.trim()}\` publishes without --ignore-scripts`).toMatch(/--ignore-scripts/);
            expect(command, `${file}: \`${command.trim()}\` publishes a working directory rather than a packed tarball`).not.toMatch(/npm publish\s+\.?\//);
        }
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

    it("recognises an upload template call only when it is a template step", () => {
        expect(callsUploadTemplate("          - template: upload-static-site.yml")).toBe(true);
        expect(callsUploadTemplate("          - template: config/templates/upload-static-site.yml")).toBe(true);
        expect(callsUploadTemplate("# see config/templates/upload-static-site.yml for the contract")).toBe(false);
    });
});
