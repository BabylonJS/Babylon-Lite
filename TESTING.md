# Testing

Babylon Lite uses four categories of automated tests, all orchestrated by
Playwright and/or Vitest. An Azure Pipelines CI pipeline runs seven parallel
jobs on every PR targeting `master`.

---

## Quick Reference

| Command                  | What it runs                                             |
| ------------------------ | -------------------------------------------------------- |
| `pnpm test`              | Build bundles → parity tests (local)                     |
| `pnpm test:parity`       | Parity pixel-diff tests (local Chrome)                   |
| `pnpm test:parity-cloud` | Parity tests on BrowserStack (macOS Chrome, real WebGPU) |
| `pnpm test:perf`         | Performance regression tests (local)                     |
| `pnpm test:perf-cloud`   | Performance regression on BrowserStack                   |
| `pnpm test:bundle-size`  | Bundle size ceiling checks                               |
| `pnpm test:bundle-delta` | Bundle size delta vs committed baseline                  |
| `pnpm test:all`          | Parity + perf tests (local)                              |
| `pnpm test:watch`        | Vitest in watch mode (unit tests)                        |
| `pnpm lint`              | ESLint + TypeScript type-check                           |

---

## 1. Unit Tests

**Runner:** Vitest  
**Location:** `tests/lite/unit/`  
**Config:** `vitest.config.ts`

Standard unit tests for core logic (shader composer, shader integration, etc.).

```sh
pnpm test:watch        # interactive
pnpm exec vitest run   # single run
```

---

## 2. Plumbing Tests

**Runner:** Playwright  
**Location:** `tests/lite/plumbing/`

Browser-based integration tests that exercise engine lifecycle:

- `dispose.spec.ts` — resource cleanup
- `material-swap.spec.ts` — hot material replacement
- `memory-leak.spec.ts` — allocation tracking
- `picking.spec.ts` — GPU picking

```sh
pnpm exec playwright test tests/lite/plumbing/
```

---

## 3. Parity Tests (Pixel Comparison)

**Runner:** Playwright  
**Location:** `tests/lite/parity/scenes/` (25 scene spec files)  
**Configs:**

- Local: `playwright.config.ts`
- Cloud: `config/playwright.parity-cloud.config.ts`

Compares screenshots of Babylon Lite rendering against golden reference images
(BJS screenshots stored in `reference/lite/`). Uses Mean Absolute Difference (MAD)
as the error metric; thresholds are defined per-scene in `scene-config.json`.

### How it works

1. Opens the Lite bundle page (`bundle-scene{N}.html`)
2. Waits for `canvas[data-ready="true"]`
3. Takes a screenshot
4. Compares pixel-by-pixel against the golden reference
5. Asserts MAD ≤ scene threshold

### Running locally

```sh
pnpm build:bundle-scenes
pnpm test:parity
```

### Running on BrowserStack

Requires `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` (set in
`.env.local` or as environment variables). Azure Pipelines gets these from the
`BabylonJS-BrowserStack` variable group.

The cloud parity config connects to remote Chrome **directly over CDP**
(`wss://cdp.browserstack.com/playwright`) — it does **not** use
`browserstack-node-sdk`. Each Playwright worker is its own BrowserStack session,
so specs shard across `CIWORKERS` parallel cloud browsers. The local Vite dev
server is exposed to the remote browser through a BrowserStack Local tunnel
started by the config's `globalSetup` (`config/browserstack-local-tunnel.ts`).
Both BrowserStack Playwright configs explicitly disable tracing, including
retry tracing, because BrowserStack connection metadata can embed credentials.

```sh
pnpm build:bundle-scenes

# One session (bare invocation never over-claims capacity):
pnpm test:parity-cloud

# Shard across up to N sessions (falls back to fewer when the plan is busy):
BSTACK_SESSIONS_REQUIRED=2 bash scripts/browserstack-wait.sh pnpm test:parity-cloud
```

### Golden References

Golden images are committed in `reference/lite/` and compared against Lite renders.
`captureGolden()` skips BJS page capture when the golden file already exists
on disk, which significantly speeds up test runs.

To force recapture of all golden references (e.g., after a Babylon.js update):

```sh
RECAPTURE_GOLDEN=true pnpm test:parity
```

### Timeouts

Canvas-ready timeouts are set per-scene based on model complexity:

| Scenes           | Timeout |
| ---------------- | ------- |
| Most scenes      | 60 s    |
| Hill Valley, KTX | 90 s    |
| Sponza           | 120 s   |

These higher values account for model downloads through the BrowserStack
tunnel.

---

## 4. Performance Regression Tests

**Runner:** Playwright  
**Location:** `tests/lite/perf/perf-regression.spec.ts`  
**Configs:**

- Local: `playwright.perf.config.ts`
- Cloud: `config/playwright.perf-cloud.config.ts`

Measures CPU + GPU frame time by intercepting the engine's RAF-based render
loop at runtime, then compares current Lite bundles against a baseline built
from the previous release.

### How it works

1. **Runtime injection** via `page.addInitScript()` — no scene modifications
   needed:
    - Monkey-patches `requestAnimationFrame` to capture the render callback
    - Monkey-patches `GPUQueue.prototype.submit` to capture the GPU queue
    - Exposes `window.__perfStop()` to halt the RAF loop
    - Exposes `window.__perfRender()` to call render + `await queue.onSubmittedWorkDone()`

2. **Single-page measurement** — all runs happen on one page load (one model
   download) to eliminate network variance:
    - Each run: warmup frames → measured frames
    - Measured frames use `performance.now()` around `__perfRender()` for true
      CPU+GPU cost
    - Trimmed mean (drops top/bottom 10%) per run
    - Median across all runs = final result

