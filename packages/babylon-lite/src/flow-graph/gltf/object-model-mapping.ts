// ⚠️ SPEC-VOLATILE — KHR_interactivity is an UNRATIFIED glTF draft. All code in
// flow-graph/gltf/ is quarantined here so the runtime core never changes when
// the spec churns. Mirrored against Babylon.js commit 8f728b23ea (2026-06-24).
// Re-sync against BJS PR #18455 ("KHR_interactivity rework") when it lands.
// See docs/lite/architecture/51-flow-graph.md → glTF KHR_interactivity Loader.
//
// object-model-mapping: maps glTF JSON-pointer object-model paths to the Lite
// scene property they address + the FgType of that property. Phase 2 covers the
// node TRS triplet (the vertical-slice surface). Broaden in Phase 3+ (materials,
// cameras, lights, extensions) — mirror BJS `objectModelMapping.ts`.

import { FgType } from "../types.js";

/** A scene-graph node TRS property addressable by a JSON pointer. */
export type NodeTrsProp = "translation" | "rotation" | "scale";

/** Object-model entry: which node property a pointer tail addresses + its type. */
export interface ObjectModelEntry {
    /** The pointer tail after `/nodes/{index}/` (e.g. "translation"). */
    readonly prop: NodeTrsProp;
    readonly type: FgType;
}

/** Supported `/nodes/{index}/<prop>` tails. glTF uses RH coordinates; the Lite
 *  import root carries the RH→LH conversion, so accessors read/write the node's
 *  LOCAL TRS with raw glTF values (no per-accessor handedness flip for
 *  translation/scale). Rotation handedness is revisited in Phase 3. */
export const NODE_TRS_PROPS: Record<string, ObjectModelEntry> = {
    translation: { prop: "translation", type: FgType.Vector3 },
    rotation: { prop: "rotation", type: FgType.Quaternion },
    scale: { prop: "scale", type: FgType.Vector3 },
};
