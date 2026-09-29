# Task 3.3: Implement Range-Source Bootstrap Protocol

## Goal

Implement URL, `ArrayBuffer`, and `Blob` range sources and the exact coarse-first bootstrap sequence.

## Requirements addressed

REQ-FMT-2, REQ-FMT-3, REQ-FMT-7, REQ-STREAM-1

## Background

Task 3.2 parses complete byte ranges. URL loading starts with bytes `0-65535`, may request one continuation through `bootstrapBytes`, or may retain a validated complete HTTP 200 response.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-range-source.ts` — source abstraction and response validation.
- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts` — bootstrap orchestration.
- `tests/lite/unit/mesh-lod/mesh-lod-range-source.test.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-http.test.ts`
- `vitest.config.ts` — add a `lite-integration` project for `tests/lite/integration/**/*.test.ts`.
- `package.json` — add `test:integration`.

## APIs and structs involved

- Internal `MeshLoDRangeSource.read(start,end,signal)`.
- `MeshLoDRequestOptions.fetch/headers/credentials`.
- HTTP `206 Content-Range` and full-body `200` fallback.

## Implementation details

1. Treat `ArrayBuffer`/`Blob` as complete-file sources with strict bounds checks.
2. For URLs, merge custom fetch, headers, credentials, and abort signals without mutating caller inputs.
3. Validate identity/no content encoding, exact `Content-Range`, body length, total size, and status.
4. Retain a 200 body only when it exactly equals declared `fileBytes`; satisfy later reads from it.
5. Bootstrap header/directory first, then only the remainder through pinned pages.
6. Reject multipart, transformed, mismatched, short, 304, and unusable statuses explicitly.

## Targeted tests

- Exact 206, two-range bootstrap, exact 200 fallback, custom fetch, abort.
- Invalid range/status/encoding/length/total matrices.

## Gotchas

- Redirects must not silently drop caller authorization policy.
- Fine requests remain page-granular; do not coalesce here.

## Dependencies

- Task 3.2 parser.

## Verification checklist

- [ ] Bootstrap needs at most two URL requests.
- [ ] Full-body fallback prevents repeated downloads.
- [ ] Invalid protocol responses fail explicitly.
- [ ] Unit and integration protocol tests pass.
