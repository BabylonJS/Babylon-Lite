# Testing

Babylon Lite uses four categories of automated tests, all orchestrated by
Playwright and/or Vitest. An Azure Pipelines CI pipeline runs five parallel
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

**Config:** `azure-pipelines.yml`  
**Trigger:** PRs targeting `master`

Five parallel jobs:

| Job                 | What it does                                           |
| ------------------- | ------------------------------------------------------ |
| **Unit Tests**      | Vitest unit tests + Playwright plumbing tests          |
| **Bundle Size**     | Ceiling checks + delta vs baseline                     |
| **Perf Regression** | Current vs baseline on BrowserStack (macOS Chrome)     |
| **Parity (Cloud)**  | Pixel-diff on BrowserStack (macOS Chrome, real WebGPU) |
| **Lint**            | ESLint + TypeScript `--noEmit` type-check              |

### Required Pipeline Variable Groups

Azure Pipelines uses `BabylonJS-BrowserStack` for shared BrowserStack
credentials:

- `BROWSERSTACK_USERNAME`
- `BROWSERSTACK_ACCESS_KEY`

It uses `BabylonJS-Deployment` for deployment server credentials used when
uploading failed Playwright HTML reports:

- `DEPLOYMENT_SERVER`
- `DEPLOY_TOKEN`
- `DEPLOY_ENDPOINT_UPLOAD`

It uses `BabylonJS-CI-Infrastructure` for the storage accounts and CDN profiles
that uploads target:

- `SNAPSHOTS_STORAGE_ACCOUNT` — snapshots account, used by
  `azure-pipelines-bundle-manifest.yml` for the bundle-size baseline
- `TOOLS_STORAGE_ACCOUNT` — tools account backing `liteplayground.babylonjs.com`
- `CDN_PROFILE_TOOLS`

This third group is easy to miss. It was **omitted from this list until the
bundle-manifest pipeline failed on it**, even though `azure-pipelines.yml`,
`azure-pipelines-playground.yml` and `azure-pipelines-npm-publish.yml` had all
three been importing it all along. A pipeline that needs a storage account and
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
  `DEPLOY_TOKEN` of it would be a misfire.

The subject is every `azure-pipelines*.yml`, every file under
`config/templates/`, and every file under `.github/workflows/` — 10
`Authorization:` headers today. The first version read the repo root alone and
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
