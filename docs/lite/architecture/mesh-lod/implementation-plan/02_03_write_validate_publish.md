# Task 2.3: Write, Validate, and Atomically Publish `.mlod`

## Goal

Assemble the complete container, validate it independently, emit canonical statistics, and publish all selected outputs atomically.

## Requirements addressed

REQ-TOOL-7, REQ-TOOL-8, REQ-TOOL-9, REQ-FMT-2, REQ-FMT-5, REQ-FMT-6

## Background

Tasks 2.1–2.2 define records and pages. This task creates the first end-to-end `.mlod` writer and prevents partial successful-looking output.

## Files to modify/create

- `mesh-lod-tool/src/mlod_writer.h`, `mlod_writer.cpp` — sections, directory, header, alignment.
- `mesh-lod-tool/src/validator.h`, `validator.cpp` — independent binary/in-memory validation.
- `mesh-lod-tool/src/statistics.h`, `statistics.cpp` — text and canonical JSON.
- `mesh-lod-tool/src/main.cpp` — conversion pipeline and atomic rename.
- `mesh-lod-tool/tests/format_tests.cpp`, `tool_tests.cpp` — end-to-end failures.

## APIs and structs involved

- All v1 binary records and CRC fields.
- Provenance JSON with versions, pins, canonical options, counts/ranges.
- `--stats-json`, `--validate-only`, exits 3, 6, 7, 8.

## Implementation details

1. Serialize required sections sorted by section type with 64-byte metadata and 64 KiB page alignment.
2. Place metadata then contiguous pinned pages within `bootstrapBytes`.
3. Compute section/page/directory/header CRCs in dependency order.
4. Reparse produced bytes with the independent validator before success.
5. Validate compatibility, offsets, overlaps, counts, DAG references, page records, CRCs, and zero padding.
6. Emit canonical UTF-8 statistics with fixed key order and no timestamp.
7. Build all selected outputs in memory or sibling temporary files; rename only after every output validates, cleaning failed temporaries.

## Targeted tests

- Golden field inspection, corruption/truncation/overlap/version mutation corpus.
- Validator failure injection.
- Multi-output failure leaves no final files.
- Two clean conversions compare byte-for-byte.

## Gotchas

- Header CRC is computed with its CRC field zero.
- `PAGE_DATA` uses per-page CRCs rather than one section CRC.

## Dependencies

- Tasks 1.2, 2.1, and 2.2.

## Verification checklist

- [ ] Writer output reparses and validates.
- [ ] Corrupt mutations fail deterministically.
- [ ] Statistics contain all required counts/errors/layout data.
- [ ] Atomic multi-output behavior is proven.
