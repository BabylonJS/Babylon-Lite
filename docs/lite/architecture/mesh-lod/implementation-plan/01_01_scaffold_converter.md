# Task 1.1: Scaffold Converter and Pin Dependencies

## Goal

Create the root CMake project and reproducible dependency/tool-version foundation for `mesh-lod-tool`.

## Requirements addressed

REQ-NAME-2, REQ-TOOL-1, REQ-TOOL-2, REQ-TOOL-6

## Background

MeshLoD preprocesses glTF primitives offline. This first task creates no geometry output; it establishes the build that every converter task uses. The repository has no existing native tool framework. Use the architecture pins exactly: meshoptimizer `f843aae0b3070306bd2aeef43ffcf09509fee526` and cgltf `85cd62382dfea638278962690cf515023f33ed00`.

## Files to modify/create

- `mesh-lod-tool/CMakeLists.txt` — project, language level, targets, testing.
- `mesh-lod-tool/cmake/Dependencies.cmake` — pinned `FetchContent`.
- `mesh-lod-tool/cmake/CompilerWarnings.cmake` — MSVC/GCC/Clang warnings.
- `mesh-lod-tool/src/main.cpp` — minimal command dispatch.
- `mesh-lod-tool/src/cli.h`, `mesh-lod-tool/src/cli.cpp` — help/version entry points.
- `mesh-lod-tool/tests/CMakeLists.txt`, `mesh-lod-tool/tests/tool_tests.cpp` — build smoke tests.

## APIs and structs involved

- CLI modes `--help` and `--version`.
- Machine-readable version keys: tool version, format `1.0`, both dependency revisions, compiler target.
- `CLUSTERLOD_IMPLEMENTATION` and cgltf implementation macros must not be defined yet.

## Implementation details

1. Require modern C++ consistently across supported generators.
2. Fetch both dependencies by full commit ID; expose targets/includes without floating branches.
3. Build one `mesh-lod-tool` executable and one CTest target.
4. Make `--help` and `--version` work without input files; reject unknown arguments with exit code 2.
5. Keep version constants in one header consumed by CLI and later provenance code.
6. Document Ninja and Visual Studio configure/build/executable paths in `mesh-lod-tool/README.md`.

## Targeted tests

- Configure and build with the available Windows generator.
- CTest assertions for `--help`, `--version`, unknown arguments, and exact dependency SHAs.

## Gotchas

- Do not use dependency tags or branches.
- Do not let absolute source/build paths enter version output.

## Dependencies

None.

## Verification checklist

- [ ] Clean CMake configure resolves pinned commits.
- [ ] Release build produces the executable.
- [ ] `--version` is deterministic and machine-readable.
- [ ] CTest smoke tests pass.
