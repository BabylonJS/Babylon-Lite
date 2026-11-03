# BabylonJS/Babylon-Lite fork pull request CodeQL migration

This runbook prepares an advanced CodeQL workflow that can scan fork-origin pull requests without running submitted project code or granting infrastructure credentials. It does not activate the workflow, change repository settings, approve a contributor workflow, or establish a merge gate.

## Status

| Milestone | Status | Evidence required to advance |
| --- | --- | --- |
| Workflow prepared | **Complete locally** | `.github/workflows/codeql.yml` passes independent YAML and Actions validation. |
| Advanced setup active | **Not complete** | A repository administrator switches from default setup and the committed workflow completes on `master`. |
| Fork PR successfully scanned | **Not complete** | Both CodeQL matrix jobs complete on an authorized benign fork PR and analyses are attached to its pull request merge ref/SHA. |
| Merge gate verified | **Not complete** | A separately approved ruleset change blocks a controlled vulnerable PR at the chosen threshold and permits a clean PR. |

Do not describe the local workflow as a successful fork scan or a verified merge gate.

## Prepared workflow

Path: `.github/workflows/codeql.yml`

- Events: pushes and pull requests targeting `master`, a weekly schedule, and `merge_group` for future queue compatibility.
- Languages: `javascript-typescript` and `actions`, matching the two categories in current CodeQL analyses. The default-setup API also reports the aliases `javascript` and `typescript`; CodeQL combines those into the `javascript-typescript` database.
- Query suite: `security-extended`, which includes the default security queries plus lower-precision security queries.
- Build mode: `none` for every matrix entry.
- Execution: only `actions/checkout`, `github/codeql-action/init`, and `github/codeql-action/analyze` on a disposable `ubuntu-latest` GitHub-hosted runner.
- Checkout: the event's normal ref is used. On `pull_request`, this is the pull request merge ref; there is no `ref` override and no `pull_request_target`.
- Project code: checked out for static extraction only. The workflow has no package installation, dependency restoration, autobuild, shell command, project script, build, test, downloaded project tool, cache, artifact handoff, or custom query execution.
- Credentials: no secrets, PAT, OIDC token, self-hosted runner, internal runner, or internal network. Checkout sets `persist-credentials: false`.
- Token permissions: deny by default, then job-level `contents: read` and `security-events: write`. GitHub downgrades a fork PR token to read-only; CodeQL's supported `pull_request` upload path is the exception that accepts pull request results from untrusted actors.
- Actions: official GitHub-owned actions pinned to full, verified release commit SHAs.

The workflow deliberately has no actor filter and no path filter, so every pull request targeting `master` is eligible for both language scans.

## Local validation evidence

Validation was intentionally independent of repository dependencies and project scripts:

