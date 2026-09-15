import type { EngineContext } from "../engine/engine.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Mesh } from "../mesh/mesh.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { UsdRecord } from "./usd-protocol.js";
import type { UsdGeometry } from "./usd-geometry.js";
import type { UsdAssetContainer } from "./usd-types.js";
import type { MorphTargetData, SkeletonData } from "../animation/types.js";

/** @internal One protocol skeleton and every GPU skin that consumes it. */
export interface UsdRig {
    joints: SceneNode[];
    inverseBindMatrices: Float32Array;
    skins: SkeletonData[];
}

/** @internal One protocol morph target replicated across material-subset draws. */
export interface UsdMorphBinding {
    data: MorphTargetData;
    targetIndex: number;
}

/** @internal A source draw and its skin remapping, shared by instance placements. */
export interface UsdDraw {
    mesh: Mesh;
    geometry: UsdGeometry;
    skeletonId: number;
}
/** @internal Per-import state passed only to triggered USD feature modules. */
export interface UsdContext {
    engine: EngineContext;
    data: ArrayBuffer;
    records: readonly UsdRecord[];
    nodes: Map<number, SceneNode>;
    sources: Map<number, UsdDraw[]>;
    draws: UsdDraw[];
    materials: Map<number, PbrMaterialProps>;
    container: UsdAssetContainer;
    root: SceneNode;
    signal?: AbortSignal;
    timeCodesPerSecond: number;
    rigs: Map<number, UsdRig>;
    bones: Map<number, SceneNode>;
    morphTargets: Map<number, UsdMorphBinding[]>;
    classicInstanceSources: Set<number>;
    thinInstanceSources: Set<number>;
}
