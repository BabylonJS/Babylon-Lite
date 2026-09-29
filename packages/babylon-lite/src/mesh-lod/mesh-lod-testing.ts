/** MeshLoD internal testing surface.
 *
 *  Exposed through the package's `./mesh-lod/testing` subpath for the
 *  parity/equivalence harness and unit tests. This is NOT part of the public API
 *  (`index.ts`): it re-exports the deterministic CPU selection oracle, the
 *  format parser, and the immutable record types so tests can drive selection and
 *  compare against the GPU path without those internals leaking into the public
 *  declaration surface. */

export { selectMeshLoDCpu } from "./mesh-lod-selection-cpu.js";
export type { MeshLoDCamera, MeshLoDDesiredPage, MeshLoDFrustumPlane, MeshLoDSelectionInput, MeshLoDSelectionResult } from "./mesh-lod-selection-cpu.js";

// GPU selection/expansion models — the deterministic TS mirrors of the selection WGSL,
// exposed on the internal testing path (never the public API) so equivalence fixtures
// can compare GPU selection to the CPU oracle without a real device.
export { runMeshLoDGpuExpansion, runMeshLoDGpuSelection } from "./mesh-lod-selection-gpu.js";
export type {
    MeshLoDGpuExpansionInput,
    MeshLoDGpuExpansionResult,
    MeshLoDGpuSelectionModelInput,
    MeshLoDGpuSelectionModelResult,
    MeshLoDGpuSelectionParams,
    MeshLoDGpuSelectedPair,
} from "./mesh-lod-selection-gpu.js";

export { crc32c, parseMeshLoDContainer, readBootstrapExtent, toMeshLoDMetadata } from "./mesh-lod-format.js";
export type { MeshLoDProvenance, ParsedMeshLoDContainer } from "./mesh-lod-format.js";

export type { MeshLoDCluster, MeshLoDGroup, MeshLoDHeader, MeshLoDHierarchyNode, MeshLoDPageRecord, MeshLoDSectionEntry } from "./mesh-lod-runtime.js";
export { _normalizeMeshLoDSelectedClusterIds as normalizeMeshLoDSelectedClusterIds } from "./mesh-lod-runtime.js";
