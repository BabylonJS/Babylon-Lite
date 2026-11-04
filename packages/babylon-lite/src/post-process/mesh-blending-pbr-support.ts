import { _installMeshBlendingGeometrySupport } from "../frame-graph/geometry-mesh-blending.js";

/** @internal Install PBR parity support only when a geometry tag attachment is requested. */
export function _installMeshBlendingPbrSupport(): void {
    _installMeshBlendingGeometrySupport();
}
