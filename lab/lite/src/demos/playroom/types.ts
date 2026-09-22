import type {
    ArcRotateCamera,
    AudioEngine,
    AudioInputSource,
    Bone,
    EngineContext,
    FreeCamera,
    Mesh,
    NodeMaterial,
    PhysicsAggregate,
    PhysicsBody,
    PhysicsConstraint,
    PhysicsShape,
    PhysicsWorld,
    Quat,
    SceneContext,
    SceneNode,
    ShadowGenerator,
    Skeleton,
    Texture2D,
    Vec3,
} from "babylon-lite";

export type Vec3Tuple = readonly [number, number, number];
export type PlayroomPhase = "loading" | "ready" | "aiming" | "watching" | "ended" | "free";
export type PuzzleFamily = "domino" | "stack" | "tower" | "cup" | "bowlingBall" | "bowlingPins" | "ramp" | "cubeStack" | "cubes" | "arch" | "popper" | "chess";

export interface LayoutEntry {
    readonly family: PuzzleFamily;
    readonly points: readonly Vec3Tuple[];
    readonly values?: readonly number[];
    readonly direction?: Vec3Tuple;
    readonly strong?: boolean;
}

export interface ModelTemplate {
    readonly root: SceneNode;
    readonly mesh: Mesh;
    readonly collisionBounds: {
        readonly center: Vec3Tuple;
        readonly extents: Vec3Tuple;
    };
}

export interface PlayroomAssets {
    readonly models: Readonly<Record<string, ModelTemplate>>;
    readonly bunnyRoot: SceneNode;
    readonly bunnyMesh: Mesh;
    readonly bunnySkeleton: Skeleton;
    readonly textures: Readonly<Record<string, Texture2D>>;
    readonly blockMaterial: NodeMaterial;
    readonly rugMaterial: NodeMaterial;
    readonly dominoMaterial: NodeMaterial;
    readonly aimingMaterial: NodeMaterial;
    readonly rig: BunnyRigMetadata;
}

export interface BunnyRigJoint {
    readonly name: string;
    readonly nearestConfiguredParent: string | null;
    readonly bindWorldPosition: Vec3Tuple;
    readonly bindWorldMatrix: readonly number[];
    readonly translation: Vec3Tuple;
    readonly rotation: readonly [number, number, number, number];
    readonly width?: number;
    readonly height?: number;
    readonly depth?: number;
    readonly size?: number;
    readonly boxOffset: number;
    readonly axis: Vec3Tuple;
    readonly jointAxis?: Vec3Tuple;
}

export interface BunnyRigMetadata {
    readonly gameScale: number;
    readonly mass: number;
    readonly friction: number;
    readonly restitution: number;
    readonly root: string;
    readonly joints: readonly BunnyRigJoint[];
}

export interface BodyRecord {
    readonly id: number;
    readonly family: PuzzleFamily | "ground" | "wall" | "ragdoll";
    readonly body: PhysicsBody;
    readonly mesh: Mesh | SceneNode;
    readonly mass: number;
    readonly shape?: PhysicsShape;
    readonly scored: Set<number>;
    readonly audioTags: readonly string[];
    readonly popperIndex?: number;
    readonly initialInstanceCount?: number;
    active?: boolean;
    resetGeneration?: number;
}

export interface WorldState {
    readonly records: BodyRecord[];
    readonly bodiesByObject: Map<PhysicsBody, BodyRecord>;
    readonly aggregates: PhysicsAggregate[];
    readonly constraints: PhysicsConstraint[];
    readonly shapes: PhysicsShape[];
    readonly meshes: Mesh[];
    readonly poppers: BodyRecord[];
    nextBodyId: number;
}

export interface RagdollState {
    readonly records: BodyRecord[];
    readonly constraints: PhysicsConstraint[];
    readonly bones: Readonly<Record<string, Bone | undefined>>;
    readonly root: BodyRecord;
    readonly visualRoot: SceneNode;
    readonly restTransforms: ReadonlyArray<{
        readonly position: { readonly x: number; readonly y: number; readonly z: number };
        readonly rotation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
    }>;
    readonly jointBindPoses: ReadonlyArray<{
        readonly rotation: Quat;
        readonly colliderOffset: Vec3;
        readonly parentIndex: number;
        readonly parentLocalOffset: Vec3;
    }>;
    readonly poseOrder: readonly number[];
    readonly posePositions: Vec3[];
    readonly poseRotations: Quat[];
    launched: boolean;
}

export interface AudioState {
    disposed: boolean;
    engine: AudioEngine | null;
    context: BaseAudioContext | null;
    master: GainNode | null;
    route: AudioInputSource | null;
    buffers: Map<string, AudioBuffer>;
    voices: Set<AudioBufferSourceNode>;
    flight: AudioBufferSourceNode | null;
    flightGain: GainNode | null;
    flightStartedAt: number;
    projectileFlying: boolean;
    status: "loading" | "ready" | "unavailable";
    lastScoreMs: number;
    lastPopMs: number;
    readonly contactLastPlayMs: Map<string, number>;
    readonly contactPairTimes: Map<string, number>;
    readonly contactPoolIndices: Map<string, number>;
}

export interface ChargeState {
    pointerId: number;
    body: PhysicsBody;
    bodyIndex: number;
    point: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
    startedAt: number;
}

export interface PlayroomState {
    readonly canvas: HTMLCanvasElement;
    readonly engine: EngineContext;
    readonly scene: SceneContext;
    readonly physics: PhysicsWorld;
    readonly assets: PlayroomAssets;
    readonly camera: ArcRotateCamera;
    readonly freeCamera: FreeCamera;
    readonly shadow: ShadowGenerator;
    world: WorldState;
    ragdoll: RagdollState;
    audio: AudioState;
    phase: PlayroomPhase;
    underlyingPhase: Exclude<PlayroomPhase, "free" | "loading">;
    throwCount: number;
    score: number;
    scorePaused: boolean;
    scorePausedBeforeFree: boolean;
    poppersArmed: boolean;
    charge: ChargeState | null;
    settlingFrames: number;
    disposed: boolean;
    setCameraMode: (mode: "none" | "orbit" | "free") => void;
    cancelCharge: () => void;
    readonly cleanup: Array<() => void>;
    readonly timers: Set<number>;
    readonly retiredWorlds: Array<{ world: WorldState; frames: number }>;
}
