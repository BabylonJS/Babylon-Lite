# Task 2.1: Define Binary Structs and Integrity Utilities

## Goal

Define the exact `.mlod` v1 persisted layouts and deterministic CRC32C/SHA-256 helpers.

## Requirements addressed

REQ-FMT-1, REQ-FMT-5, REQ-FMT-6, REQ-TOOL-6

## Background

Task 1.4 produces validated hierarchy records. This task establishes the byte contract shared by writer, validator, and tests before page packing.

## Files to modify/create

- `mesh-lod-tool/include/mlod_format.h` — constants, section IDs, flags, field offsets/strides.
- `mesh-lod-tool/src/crc32c.h`, `crc32c.cpp` — deterministic CRC32C.
- `mesh-lod-tool/src/sha256.h`, `sha256.cpp` — source/build fingerprints.
- `mesh-lod-tool/tests/format_tests.cpp` — layout and digest vectors.

## APIs and structs involved

- 256-byte header.
- 64-byte section entry, group, cluster, page-table record, stored-page header.
- 32-byte hierarchy node.
- Required sections 1–7 and format/min-reader version `1.0`.

## Implementation details

1. Represent persisted values through explicit little-endian read/write helpers, not compiler struct packing.
2. Define every architecture section 8 offset, bit, reserved field, alignment, and stride as named constants.
3. Add checked integer arithmetic/range helpers for offsets and element counts.
4. Implement CRC32C test vectors and SHA-256 source/build fingerprint composition.
5. Ensure source digest excludes images and includes used external geometry buffers with length prefixes.
6. Ensure build fingerprint includes versions, pins, target architecture, and canonical options only.

## Targeted tests

- Static/runtime assertions for all record sizes and offsets.
- Published CRC32C/SHA-256 vectors.
- Fingerprint stability and sensitivity tests.

## Gotchas

- Never serialize native structs or host endianness.
- Reserved bytes must be written and validated as zero.

## Dependencies

- Task 1.4 hierarchy field model.

## Verification checklist

- [ ] Every persisted field has one named offset.
- [ ] Record strides exactly match architecture.
- [ ] Integrity helpers pass known vectors.
- [ ] No timestamps or paths enter hashes.
