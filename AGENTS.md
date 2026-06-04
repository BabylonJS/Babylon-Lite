# Agent Instructions

## Mandatory: Read GUIDANCE.md

At the start of every session and after every context compaction,
you **MUST** read and follow `GUIDANCE.md` in the repo root before
doing any work. It is the single source of truth for all
architectural and workflow decisions.

---

## Two-Agent Workflow

This repo uses two Copilot chat modes (`.github/chatmodes/`):

| Mode         | File                   | Role                                                                               |
| ------------ | ---------------------- | ---------------------------------------------------------------------------------- |
| **Gandalf**  | `gandalf.chatmode.md`  | Orchestrator & QA gatekeeper — receives tasks, delegates work, enforces guardrails |
| **Einstein** | `einstein.chatmode.md` | Expert coder — implements features, fixes bugs, runs tests                         |

### How It Works

1. **User → Gandalf**: Describe the task or feature you want.
2. **Gandalf → Einstein**: Gandalf delegates coding work via sub-agent with full context.
3. **Einstein → Gandalf**: Einstein reports completion with checklist status.
4. **Gandalf verifies**: Runs **all** guardrail checks independently (does NOT trust Einstein's word).
   Gandalf **MUST** run the agent-allowed test suite before declaring success:
    - `pnpm build:bundle-scenes` — bundle scenes build successfully
    - `pnpm test:parity` — no MAD regression in visual parity AND bundle-size ceilings hold
    - `git diff tests/lite/parity/bundle-size.spec.ts` — no ceiling changes
    - `git diff reference/lite/` — no golden reference changes
      These can be chained via `pnpm test` (build + parity). **Do NOT run `pnpm test:perf`** — perf tests are machine-sensitive and reserved for the user / CI. If perf validation is needed, ask the user to run it locally.
      **Iteration tip:** During the edit/test loop on a specific scene, run only that scene's spec (`npx playwright test tests/lite/parity/scenes/<scene>.spec.ts`) to save time. Run the full `pnpm test` only as the final guardrail gate before declaring success.
5. **All pass** → Gandalf reports success. **Any fail** → Einstein sent back to fix.

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
and incrementing its `nonce`; weekly scheduled releases remain `auto`.

### Guardrails (Non-Negotiable)

- **Run ALL agent-allowed tests before validating** — Gandalf must actually execute `pnpm test` (build + parity) and review the output. Never skip tests or declare success based on code review alone.
- **No MAD regression** — visual parity tests must all pass.
- **All agent-allowed tests green** — bundle-size and parity tests must all pass. Perf tests are user/CI-only.
- **No bundle-size regression** — bundle size must stay within ceilings.
- **No ceiling updates** — bundle-size test thresholds cannot be changed without explicit user approval.
- **No golden reference changes** — reference screenshots are immutable unless user explicitly requests update.
