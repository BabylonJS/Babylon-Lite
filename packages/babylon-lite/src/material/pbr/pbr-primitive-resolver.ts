/** Installs the PBR pipeline's primitive-state resolver AND the extra mesh-feature encoder, which
 *  together handle non-triangle glTF topologies (POINTS / LINES / LINE_STRIP / TRIANGLE_STRIP) and
 *  negative-determinant winding reversal. Imported for side effect only by the glTF primitive +
 *  negative-winding features, so triangle-list positive-winding scenes (the overwhelming majority)
 *  never bundle this code and keep their renderer + pipeline chunks byte-identical.
 *
 *  These bit constants are deliberately defined locally (not exported from mesh-features.ts): a bit
 *  used only inside this lazy module must not leak into the shared mesh-features chunk, or it would
 *  grow every scene's bundle. */
import type { Mesh } from "../../mesh/mesh.js";
import { _installMeshFeatureExtra } from "../mesh-features.js";
import { _installPbrPrimitiveResolver } from "./pbr-pipeline.js";

/** Mesh world transform has a positive determinant (mirrored vs the RH→LH root): its triangle
 *  winding is reversed, so back-face culling must flip (cull "front"). */
const MSH_REVERSE_WINDING = 1 << 11;
/** Non-triangle-list primitive topology, encoded as a 3-bit index in bits 12-14 (1=point-list,
 *  2=line-list, 3=line-strip, 4=triangle-strip; 0=triangle-list). */
const MSH_TOPOLOGY_SHIFT = 12;
/** A line-strip / triangle-strip mesh uses a uint32 index buffer (vs uint16); WebGPU needs the
 *  pipeline's `stripIndexFormat` to match the index buffer for indexed strip draws. */
const MSH_INDEX_U32 = 1 << 15;

// Encode the topology + negative-winding bits from the per-mesh flags set by the loader/feature.
_installMeshFeatureExtra((mesh: Mesh): number => {
    let f = 0;
    if ((mesh as { _reverseWinding?: boolean })._reverseWinding) {
        f |= MSH_REVERSE_WINDING;
    }
    const topo = (mesh as { _topology?: number })._topology;
    if (topo) {
        f |= topo << MSH_TOPOLOGY_SHIFT;
        // Strips need the pipeline stripIndexFormat to match the index buffer; flag uint32 so the
        // pipeline picks the right format. Lite always draws indexed.
        if (topo >= 3 && mesh._gpu.indexFormat === "uint32") {
            f |= MSH_INDEX_U32;
        }
    }
    return f;
});

_installPbrPrimitiveResolver((meshFeatures, hasDoubleSided): GPUPrimitiveState => {
    // `reverseWinding` marks a mesh mirrored relative to Lite's world space: the loader sets it when
    // the node's world-matrix determinant is positive. (Lite applies a RH→LH root flip with det < 0,
    // so an un-mirrored glTF node lands at a negative world determinant and a mirrored one — e.g. KHR
    // negative node scale — at a positive one.) A mirrored mesh has reversed triangle winding, so we
    // flip the pipeline's `frontFace` (ccw→cw) rather than the cull face: WebGPU derives
    // `@builtin(front_facing)` from `frontFace`, so this keeps the double-sided shader's front-facing
    // normal flip correct (a cullMode flip would leave front_facing evaluated against the un-mirrored
    // ccw winding, wrongly inverting the shading normal on the visible outer surface → black). BJS
    // handles the same case by flipping sideOrientation (the GL front-face winding); it states the
    // condition as a negative determinant because it measures the sign in its own opposite-handed space.
    const reverseWinding = (meshFeatures & MSH_REVERSE_WINDING) !== 0;
    // Non-triangle-list primitive topology. Points and lines have no faces to cull; for a strip the
    // material's culling still applies.
    const topoIdx = (meshFeatures >> MSH_TOPOLOGY_SHIFT) & 7;
    const topology: GPUPrimitiveTopology =
        topoIdx === 1 ? "point-list" : topoIdx === 2 ? "line-list" : topoIdx === 3 ? "line-strip" : topoIdx === 4 ? "triangle-strip" : "triangle-list";
    const noCull = topoIdx >= 1 && topoIdx <= 3;
    // Indexed strip draws need stripIndexFormat to match the index buffer.
    const stripIndexFormat: GPUIndexFormat | undefined = topoIdx >= 3 ? (meshFeatures & MSH_INDEX_U32 ? "uint32" : "uint16") : undefined;
    return {
        topology,
        ...(stripIndexFormat ? { stripIndexFormat } : undefined),
        cullMode: noCull || hasDoubleSided ? "none" : "back",
        frontFace: reverseWinding ? "cw" : "ccw",
    };
});