- `actionlint 1.7.12` (`darwin/arm64`, built with Go 1.26.1) reported no findings for `.github/workflows/codeql.yml`.
- The validator archive was downloaded from the [official `rhysd/actionlint` v1.7.12 release](https://github.com/rhysd/actionlint/releases/tag/v1.7.12) and matched the release asset SHA-256 `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f`.
- PyYAML 6.0.3 parsed the workflow with a string-preserving loader, and structural assertions passed for event branches, `merge_group`, deny-by-default permissions, the two matrix entries, `build-mode: none`, and the three-step job.
- `git diff --check` passed.
- No repository install, build, lint, test, bundle, parity, performance, or application command was run.

## Repository-specific read-only findings

Observed on 2026-11-03 through GitHub REST/GraphQL APIs:

| Area | Finding | Evidence |
| --- | --- | --- |
| Repository | Public repository; default branch is `master`; auto-merge is enabled. | [`GET /repos/BabylonJS/Babylon-Lite`](https://api.github.com/repos/BabylonJS/Babylon-Lite) |
| Languages | TypeScript is dominant; JavaScript and GitHub Actions workflow code are present. | [`GET /languages`](https://api.github.com/repos/BabylonJS/Babylon-Lite/languages) |
| Current CodeQL | Default setup is configured, weekly, standard GitHub-hosted runner, default suite, remote threat model. Reported languages: `actions`, `javascript`, `javascript-typescript`, and `typescript`. | [`GET /code-scanning/default-setup`](https://api.github.com/repos/BabylonJS/Babylon-Lite/code-scanning/default-setup) |
| Actual analysis categories | Recent analyses use `/language:javascript-typescript` and `/language:actions` on `master` and same-repository pull requests. | [`GET /code-scanning/analyses`](https://api.github.com/repos/BabylonJS/Babylon-Lite/code-scanning/analyses) |
| Default-setup limitation | GitHub documents that default setup excludes pull requests from forks. | [About setup types for code scanning](https://docs.github.com/en/code-security/concepts/code-scanning/setup-types#about-default-setup) |
| Fork corroboration | Open fork PR [#813](https://github.com/BabylonJS/Babylon-Lite/pull/813), head `tini2n/Babylon-Lite@678a7a1cea77c9fd0e87b5f37e7afc6d7ad533a3`, had no CodeQL analysis for `refs/pull/813/head` and no GitHub Actions pull-request run when checked. Its only head check was GitGuardian. | [`GET /pulls/813`](https://api.github.com/repos/BabylonJS/Babylon-Lite/pulls/813), [`GET /analyses?ref=refs/pull/813/head`](https://api.github.com/repos/BabylonJS/Babylon-Lite/code-scanning/analyses?ref=refs/pull/813/head), [`GET /commits/678a7a1/check-runs`](https://api.github.com/repos/BabylonJS/Babylon-Lite/commits/678a7a1cea77c9fd0e87b5f37e7afc6d7ad533a3/check-runs) |
| Branches | `master` is the only protected branch returned by the branch API. No maintained release branch was identified. | [`GET /branches`](https://api.github.com/repos/BabylonJS/Babylon-Lite/branches) |
| Active ruleset | `Protect Master` targets the default branch and requires `BabylonJS.Babylon-Lite` from integration `9426`; it also blocks deletion/non-fast-forward updates and enables Copilot review. It does not currently require CodeQL or code scanning results. | [Ruleset 14982197](https://github.com/BabylonJS/Babylon-Lite/rules/14982197) |
| Legacy protection | `master` requires two approvals and conversation resolution; force pushes and deletion are disabled. | [`GET /branches/master/protection`](https://api.github.com/repos/BabylonJS/Babylon-Lite/branches/master/protection) |
| Merge queue | GraphQL returned `mergeQueue: null`. `merge_group` is included proactively, but there is no queue to verify today. | [Repository](https://github.com/BabylonJS/Babylon-Lite) |
| Actions policy | Actions are enabled and all actions are allowed. Repository SHA pin enforcement is off. Default workflow token permission is `write`, and workflows may approve pull request reviews. | [`GET /actions/permissions`](https://api.github.com/repos/BabylonJS/Babylon-Lite/actions/permissions), [`GET /actions/permissions/workflow`](https://api.github.com/repos/BabylonJS/Babylon-Lite/actions/permissions/workflow) |
| Outside contributors | Workflow approval policy is `first_time_contributors`. Approval can release all pending workflows for that commit, not only CodeQL, so every pending workflow must be reviewed before approval. | [`GET /actions/permissions/fork-pr-contributor-approval`](https://api.github.com/repos/BabylonJS/Babylon-Lite/actions/permissions/fork-pr-contributor-approval) |
| Custom CodeQL configuration | No `.github/codeql*` file, CodeQL workflow, repository property value, or `github-codeql-config-file` organization property was found. The repository code-security-configuration endpoint returned `204 No Content`. | Repository tree; [`GET /properties/values`](https://api.github.com/repos/BabylonJS/Babylon-Lite/properties/values) |

### Coverage and trusted configuration

The prepared workflow keeps the current JavaScript/TypeScript and Actions coverage and moves from the current `default` suite to `security-extended`. Its trusted configuration is inline and contains no `config-file`, `packs`, registries, external repository token, or repository-supplied query path. Consequently, it does not download or execute pull-request-supplied custom queries or query packs.

The default-setup REST response does not expose selected UI model packs. Before switching, an administrator must inspect the current CodeQL default-setup UI for model packs or organization-applied configuration. If anything is configured there, stop and inventory it. Do not silently drop it, and do not copy it into advanced setup until its source, version, and trust are reviewed.

Workflow changes proposed by a pull request remain untrusted. Keep the workflow free of secrets and privileged infrastructure, review workflow diffs before approving any outside-contributor run, and protect `.github/workflows/codeql.yml` through normal review. Never replace this design with `pull_request_target` plus a fork checkout.

## Exact administrative activation steps

These are manual steps for a repository administrator. They intentionally preserve the existing Actions approval policy and branch protections.

1. **Review and merge the prepared files**
   - Repository: `BabylonJS/Babylon-Lite`.
   - Review `.github/workflows/codeql.yml` and this runbook.
   - Confirm there are no unrelated changes and no changes to signing, publishing, dependencies, application code, or other CI.
   - Merge only through the repository's normal reviewed process. This runbook does not authorize a merge.

2. **Inventory current default-setup-only configuration**
   - Open **Settings → Advanced Security → CodeQL analysis**.
   - Record the languages, query suite, threat model, model packs, custom configuration property, runner, and schedule.
   - Expected repository-specific baseline: JavaScript/TypeScript plus Actions, default suite, remote threat model, weekly standard runner.
   - If the UI shows model packs or organization configuration not listed above, stop and preserve that coverage before continuing.

3. **Switch from default setup to advanced setup**
   - In **Settings → Advanced Security → CodeQL analysis**, open the `…` menu and choose **Switch to advanced**.
   - In the confirmation dialog, choose **Disable CodeQL**.
   - Consequence: this disables only GitHub's managed default setup. It does not activate the replacement by itself. Perform this immediately after the workflow is present on `master`; do not leave the repository without a working CodeQL configuration.
   - Do not try to upload advanced results while default setup is still active; GitHub rejects the competing configuration.
   - Recovery before a successful advanced run: re-enable default setup with the inventory from step 2.

4. **Verify the first advanced `master` run**
   - Open **Actions → CodeQL** and select the `push` run for the activation commit.
   - Require both `Analyze (javascript-typescript)` and `Analyze (actions)` to complete successfully.
   - In **Security → Code scanning**, confirm two CodeQL analyses exist for `refs/heads/master` at the activation commit SHA with categories `/language:javascript-typescript` and `/language:actions`.
   - Confirm the logs contain no install, build, test, project script, custom query, self-hosted runner, secret, PAT, or OIDC use.
   - If either analysis fails, do not add a merge requirement. Fix or revert the workflow; if coverage cannot be restored promptly, re-enable default setup.

5. **Authorize one benign fork validation only after workflow review**
   - Create a new benign fork PR only with explicit authorization; do not repurpose an unrelated contributor PR.
   - The benign change should touch a non-executable comment or documentation line and must not modify `.github/workflows/**`, Actions, dependencies, build scripts, or CodeQL configuration.
   - In the PR's **Checks** tab, review every workflow awaiting approval. Approval may release workflows other than CodeQL. Do not approve until every pending workflow is safe.
   - Use GitHub's normal **Approve and run workflows** control only after that review. Keep the repository's `first_time_contributors` approval policy unchanged.
   - Expected result: both CodeQL jobs run with a read-only fork token on GitHub-hosted runners and upload through the supported `pull_request` exception.

6. **Prove the fork PR merge-ref analysis**
   - Record the PR number, fork head SHA, and GitHub-generated pull request merge SHA from the PR API.
   - Confirm the CodeQL workflow run uses `event=pull_request` and `head_sha` equal to the current PR merge SHA, not only the fork head SHA.
   - In the code-scanning analyses API and PR checks, confirm both `/language:javascript-typescript` and `/language:actions` are associated with that PR merge ref/SHA.
   - Update the status table only after both jobs and both uploaded analyses are verified.

7. **Handle existing required checks narrowly**
   - Before changing rules, capture the exact successful check names and GitHub App/integration shown on the validated `master` and fork-PR runs.
   - The current ruleset requires `BabylonJS.Babylon-Lite` from integration `9426`. Preserve it.
   - Do not broadly remove old required checks. If an obsolete CodeQL check is already required elsewhere, replace only that exact stale context after proving the new context on both `master` and a fork PR.
   - Prefer the code-scanning results rule for vulnerability thresholds; use required status checks separately when job execution itself must be required.

8. **Choose and add vulnerability merge protection**
   - Threshold choice is intentionally pending. Decide explicitly whether to block at **Critical**, **High or higher**, **Medium or higher**, or **All**, and whether non-security alerts block.
   - Open **Settings → Rulesets → Rulesets** and edit `Protect Master`, or create a narrowly targeted branch ruleset for the default branch.
   - Add **Require code scanning results**, add tool **CodeQL**, and select the approved **Alerts** and **Security alerts** thresholds.
   - Preserve all existing rules, required checks, review requirements, bypass actors, deletion protection, and non-fast-forward protection.
   - Start in evaluate mode if available; otherwise make the smallest reviewed change only after successful scans.

9. **Verify the merge gate separately**
   - With explicit authorization, use a controlled PR whose new diff contains a known test-only CodeQL finding at or above the chosen threshold.
   - Verify CodeQL completes and the ruleset blocks merge because of the code-scanning result.
   - Remove the test finding and verify the same gate clears after a clean rerun.
   - Do not disable or exclude `js/polynomial-redos` merely to suppress a separate SARIF warning. Investigate the warning independently.
   - Record the evidence URLs and only then mark **Merge gate verified**.

## Merge queue and Dependabot limitations

- No merge queue is configured today. The workflow includes `merge_group` so CodeQL job execution can be required if a queue is enabled later.
- GitHub states that **code scanning results rules do not apply to merge queue groups**. A successful `merge_group` scan therefore proves job execution only; it is not vulnerability-based queue enforcement. If a queue is enabled, require the exact CodeQL job statuses for queue admission and report the remaining vulnerability-enforcement gap.
- GitHub states that code scanning results rules do not apply to **Dependabot pull requests analyzed by default setup**. After this migration, validate Dependabot separately. Its `pull_request` runs may upload through GitHub's supported exception, but default-branch pushes authored by Dependabot can still receive a read-only token and fail uploads after squash merge.
- Code scanning merge protection considers alerts only when all reported source locations exist in the pull request diff. Treat this as a documented enforcement boundary, not complete repository-wide vulnerability prevention.

## Recovery

1. If the workflow fails before any successful advanced analysis, revert the workflow change through normal review and re-enable default setup with the recorded settings.
2. If a new ruleset blocks clean pull requests unexpectedly, revert only the newly added CodeQL rule or exact new status context. Preserve the existing `Protect Master` rules and `BabylonJS.Babylon-Lite` requirement.
3. If a fork run exposes unexpected credentials or infrastructure, cancel the run, do not approve additional workflows, and investigate before retrying. This prepared workflow is not expected to expose either.

## Pin provenance

| Action | Pinned commit | Reviewed release | Verification |
| --- | --- | --- | --- |
| `actions/checkout` | [`3d3c42e5aac5ba805825da76410c181273ba90b1`](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1) | [`v7.0.1`](https://github.com/actions/checkout/releases/tag/v7.0.1), published 2026-07-20 | Tag resolves directly to the pinned commit; GitHub commit signature reports `verified: true`. `persist-credentials` is a supported input and is set to `false`. |
| `github/codeql-action` | [`1fc58d04a4d4374f921bdac573c3811c240f9c26`](https://github.com/github/codeql-action/commit/1fc58d04a4d4374f921bdac573c3811c240f9c26) | [`v4.39.2`](https://github.com/github/codeql-action/releases/tag/v4.39.2), published 2026-11-03 | Release tag resolves to the pinned commit; GitHub commit signature reports `verified: true`. The reviewed `init/action.yml` supports `languages`, `build-mode: none`, and `queries`; `analyze/action.yml` documents fork-PR ref/SHA handling. |

## GitHub documentation

- [About setup types for code scanning](https://docs.github.com/en/code-security/concepts/code-scanning/setup-types)
- [Configuring advanced setup for code scanning](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configuring-advanced-setup-for-code-scanning)
- [Workflow configuration options for code scanning](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options)
- [Code scanning merge protection](https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection)
- [Set code scanning merge protection](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/set-merge-protection)
- [Dependabot `Resource not accessible by integration`](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/resource-not-accessible)
