# Agent Instructions

## Mandatory: Read GUIDANCE.md

At the start of every session and after every context compaction,
you **MUST** read and follow `GUIDANCE.md` in the repo root before
doing any work. It is the single source of truth for all
architectural and workflow decisions.

---

## Release Commit Messages

The npm publish pipeline's weekly `auto` mode decides between a minor and major
release by scanning commit messages since the last `npm-lite-v*` tag.

For normal changes, use Conventional Commit-style messages such as:

- `fix: correct texture upload alignment`
- `feat(loader): add KTX2 fallback handling`

For breaking changes, the final commit that lands on `master` **MUST** contain
one of these markers:

- `feat!: remove deprecated loader option`
- `feat(loader)!: change loadGltf return shape`
- `BREAKING CHANGE: describe the migration path`

Because GitHub squash merge usually builds the final commit from the PR title
and body, agents must make sure breaking-change markers are present in the PR
title/body or in the final squash message, not only in an intermediate local
commit. If a PR is labeled `breaking`, `breaking change`, `major`, or
`semver-major`, PR CI will require a marker in the PR title/body when the
release-marker job has a repo-scoped `GITHUB_TOKEN` available to read PR labels.

Manual patch/minor/major releases are requested by editing `config/release.json`
and incrementing its `nonce`; weekly scheduled releases remain `auto`. The npm
publish script scans commits since the previous `npm-lite-v*` release tag for
breaking-change markers on every release mode. If breaking changes are present,
`auto` resolves to `major`, and explicit `patch`/`minor` releases are rejected
so a manual patch cannot hide a breaking change from the next weekly auto
release.

### Guardrails (Non-Negotiable)

- **Run ALL agent-allowed tests before validating** — actually execute `pnpm test` (build + parity) and review the output. Never skip tests or declare success based on code review alone.
- **No MAD regression** — visual parity tests must all pass.
- **All agent-allowed tests green** — bundle-size and parity tests must all pass. Perf tests are user/CI-only.
- **No bundle-size regression** — bundle size must stay within ceilings.
- **No ceiling updates** — bundle-size test thresholds cannot be changed without explicit user approval.
- **No golden reference changes** — reference screenshots are immutable unless user explicitly requests update.