3. **Assertion** — only the trimmed mean average is asserted (p95 is logged
   but not asserted, as it's too noisy at sub-ms frame times)

### Environment Variables

| Variable              | Default | Description                                       |
| --------------------- | ------- | ------------------------------------------------- |
| `PERF_REGRESSION_PCT` | `5`     | Maximum allowed regression % (trimmed mean)       |
| `PERF_FRAMES`         | `300`   | Measured frames per run                           |
| `PERF_RUNS`           | `5`     | Number of runs per version (takes median)         |
| `PERF_WARMUP`         | `60`    | Warmup frames before each measurement run         |
| `PERF_SCENES`         | all     | Comma-separated scene IDs to test (e.g., `1,5,9`) |

### Prerequisites

```sh
pnpm build:bundle-scenes       # build current bundles
pnpm build:perf-baseline        # build baseline from last release tag
```

The baseline script (`scripts/build-perf-baseline.ts`) uses a git worktree to
check out the last `v*` release tag (or `origin/master` if no tags exist),
builds its bundles, and copies them to `lab/public/bundle-baseline/`.

### Running locally

```sh
pnpm build:bundle-scenes
pnpm build:perf-baseline
pnpm test:perf
```

### Running on BrowserStack

```sh
pnpm build:bundle-scenes
pnpm build:perf-baseline
pnpm test:perf-cloud
```

### Tuning for stability

If tests are flaky on noisy VMs, increase warmup and frame count:

```sh
PERF_WARMUP=120 PERF_FRAMES=500 pnpm test:perf-cloud
```

---

## 5. Bundle Size Checks

**Runner:** Playwright  
**Location:** `tests/lite/parity/bundle-size.spec.ts`

Each scene bundle must stay under `maxRawKB` defined in `scene-config.json`
(gzip size is shown for reference but not enforced). This ceiling is the gate for
bundle-size regressions in CI.

```sh
pnpm build:bundle-scenes
pnpm test:bundle-size
```

The master baseline used for the "how did this change move sizes" report is not
tracked in git. `azure-pipelines-bundle-manifest.yml` re-measures every scene
after each merge and publishes the aggregate manifest to a stable public URL:

```
https://snapshots-cvgtc2eugrd3cgfd.z01.azurefd.net/lite/bundle-baseline/manifest.json
```

`pnpm build:bundle-scenes` fetches it automatically and writes
`lab/public/bundle/master-manifest.json`, which the bundle-size spec and the PR
comment read. Everything under `lab/public/bundle/` is generated and gitignored,
so there is nothing to commit and nothing to conflict on.

If you need to point at a different baseline — an offline run, or comparing
against a specific build — override the source:

```sh
BUNDLE_MASTER_MANIFEST_URL=  pnpm build:bundle-scenes          # skip the fetch entirely
BUNDLE_MASTER_MANIFEST_FILE=/path/to/manifest.json pnpm build:bundle-scenes
```

A missing baseline is not an error: the delta report is skipped and the
`maxRawKB` ceilings above still gate the build.

---

## BrowserStack Configuration

Two jobs use BrowserStack differently:

| Job             | How it connects                                  | Config                                     |
| --------------- | ------------------------------------------------ | ------------------------------------------ |
| Parity (Cloud)  | Direct **CDP** (no SDK), sharded across sessions | `config/playwright.parity-cloud.config.ts` |
| Perf Regression | `browserstack-node-sdk` (SDK-managed tunnel)     | `config/browserstack.yml`                  |

### Parity (CDP)

| Setting           | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| Platform          | macOS Sonoma                                          |
| Browser           | Chrome latest                                         |
| Parallel sessions | Up to `BSTACK_SESSIONS_REQUIRED` (CI default 2)       |
| Local tunnel      | `browserstack-local`, started by config `globalSetup` |

`scripts/browserstack-wait.sh` polls the BrowserStack plan, grabs up to the
requested number of sessions (falling back to fewer when busy), and exports
`CIWORKERS` so Playwright shards specs across exactly that many cloud browsers.

### Perf (SDK)

**Config file:** `config/browserstack.yml`

| Setting           | Value                                |
| ----------------- | ------------------------------------ |
| Platform          | macOS Sonoma                         |
| Browser           | Chrome latest                        |
| Parallel sessions | 1                                    |
| Local tunnel      | Enabled (tests hit `localhost:5174`) |

Credentials are read from environment variables:

- `BROWSERSTACK_USERNAME`
- `BROWSERSTACK_ACCESS_KEY`

For local development, add these to `.env.local` (git-ignored).

---

## Azure Pipelines CI

**Entry point:** `azure-pipelines.yml`
**Job definitions:** `config/templates/pr-ci.yml`, read from `refs/heads/master`
**Trigger:** PRs targeting `master`

`azure-pipelines.yml` contains no job, no variable group, no script and no
credentialed service connection. It names the trigger and `extends`
`config/templates/pr-ci.yml` through a repository resource pinned to
`refs/heads/master`. Everything CI actually does is defined there.
[Why](#why-the-jobs-are-not-in-azure-pipelinesyml) is the whole of the next
section — it is not a tidy-up, and moving a job back into the entry point
reintroduces a vulnerability.

The run is **one stage**, and it holds nothing:

| Stage  | Runs PR code | Variable groups | Service connections                     |
| ------ | ------------ | --------------- | --------------------------------------- |
| **CI** | yes          | none            | `BabylonLite-PRCI-RepoRead` (read-only) |

The single connection exists so the pinned template can be fetched. It is scoped
to *read* this repository and nothing else, so a pull request that rewrites the
entry point and asks for it by name gains read access to a repository it is
already reading. Everything else — deploys, comments, tags, npm, BrowserStack —
belongs to master-only definitions; see
[Protected resource matrix](#protected-resource-matrix).

There is deliberately no cloud-browser stage — see
[Cloud browser tests run post-merge](#cloud-browser-tests-run-post-merge) — and
no publish stage — see
[PR previews and comments are published separately](#pr-previews-and-comments-are-published-separately).

Jobs:

| Job                     | What it does                                       |
| ----------------------- | -------------------------------------------------- |
| **Release Markers**     | Commit-message half of the breaking-change rule    |
| **API Report**          | Public API diff; stages the comment body           |
| **Unit Tests**          | Vitest unit tests + Playwright plumbing tests      |
| **Bundle Size**         | Ceiling checks, delta comment body, lab-site build |
| **Lint**                | ESLint + TypeScript `--noEmit` type-check          |
| **Compat**              | Cross-version compatibility checks                 |
| **Playground Snapshot** | Builds the playground; stages it as an artifact    |

Everything a pull request produces that needs a credential to deliver leaves the
run as a **pipeline artifact**: `api-comment`, `bundle-comment`, `lab-site`,
`playground-site`.

### PR comments are published separately; previews are disabled

**Pipeline:** `azure-pipelines-pr-publish.yml`
**Trigger:** none. `pr: none`. Emergency/debug runs are queued by hand from
`master`; the mergeable steady state requires the scheduled master poller in
issue #627.

| Job                          | What it does                                                  |
| ---------------------------- | ------------------------------------------------------------- |
| **Validate run parameters**  | Verifies the numeric inputs and the PR CI run's provenance    |
| **Release Markers (labels)** | Label half of the rule, from the pinned master checkout       |
| **PR previews disabled**     | Explicitly skips the untrusted `lab-site`/`playground-site` artifacts |
| **Post PR Comments**         | Posts the API and bundle-size comment bodies                  |

For an emergency/debug comment publish:

```
Pipelines → "Babylon Lite PR Publish" → Run pipeline
  Branch:            master        (nothing else is permitted)
  prNumber:          641           (the pull request number)
  prCiRunId:         12345         (the PR CI run id, from the run's URL)
  prCiDefinitionId:  7             (the PR CI pipeline's definition id)
```

The three identity values are **compile-time `number` parameters**, fixed and
type-checked before the first step runs. Before any protected job starts,
`Preflight` reads build metadata from the Azure Build API and verifies all of:

- build id equals `prCiRunId`;
- definition id equals `prCiDefinitionId`;
- reason is `pullRequest` and status is `completed`;
- source branch is exactly `refs/pull/<prNumber>/merge`;
- repository type/name are exactly `GitHub` / `BabylonJS/Babylon-Lite`.

The publisher downloads only `api-comment` and `bundle-comment`. It never
executes artifact content, fixes every GitHub task's repository to
`BabylonJS/Babylon-Lite`, and constrains every step that touches downloaded
artifact bytes through the agent's `target.commands: restricted` /
`settableVariables` enforcement. `PostApiComment` permits exactly
`API_COMMENT_BODY` and `POST_API_COMMENT`; `PostBundleComment` permits
`settableVariables: none`, because its reconciler reads the artifact from disk
and needs no pipeline variable at all — so untrusted bytes never pass through a
variable on that path.

Manual queueing is **not** the normal operation. Automation is restored by the
stacked #627 change described below; the manual queue survives only as an
emergency and debugging path. A `resources.pipelines` completion trigger is
the obvious wiring and is the one shape that would rebuild the whole vulnerability:
when the triggering and triggered pipelines share a repository, Azure runs the
triggered pipeline on the *triggering run's* branch — for a PR build, the pull
request's own merge ref. This file, holding `BabylonJS-Deployment`,
and `BabylonBotPAT`, would then be read from the pull request. A guard asserts
the file declares no pipeline resource at all.

The required stacked design is:

- **PR 1:** this credential-boundary redesign and publisher contract, opened
  draft and blocked from merge.
- **PR 2 / #627:** `azure-pipelines-pr-comment-poller.yml`, a scheduled pipeline
  that always runs from `master`, derives which publisher runs are missing, and
  queues this publisher with the validated number triple through a dedicated
  queue identity. It owns fixed, trusted hidden markers for sticky-comment
  reconciliation; no marker, destination, repository or action is read from an
  artifact. See “The scheduled comment poller” below.

The publisher contract #627 consumes is exact:

| Parameter | Type | Meaning |
| --------- | ---- | ------- |
| `prNumber` | `number` | Number parsed from `refs/pull/<N>/merge` |
| `prCiRunId` | `number` | Completed Azure build id |
| `prCiDefinitionId` | `number` | Fixed PR CI definition id configured by an administrator |
| `postComments` | `boolean` | Master switch; the poller uses `true` |
| `postApiComment` | `boolean` | Runs `PostApiComment`. Defaults `true` |
| `postBundleComment` | `boolean` | Runs `PostBundleComment`. Defaults `true` |

The last two exist because the two comment paths have different retry semantics.
`GitHubComment@0` can only create, so re-running the API path posts a second
comment; the bundle path is a reconciler that must be retryable. They were one
job until #627, which meant a bundle retry necessarily duplicated the API
comment. They are now separate jobs with separate results, and the poller sets
each flag from the corresponding job's outcome on earlier attempts. Both default
`true`, so a manual emergency queue behaves exactly as it did before.

| Artifact | Required file | Ownership |
| -------- | ------------- | --------- |
| `api-comment` | `api-report-comment.md` | Untrusted markdown body only |
| `bundle-comment` | `bundle-comment-state.json` | Trusted fixed schema: `{"schemaVersion":1,"state":"report"\|"none"\|"unavailable"}` |
| `bundle-comment` | `bundle-size-comment.md` | Untrusted markdown body only; required when the state is `report` |

`bundle-comment-state.json` is staged on **every** successful bundle-size run,
including runs with nothing to report, because a sticky comment has to be
retractable and “there is no regression” is not the same fact as “I could not
measure”. The third value, `unavailable`, covers the case where the master
baseline could not be fetched. Collapsing it into `none` would be silent and
wrong in the worst direction — a failed download would read as a clean run and
retract a regression report that is still accurate.

The state file is a fixed enumeration, not a body: it selects between three
behaviours the publisher already implements. It cannot name a repository, a pull
request, a comment, a marker or an action.

The poller and the publisher, not either artifact, own the retry state, GitHub
repository, comment markers and reconciliation action. A missing optional
artifact means “no comment update for that report,” not permission to invent a
destination. Previews remain disabled until a separate registrable domain,
storage account and CDN exist; that infrastructure is not part of #627.

The #627 queue identity is a dedicated service principal or narrowly scoped PAT
that can read PR CI build metadata/artifacts and **Queue builds** on "Babylon
Lite PR Publish", and has no permission on any other definition or Azure DevOps
resource. Store it in a protected, master-branch-controlled variable group
authorized only for #627. Do not use `System.AccessToken` to queue the
publisher: the PR CI job token uses the same project Build Service identity, so
granting it queue permission would let PR-authored YAML start a protected
publisher run on `master`.

The costs, stated rather than hidden:

- Until the stacked #627 PR is ready, API/bundle-size comments require the
  emergency manual queue. **PR 1 must not merge in that state.**
- Comments arrive a poll interval later than they used to. That is the price of
  the trigger this design refuses; the alternative was a credentialed pipeline
  whose YAML came from the pull request.
- The **label** half of the breaking-change rule moved here with the token it
  needs, so it no longer blocks a pull request by itself. The **commit-message**
  half still runs on every pull request, with no credential, in PR CI.

### The scheduled comment poller

`azure-pipelines-pr-comment-poller.yml` is the automatic half of #627. It runs
from `master` on a schedule, decides which publisher runs are missing, and queues
them. It never checks out pull-request code, never downloads a pipeline artifact,
and holds no GitHub credential that can write anything.

**It derives the desired state; it does not track it.** An earlier design scanned
"builds finished in the last seven days" and was rejected, correctly: an outage
longer than the window permanently hides the runs it spanned, and a freshly
created poller definition never sees an old-but-still-open pull request at all.
There is no watermark here and no time filter. Each tick:

1. Enumerate every **open** pull request in `BabylonJS/Babylon-Lite`, following
   `Link: rel="next"` to exhaustion. A partial listing fails the run rather than
   producing a partial reconciliation. More than 250 open pull requests fails
   visibly rather than truncating.
2. For each, ask the Builds API for the single latest **completed** run of the
   fixed PR CI definition on exactly `refs/pull/<N>/merge`, and re-verify every
   field of what comes back — definition id, `reason`, `status`, `sourceBranch`,
   `repository.type`, `repository.name` — by exact string equality.
3. Compare against what the publisher has already done, and queue what is
   missing, oldest-finished first, at most 20 per tick.

The desired state is therefore a pure function of "which pull requests are open
now" and "what is each one's latest completed run". A restart, a week of
downtime, and a brand-new definition all converge on the first tick. Obsolete
builds are ignored by construction, which is also the right semantics for a
sticky comment: only the newest result is worth showing.

**The documented boundary:** closed and merged pull requests are not enumerated,
so their comments freeze in whatever state the last processed run left them. That
is intended — a closed pull request needs no fresh report.

**Matching prior attempts.** Candidate publisher runs are found by build number,
whose format is compiled from the publisher's own parameters
(`blp-<pr>-<runId>-<rev>`). That index is treated as **untrusted**, because build
numbers are writable by anyone holding _Update build information_. It is only
ever allowed to produce candidates; it can never assert "already published". Each
candidate is then confirmed by reading the immutable queue-time triple, from the
Pipelines run representation first and the Builds representation second. If
neither carries it, **the poller fails and queues nothing**. There is deliberately
no third fallback: build _tags_ would work and are writable by the Build Service
identities pull-request YAML can reach, so a pull request could forge "already
published" and suppress its own report.

**Retry.** Per-axis job results come from the publisher run's timeline, keyed on
the `PostApiComment` and `PostBundleComment` **jobs**. `succeeded`,
`succeededWithIssues` and `partiallySucceeded` all count as published;
`skipped` does not, so an axis that was switched off is never mistaken for one
that ran. Counting `succeededWithIssues` matters more than it looks: Azure
reports it whenever a `continueOnError` step fails, and `PostApiComment` reaches
that state on every pull request that does not move the public API, because PR CI
stages the `api-comment` artifact only when there is a diff. Reading it as a
failure would re-queue the publisher on nearly every pull request, exhaust the
attempt budget, fail the tick, and duplicate the create-only API comment. A
genuinely failed axis is retried up to three times; exhaustion fails the tick
loudly, after everything else has been queued, so one broken pull request cannot
stall the rest.

**The API comment stays create-only, and stays automatic.** `GitHubComment@0`
cannot update, and #627 does not change that. What it does change is that the API
path is queued at most once per selected PR CI build, so a bundle retry no longer
duplicates it — strictly better than the manual re-queue it replaced. One
residual difference is worth knowing: if two PR CI runs for the same pull request
complete inside one poll interval, only the latest produces an API comment. Every
pull request with a completed run still gets one; what is lost is a duplicate
comment about an already-superseded state.

### The sticky bundle-size comment

`scripts/reconcile-bundle-size-comment.ts` runs in the publisher's
`PostBundleComment` job. It replaced a create-only task that added a comment on
every push and retracted none, so a reviewer could not tell which report was
current.

A comment is **canonical** when its **first line** is the marker
`<!-- babylon-lite:bundle-size:v1 {...} -->`, its author id equals the token's own
viewer id, and the marker names this repository and this pull request. First-line
anchoring is what makes the API-report comment — same bot, same pull request,
body this repository does not control — structurally unable to be adopted: its
first line is a trusted heading. The author check compares numeric ids, never
logins, because a login can be renamed and then claimed.

| measured state | existing canonical | outcome                                           |
| -------------- | ------------------ | ------------------------------------------------- |
| `report`       | none               | create exactly one                                |
| `report`       | one                | update it, or leave it alone if already identical |
| `none`         | one                | rewrite to a concise resolved state               |
| `none`         | none               | nothing — silence on never-notable pull requests  |
| `unavailable`  | anything           | nothing at all                                    |

Additional duplicates are rewritten in place to a concise tombstone whose marker
is demoted to `:v1-superseded`, which is deliberately not a prefix of the
canonical marker so it can never be re-adopted. **Nothing in this script deletes
a comment.** The token can delete any comment in the repository, including a
reviewer's, so a selection bug must not be able to destroy review history.

Two failure modes are handled explicitly because both are unbounded if they are
not:

- **A create on an incomplete listing.** If a truncated page listing hides the
  canonical comment, every tick creates another one. The enumeration must prove
  it read every page, and the reconciler refuses to create otherwise.
- **A poisoned marker.** Artifact markdown is escaped — `<!--` and `-->` become
  entities — _before_ the body is ever posted, so a comment this script owns
  cannot contain a second marker. Both artifacts are escaped: the bundle body
  in-process by the reconciler, the API body by
  `scripts/strip-logging-commands.sh`.

Where a body is nevertheless ambiguous or malformed, the script declines rather
than fails. A comment carrying two markers is skipped, not treated as fatal; a
marker whose payload is corrupt is read as "not ours"; and a staged artifact that
breaks its contract — bad JSON, an unknown schema version or state, a missing,
empty, oversized, non-UTF-8 or NUL-bearing body — is reported loudly on stderr
and treated as `unavailable`, leaving every comment untouched and the job green.

The asymmetry is the whole point. These inputs are pull-request-authored and
deterministic, so a retry cannot fix any of them: failing would burn the poller's
attempt budget for that build, and the poller escalates an exhausted budget by
failing its tick. One malformed artifact would stop bundle-size reconciliation
for _every_ open pull request. Declining costs at most one stale or duplicate
comment, which the next run resolves. Transient GitHub and Azure DevOps errors
are the opposite case and still fail hard, because for those a retry is exactly
the right response.

### Cloud browser tests run post-merge

**Pipeline:** `azure-pipelines-cloud-tests.yml`
**Trigger:** pushes to `master`, plus a nightly schedule. `pr: none`.

| Job                 | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| **Perf Regression** | Current vs baseline on BrowserStack (macOS Chrome)      |
| **Parity (Cloud)**  | Pixel-diff on BrowserStack (macOS Chrome, real WebGPU)  |
| **Publish reports** | Uploads both reports, in `checkout: none` jobs          |

These two jobs used to run in a `Cloud` stage of PR CI, holding
`BabylonJS-BrowserStack` while executing the pull request's own test code. The
justification was that a cloud browser cannot be driven without giving the tests
the account key, and that a leaked key only buys browser minutes. Both halves
were wrong. The key is long-lived, so a pull request that is never merged still
walks away with it permanently; and a BrowserStack session is a browser inside
someone else's network, which is a position to attack from rather than a metered
resource.

The credential cannot be removed from the tests, so the tests moved to where the
code they run has already been reviewed. The cost is that a cloud-browser
regression is caught after merge rather than before it. The nightly schedule and
the per-push trigger keep that window to a single commit.

The reports are still redacted before they leave the credentialed job — see
[Test Reporting](#test-reporting) — because "master code" is not the same as
"code that never prints a secret". The publish jobs then upload them with
`checkout: none`.

### Why the jobs are not in `azure-pipelines.yml`

For a pull-request build, Azure reads the pipeline definition from the pull
request:

> the YAML file that is used to run the pipeline is also a merge between the
> source and the target branch. As a result, the changes you make to the YAML
> file in source branch of the pull request can override the behavior defined by
> the YAML file in target branch.

There is no setting that makes a PR build use the target branch's YAML. So for
as long as the jobs live in `azure-pipelines.yml`, the author of the pull request
writes them — including which job holds which variable group, which job runs
`checkout: none`, and where an authenticated upload is pointed. A pull request
could add `- group: BabylonJS-Deployment` to a job that also runs its own code,
set `DEPLOYMENT_SERVER` to a host it controls, and receive `DEPLOY_TOKEN` in the
`Authorization` header of the upload. Nothing in the repository would notice,
because the repository is what was rewritten.

`System.PullRequest.IsFork` does not fix this. It only distinguishes forks — a
branch pushed to this repository is not a fork, and most of this project's pull
requests come from such branches. Microsoft documents system variables as
read-only but does not document the agent refusing a `##vso[task.setvariable]`
that shadows one for later steps, so it is also not a control you can lean on.

Repository resources, by contrast, are resolved from their pinned ref, once, at
pipeline start. Pinning the template to `refs/heads/master` means the jobs that
run are the reviewed, merged ones no matter which branch queued the build.

**And that is not the part that holds.** Pinning stops a pull request from
quietly changing what CI does; it does not stop one from deleting the `extends`
and writing its own jobs. Pipeline authorization is per **definition**, not per
file, so any resource the PR CI definition is authorized for can be asked for by
a job the pull request wrote. That is why the section below is about which
resources the definition is authorized for at all, rather than about which job
holds them.

### Protected resource matrix

Every protected resource, the definitions allowed to consume it, and the check
that enforces it. **No resource appears on both sides of the line**, which is the
property that makes the checks consistent: a required-template check refuses the
resource to any run that does not extend the named template, and a branch-control
check refuses it to any run that is not on the named ref. A pull-request run is
`refs/pull/<n>/merge`, and the master pipelines declare their stages inline
rather than extending anything — so a resource shared by both can satisfy neither
check, and would have to be left with no check at all. That was the state this
matrix replaced.

| Resource | Secret? | Allowed definitions | Check |
| --- | --- | --- | --- |
| `BabylonLite-PRCI-RepoRead` (GitHub service connection) | read-only PAT, no write scope | `azure-pipelines.yml` **only** | **Required template**: `config/templates/pr-ci.yml` @ `refs/heads/master` |
| `BabylonJS-Deployment` | yes — `DEPLOY_TOKEN`, `GITHUB_TOKEN` | `azure-pipelines-pr-publish.yml`, `-demos.yml`, `-playground.yml`, `-bundle-manifest.yml`, `-cloud-tests.yml`, `-npm-publish.yml` | **Branch control**: `refs/heads/master` only |
| `BabylonJS-CI-Infrastructure` | no secrets, but names deploy targets | `-playground.yml`, `-bundle-manifest.yml`, `-npm-publish.yml` | **Branch control**: `refs/heads/master` only |
| `BabylonJS-BrowserStack` | yes — account key | `azure-pipelines-cloud-tests.yml` **only** | **Branch control**: `refs/heads/master` only |
| `BabylonJS-NpmPublish` | yes — registry token | `azure-pipelines-npm-publish.yml`, `azure-pipelines-npm-publish-gl.yml` | **Branch control**: `refs/heads/master` only |
| `BabylonBotPAT` (GitHub service connection) | yes — comment/tag write | `azure-pipelines-pr-publish.yml`, `-npm-publish.yml`, `-npm-publish-gl.yml`, and any master pipeline calling an upload template | **Branch control**: `refs/heads/master` only |
| `BabylonLite-Trusted-RepoRead` (GitHub service connection) | read-only PAT, no write scope | `azure-pipelines-pr-comment-poller.yml` **only** | **Branch control**: `refs/heads/master` only |
| `BabylonLite-PRComments` | yes — `PR_COMMENT_TOKEN`, issue-comment write | `azure-pipelines-pr-publish.yml` **only** | **Branch control**: `refs/heads/master` only |
| `BabylonLite-PRPublishQueue` | yes — `PR_PUBLISH_QUEUE_TOKEN`, queues the publisher | `azure-pipelines-pr-comment-poller.yml` **only** | **Branch control**: `refs/heads/master` only |
| `BabylonLite-PRMetadata` | yes — `PR_METADATA_TOKEN`, read-only | `azure-pipelines-pr-comment-poller.yml` **only** | **Branch control**: `refs/heads/master` only |

Reading the table:

- **`BabylonLite-PRCI-RepoRead` is the only resource a pull-request build
  touches.** It is what the `trusted` repository resource needs in order to fetch
  the pinned template. Its PAT must have **read** access to this repository and
  nothing else — no contents write, no issue or PR write, no deployment. A pull
  request that rewrites the entry point and asks for it is handed read access to
  a repository it is already reading, which is why the required-template check on
  it is defence in depth rather than the thing standing between a pull request
  and a credential.
- **A required-template check is possible here only because the consumer set is
  exactly one definition, and that definition extends the template.** It was
  impossible on `BabylonJS-Deployment` and `BabylonBotPAT` for as long as PR CI
  consumed them, because the master pipelines consume them too and would have
  been refused them outright.
- **Branch control is the enforceable half everywhere else.** A run queued from
  another ref executes that ref's YAML and can delete any condition written in
  this repository, but it cannot make the server hand it a group.
- `BabylonJS-CI-Infrastructure` holds no secret, but it names the storage
  accounts and CDN profiles uploads are aimed at, so it stays on the master side
  with the tokens that reach them.

`tests/lite/unit/pr-pipeline-credential-isolation.test.ts` walks `extends` and
`template:` from the entry point to compute the PR-reachable file set, and fails
if any file in it names a resource from the master rows, imports any variable
group, or names any service connection other than `BabylonLite-PRCI-RepoRead`. It
also fails if a master-only definition names that connection, or if any group or
connection appears in both sets.

### CI/CD Secret Handling

Four rules, all enforced by
`tests/lite/unit/pr-pipeline-credential-isolation.test.ts`:

0. **The pull-request definition is authorized for nothing that matters.** The
   entry point, the pinned template and every template they include name no
   variable group, no deploy credential and no write-capable service connection —
   only `BabylonLite-PRCI-RepoRead`. The reachable set is computed by following
   `extends` and `template:`, not listed, so a new include is inspected rather
   than trusted.
1. **The entry point defines nothing.** No job, no step, no group, no credentialed
   service connection — only the trigger and the pinned `extends`. The repository
   resource must carry an explicit `ref: refs/heads/master`; without one it
   follows the default branch, which is the right branch by accident and
   silently the wrong one if the default ever changes.
2. **No credential is in scope for a job that checks out the pull request.** No
   variable group, no `GITHUB_TOKEN`, no `System.AccessToken`, no
   `gitHubConnection`, and no `persistCredentials` — that last one leaves the
   build's OAuth token in `.git/config`, where every later step in the job,
   including a dependency's install script, can read it. **There is no
   exception.** `BabylonJS-BrowserStack` used to be one; it is now banned from
   the entry point and the pinned template by name, not merely as a `- group:`
   line, so mapping `BROWSERSTACK_ACCESS_KEY` by hand fails the guard too.
   Beyond those named shapes the guard refuses **any credential-shaped name** —
   `…TOKEN`, `…SECRET`, `…PASSWORD`, `…ACCESS_KEY`, `…API_KEY`, `…CREDENTIAL`,
   `BROWSERSTACK…`, `…_PAT` — appearing as a key, as a `- name:` declaration or
   as a `$(…)` / `${{ … }}` dereference in such a job. That is the general form
   of the rule: the BrowserStack key reached PR code as an `env:` mapping, which
   none of the four named shapes covers, so a credential invented tomorrow is
   denied by default rather than until someone remembers to add it to a list.
3. **Privileged work runs in a definition a pull request cannot trigger.** Every
   upload happens in a `checkout: none` job in a `pr: none` pipeline, consuming a
   pipeline artifact; the two jobs that need repository code with a credential in
   scope (`Release Markers (labels)`, `Post PR Comments`) check out the pinned
   master resource instead. A gate flag set by a repository script —
   `ArtifactsSafe` — is not a substitute, because PR code can set it too; it may
   gate artifact publication and nothing else.

Untrusted *content* still crosses the boundary: the API-report and bundle-size
comment bodies are written by jobs running PR code, in a different run.
`PostApiComment` in `azure-pipelines-pr-publish.yml` runs its body through
`scripts/strip-logging-commands.sh`, which neutralises every `##vso[` and `##[`
sequence before the body is loaded into a variable — otherwise a comment body
could issue logging commands inside the job that holds the GitHub connection.
That script also escapes `<!--` and `-->` to entities, because the sibling
bundle-size comment is identified by a hidden marker on its first line and both
comments are posted by the same bot: without the escaping a pull request could
open its API report with a byte-exact copy of that marker and have the trusted
reconciler adopt and overwrite the wrong comment. Real API reports contain no
HTML comments, and `ci-log-command-injection.test.ts` proves a representative
report survives the script byte for byte, so the escaping changes no live body.

`PostBundleComment` carries no such step: it runs under `settableVariables:
none` and never loads artifact bytes into a variable at all, reading the files
from disk and sanitising in-process instead. Both jobs use the agent-enforced
`target.commands: restricted`, with `settableVariables` pinned per job to
exactly the names that job sets. The string neutraliser and the agent
restriction are independent controls.

The upload templates allowlist their deploy paths, pin `curl` to `https` with no
redirect following, and pass `DEPLOY_TOKEN` via `env:` so it never reaches a
command line. An https URL on its own is not a destination check: an attacker's
host serves https too.

The destination host is checked against `allowedDeployHosts`, a **template
parameter**, not a variable. Parameters are expanded when the run is compiled,
before any step executes, so no `##vso[task.setvariable]`, no queue-time override
and no variable-group edit can add a host to the list. That is the difference
from the `DEPLOY_HOST_ALLOWLIST` variable it replaces: a variable is something a
run can be talked into changing.

The same applies to *which* pull request is written to.
`azure-pipelines-pr-publish.yml` takes `prNumber`, `prCiRunId` and
`prCiDefinitionId` as `type: number` parameters, validates the referenced build's
definition, PR merge ref and fixed repository through the Azure Build API, and
builds the comment id and artifact-download inputs from those parameters.
Nothing inside a downloaded artifact can redirect a comment.

`allowedDeployHosts` ships **empty**, because the Babylon deployment host is not
public and cannot be committed by anyone without access to
`BabylonJS-Deployment`. Until an administrator fills it in
([see below](#settings-that-repository-files-cannot-enforce)):

- PR preview publishing stays disabled. A preview artifact contains unreviewed
  JavaScript and must not be served from a production origin. Provisioning its
  separate origin is blocked infrastructure work outside this change.
- Trusted master-only uploads fall back to the `DEPLOY_HOST_ALLOWLIST` variable
  with a warning. Those jobs run no repository code at all, so there is no step
  that could have rewritten it. The host is still parsed the same way the
  templates parse it — an `https://` scheme, no embedded userinfo, and no
  character that is not valid in a host or port — so
  `https://real-host@attacker.invalid/` is refused even with no allowlist to
  compare it against. `azure-pipelines-bundle-manifest.yml` performs its own
  upload rather than calling a template, and applies the same parse.

#### Credentials leave the job with the job

Three rules about *how* a credentialed job holds its secret, each enforced by a
clause in `tests/lite/unit/pr-pipeline-credential-isolation.test.ts` or
`tests/lite/unit/pipeline-secret-hygiene.test.ts`:

1. **No credential is passed as a command-line argument.** A command line is not
   private: `/proc/<pid>/cmdline` is world-readable, `ps` prints it, and agent
   diagnostics collect it. `scripts/browserstack-wait.sh` used to poll the
   BrowserStack plan API with `curl -u "$USER:$ACCESS_KEY"`; it now feeds curl
   the same setting on stdin with `curl --config -`. `env:` and stdin are the
   channels; an argument is not one.
2. **npm publishes with a job-scoped npmrc.** Both publish pipelines create
   `$(Agent.TempDirectory)/npm-publish-<build>.npmrc` under `umask 077` — so it
   is `0600` before the token is written into it, not after — pass it to `npm
   publish` with `--userconfig`, and remove it in an `EXIT` trap. Nothing is
   written to `~/.npmrc`, which would outlive the step and, on a self-hosted
   agent, the build.
3. **Artifact content is constrained before it can act as a command.** The
   publish jobs read a version and a tarball path out of an artifact staged by
   the job that ran repository code, and echo them into
   `##vso[task.setvariable]`. The agent obeys any logging command that starts a
   line of step output, so those values are matched against a whole-value
   pattern with bash's `[[ … =~ ]]` first. `grep -Eq '^…$'` is not sufficient
   and is rejected by the guard: grep matches when *any* line matches, so it
   accepts `1.2.3\n##vso[task.prependpath]…`.

The same rule covers test output. `scripts/report-test-results.ts` copies a
JUnit test title and failure message into `##vso[task.logissue]` annotations,
and a JUnit `name="…"` attribute may contain a raw newline — so a test titled
`ok\n##vso[task.setvariable …]` used to be executed rather than reported. Every
interpolated value now goes through a neutraliser that puts it on one line and
defangs `##vso[` / `##[`. `tests/lite/unit/ci-log-command-injection.test.ts`
asserts that both that script and `scripts/strip-logging-commands.sh` emit only
the logging commands they compose themselves — and that they still report the
test, so the fix cannot be silence.

#### Credentialed pipelines run only from the protected ref

`pr: none` and a `- master` branch filter describe a pipeline's *automatic*
triggers. Neither says anything about a **manual queue**, which may name any ref
— and Azure reads the pipeline definition from the ref being built, so a run
queued from another branch executes that branch's YAML.

Every job that holds a credential outside PR CI therefore also carries:

```yaml
condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/master'), ne(variables['Build.Reason'], 'PullRequest'))
```

The full ref, not `Build.SourceBranchName`: that variable is the last path
segment, so a tag named `master`, or a branch named `heads/master`, satisfies a
check written against it while being a different ref. A guard clause rejects
`Build.SourceBranchName` in a condition anywhere.

This condition is not by itself the control — a run from another ref could
simply not have it, because it is that ref's YAML that runs. It is what states
the rule for every run still executing master's definition; the enforceable half
is the **branch-control check** on each protected resource, listed below.

#### Changing CI

Because the template is pinned, edits to `config/templates/pr-ci.yml` take effect
only once they are on `master`. A pull request that changes it will not see its
own changes run — that is the point. To try a change first, queue a **manual**
run of the pipeline from your branch with the `trusted` resource's ref overridden
to that branch. A manual run is not a pull-request run, is subject to the same
checks, and grants no additional access.

#### Settings that repository files cannot enforce

The design above stops a pull request from *quietly* taking a credential, and —
once the authorizations below are removed — from loudly taking one either. What
no file in this repository can do is remove those authorizations: pipeline
permissions and resource checks are configured in Azure DevOps and
[cannot be modified from YAML](https://learn.microsoft.com/azure/devops/pipelines/process/approvals):

> Approvals and other checks aren't defined in the yaml file. Users modifying the
> pipeline yaml file can't modify the checks performed before start of a stage.

An administrator must configure all of the following. Until they do, the
protections above are conventions rather than controls. The
[Protected resource matrix](#protected-resource-matrix) is the summary; this is
the order to do it in.

This pull request must remain **draft and blocked from merge** until all three
conditions hold:

1. the resource authorizations, checks, pipeline definitions, security settings
   and credential rotations below are complete;
2. the same-repository pinned-template shape has passed the empirical validation
   in step 8; and
3. the stacked #627 scheduled poller and sticky-comment reconciliation are ready
   and validated against the publisher contract above.

- **1. Create `BabylonLite-PRCI-RepoRead`, and repoint the PR CI definition at
  it.** A GitHub service connection whose PAT can **read** this repository and do
  nothing else: no contents write, no issues or pull-requests write, no
  deployment. `azure-pipelines.yml` names it as the `endpoint:` of its `trusted`
  repository resource. Authorize it for the **PR CI definition only**. Until it
  exists, PR CI cannot resolve its pinned template and every pull-request build
  fails at startup — which is the loud failure mode, and the right one.
- **2. Remove every other resource authorization from the PR CI definition.**
  This is the change that closes the finding, and no file in this repository can
  make it. In *Pipelines → the PR CI definition → Security / resource
  authorization*, and on each resource's **Pipeline permissions**, revoke
  `BabylonJS-Deployment`, `BabylonJS-CI-Infrastructure`, `BabylonJS-BrowserStack`,
  `BabylonJS-NpmPublish` and `BabylonBotPAT`. While any of them remains
  authorized, a pull request that deletes the `extends` line and writes its own
  job is handed it — the YAML in this repository is not what is being consulted.
  Do **not** enable "Grant access permission to all pipelines" on any of them.
- **3. Required template check on `BabylonLite-PRCI-RepoRead`.** Requiring
  `config/templates/pr-ci.yml` from this repository at ref `refs/heads/master`.
  A run whose YAML does not extend that exact template at that exact ref is
  refused the connection before its stage starts, so a rewritten entry point
  cannot even fetch the pinned ref through it. The check is possible here, and
  only here, because this resource has exactly one consumer and that consumer
  extends the template. It is defence in depth rather than the load-bearing
  control: the connection is read-only, so a pull request that obtained it would
  gain read access to a repository it is already reading. Microsoft documents
  the repository/ref/path fields but not the exact ref-matching algorithm; do
  not treat this check as a substitute for step 2's resource separation.
- **4. Branch control on every other resource, `refs/heads/master` only.** On
  `BabylonJS-Deployment`, `BabylonJS-CI-Infrastructure`, `BabylonJS-BrowserStack`,
  `BabylonJS-NpmPublish` and the `BabylonBotPAT` service connection, add a
  **Branch control** check allowing only `refs/heads/master`, with "Verify branch
  protection" enabled. A pull-request run is `refs/pull/<n>/merge` and can never
  satisfy it. Nothing legitimate is blocked, because after step 2 no
  pull-request definition consumes any of them. Do **not** add a required-template
  check to these: the master pipelines declare their stages inline rather than
  extending anything, so it would refuse them the resource and break master. Each
  credentialed job already carries the matching YAML condition
  ([above](#credentialed-pipelines-run-only-from-the-protected-ref)), but a run
  queued from another ref executes that ref's YAML and can simply omit it —
  branch control is the half a rewritten YAML cannot reach.
- **5. Enable the organization/project pipeline security settings.** In both
  *Organization settings → Pipelines → Settings* and
  *Project settings → Pipelines → Settings*, enable **Limit job authorization
  scope to current project**, **Protect access to repositories in YAML
  pipelines**, and **Limit variables that can be set at queue time**. The first
  two bound `System.AccessToken` to the current Azure DevOps project and declared
  Azure Repos resources; they do not narrow the external GitHub PAT/service
  connections, which are controlled separately above.
- **6. Deny the PR job token permission to queue protected definitions.** A pull
  request can replace the outer YAML, map `$(System.AccessToken)`, and call the
  Builds Queue REST API. Project scoping alone does not remove **Queue builds**:
  if the project Build Service identity can queue a credentialed definition on
  `refs/heads/master`, that new run satisfies branch control and receives the
  definition's protected resources. On every credentialed definition — the PR
  publisher, cloud tests, npm publishers, playground, demos, bundle manifest and
  the #627 comment poller — explicitly **Deny Queue builds**, **Update build
  information** and **Edit build quality** to `<Project> Build Service (<Org>)`
  and `Project Collection Build Service (<Org>)`. Keep build-read permission only
  where artifact download/provenance validation needs it.

  The last two verbs matter as much as the first. The poller finds prior publish
  attempts by build number and confirms them against queue-time parameters; both
  build numbers and build tags are _mutable_ by an identity holding those
  permissions. Leaving them at their Allow-by-default state would let
  pull-request-authored YAML rewrite publish history — not to publish anything,
  but to make the poller believe a comment had already been posted, and so
  suppress its own bundle-size report.

  Before merge, run a temporary PR CI step that authenticates with its job token
  and attempts, for each protected definition on `master`, to queue a build, to
  update build information, and to set build quality; **all three** must return
  403. The #627 poller uses the dedicated queue identity described above, never
  the project Build Service identity.
- **7. Gate untrusted fork builds on a team member.** In the PR CI definition's
  *Triggers → Pull request validation → Forks* settings, keep **Make secrets
  available to builds of forks** and **Make fork builds run with the same
  permissions** disabled, and set **Require a team member's comment before
  building a pull request** to at least *On pull requests from non-team
  members*. PR CI should hold no secret after this migration, but the approval
  still prevents unauthenticated users from spending hosted agents immediately.
- **8. Rotate every credential exposed by the old definition.** Do not copy the
  existing values into the new boundary. Rotate `GITHUB_TOKEN`, `DEPLOY_TOKEN`,
  `BROWSERSTACK_ACCESS_KEY`, the PAT backing `BabylonBotPAT`, and the old npm
  token. Any same-repository pull request could previously execute code in jobs
  where the first four were in scope; the npm token was an unprotected
  pipeline-level UI variable on definitions queueable from arbitrary refs.
- **9. Empirically validate the same-repository pinned template before merge.**
  Microsoft documents a pinned `ref` for *other* repository resources and
  documents `self` as following the triggering commit, but does not document the
  same GitHub repository declared again under a different resource alias — the
  exact shape used here. Because `config/templates/pr-ci.yml` is not yet on
  `master`, create a temporary protected validation ref containing this commit,
  configure a temporary required-template check for that ref, and queue a PR
  validation whose outer YAML tries to replace a marker `displayName`. Confirm
  that the marker from the protected template is the one Azure compiles and the
  source-branch marker does not appear. Delete the temporary ref/check
  afterwards. A loud startup failure is acceptable; silently compiling the PR's
  template is not.
- **10. Create the `azure-pipelines-pr-publish.yml` pipeline definition.** Name it
  "Babylon Lite PR Publish". Authorize `BabylonJS-Deployment` and
  `BabylonBotPAT` for it. Note its **definition
  id** and the **PR CI definition id** — maintainers pass the latter as
  `prCiDefinitionId` only for emergency/debug runs; #627 configures the same id
  as its fixed poll target. Record both in the team's runbook. Do **not** add a
  `resources.pipelines` completion trigger from PR CI to it: the two share a
  repository, so Azure would run it on the triggering run's branch — the pull
  request's own merge ref — with both protected resources in scope. Keep this
  change draft until the stacked #627 scheduled poller is ready.
- **11. `GITHUB_TOKEN` must live in a protected variable group.** A variable
  defined in the pipeline's UI **is not a protected resource**, so no check
  applies to it and every job in the definition can read it. `Release Markers
  (labels)` in the publisher reads it from `BabylonJS-Deployment`; any
  pipeline-level UI variable of the same name must be **deleted**, on the PR CI
  definition above all.
- **12. `allowedDeployHosts` must be filled in, in both upload templates.** This is
  the one change this work could not make: the exact deployment host is not
  public and appears nowhere in this repository. Add the `host[:port]` literals
  to the `allowedDeployHosts` parameter default in **both**
  `config/templates/upload-static-site.yml` and
  `config/templates/upload-test-report.yml` — a unit test requires the two lists
  to be identical, so a half-done edit fails CI rather than leaving one template
  open. PR previews do not use this path — they remain disabled. Because this is
  a compile-time parameter, changing it is a reviewed commit to `master`, which
  is the property that makes it stronger than the variable it replaces.
- **13. `DEPLOY_HOST_ALLOWLIST` should be set** in `BabylonJS-Deployment`, to a space-
  or comma-separated list of the same values. It is now only the fallback for
  trusted master-only uploads, used while `allowedDeployHosts` is empty. Once
  `allowedDeployHosts` is populated it is ignored entirely, and can be deleted.
- **14. Create the `azure-pipelines-cloud-tests.yml` pipeline definition.** The file
  is merged but a YAML file is not a pipeline until someone creates a definition
  pointing at it. Until it exists, perf and parity-cloud do not run anywhere —
  they no longer run in PR CI. Authorize `BabylonJS-BrowserStack` for this
  definition and for nothing else.
- **15. `BabylonBotPAT` must be authorized for the npm-publish pipelines.** Both
  publish pipelines create their release tag with `GitHubRelease@1` through that
  service connection, instead of `git push` from a checkout carrying persisted
  credentials. If the connection is not authorized for those definitions, tagging
  fails at the last job — after the packages are already on npm.
- **16. Create `BabylonJS-NpmPublish`, and delete the old `NPM_TOKEN` UI variable.**
  Both publish pipelines now import the protected variable group
  `BabylonJS-NpmPublish` inside their `PublishToNpm` job only, and read the
  credential as **`NPM_PUBLISH_TOKEN`** — a deliberately new name. In order:

  1. **Create the group.** `BabylonJS-NpmPublish`, with a single variable
     `NPM_PUBLISH_TOKEN`, **marked secret**, holding a granular, publish-only npm
     token scoped to `@babylonjs/lite`, `@babylonjs/lite-compat` and
     `@babylonjs/lite-gl`. Scoping the token to those packages bounds what a
     failure of the publishing boundary would be worth. The credential is used
     only in a `checkout: none` job that runs `npm publish --ignore-scripts` on a
     tarball built by an earlier, credential-free job, through a `0600` npmrc in
     the agent's temp directory that is deleted when the step ends.
  2. **Delete the old pipeline UI variables, and rotate the token.** Remove
     `NPM_TOKEN` from the pipeline-level variables of **both** the
     `azure-pipelines-npm-publish.yml` and `azure-pipelines-npm-publish-gl.yml`
     definitions, and issue a **new** npm token for the group rather than copying
     the old value across. The old one was readable by every job in those
     definitions — including a job written by a manually queued run of an
     arbitrary branch, whose YAML is that branch's YAML — so treat it as exposed.
     The rename is what makes this step checkable: nothing reads `NPM_TOKEN` any
     more, so a forgotten UI variable cannot quietly keep publishing working
     while the group is missing, misnamed or unauthorized. Both jobs refuse to
     publish when `NPM_PUBLISH_TOKEN` is empty **or** still the unsubstituted
     macro text, which is what an out-of-scope variable resolves to.
  3. **Authorize the group for exactly the two publish definitions.** The
     pipelines built from `azure-pipelines-npm-publish.yml` and
     `azure-pipelines-npm-publish-gl.yml`, and nothing else. Do **not** enable
     "Grant access permission to all pipelines" — that setting turns the group
     back into the ambient credential the UI variable was.
  4. **Branch control, `refs/heads/master` only.** Add a **Branch control** check
     on the group allowing only `refs/heads/master`, with "Verify branch
     protection" enabled. This is the enforceable half of the job conditions
     ([above](#credentialed-pipelines-run-only-from-the-protected-ref)): a run
     queued from another ref executes that ref's YAML and can delete the
     condition, but it cannot make the server hand it the group. Every
     legitimate run of both publish pipelines is a master run, so nothing that
     should work is blocked.
  5. **No required-template check on this group — yet.** A required-template
     check refuses the resource to any run that does not `extends` the named
     template, and neither publish pipeline is written that way; adding one today
     would break releases rather than protect them. Branch control is strictly
     stronger for a resource whose every legitimate run is from
     `refs/heads/master`. If either publish pipeline is later converted to the
     shell-plus-pinned-template shape `azure-pipelines.yml` uses, add a Required
     template check naming that template at ref `refs/heads/master` at the same
     time.
  6. **No queue-time override.** `NPM_PUBLISH_TOKEN` must not be settable at
     queue time, and the group must not allow users to override its values when
     running a pipeline. A queue-time override re-creates exactly the
     unprotected, caller-supplied variable this replaced.
- **17. Fork secrets stay off.** "Make secrets available to builds of forks" and
  "Make fork builds run with the same permissions" must both be disabled.
  Enabling either hands every secret above to fork-authored code.
- **18. Queue-time overrides stay off.** `DEPLOYMENT_SERVER`, `DEPLOY_ENDPOINT_UPLOAD`,
  `DEPLOY_HOST_ALLOWLIST`, `STORAGE_ACCOUNT`, `TOOLS_STORAGE_ACCOUNT` and
  `SERVE_DOMAIN` must not be settable at queue time.
- **19. The `endpoint:` on the repository resource must exist.** The `trusted`
  resource in `azure-pipelines.yml` names `BabylonLite-PRCI-RepoRead`, and the
  one in `azure-pipelines-pr-publish.yml` names `BabylonBotPAT`. If either name
  is wrong the pipeline fails at startup, so confirm both before merging a change
  to them. They must stay **different** connections: the read-only one carries a
  required-template check that the publisher, which declares its stages inline,
  could not satisfy.
- **20. Credentials are least-privilege and rotated.** `BabylonLite-PRCI-RepoRead`
  should be able to read this repository and nothing else; `DEPLOY_TOKEN` should
  be write-only to its storage paths; the `BabylonBotPAT` service connection
  should be limited to posting issue comments and creating releases;
  `GITHUB_TOKEN` should be a read-only, fine-grained token scoped to this
  repository's pull-request metadata; `NPM_PUBLISH_TOKEN` should be a granular
  token that can publish the three published packages and nothing else. Rotate
  all of them on a fixed schedule and after any suspected exposure.
- **21. Secret variables are marked secret.** A plain variable is written into the
  build environment and into logs; only variables marked secret are masked and
  withheld from fork builds.
- **22. Create the `BabylonLite-PRComments` group.** One secret variable,
  `PR_COMMENT_TOKEN`: a fine-grained GitHub token scoped to
  `BabylonJS/Babylon-Lite` with **Issues: read and write** and nothing else.
  Authorize it to `azure-pipelines-pr-publish.yml` only, mark it secret, add
  branch control for `refs/heads/master`, and do not allow it to be overridden at
  queue time. It is a new token rather than a widening of `GITHUB_TOKEN` because
  that one lives in `BabylonJS-Deployment` — widening it would hand
  comment-write to every other consumer of that group — and rather than an
  extraction of `BabylonBotPAT`, which is a service connection whose credential
  is deliberately opaque to scripts.
- **23. Create the dedicated queue identity and the
  `BabylonLite-PRPublishQueue` group.** Create a service principal or PAT that
  holds **Queue builds** and **View builds** on the PR publisher definition,
  **View builds** on the PR CI definition, and no permission on any other
  definition or resource. Store it as the secret variable
  `PR_PUBLISH_QUEUE_TOKEN`, authorize the group to
  `azure-pipelines-pr-comment-poller.yml` only, and apply the same secret,
  branch-control and no-queue-time-override settings. This identity exists so the
  poller never queues with `System.AccessToken`: that token belongs to a Build
  Service identity pull-request YAML can also reach, and item 6 denies it queue
  permission precisely so a pull request cannot start a credentialed run.
- **24. Create the `BabylonLite-PRMetadata` group.** One secret variable,
  `PR_METADATA_TOKEN`: a fine-grained GitHub token scoped to
  `BabylonJS/Babylon-Lite` with **Pull requests: read** and **Metadata: read**,
  and no write permission of any kind. Same authorization and branch control as
  above. This is a read-only GitHub credential living in trusted, master-pinned,
  PR-unreachable code, and it is a deliberate trade: the alternative was a
  time-windowed build scan that silently loses runs across an outage. Verify it
  has no write scope before storing it — that property is the whole argument for
  putting it there.
- **25. Create the `BabylonLite-Trusted-RepoRead` service connection.** A
  read-only GitHub connection used by the poller's pinned `checkout: trusted`.
  Not `BabylonLite-PRCI-RepoRead`, which is the one connection PR CI is
  authorized for and must not be shared with a credentialed definition; not
  `BabylonBotPAT`, which can write.
- **26. Create the poller definition and record the definition ids.** Create a
  pipeline from `azure-pipelines-pr-comment-poller.yml` on `master`, authorize it
  for the two groups above and the connection from item 25, and set its
  `PR_CI_DEFINITION_ID`, `PUBLISHER_DEFINITION_ID` and `POLLER_DEFINITION_ID`
  variables to the real ids. They are pipeline configuration rather than
  something the poller derives at runtime: deriving them from a build it had just
  read would let the thing being inspected choose which pipeline gets queued.
  After the first scheduled run, confirm in its log that the queue-time triple was
  resolved from an authoritative representation — if neither the Pipelines run
  nor the Builds representation exposes `templateParameters`, the poller fails
  closed and queues nothing, and that must be resolved before this is relied on.

### Required Pipeline Variable Groups

Azure Pipelines uses `BabylonJS-BrowserStack` for shared BrowserStack
credentials, in `azure-pipelines-cloud-tests.yml` and nowhere else:

- `BROWSERSTACK_USERNAME`
- `BROWSERSTACK_ACCESS_KEY`

It uses `BabylonJS-Deployment` for deployment server credentials, used when
uploading static sites and failed Playwright HTML reports. Master-only: no
pull-request-triggered definition may be authorized for it.

- `DEPLOYMENT_SERVER`
- `DEPLOY_TOKEN`
- `DEPLOY_ENDPOINT_UPLOAD`
- `DEPLOY_HOST_ALLOWLIST` — exact `host[:port]` values uploads may reach.
  Fallback only, for trusted master-only uploads, and only while the
  `allowedDeployHosts` template parameter is still empty
- `GITHUB_TOKEN` — read-only PR metadata, read by `Release Markers (labels)` in
  `azure-pipelines-pr-publish.yml`

It uses `BabylonJS-CI-Infrastructure` for the storage accounts and CDN profiles
that uploads target. Master-only, for the same reason:

- `SNAPSHOTS_STORAGE_ACCOUNT` — snapshots account, used by
  `azure-pipelines-bundle-manifest.yml` for the bundle-size baseline
- `TOOLS_STORAGE_ACCOUNT` — tools account backing `liteplayground.babylonjs.com`
- `CDN_PROFILE_TOOLS`

It uses `BabylonJS-NpmPublish` for the npm registry credential, imported by the
`PublishToNpm` job of `azure-pipelines-npm-publish.yml` and
`azure-pipelines-npm-publish-gl.yml` and by no other job in either file:

- `NPM_PUBLISH_TOKEN` — granular, publish-only npm token for `@babylonjs/lite`,
  `@babylonjs/lite-compat` and `@babylonjs/lite-gl`

The name is new on purpose. The publish jobs previously read `$(NPM_TOKEN)` and
imported no group at all, so that value could only have come from a
pipeline-level UI variable — not a protected resource, readable by every job in
the definition, and handed just as freely to a run queued manually from any
branch, whose YAML is that branch's YAML. Had the group simply exported
`NPM_TOKEN`, a surviving UI variable of that name would have kept publishing
working whether or not the group existed, hiding the misconfiguration the move
exists to surface. Both jobs now fail closed when `NPM_PUBLISH_TOKEN` is empty
_or_ still the unsubstituted macro text an out-of-scope variable resolves to.

It uses three groups introduced by issue #627, which restored _automatic_
bundle-size comments after pull-request CI lost every write credential. They are
deliberately three groups rather than one: the poller decides _when_ to publish
and the publisher decides _what_ to write, and neither should be able to do the
other's job.

`BabylonLite-PRComments` is imported by the `PostBundleComment` job of
`azure-pipelines-pr-publish.yml` and by no other job in any definition:

- `PR_COMMENT_TOKEN` — fine-grained GitHub token, `BabylonJS/Babylon-Lite` only,
  **Issues: read and write** and nothing else. It exists because the sticky
  comment must list, update and demote comments, and `GitHubComment@0` is
  create-only with its credential opaque to scripts. It is not `GITHUB_TOKEN`
  from `BabylonJS-Deployment`: that one is documented above as read-only PR
  metadata, and widening it would hand comment-write to every other consumer of
  that group.

`BabylonLite-PRPublishQueue` and `BabylonLite-PRMetadata` are imported by
`azure-pipelines-pr-comment-poller.yml` and by nothing else:

- `PR_PUBLISH_QUEUE_TOKEN` — a dedicated Azure DevOps identity holding
  `Queue builds` and `View builds` on the publisher and `View builds` on PR CI,
  and no other permission anywhere. The ambient job token is deliberately not
  used to queue: it belongs to a Build Service identity that pull-request YAML
  can also reach, and runbook item 6 denies that identity `Queue builds` on the
  publisher precisely so a pull request cannot start a credentialed run.
- `PR_METADATA_TOKEN` — fine-grained GitHub token, `BabylonJS/Babylon-Lite` only,
  **Pull requests: read** and **Metadata: read**, no write of any kind. This is a
  read-only GitHub credential in trusted, master-pinned, PR-unreachable code, and
  it is a deliberate trade: the alternative was scanning "builds from the last N
  days", which silently loses runs across an outage and never sees an
  old-but-still-open pull request at all. Enumerating the open pull requests
  needs no watermark and cannot skip a run.

This third group is easy to miss. It was **omitted from this list until the
bundle-manifest pipeline failed on it**, even though the PR CI template,
`azure-pipelines-playground.yml` and `azure-pipelines-npm-publish.yml` had all
three been importing it all along. (PR CI imports nothing now — its credentialed
half is `azure-pipelines-pr-publish.yml`.)
`azure-pipelines-cloud-tests.yml` imports `BabylonJS-BrowserStack` in its test
jobs and `BabylonJS-Deployment` in its `checkout: none` report-upload jobs, never
both in one job. A pipeline that needs a storage account and
declares only the first two groups will not fail at parse time — see the trap
described below.

### Never copy a command out of a build log

Azure masks secret values in build logs as a run of asterisks. If you copy a
`curl` line out of a log to reproduce it, you copy the mask, and pasting it back
into a pipeline produces a header that still _looks_ like a header while
carrying no credential at all.

This is not hypothetical. The bundle-manifest publish step shipped with a
literal asterisk run where the bearer token belonged, and it survived review for
weeks, because it is close to invisible: a code-review diff redacts the value of
an `Authorization` header to asterisks whether the file holds a real token
reference or a mask, so both render identically. It reads as correct in every
view except the raw bytes.

It was also a _second_, independent cause of the same 401 that the storage
account produced — so fixing one of the two would have left the symptom
unchanged and the remaining cause looking disproven.

`tests/lite/unit/pipeline-secret-hygiene.test.ts` guards this. Read what it
actually asserts before relying on it, because each clause is narrower than the
obvious phrasing, deliberately:

- It rejects a **mask in value position for a credential** — an all-asterisk
  token following an auth header, `token=`, `password:` or similar. Not any
  asterisk run, and not any asterisk token either: `echo "a***b"`,
  `dist/**/*` and log banners such as `displayName: "*** Publish ***"` are
  legitimate and must keep passing. A guard that fails on correct code gets
  deleted rather than debugged, and this invariant is one whose violation is
  invisible. Forms carrying a credential with no separator (`curl -u`) are a
  known gap.
- Every `Authorization:` header must **interpolate some variable**. This is the
  universal clause and it holds in any CI dialect. Header names are matched
  case-insensitively, because HTTP header names are: a hardcoded credential in
  a lowercase `authorization:` once passed every clause, differing from a
  caught one by a single letter. Commented examples are excluded so documented
  prose is not read as a live header. The mask passed every earlier
  check precisely because it still resembled a header.
- Azure pipelines and their step templates must additionally reference
  `DEPLOY_TOKEN`. This one is **not** applied repo-wide: the GitHub Actions
  workflow authenticates with `Basic ${AUTH}`, which is correct, and demanding
  `DEPLOY_TOKEN` of it would be a misfire. It is a **trace** through the
  assignments in the header's own file, not a match on the header line: the
  token takes one escaping hop before it reaches the header, and a single-line
  pattern would call the correct form a violation.
- No credential may sit in **argument position**. A command line is not
  private — `/proc/<pid>/cmdline` is world-readable, `ps` prints it, and agent
  diagnostics collect it — so `env:` and stdin are the only channels. This
  started as a `curl -u` clause keyed on the flag name, which is why it watched
  all four uploads spend a live deploy token on
  `-H "Authorization: ${DEPLOY_TOKEN}"` without a word: `-u` was the specimen,
  not the property. It now reads any payload-carrying flag (`-H`, `-d`, `-F`
  and their long spellings) whose value interpolates a credential. Literal
  headers such as `-H "Content-Type: multipart/form-data"` still pass, which is
  what keeps the clause alive.
- Every `Authorization:` header in an Azure pipeline must be **fed to curl
  through `--config`**. This is the positive counterpart to the clause above:
  that one says where the token must not be, this one says where it must be.
  They fail on different mutations — reverting to `-H` trips both, but hoisting
  the emitter into a shell function keeps the token out of argv while silently
  detaching it from the request, and only this clause sees that. A detached
  emitter sends no credential at all and the deployment server answers 401,
  which reads like a server problem rather than a pipeline one.

The four authenticated uploads therefore look like this. The escaping is not
optional: a curl config value is a quoted string, so a token containing a
backslash or a double quote would end the value early and send a truncated
header.

```bash
token_escaped=${DEPLOY_TOKEN//\\/\\\\}
token_escaped=${token_escaped//\"/\\\"}

printf 'header = "Authorization: %s"\n' "$token_escaped" |
curl "${DEPLOYMENT_SERVER}/${DEPLOY_ENDPOINT_UPLOAD}" --config - --fail-with-body ...
```

`printf` is a bash builtin, so the token never becomes another process's argv
either. Keep the emitter immediately above the `curl` that consumes it rather
than hoisting it into a helper: the guard folds the two into one logical
command, and a function call puts them where nothing can check that they still
belong together.

The subject is every `azure-pipelines*.yml`, every file under
`config/templates/`, and every file under `.github/workflows/` — 5
`Authorization:` headers today, four of them config-fed uploads. The first version read the repo root alone and
so covered 7 of them, while claiming the pipelines; the three it missed were the
`curl` uploads in the shared templates, which `azure-pipelines.yml` includes at
four call sites and which therefore run on every PR. If you add a CI file
somewhere else, add its directory to that list — and you do not have to
remember to: the same test walks the repo for anything its clauses examine, an
`Authorization:` header **or** a masked value, and fails naming any file its
roots do not reach. Documentation text is blanked before either clause reads a
line — a `description:` explaining that a token "appears as `Authorization:
Bearer ******`" is correct content in a file the guard must read, and the line
was in scope, collected, and matched correctly; it simply was not a header.
Issue templates are excluded by category rather than by key, because `value:`
holds prose in a GitHub form and a real secret in an Azure `variables:` block —
the same key carries opposite meaning depending on the file it sits in. Test
data is excluded for the same categorical reason: a fixture holding a mask is
correct code, and flagging it would advise adding a test directory to the
roots, which would make the guard scan fixtures and fail on the very mask it
was sent to read. Discovering by a narrower category than the clauses read
would certify part of the subject while reporting on all of it. That
enforcement is deliberately
a test rather than this sentence. Once a second guard ships its own root list,
"add it to that list" is an instruction a reader can follow correctly and still
be wrong, and no rewording fixes it.

This list is no longer maintained by hand:
`tests/lite/unit/pipeline-variable-groups-documented.test.ts` parses every
`- group:` declaration out of the `azure-pipelines*.yml` files and asserts this
section covers them, and that it names no group any pipeline stopped using. The
prose above is still hand-written and can drift — the count of importing files
in the previous paragraph was itself wrong until the guard's failure output
listed them — so treat the pipeline files as the source of truth and this text
as commentary.

### Required Report Upload Variables

The failed-test report upload template also expects these pipeline variables:

- `DEPLOY_ENDPOINT_UPLOAD` — from `BabylonJS-Deployment`, listed above
- `SERVE_DOMAIN` — group not verified; confirm against a build log before
  relying on it in a new pipeline
- `STORAGE_ACCOUNT` — **not exported by any variable group.** This is the upload
  template's own parameter name, and each pipeline maps its own account into it:
  `azure-pipelines-playground.yml` uses `$(TOOLS_STORAGE_ACCOUNT)`,
  `azure-pipelines-bundle-manifest.yml` uses `$(SNAPSHOTS_STORAGE_ACCOUNT)` (both
  from `BabylonJS-CI-Infrastructure`), and `azure-pipelines-demos.yml` hardcodes
  `babylonsnapshots`.

The `STORAGE_ACCOUNT` naming is a genuine trap: it reads like a group variable
because it sits beside `DEPLOYMENT_SERVER`/`DEPLOY_TOKEN` in every upload call.
Writing `$(STORAGE_ACCOUNT)` in a new pipeline does not fail loudly — ADO leaves
the unresolved macro as literal text, bash evaluates it as a command
substitution, and the upload is posted with an empty account, which the
deployment server rejects as an HTTP 401. Always map an explicit account
variable, and validate it before doing expensive work.

> **Do not trust `BabylonJS/Babylon.js/.azure-pipelines/VARIABLE-GROUPS.md` for
> this repo.** It documents the same ADO organisation but a different group
> layout — it places `DEPLOY_ENDPOINT_UPLOAD` in `BabylonJS-CI-Infrastructure`
> and names the BrowserStack group `Browserstack-Opensource`, whereas here
> `DEPLOY_ENDPOINT_UPLOAD` resolves from `BabylonJS-Deployment` (observed in
> build `20260825.1`, which imported only that group) and the BrowserStack group
> is `BabylonJS-BrowserStack`. The two repos have drifted; verify against an
> actual build log rather than the sibling repo's documentation.

### Fail-Fast Ordering in the Bundle-Manifest Pipeline

The validation above is only worth anything if it runs _before_ the expensive
work. `azure-pipelines-bundle-manifest.yml` measures 245 scenes, which takes
around half an hour; a deploy variable that does not resolve should cost
seconds, not a full measurement run that then fails at the publish step with
nothing to publish. That is not hypothetical either — it is exactly how this
pipeline first failed.

So `Check deploy configuration` runs at the top, and the only steps permitted
ahead of it are these:

- `checkout` — the repository has to be present before any step can run, and
  fetching it tells the build nothing about whether it can publish.

Everything else, including dependency installation and browser downloads, runs
after the check. Anything named in that list runs before the build knows it can
publish, so a step earns a place there only by being both cheap and genuinely
required _by the check itself_.

Widening the list is therefore a decision, not a repair, and it takes an edit
here as well as in `tests/lite/unit/pipeline-fail-fast-ordering.test.ts` —
deliberately, so the justification lands in prose where a reviewer sees it
rather than as one more name in a constant. Note what it costs: a step listed
here is no longer watched by the ordering check, so choosing this route for
expensive work buys silence rather than safety.

### Optional Pipeline Variables

- `PERF_REGRESSION_PCT` — override regression threshold
- `PERF_FRAMES` — override measured frames per run
- `PERF_RUNS` — override number of runs per version
- `PERF_WARMUP` — override warmup frames per run
- `BUNDLE_DELTA_PCT` — override bundle delta threshold

### Test Reporting

Both cloud test suites (perf and parity) produce:

- **JUnit XML** — consumed by Azure DevOps `PublishTestResults@2` and
  displayed in the pipeline's **Tests** tab with pass/fail counts, durations,
  and error messages
- **HTML report** — interactive Playwright report with error details and
  screenshots; tracing is disabled for BrowserStack runs

Report locations after a run:

| Suite  | JUnit XML                       | HTML Report                             |
| ------ | ------------------------------- | --------------------------------------- |
| Parity | `test-results/parity-junit.xml` | `test-results/parity-report/index.html` |
| Perf   | `test-results/perf-junit.xml`   | `test-results/perf-report/index.html`   |

To view the HTML report locally:

```sh
pnpm exec playwright show-report test-results/parity-report
pnpm exec playwright show-report test-results/perf-report
```

In CI, BrowserStack reports and JUnit files are sanitized and independently
verified before publication. The fail-closed scan requires both BrowserStack
credentials, checks raw and URL-encoded forms in every file and nested ZIP, and
sets `ArtifactsSafe=true` only after verification succeeds. Azure test-result
publication and failed-test CDN report uploads are gated on that variable. The
CDN allowlist contains only `test-results/parity-report` and
`test-results/perf-report`; raw Playwright artifact/trace directories are never
uploaded.

---

## Scene Configuration

All 25 test scenes are defined in `scene-config.json` at the repo root. Each
entry specifies:

```json
{
    "id": 1,
    "slug": "boombox",
    "name": "BoomBox",
    "maxMad": 1.5,
    "maxRegionMad": 3.0,
    "maxRawKB": 200
}
```

- `maxMad` — parity MAD threshold (whole image)
- `maxRegionMad` — parity MAD threshold (focus region, if defined)
- `maxRawKB` — bundle raw size ceiling (gzip is informational only)

---

## Environment Variables Reference

| Variable                  | Scope  | Default | Description                             |
| ------------------------- | ------ | ------- | --------------------------------------- |
| `PERF_REGRESSION_PCT`     | Perf   | `5`     | Max allowed regression %                |
| `PERF_FRAMES`             | Perf   | `300`   | Measured frames per run                 |
| `PERF_RUNS`               | Perf   | `5`     | Runs per version (takes median)         |
| `PERF_WARMUP`             | Perf   | `60`    | Warmup frames before each run           |
| `PERF_SCENES`             | Perf   | all     | Comma-separated scene IDs               |
| `BUNDLE_DELTA_PCT`        | Bundle | —       | Max allowed bundle size growth %        |
| `RECAPTURE_GOLDEN`        | Parity | —       | Set to `true` to force golden recapture |
| `BROWSERSTACK_USERNAME`   | Cloud  | —       | BrowserStack credentials                |
| `BROWSERSTACK_ACCESS_KEY` | Cloud  | —       | BrowserStack credentials                |
