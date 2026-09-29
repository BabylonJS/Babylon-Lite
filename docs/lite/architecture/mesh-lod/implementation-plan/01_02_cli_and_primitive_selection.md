# Task 1.2: Implement CLI and Primitive Selection

## Goal

Implement complete non-interactive option parsing and deterministic one-or-many primitive output naming.

## Requirements addressed

REQ-TOOL-5, REQ-TOOL-9, REQ-GEO-6

## Background

Task 1.1 created the native target and version constants. One `.mlod` will represent one material primitive. A command selecting multiple primitives must derive sibling names such as `statue.mesh000.prim000.mlod`; a single selection uses the exact requested output.

## Files to modify/create

- `mesh-lod-tool/src/cli.h`, `mesh-lod-tool/src/cli.cpp` — `ConversionOptions`, parsing, validation, help.
- `mesh-lod-tool/src/main.cpp` — exit-code mapping and command dispatch.
- `mesh-lod-tool/src/input.h` — primitive-selection declarations.
- `mesh-lod-tool/tests/tool_tests.cpp` — argument and naming matrix.

## APIs and structs involved

- `ConversionOptions`: input/output, optional mesh/primitive, meshlet limits, partition size, simplify ratio/threshold, page min/target/max KiB, stats path, validate-only.
- Exit codes 0, 2–8 from `architecture.md`.

## Implementation details

1. Parse every option and default specified in architecture section 7.3.
2. Use locale-independent numeric parsing; reject NaN/infinity, missing values, duplicates, and conflicts.
3. Enforce `--primitive` requires `--mesh`, meshlet/page ranges, and `pageMin <= pageTarget <= pageMax`.
4. Canonicalize options into a stable value object for hashing/provenance.
5. Add deterministic output-name derivation using three-digit source indices.
6. Centralize diagnostics so argument errors identify the offending option and map to exit 2.

## Targeted tests

- Table-driven CLI tests for every option, default, lower/upper boundary, conflict, and invalid number.
- Naming tests for one primitive, one mesh with several primitives, and whole-file selection.

## Gotchas

- Do not resolve or serialize absolute paths into canonical options.
- Page values are multiples of 64 KiB in v1.

## Dependencies

- Task 1.1 version/build scaffold.

## Verification checklist

- [ ] `--help` documents every option/default.
- [ ] Invalid arguments never begin conversion.
- [ ] Multi-primitive names are stable and collision-free.
- [ ] CLI tests pass.
