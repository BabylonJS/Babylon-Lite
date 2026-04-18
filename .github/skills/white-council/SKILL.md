---
name: white-council
description: "Convene a council of top-tier AI models to independently solve a task, then synthesize the best combined answer. Invoke ONLY when the user explicitly types `/white-council`."
---

# White Council

A "mixture of agents" skill: dispatch the same task to multiple frontier models
in parallel, collect their full solutions, and synthesize a single superior
answer from the best parts of each.

Inspired by Tolkien's White Council — a gathering of the wise to deliberate
on matters of consequence.

## Activation

**This skill runs ONLY when the user explicitly invokes it with `/white-council`.**

Do not auto-trigger on difficult tasks, ambiguous requests, or any other
heuristic. If the user has not typed `/white-council`, behave normally.

## When to use

Appropriate for:

- High-stakes decisions (architecture, API design, tricky refactors).
- Hard bugs where multiple perspectives help.
- Code the user wants maximum quality on.

Not appropriate for:

- Trivial edits, single-line fixes, formatting changes.
- Pure information lookup (use `babylon-researcher` or a single model).

If the user invokes `/white-council` for something trivial, ask once whether
they really want the full council, then proceed if confirmed.

## Workflow

### 1. Bounded interview

Before dispatching, ensure the task is well-defined:

- If requirements are **already clear**, skip straight to step 2. Do not ask
  questions for their own sake.
- If ambiguous, ask **only the minimum** clarifying questions needed — prefer
  a single consolidated message with multiple bullet-point questions over a
  back-and-forth.
- Confirm success criteria (tests to pass, files in scope, constraints).

Produce a crisp **task brief** you will hand to every council member. It must
contain: goal, constraints, files/areas in scope, success criteria, and any
project-specific context (e.g. relevant `AGENTS.md` / `GUIDANCE.md` rules).

### 2. Convene the council (parallel dispatch)

Issue **all** `runSubagent` calls in a **single tool-call batch** so the
harness can parallelize them. Use `agentName: "Explore"` for research-only
councils, or the default agent for coding councils.

Each subagent receives the **same** task brief and is instructed to:

- Fully complete the task (not a sketch, not a plan — a real solution).
- Report back: summary of approach, files changed / code produced, tradeoffs
  considered, confidence level, and any open questions.

#### MANDATORY model roster — you MUST dispatch ALL of these

A White Council is **not** a White Council unless every seat below is
attempted in the **same** batch. Skipping seats — for any reason short of
a hard tool error — is a guardrail violation.

- `Claude Opus 4.7 (copilot)`
- `Claude Opus 4.6 (copilot)` — high thinking
- `Claude Opus 4.6 (1M context)(Internal only) (copilot)` — high thinking (for large-context tasks)
- `GPT-5.4 (copilot)` — xhigh thinking
- `GPT-5.3-Codex (copilot)` — xhigh thinking
- `Gemini 3.1 Pro (Preview) (copilot)`
- `Goldeneye (Internal Only) (copilot)`

**Non-negotiable rules:**

1. **Dispatch all 7 seats in the same parallel batch on the first attempt.**
   Do not pre-filter the roster. Do not "save time" by dropping seats. Do
   not assume a model will fail — try it.
2. **If a seat errors out, retry it once** with the same prompt before
   giving up on it. Transient failures are common.
3. **If an exact model string is rejected**, try the closest available
   variant on the spot (e.g. fall back from `Opus 4.7` to the latest
   available Opus, from `GPT-5.4` to the latest available GPT-5, from
   `Gemini 3.1 Pro` to the latest available Gemini). Do not drop the
   seat — substitute it.
4. **If a council is convened more than once in the same conversation**
   (e.g. a follow-up `/white-council` on a related question), the full
   roster MUST be attempted again from scratch. Do not carry forward
   exclusions from a previous round — a model that failed once may
   succeed the next time.
5. **You MUST account for every seat in the final delivery.** The council
   notes section must explicitly state, for each of the 7 seats, whether
   it (a) responded, (b) was substituted (and with what), or (c) failed
   after retry. A delivery that silently lists fewer than 7 seats is a
   guardrail violation.
6. **Minimum to still call it a council: 5 of 7 responders.** Below that,
   report that the council could not convene and fall back per the
   guardrails section.

When the caller exposes an explicit thinking-level control, use the level
noted for each seat. If no such control is available, use the closest
available default for that model and proceed.

Pass `model` to `runSubagent` in the form `"Model Name (vendor)"`.

### 3. Synthesize

Do **not** just pick one winner, and do **not** present a menu of options to
the user. Produce a single merged solution using this rubric:

1. **Correctness first** — discard any solution that fails stated constraints
   or success criteria.
2. **Diff the solutions** — identify where they agree (high confidence) vs
   where they disagree (needs judgment).
3. **For each disagreement**, prefer the option that is:
    - Better tested / more verifiable
    - Smaller and more localized
    - More idiomatic for the codebase
    - Simpler (fewer moving parts, fewer abstractions)
    - More backward-compatible (per repo rules)
4. **Merge** — combine the strongest elements into one coherent solution.
   Don't Frankenstein incompatible pieces; reconcile them.
5. **Verify** — if code was produced, sanity-check the merged result
   compiles/runs in principle. Run tests if the workflow supports it.

### 4. Deliver

Present to the user in this order:

1. **The synthesized solution** (code, diff, or answer) — clean, single,
   ready to use.
2. **Council notes** (short section) — one or two sentences per model on what
   each contributed and where they diverged. Flag any substitutions made to
   the preferred roster and any seats that failed to respond.
3. **Open questions** (if any) — things no council member resolved
   confidently.

Keep the council notes brief. The headline is the synthesized answer; the
notes are supporting context.

## Guardrails

- **Always dispatch the full 7-seat roster on the first attempt.** Silently
  shrinking the council is the most common failure mode of this skill and
  is explicitly prohibited. See the "MANDATORY model roster" section above.
- **Always retry a failed seat once** before substituting or dropping it.
- **Always re-attempt the full roster on every new council**, even within
  the same conversation. Do not carry forward exclusions from a previous
  round.
- **Always report the status of every seat** in the council notes:
  responded / substituted / failed-after-retry. A delivery that fails to
  account for all 7 seats is a guardrail violation.
- Never fabricate a council response. If fewer than 5 of 7 models respond
  successfully, report that the council could not convene and fall back to
  a single-model answer with that caveat.
- Never show raw per-model transcripts unless the user asks — synthesize.
- Respect all repo rules (`AGENTS.md`, `GUIDANCE.md`, instruction files).
  The council brief must include a pointer to these so members abide by them.
- If council members produce conflicting file edits, do not apply any until
  the synthesis step has reconciled them.
