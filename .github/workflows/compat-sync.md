---
# Babylon Lite Compat-Layer Sync — GitHub Agentic Workflow
#
# Runs the update-compat-layer skill and opens a DRAFT pull request with whatever it
# changed under packages/babylon-lite-compat/.
#
# Triggers:
#   1. Daily schedule.
#   2. An issue labeled `compat`.
#
# After editing this file you MUST recompile the hardened lock file and commit both:
#   gh aw compile .github/workflows/compat-sync.md
# This produces compat-sync.lock.yml — commit it alongside this file on the default branch.

on:
    schedule: daily
    issues:
        types: [labeled]
        names: [compat]
    # `gh aw compile` also injects workflow_dispatch so you can run it manually.

# Read-only by default. `copilot-requests: write` bills Copilot inference to the org
# via the built-in GITHUB_TOKEN (requires the org's "Copilot CLI" policy enabled);
# drop it and configure COPILOT_GITHUB_TOKEN instead if billing to the org is not set up.
permissions:
    contents: read
    issues: read
    pull-requests: read
    copilot-requests: write

# The skill diffs the upstream BabylonJS/Babylon.js and Babylon Lite trees, so the agent
# needs outbound network and GitHub read access.
network: defaults

engine: copilot

tools:
    github:
        toolsets: [default]
    edit:
    bash: ["*"]

# Per-run inference spend cap (1 AIC = $0.01). The daily cap across all agentic
# workflows is set separately via the repo variable GH_AW_DEFAULT_MAX_DAILY_AI_CREDITS.
max-ai-credits: 25000

safe-outputs:
    # The agent runs read-only and edits files in the workspace; this validated job
    # branches, commits, pushes, and opens the PR — no custom PR driver script needed.
    create-pull-request:
        draft: true
        title-prefix: "[compat-sync] "
        labels: [compat, automation]

# Pull the maintenance skill in verbatim so its instructions drive the run.
imports:
    - .github/copilot/skills/update-compat-layer.md
---

# Compat-Layer Sync

Follow the imported `update-compat-layer` skill to reconcile `@babylonjs/lite-compat`
against the latest Babylon.js and Babylon Lite changes: implement what is newly
possible, land at least one new lab oracle scene at pixel parity, add GPU-free tests,
and update `packages/babylon-lite-compat/COMPAT-STATUS.md` (including the synced commit
SHA and date).

Before finishing, run the agent-allowed guardrail checks and make sure they pass:

- `pnpm build:bundle-scenes`
- `pnpm test:parity`

Do **not** run `pnpm test:perf` (machine-sensitive; reserved for CI). Do **not** change
bundle-size ceilings or golden reference screenshots.

When you have changes, open a **draft** pull request summarizing what changed, which new
scene(s) reached parity, and the guardrail results. If a guardrail check fails, still
open the draft PR but call out the failure prominently in the PR body so a human can
take over.

If, after investigating, there is nothing to change (no upstream deltas and no scene you
can land), do not open a pull request — call the `noop` tool with a short explanation.

When this workflow is triggered by an issue labeled `compat`, treat the issue body as the
specific request to address and reference the issue number in the PR description.
