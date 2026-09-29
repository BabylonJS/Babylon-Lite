# Task 3.2: Parse and Validate Complete `.mlod` Buffers

## Goal

Parse complete `ArrayBuffer`/`Blob` sources into immutable metadata records with strict compatibility and integrity validation.

## Requirements addressed

REQ-FMT-1, REQ-FMT-5, REQ-FMT-6, REQ-VERIFY-2

## Background

Task 3.1 supplies errors/public state. Use the exact C++ binary contract from Phase 2; TypeScript must independently reject malformed bytes before runtime registration.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-format.ts` — constants, little-endian readers, parser/validator.
- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts` — internal record interfaces.
- `tests/lite/unit/mesh-lod/mesh-lod-format.test.ts`
- `tests/lite/unit/mesh-lod/fixtures/**` — compact valid/mutated containers.

## APIs and structs involved

Header 256; section/group/cluster/page records 64; hierarchy node 32; stored page header 64; required sections 1–7.

## Implementation details

1. Read with `DataView` little-endian helpers and overflow-checked range arithmetic.
2. Validate magic/version/min-reader/endian/header size before trusting offsets.
3. Verify header/directory/metadata CRC32C and required/optional section rules.
4. Parse groups, clusters, hierarchy nodes, group-page refs, page table, and provenance into immutable records.
5. Validate strides, counts, sorted unique sections, alignment, overlaps, page ranges, zero reserved fields, DAG references, roots, terminal coverage, and bounds/errors.
6. Map each failure to the architecture error code and byte/section/page context.

## Targeted tests

- Valid converter-produced fixture.
- Unsupported major/minor capability, truncation, overflow, overlap, bad CRC, bad reference, bad reserved byte, page-size violations.

## Gotchas

- Do not parse page codec streams before page CRC validation.
- Unknown optional sections are skippable only when their range/CRC is valid.

## Dependencies

- Task 3.1 and committed Phase 2 fixtures.

## Verification checklist

- [ ] Valid bytes produce exact metadata/counts.
- [ ] Every mutation fails with a stable error code.
- [ ] Failed bytes never create a ready asset.
- [ ] Parser tests pass.
