# Task 2.2: Pack Deterministic Geometry Pages

## Goal

Encode meshlet-local geometry into deterministic independently decodable 64–256 KiB pages.

## Requirements addressed

REQ-TOOL-7, REQ-FMT-3, REQ-FMT-4, REQ-GEO-7

## Background

Task 2.1 defines exact records and integrity helpers; Task 1.4 supplies ordered groups/clusters. Page packing must pin all terminal-group pages and make output byte-identical.

## Files to modify/create

- `mesh-lod-tool/src/page_packer.h`, `page_packer.cpp` — packing and codec streams.
- `mesh-lod-tool/src/hierarchy.*` — attach page/offset references.
- `mesh-lod-tool/tests/format_tests.cpp` — page boundary and decode tests.

## APIs and structs involved

- Decoded vertex record: 24 bytes (position f32x3, oct-normal snorm16x2, UV binary16x2, zero reserved).
- Local indices: `u16`.
- Stored page header: 64 bytes.
- Page-table record: 64 bytes.

## Implementation details

1. Emit unique vertices in `clodLocalIndices` order and local triangle indices in cluster order.
2. Encode meshoptimizer glTF-compatible `ATTRIBUTES/NONE` and `TRIANGLES/NONE` streams.
3. Prefer each group in as few pages as possible; split only when decoded geometry cannot fit.
4. Use stable first-fit/source ordering and fixed stream alignment.
5. Pad every stored page to a 64 KiB multiple, minimum 64 KiB, maximum 256 KiB; cover zero padding by CRC.
6. Pin every page referenced by terminal groups and place pinned pages before fine pages.
7. Validate decode sizes, offsets, non-overlap, cluster ranges, and multi-meshlet page statistics.

## Targeted tests

- Exact page bytes across two runs.
- Min/target/max boundaries, forced group split, final-page padding, pinned ordering.
- Decode round trip preserving positions/normals/UVs/indices within specified packing precision.

## Gotchas

- Page order and padding are format-visible.
- A group may span pages, but runtime refinement requires all referenced pages.

## Dependencies

- Tasks 1.4 and 2.1.

## Verification checklist

- [ ] All pages meet size/alignment limits.
- [ ] Pinned pages form a contiguous prefix.
- [ ] Decode round trips pass.
- [ ] Repeated packing is byte-identical.
