---
name: wrapup
description: All-in-one finish line — runs maintenance audit, code review, and full test suite sequentially, then updates CLAUDE.md and memory to reflect current state.
---

Run all steps in sequence. Each step must complete before the next begins.

## Step 1 — Maintenance Audit

Use the Skill tool to invoke the `maintain` skill. This audits for drift between the codebase, CLAUDE.md, tests, skills, and model IDs.

Wait for results before proceeding.

## Step 2 — Code Review

Use the Skill tool to invoke the `review` skill. This reviews recently changed files for type safety, React patterns, R3F invariants, Zustand patterns, API route security, performance, and code quality.

Wait for results before proceeding.

## Step 3 — Test Suite

Use the Skill tool to invoke the `test` skill. This runs typecheck, Vitest unit tests, and conditionally Playwright E2E.

Wait for results before proceeding.

## Step 4 — Knowledge Base Sync

Using the findings from Steps 1–3, update the knowledge base to reflect current reality. Do this **before** writing the report.

### 4a — CLAUDE.md sync

Read `CLAUDE.md`. Apply only what the maintain audit flagged as `[STALE]`, `[NEW]`, or `[REMOVED]`:

- **Package table**: update any `[STALE]` version ranges to match `package.json`; add `[NEW]` packages; remove `[REMOVED]` ones
- **AI model table**: update any `[STALE]` model IDs or voice IDs to match `src/lib/constants.ts` / `src/lib/liveConstants.ts`
- **Key Invariants**: if the review found a new invariant, add it; if a `[VIOLATED]` invariant was resolved, update its wording

Do **not** rewrite narrative sections, rename headings, or change anything the audit did not flag. Surgical edits only.

### 4b — Memory sync

Read `C:\Users\tyler\.claude\projects\c--Projects-Roastie\memory\MEMORY.md` and its linked files.

Apply updates only for things that materially changed:

- If a new architectural decision was made (new session mode, new API route, new invariant pattern), update or create the relevant project or feedback memory and update the MEMORY.md index
- If a previously recorded fact is now stale (old model ID, removed feature), update or remove that memory
- If the code review found a recurring pattern the user confirmed and it isn't already in memory, save it as a feedback memory

Do **not** create memories for things already in CLAUDE.md or derivable from reading the code. Do **not** duplicate existing memories.

### 4c — Comedy Feedback Distillation

Read all files in `.debug/feedback/` (both `feedback-*.json` and `critique-*.json`).

If no feedback files exist, skip this step.

For each file, extract:
- The feedback text
- The type (`post-session` text vs in-session `critique`)
- The persona active at the time (if available)
- The joke that triggered the critique (if available, in `lastJokeText`)

Using comedy expertise, analyze the accumulated feedback and update `src/lib/comedyGuidelines.ts`:

1. **Read the current file** to see existing guidelines
2. **Distill new patterns** — do NOT log specific jokes or user quotes. Extract GENERAL PRINCIPLES like:
   - "Audiences find [category] jokes too harsh at high intensity"
   - "Self-deprecating humor gets better reactions than direct attacks on [X]"
   - "Questions about [topic] tend to produce flat material"
3. **Determine scope**: If feedback consistently mentions a specific persona, add to `PERSONA_COMEDY_GUIDELINES[personaId]`. If it's about the overall experience, add to `GLOBAL_COMEDY_GUIDELINES`.
4. **Merge, don't replace**: New insights should be ADDED to existing guidelines. If a new insight contradicts an existing one, refine it. If feedback validates an existing guideline, leave it.
5. **Keep it concise**: Maximum 15 global guidelines + 5 per persona. Consolidate if over.
6. **After updating**, delete the processed feedback files from `.debug/feedback/` — the guidelines are the persistent artifact.

### 4d — Report what changed

List every file edited in this step and the specific change. If nothing needed updating, say "Knowledge base: already current — no changes."

## Step 5 — Unified Report

Combine all results into a single report:

```
═══════════════════════════════════════
  WRAPUP REPORT
═══════════════════════════════════════

## 1. Maintenance Audit
[Key findings: STALE/MISSING/VIOLATED items, or CLEAN]

## 2. Code Review
[Verdict: APPROVE / REQUEST CHANGES]
[Top issues if any]

## 3. Test Suite
[Verdict: CLEAN / ISSUES]
[Failures if any]

## 4. Knowledge Base
[Files updated and what changed, or "already current"]

───────────────────────────────────────
OVERALL: SHIP IT ✓  |  NEEDS WORK ✗
───────────────────────────────────────
[If NEEDS WORK: prioritized action list]
```

**SHIP IT** = review approved + no critical maintenance drift + all tests pass.
**NEEDS WORK** = any critical review finding, any violated invariant, or any test failure.

## Step 6 — Commit & Push

After the report, if there are any uncommitted changes (from knowledge base sync or bug fixes during review):

1. Stage only the files changed during this wrapup session
2. Commit with a descriptive message
3. `git push`

If there are no uncommitted changes, skip this step.

Always push at the end — the wrapup is the finish line.
