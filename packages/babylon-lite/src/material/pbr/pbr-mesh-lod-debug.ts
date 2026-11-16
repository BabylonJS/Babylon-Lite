/** MeshLoD debug-view helpers — pure mode/attribute mapping shared by the
 *  material-owned renderable (which packs a per-cluster attribute into the
 *  reserved draw-vertex slot) and its unit tests. The debug WGSL that turns these
 *  codes into colours lives in `pbr-mesh-lod-compose.ts`; keep the palettes there
 *  in sync with the demo legend.
 *
 *  Debug output is purely observational: it changes only the fragment colour and
 *  the reserved draw-vertex word, never selection, residency, or demand. */

import type { MeshLoDDebugView } from "../../mesh-lod/mesh-lod.js";
import type { MeshLoDPageState } from "../../mesh-lod/mesh-lod-runtime.js";

const CONE_F32 = new Float32Array(1);
const CONE_U32 = new Uint32Array(CONE_F32.buffer);

/** Shader `debugMode` code (0 = off). Mirrored by the WGSL fragment branch. */
export function meshLoDDebugModeCode(view: MeshLoDDebugView): number {
    switch (view) {
        case "meshlet-id":
            return 1;
        case "lod-depth":
            return 2;
        case "selected-group":
            return 3;
        case "page-residency":
            return 4;
        case "requested-pages":
            return 5;
        case "meshlet-cone":
            return 6;
        default:
            return 0;
    }
}

/** Page-residency colour code: 0 gray (unavailable), 1 green (resident),
 *  2 yellow (pinned coarse), 3 red (terminal failure). */
export function meshLoDPageResidencyCode(pinned: boolean, state: MeshLoDPageState): number {
    if (state === "terminal-failed") {
        return 3;
    }
    if (pinned) {
        return 2;
    }
    if (state === "gpu-resident") {
        return 1;
    }
    return 0;
}

/** Requested-pages colour code: 1 cyan (streamed-in, on-demand resident),
 *  2 orange (queued/in-flight/transitioning), 0 normal material otherwise. */
export function meshLoDPageRequestCode(pinned: boolean, state: MeshLoDPageState): number {
    switch (state) {
        case "queued":
        case "fetching":
        case "retry-wait":
        case "received":
        case "decoding":
        case "cpu-resident":
        case "uploading":
        case "evicting":
            return 2;
        case "gpu-resident":
            return pinned ? 0 : 1;
        default:
            return 0;
    }
}

/** Bitcast a cone-culling margin into the draw vertex's reserved u32 word. */
export function meshLoDConeDebugAttr(margin: number): number {
    CONE_F32[0] = margin;
    return CONE_U32[0]!;
}

/** Per-cluster attribute stored in the reserved draw-vertex word for the active
 *  mode. The vertex `clusterId` (a separate word) already covers meshlet-id, so
 *  that mode stores nothing here. */
export function meshLoDClusterDebugAttr(mode: number, groupId: number, depth: number, residencyCode: number, requestCode: number): number {
    switch (mode) {
        case 2:
            return depth;
        case 3:
            return groupId;
        case 4:
            return residencyCode;
        case 5:
            return requestCode;
        default:
            return 0;
    }
}
