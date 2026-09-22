import { createDefaultMeshBlendRadiusDefinitions, packMeshBlendingTag, unpackMeshBlendingTag } from "babylon-lite";

import { unsupported } from "../error.js";

export enum MeshBlendingRadiusClass {
    Small = 0,
    Medium = 1,
    Large = 2,
    ExtraLarge = 3,
}

export interface IMeshBlendingTag {
    groupId: number;
    radiusClass: MeshBlendingRadiusClass;
}

export function PackMeshBlendingTag(groupId: number, radiusClass: MeshBlendingRadiusClass): number {
    return packMeshBlendingTag(groupId, radiusClass);
}

export function UnpackMeshBlendingTag(tag: number): IMeshBlendingTag {
    const unpacked = unpackMeshBlendingTag(tag);
    return {
        groupId: unpacked.groupId,
        radiusClass: unpacked.radiusClass as MeshBlendingRadiusClass,
    };
}

export enum MeshBlendQuality {
    Low = 0,
    Medium = 1,
    High = 2,
    Cinematic = 3,
}

export enum MeshBlendDebugMode {
    Off = 0,
    PackedTag = 1,
    CandidateDirectionDistance = 2,
    SeamFade = 3,
    RejectionReason = 4,
    StageWork = 5,
    Continuation = 6,
    TinyObject = 7,
    MultiTarget = 8,
    TargetColor = 9,
    ShadowAttenuation = 10,
    ColorInterpolation = 11,
    WorldPosition = 12,
}

export enum MeshBlendDepthType {
    View = 0,
    Screen = 1,
}

export interface IMeshBlendRadiusDefinition {
    worldRadius: number;
    minimumProjectedRadius: number;
}

export type MeshBlendRadiusDefinitions = readonly [IMeshBlendRadiusDefinition, IMeshBlendRadiusDefinition, IMeshBlendRadiusDefinition, IMeshBlendRadiusDefinition];

export interface IMeshBlendConfiguration {
    quality?: MeshBlendQuality;
    radiusClasses?: MeshBlendRadiusDefinitions;
    slopeFactor?: number;
    depthType?: MeshBlendDepthType;
    debugMode?: MeshBlendDebugMode;
}

export interface IThinMeshBlendingPostProcessOptions extends IMeshBlendConfiguration {
    [key: string]: unknown;
}

export interface IMeshBlendingPostProcessOptions extends IMeshBlendConfiguration {
    effectWrapper?: ThinMeshBlendingPostProcess;
    meshBlendTagTexture: unknown;
    depthTexture: unknown;
    baseColorTexture?: unknown;
    [key: string]: unknown;
}

export function CreateDefaultMeshBlendRadiusDefinitions(): MeshBlendRadiusDefinitions {
    return createDefaultMeshBlendRadiusDefinitions();
}

const MESH_BLENDING_BLOCKER =
    "Babylon Lite supports mesh blending through its native createMeshBlendingPostProcessTask API; the Babylon.js post-process, frame-graph, and node-render-graph wrapper classes are not implemented by the compat layer.";

export class ThinMeshBlendingPostProcess {
    public constructor(..._args: unknown[]) {
        unsupported("ThinMeshBlendingPostProcess", MESH_BLENDING_BLOCKER);
    }
}

export class MeshBlendingPostProcess {
    public constructor(..._args: unknown[]) {
        unsupported("MeshBlendingPostProcess", MESH_BLENDING_BLOCKER);
    }
}

export class FrameGraphMeshBlendingTask {
    public constructor(..._args: unknown[]) {
        unsupported("FrameGraphMeshBlendingTask", MESH_BLENDING_BLOCKER);
    }
}

export class NodeRenderGraphMeshBlendingPostProcessBlock {
    public constructor(..._args: unknown[]) {
        unsupported("NodeRenderGraphMeshBlendingPostProcessBlock", MESH_BLENDING_BLOCKER);
    }
}

export function RegisterMeshBlendingPostProcessBlock(): never {
    return unsupported("RegisterMeshBlendingPostProcessBlock", MESH_BLENDING_BLOCKER);
}
