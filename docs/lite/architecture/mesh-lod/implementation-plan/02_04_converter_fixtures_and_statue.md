# Task 2.4: Add Converter Fixtures and Generate Statue Assets

## Goal

Complete native converter coverage and generate the committed three-primitive statue `.mlod` assets.

## Requirements addressed

REQ-NAME-3, REQ-VERIFY-1, REQ-TOOL-1..9, REQ-GEO-1..7

## Background

Task 2.3 delivers an end-to-end converter. The repository root contains `harvard-yenching_institute_statue.glb`, which architecture identifies as three meshes with one primitive each.

## Files to modify/create

- `mesh-lod-tool/tests/fixtures/**` — complete success/failure inventory.
- `mesh-lod-tool/tests/tool_tests.cpp`, `format_tests.cpp` — matrix completion.
- `mesh-lod-tool/README.md` — build, conversion, serving, and deterministic environment.
- `lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod`
- `lab/public/mesh-lod/harvard-yenching_institute_statue.mesh001.prim000.mlod`
- `lab/public/mesh-lod/harvard-yenching_institute_statue.mesh002.prim000.mlod`
- `lab/public/mesh-lod/statue-stats.json` — canonical conversion evidence.

## APIs and structs involved

- Final converter CLI and all v1 records.
- Statue output naming contract.

## Implementation details

1. Map every `REQ-VERIFY-1` behavior/failure to a named fixture/test.
2. Run clean Ninja or available Windows release configure/build/CTest.
3. Convert the statue with explicit canonical options and statistics output.
4. Run the same conversion twice in clean output locations and byte-compare all three files.
5. Inspect provenance/counts/page sizes/pinned pages and assert non-zero hierarchy statistics.
6. Document `Content-Encoding: identity` and byte-range serving requirements.
7. Commit only final validated assets and stable stats; never commit `mesh-lod-tool/build`.

## Targeted tests

- Full CTest suite.
- Determinism comparison for every statue output.
- Validate-only pass on committed outputs.

## Gotchas

- Generated files are deliverables, not temporary build products.
- Do not modify the source GLB.

## Dependencies

- Tasks 1.1–2.3.

## Verification checklist

- [ ] Fixture inventory covers every converter requirement.
- [ ] Three statue files exist with expected names.
- [ ] Repeat conversions are byte-identical.
- [ ] Committed assets pass `--validate-only`.
