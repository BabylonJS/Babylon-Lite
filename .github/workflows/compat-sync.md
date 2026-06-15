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
# Required secret:
#   COPILOT_GITHUB_TOKEN — a *fine-grained* GitHub PAT (github_pat_...) from an account
#   with an active GitHub Copilot subscription. Classic PATs (ghp_...) are NOT supported
#   by the Copilot engine. The agent authenticates Copilot with this token, so inference
#   bills to that account's Copilot allowance (the BabylonJS org has no org Copilot plan
#   and does not ladder up to a Microsoft enterprise).
#
#   Create the PAT at https://github.com/settings/personal-access-tokens/new with:
#     - Resource owner: your personal account
#     - Repository access: Public repositories (read-only)
#     - Account permissions → Copilot Requests: Read-only
#   (No repository permissions are needed — this token is only the Copilot credential;
#   the workflow's repo actions use the Actions GITHUB_TOKEN.)
#
#   NOTE: currently configured for testing in the private fork `ryantrem/Babylon-Lite`.
#   Set the secret (you have admin on your own fork):
#     gh secret set COPILOT_GITHUB_TOKEN --repo ryantrem/Babylon-Lite
#   The agent also reads the repo-wide daily AI-credit cap variable:
#     gh variable set GH_AW_DEFAULT_MAX_DAILY_AI_CREDITS --body 100000 --repo ryantrem/Babylon-Lite
#   (When promoting to the upstream repo, swap ryantrem/Babylon-Lite → BabylonJS/Babylon-Lite.)
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

# Read-only repo permissions. Copilot inference is NOT billed to the org (BabylonJS
# does not have an org Copilot plan); instead the agent authenticates with a personal
# Copilot token supplied via the COPILOT_GITHUB_TOKEN repo secret (set separately).
# Inference therefore bills to that account's Copilot allowance.
permissions:
    contents: read
    issues: read
    pull-requests: read

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
