# Task 8.4: Verify Standalone Demo Workflows

## Goal

Verify every demo control, diagnostic, debug view, camera state, loading/error state, and fallback scenario in the production bundle.

## Requirements addressed

REQ-VERIFY-6, REQ-DEMO-1..7

## Background

Tasks 8.1–8.3 complete the user-facing demo. This is a demo-only validation task; do not run parity solely for lab presentation changes unless engine code also changed in the task.

## Files to modify/create

- `tests/lite/demo/mesh-lod-demo.spec.ts` — Playwright workflow test.
- `playwright.config.ts` or existing demo-test config only if needed to include the file.
- `docs/lite/architecture/mesh-lod/demo-verification.md` — recorded requirement checklist.

## APIs and structs involved

- Canvas ready/error attributes and stable DOM test attributes for controls/metrics/legend.
- Deterministic camera times 0/5/10/15.

## Implementation details

1. Add stable `data-testid`/data attributes to UI elements if not already present.
2. Build `mesh-lod` with the production demo bundler.
3. Verify ready state, orbit/zoom, deterministic path samples, and manual pause/reset.
4. Exercise every control and assert effective-value/diagnostic changes.
5. Exercise every debug view and assert active legend state.
6. Simulate delay, pause, unavailable range, and terminal fine-page failure while asserting complete coarse representation and fallback diagnostics.
7. Verify an explicit bootstrap error reaches `data-error` and hides loading overlay.

## Targeted tests

- `pnpm build:bundle-demo mesh-lod`
- Playwright `tests/lite/demo/mesh-lod-demo.spec.ts`

## Gotchas

- Do not add or change golden reference images.
- Browser tests must use production-bundled JS, not raw TypeScript.

## Dependencies

- Tasks 8.1–8.3.

## Verification checklist

- [ ] Every `REQ-DEMO-*` row has recorded evidence.
- [ ] Production bundle passes automated workflow.
- [ ] Ready and error states both work.
- [ ] No performance test is run.
