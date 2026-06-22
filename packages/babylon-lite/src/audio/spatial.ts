/**
 * 3D spatial audio — panner sub-node + audio-context listener.
 *
 * Faithful port of AudioV2's `_SpatialWebAudioSubNode` (`PannerNode` config,
 * distance-attenuation fallback math), `_SpatialWebAudioListener`/`…Fallback`
 * (the AudioContext listener), `_SpatialAudioAttacherComponent` (attach to a
 * world transform), and `_SpatialWebAudioUpdaterComponent` (per-frame update),
 * collapsed to pure state + standalone functions.
 *
 * Tree-shaking (Pillar 4): core sound/bus creation does **not** statically
 * import this module. Spatialization is opted into by calling one of the
 * exported functions (`enableSpatial`, `setSpatialPosition`,
 * `attachSpatialTarget`, …), which lazily build the panner sub-node and splice
 * it into the sound sub-graph. An app that never calls a spatial function pays
 * zero bytes for any of this code.
 *
 * Signal flow once enabled (mirrors AudioV2's sub-graph diagram):
 *
 * `instance._volumeNode` -\> `spatial._inputNode`
 *   -\> `PannerNode` (or attenuation `GainNode` when panning is disabled)
 *   -\> `graph._volume` -\> … -\> destination
 */

import { type AudioEngine } from "./audio-engine.js";
import { type RampParam, createRampParam, isRamping, setRampTarget } from "./audio-param.js";
import { type AudioSignal } from "./audio-signal.js";
import { rebuildSoundSubGraphHead } from "./sound-sub-graph.js";
import { type AudioGraphHost, type AudioGraphHostState } from "./host-types.js";
import { type Mat4, type Quat, type Vec3 } from "../math/types.js";
import { mat4Decompose } from "../math/mat4-decompose.js";

// ─── Public option/target types ──────────────────────────────────────

/** Which components of a target's world transform drive the spatial node. */
export type SpatialAttachmentType = "position" | "rotation" | "positionAndRotation";

/**
 * Anything exposing a world transform — typically a Lite `Mesh` or camera.
 * The spatial node reads `worldMatrix` each update; if `onDispose` is provided,
 * the node auto-detaches when the target is disposed.
 */
export interface SpatialTarget {
    /** Column-major world matrix of the target. */
    readonly worldMatrix: Mat4;
    /** Optional dispose signal — firing it auto-detaches the spatial node. */
    readonly onDispose?: AudioSignal<unknown>;
}

/** Spatial (3D) options for a sound or bus. All fields optional; defaults match Babylon.js. */
export interface SpatialSoundOptions {
    /** World position of the source. Defaults to `(0, 0, 0)`. */
    position?: Vec3;
    /** Facing direction of the source. Defaults to `(1, 0, 0)`. */
    orientation?: Vec3;
    /** Source rotation as a quaternion. When set, drives {@link orientation}. */
    rotationQuaternion?: Quat;
    /** Pan between left/right channels. Defaults to `true`. */
    panningEnabled?: boolean;
    /** Panning algorithm. Defaults to `"equalpower"`. */
    panningModel?: PanningModelType;
    /** Distance attenuation model. Defaults to `"linear"`. */
    distanceModel?: DistanceModelType;
    /** Reference distance for attenuation. Defaults to `1`. */
    minDistance?: number;
    /** Max distance (linear model). Defaults to `10000`. */
    maxDistance?: number;
    /** Attenuation roll-off factor. Defaults to `1`. */
    rolloffFactor?: number;
    /** Cone inner angle, in radians. Defaults to `2π`. */
    coneInnerAngle?: number;
    /** Cone outer angle, in radians. Defaults to `2π`. */
    coneOuterAngle?: number;
    /** Volume outside the cone outer angle. Defaults to `0`. */
    coneOuterVolume?: number;
    /** Follow a world transform's position and/or rotation. */
    attachedTo?: SpatialTarget;
    /** Which transform components to follow. Defaults to `"positionAndRotation"`. */
    attachmentType?: SpatialAttachmentType;
}

/** Spatial listener options. The listener orientation is derived from its rotation quaternion. */
export interface SpatialListenerOptions {
    /** Listener world position. Defaults to `(0, 0, 0)`. */
    position?: Vec3;
    /** Listener rotation. Drives the listener forward/up vectors. */
    rotationQuaternion?: Quat;
    /** Follow a world transform. */
    attachedTo?: SpatialTarget;
    /** Which transform components to follow. Defaults to `"positionAndRotation"`. */
    attachmentType?: SpatialAttachmentType;
}

// ─── Defaults (verbatim from AudioV2 `_SpatialAudioDefaults`) ─────────

const SpatialDefaults = {
    coneInnerAngle: 6.28318530718,
    coneOuterAngle: 6.28318530718,
    coneOuterVolume: 0,
    distanceModel: "linear" as DistanceModelType,
    maxDistance: 10000,
    minDistance: 1,
    panningEnabled: true,
    panningModel: "equalpower" as PanningModelType,
    rolloffFactor: 1,
} as const;

// Attachment-type bit flags (mirror AudioV2 `SpatialAudioAttachmentType`).
const ATTACH_POSITION = 1;
const ATTACH_ROTATION = 2;
const ATTACH_BOTH = 3;

const EPSILON = 0.001;

// ─── Small math helpers (mechanical equivalents of BJS calls) ────────

function r2d(radians: number): number {
    return (radians * 180) / Math.PI;
}

/**
 * Rotate vector `(vx, vy, vz)` by unit quaternion `q`. Mechanically equivalent
 * to AudioV2's `Vector3.TransformNormalToRef(v, Matrix.FromQuaternion(q))`.
 */
function rotateByQuat(q: Quat, vx: number, vy: number, vz: number): Vec3 {
    const tx = 2 * (q.y * vz - q.z * vy);
    const ty = 2 * (q.z * vx - q.x * vz);
    const tz = 2 * (q.x * vy - q.y * vx);
    return {
        x: vx + q.w * tx + (q.y * tz - q.z * ty),
        y: vy + q.w * ty + (q.z * tx - q.x * tz),
        z: vz + q.w * tz + (q.x * ty - q.y * tx),
    };
}

function vecEquals(a: Vec3, b: Vec3): boolean {
    return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON && Math.abs(a.z - b.z) < EPSILON;
}

function quatEquals(a: Quat, b: Quat): boolean {
    return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON && Math.abs(a.z - b.z) < EPSILON && Math.abs(a.w - b.w) < EPSILON;
}

function toAttachmentFlags(type: SpatialAttachmentType | undefined): number {
    switch (type) {
        case "position":
            return ATTACH_POSITION;
        case "rotation":
            return ATTACH_ROTATION;
        default:
            return ATTACH_BOTH;
    }
}

// ─── Panner sub-node ─────────────────────────────────────────────────

/** Panner sub-node state. Pure state — driven by the spatial functions. @internal */
export interface SpatialSubNode {
    /** @internal */ _engine: AudioEngine;
    /** Head node — playing instances connect here. @internal */ _inputNode: GainNode;
    /** @internal */ _panner: PannerNode;
    /** Attenuation gain used only when panning is disabled. @internal */ _attenuationNode: GainNode;
    /** @internal */ _attenuationRamp: RampParam;
    /** @internal */ _panningEnabled: boolean;
    /** @internal */ _positionX: RampParam;
    /** @internal */ _positionY: RampParam;
    /** @internal */ _positionZ: RampParam;
    /** @internal */ _orientationX: RampParam;
    /** @internal */ _orientationY: RampParam;
    /** @internal */ _orientationZ: RampParam;
    /** @internal */ _position: Vec3;
    /** @internal */ _orientation: Vec3;
    /** @internal */ _rotationQuaternion: Quat;
    /** @internal */ _lastPosition: Vec3;
    /** @internal */ _lastOrientation: Vec3;
    /** @internal */ _lastQuat: Quat;
    /** @internal */ _attached: SpatialTarget | null;
    /** @internal */ _attachmentType: number;
    /** @internal */ _attachUnsub: (() => void) | null;
    /** Registered into `engine._spatialUpdaters` while attached. @internal */ _update: () => void;
    /** @internal */ _dispose: () => void;
}

function createSpatialSubNode(engine: AudioEngine): SpatialSubNode {
    const ctx = engine._ctx;
    const inputNode = new GainNode(ctx);
    const attenuationNode = new GainNode(ctx);
    const panner = new PannerNode(ctx);

    const node: SpatialSubNode = {
        _engine: engine,
        _inputNode: inputNode,
        _panner: panner,
        _attenuationNode: attenuationNode,
        _attenuationRamp: createRampParam(attenuationNode.gain, engine),
        _panningEnabled: SpatialDefaults.panningEnabled,
        _positionX: createRampParam(panner.positionX, engine),
        _positionY: createRampParam(panner.positionY, engine),
        _positionZ: createRampParam(panner.positionZ, engine),
        _orientationX: createRampParam(panner.orientationX, engine),
        _orientationY: createRampParam(panner.orientationY, engine),
        _orientationZ: createRampParam(panner.orientationZ, engine),
        _position: { x: 0, y: 0, z: 0 },
        _orientation: { x: 1, y: 0, z: 0 },
        _rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
        _lastPosition: { x: NaN, y: NaN, z: NaN },
        _lastOrientation: { x: NaN, y: NaN, z: NaN },
        _lastQuat: { x: NaN, y: NaN, z: NaN, w: NaN },
        _attached: null,
        _attachmentType: ATTACH_BOTH,
        _attachUnsub: null,
        _update: () => updateAttachedSubNode(node),
        _dispose: () => disposeSpatialSubNode(node),
    };

    // Apply panner defaults (degrees on the node; radians in our API).
    panner.coneInnerAngle = r2d(SpatialDefaults.coneInnerAngle);
    panner.coneOuterAngle = r2d(SpatialDefaults.coneOuterAngle);
    panner.coneOuterGain = SpatialDefaults.coneOuterVolume;
    panner.distanceModel = SpatialDefaults.distanceModel;
    panner.maxDistance = SpatialDefaults.maxDistance;
    panner.refDistance = SpatialDefaults.minDistance;
    panner.rolloffFactor = SpatialDefaults.rolloffFactor;
    panner.panningModel = SpatialDefaults.panningModel;

    connectActiveInput(node);
    return node;
}

function connectActiveInput(node: SpatialSubNode): void {
    node._inputNode.disconnect();
    node._inputNode.connect(node._panningEnabled ? node._panner : node._attenuationNode);
}

/** Connect both possible output nodes downstream (mirrors AudioV2 `_connect`). */
function connectSpatialOutput(node: SpatialSubNode, downstream: AudioNode): void {
    node._panner.connect(downstream);
    node._attenuationNode.connect(downstream);
}

function disposeSpatialSubNode(node: SpatialSubNode): void {
    detachSubNode(node);
    node._inputNode.disconnect();
    node._attenuationNode.disconnect();
    node._panner.disconnect();
}

function updateSubNodePosition(node: SpatialSubNode): void {
    if (vecEquals(node._lastPosition, node._position)) {
        updateAttenuation(node);
        return;
    }
    setRampTarget(node._positionX, node._position.x);
    setRampTarget(node._positionY, node._position.y);
    setRampTarget(node._positionZ, node._position.z);
    node._lastPosition = { x: node._position.x, y: node._position.y, z: node._position.z };
    updateAttenuation(node);
}

function updateSubNodeRotation(node: SpatialSubNode): void {
    let changed = false;
    if (!quatEquals(node._lastQuat, node._rotationQuaternion)) {
        node._orientation = rotateByQuat(node._rotationQuaternion, 1, 0, 0);
        node._lastQuat = { x: node._rotationQuaternion.x, y: node._rotationQuaternion.y, z: node._rotationQuaternion.z, w: node._rotationQuaternion.w };
        changed = true;
    } else if (!vecEquals(node._lastOrientation, node._orientation)) {
        changed = true;
    }
    if (!changed) {
        return;
    }
    setRampTarget(node._orientationX, node._orientation.x);
    setRampTarget(node._orientationY, node._orientation.y);
    setRampTarget(node._orientationZ, node._orientation.z);
    node._lastOrientation = { x: node._orientation.x, y: node._orientation.y, z: node._orientation.z };
}

/**
 * Distance-attenuation fallback used while panning is disabled. Verbatim port
 * of AudioV2 `_SpatialWebAudioSubNode._updateAttenuation`.
 */
function updateAttenuation(node: SpatialSubNode): void {
    if (node._panningEnabled) {
        setRampTarget(node._attenuationRamp, 1);
        return;
    }

    const listenerPosition = node._engine._listener?._position ?? { x: 0, y: 0, z: 0 };
    const deltaX = node._position.x - listenerPosition.x;
    const deltaY = node._position.y - listenerPosition.y;
    const deltaZ = node._position.z - listenerPosition.z;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
    const minDistance = Math.max(node._panner.refDistance, 0);
    const rolloffFactor = node._panner.rolloffFactor;
    let attenuation = 1;

    switch (node._panner.distanceModel) {
        case "linear": {
            const maxDistance = Math.max(node._panner.maxDistance, minDistance);
            const clampedDistance = Math.min(Math.max(distance, minDistance), maxDistance);
            attenuation = maxDistance === minDistance ? (distance <= minDistance ? 1 : 0) : 1 - (rolloffFactor * (clampedDistance - minDistance)) / (maxDistance - minDistance);
            break;
        }
        case "inverse":
            attenuation = minDistance === 0 ? 0 : minDistance / (minDistance + rolloffFactor * (Math.max(distance, minDistance) - minDistance));
            break;
        case "exponential":
            attenuation = minDistance === 0 ? 0 : Math.pow(Math.max(distance, minDistance) / minDistance, -rolloffFactor);
            break;
    }

    setRampTarget(node._attenuationRamp, Math.min(Math.max(attenuation, 0), 1));
}

function setSubNodePanningEnabled(node: SpatialSubNode, value: boolean): void {
    if (node._panningEnabled === value) {
        return;
    }
    node._panningEnabled = value;
    connectActiveInput(node);
    updateAttenuation(node);
}

function configureSubNode(node: SpatialSubNode, opts: SpatialSoundOptions): void {
    const panner = node._panner;
    if (opts.coneInnerAngle !== undefined) {
        panner.coneInnerAngle = r2d(opts.coneInnerAngle);
    }
    if (opts.coneOuterAngle !== undefined) {
        panner.coneOuterAngle = r2d(opts.coneOuterAngle);
    }
    if (opts.coneOuterVolume !== undefined) {
        panner.coneOuterGain = opts.coneOuterVolume;
    }
    if (opts.distanceModel !== undefined) {
        panner.distanceModel = opts.distanceModel;
    }
    if (opts.maxDistance !== undefined) {
        panner.maxDistance = opts.maxDistance;
    }
    if (opts.minDistance !== undefined) {
        panner.refDistance = opts.minDistance;
    }
    if (opts.rolloffFactor !== undefined) {
        panner.rolloffFactor = opts.rolloffFactor;
    }
    if (opts.panningModel !== undefined) {
        panner.panningModel = opts.panningModel;
    }
    if (opts.panningEnabled !== undefined) {
        setSubNodePanningEnabled(node, opts.panningEnabled);
    }
    if (opts.position) {
        node._position = { x: opts.position.x, y: opts.position.y, z: opts.position.z };
    }
    if (opts.rotationQuaternion) {
        node._rotationQuaternion = { x: opts.rotationQuaternion.x, y: opts.rotationQuaternion.y, z: opts.rotationQuaternion.z, w: opts.rotationQuaternion.w };
    } else if (opts.orientation) {
        node._orientation = { x: opts.orientation.x, y: opts.orientation.y, z: opts.orientation.z };
        node._lastQuat = { x: node._rotationQuaternion.x, y: node._rotationQuaternion.y, z: node._rotationQuaternion.z, w: node._rotationQuaternion.w };
    }
    updateSubNodePosition(node);
    updateSubNodeRotation(node);
}

// ─── Attacher (shared by sub-node and listener) ──────────────────────

function attachSubNode(node: SpatialSubNode, target: SpatialTarget, type: SpatialAttachmentType | undefined): void {
    detachSubNode(node);
    node._attached = target;
    node._attachmentType = toAttachmentFlags(type);
    if (target.onDispose) {
        node._attachUnsub = target.onDispose.add(() => detachSubNode(node));
    }
    node._engine._spatialUpdaters.add(node._update);
    updateAttachedSubNode(node);
}

function detachSubNode(node: SpatialSubNode): void {
    node._attachUnsub?.();
    node._attachUnsub = null;
    node._attached = null;
    node._engine._spatialUpdaters.delete(node._update);
}

function updateAttachedSubNode(node: SpatialSubNode): void {
    const target = node._attached;
    if (!target) {
        return;
    }
    const { translation, rotation } = mat4Decompose(target.worldMatrix);
    if (node._attachmentType & ATTACH_POSITION) {
        node._position = translation;
        updateSubNodePosition(node);
    }
    if (node._attachmentType & ATTACH_ROTATION) {
        node._rotationQuaternion = rotation;
        updateSubNodeRotation(node);
    }
}

// ─── Sub-graph splicing ──────────────────────────────────────────────

/**
 * Lazily build the panner sub-node and splice it into the host's sub-graph,
 * reconnecting any live instances. Idempotent.
 */
function ensureSpatialSubNode(host: AudioGraphHostState): SpatialSubNode {
    const graph = host._graph;
    if (graph._spatial) {
        // The graph stores a structural slot; this feature module owns the full node.
        return graph._spatial as SpatialSubNode;
    }

    ensureSpatialListener(host._engine);

    const node = createSpatialSubNode(host._engine);
    connectSpatialOutput(node, graph._volume);
    graph._spatial = node;

    // Recompute the head and reconnect live instances (handles spatial+stereo parallel routing).
    rebuildSoundSubGraphHead(graph, host._instances);

    return node;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Enables (or reconfigures) 3D spatial audio on a sound or bus, building the
 * panner sub-node on first use. Pulls the spatial module only when called.
 * @param host - A `StaticSound` or `AudioBus`.
 * @param options - Spatial options (position, distance model, cone, attach, …).
 */
export function enableSpatial(host: AudioGraphHost, options: SpatialSoundOptions = {}): void {
    const node = ensureSpatialSubNode(host);
    configureSubNode(node, options);
    if (options.attachedTo) {
        attachSubNode(node, options.attachedTo, options.attachmentType);
    }
}

/**
 * Sets the world position of a spatial sound/bus, building the panner sub-node
 * on first use.
 * @param host - A `StaticSound` or `AudioBus`.
 * @param position - World-space position.
 */
export function setSpatialPosition(host: AudioGraphHost, position: Vec3): void {
    const node = ensureSpatialSubNode(host);
    node._position = { x: position.x, y: position.y, z: position.z };
    updateSubNodePosition(node);
}

/**
 * Sets the facing orientation of a spatial sound/bus.
 * @param host - A `StaticSound` or `AudioBus`.
 * @param orientation - Facing direction.
 */
export function setSpatialOrientation(host: AudioGraphHost, orientation: Vec3): void {
    const node = ensureSpatialSubNode(host);
    node._orientation = { x: orientation.x, y: orientation.y, z: orientation.z };
    node._lastQuat = { x: node._rotationQuaternion.x, y: node._rotationQuaternion.y, z: node._rotationQuaternion.z, w: node._rotationQuaternion.w };
    updateSubNodeRotation(node);
}

/**
 * Attaches a spatial sound/bus — or the engine's listener — to a world
 * transform. The position/rotation follow the target on each
 * {@link updateSpatialAudio} (or auto-update) tick.
 * @param target - A `StaticSound`, `AudioBus`, or the `AudioEngine` (listener).
 * @param worldTarget - The transform to follow.
 * @param type - Which transform components to follow. Defaults to `"positionAndRotation"`.
 */
export function attachSpatialTarget(target: AudioGraphHost | AudioEngine, worldTarget: SpatialTarget, type?: SpatialAttachmentType): void {
    if (isEngine(target)) {
        const listener = ensureSpatialListener(target);
        attachListener(listener, worldTarget, type);
        return;
    }
    const node = ensureSpatialSubNode(target);
    attachSubNode(node, worldTarget, type);
}

/**
 * Detaches a spatial sound/bus — or the engine's listener — from its world
 * transform.
 * @param target - A `StaticSound`, `AudioBus`, or the `AudioEngine` (listener).
 */
export function detachSpatialTarget(target: AudioGraphHost | AudioEngine): void {
    if (isEngine(target)) {
        if (target._listener) {
            detachListener(target._listener as SpatialListener);
        }
        return;
    }
    if (target._graph._spatial) {
        detachSubNode(target._graph._spatial as SpatialSubNode);
    }
}

/**
 * Configures the spatial listener (the "ears"). Builds it on first use.
 * @param engine - The audio engine.
 * @param options - Listener options.
 */
export function setSpatialListener(engine: AudioEngine, options: SpatialListenerOptions = {}): void {
    const listener = ensureSpatialListener(engine);
    if (options.position) {
        listener._position = { x: options.position.x, y: options.position.y, z: options.position.z };
        updateListenerPosition(listener);
    }
    if (options.rotationQuaternion) {
        listener._rotationQuaternion = { x: options.rotationQuaternion.x, y: options.rotationQuaternion.y, z: options.rotationQuaternion.z, w: options.rotationQuaternion.w };
        updateListenerRotation(listener);
    }
    if (options.attachedTo) {
        attachListener(listener, options.attachedTo, options.attachmentType);
    }
}

/** Sets the listener world position, building the listener on first use. */
export function setSpatialListenerPosition(engine: AudioEngine, position: Vec3): void {
    const listener = ensureSpatialListener(engine);
    listener._position = { x: position.x, y: position.y, z: position.z };
    updateListenerPosition(listener);
}

/**
 * Pumps one spatial update for every attached node and the listener. Call this
 * from your render loop, or enable {@link setSpatialAutoUpdate}.
 * @param engine - The audio engine.
 */
export function updateSpatialAudio(engine: AudioEngine): void {
    for (const update of engine._spatialUpdaters) {
        update();
    }
}

/**
 * Toggles a `requestAnimationFrame`-driven loop that calls
 * {@link updateSpatialAudio} automatically.
 * @param engine - The audio engine.
 * @param enabled - Whether to run the auto-update loop.
 * @param minUpdateMs - Minimum time between updates, in milliseconds. Defaults to `0`.
 */
export function setSpatialAutoUpdate(engine: AudioEngine, enabled: boolean, minUpdateMs = 0): void {
    engine._spatialAutoStop?.();
    engine._spatialAutoStop = null;
    if (!enabled || typeof requestAnimationFrame !== "function") {
        return;
    }

    let active = true;
    let rafId = 0;
    let lastTime = 0;

    const tick = (): void => {
        if (!active) {
            return;
        }
        let skip = false;
        if (minUpdateMs > 0) {
            const now = typeof performance !== "undefined" ? performance.now() : Date.now();
            if (lastTime && now - lastTime < minUpdateMs) {
                skip = true;
            } else {
                lastTime = now;
            }
        }
        if (!skip) {
            updateSpatialAudio(engine);
        }
        rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    const stop = (): void => {
        active = false;
        if (typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(rafId);
        }
    };
    engine._spatialAutoStop = stop;
    engine._disposers.push(stop);
}

function isEngine(target: AudioGraphHost | AudioEngine): target is AudioEngine {
    return "_spatialUpdaters" in target;
}

// ─── Spatial listener ────────────────────────────────────────────────

/** Spatial listener state (the AudioContext listener). Pure state. @internal */
export interface SpatialListener {
    /** @internal */ _engine: AudioEngine;
    /** @internal */ _listener: AudioListener;
    /** Whether the listener exposes AudioParam properties (vs the legacy setters). @internal */ _hasParams: boolean;
    /** @internal */ _position: Vec3;
    /** @internal */ _rotationQuaternion: Quat;
    /** @internal */ _lastPosition: Vec3;
    /** @internal */ _lastQuat: Quat;
    /** @internal */ _positionX: RampParam | null;
    /** @internal */ _positionY: RampParam | null;
    /** @internal */ _positionZ: RampParam | null;
    /** @internal */ _forwardX: RampParam | null;
    /** @internal */ _forwardY: RampParam | null;
    /** @internal */ _forwardZ: RampParam | null;
    /** @internal */ _upX: RampParam | null;
    /** @internal */ _upY: RampParam | null;
    /** @internal */ _upZ: RampParam | null;
    /** @internal */ _attached: SpatialTarget | null;
    /** @internal */ _attachmentType: number;
    /** @internal */ _attachUnsub: (() => void) | null;
    /** @internal */ _update: () => void;
    /** @internal */ _dispose: () => void;
}

/** Builds the engine's spatial listener on first use (mirrors AudioV2's lazy listener). @internal */
export function ensureSpatialListener(engine: AudioEngine): SpatialListener {
    if (engine._listener) {
        // The engine stores a structural slot; this feature module owns the full listener.
        return engine._listener as SpatialListener;
    }

    const al = engine._ctx.listener;
    const hasParams = !!(al.positionX && al.forwardX && al.upX);

    const listener: SpatialListener = {
        _engine: engine,
        _listener: al,
        _hasParams: hasParams,
        _position: { x: 0, y: 0, z: 0 },
        _rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
        _lastPosition: { x: NaN, y: NaN, z: NaN },
        _lastQuat: { x: NaN, y: NaN, z: NaN, w: NaN },
        _positionX: hasParams ? createRampParam(al.positionX, engine) : null,
        _positionY: hasParams ? createRampParam(al.positionY, engine) : null,
        _positionZ: hasParams ? createRampParam(al.positionZ, engine) : null,
        _forwardX: hasParams ? createRampParam(al.forwardX, engine) : null,
        _forwardY: hasParams ? createRampParam(al.forwardY, engine) : null,
        _forwardZ: hasParams ? createRampParam(al.forwardZ, engine) : null,
        _upX: hasParams ? createRampParam(al.upX, engine) : null,
        _upY: hasParams ? createRampParam(al.upY, engine) : null,
        _upZ: hasParams ? createRampParam(al.upZ, engine) : null,
        _attached: null,
        _attachmentType: ATTACH_BOTH,
        _attachUnsub: null,
        _update: () => updateAttachedListener(listener),
        _dispose: () => disposeSpatialListener(listener),
    };

    engine._listener = listener;
    return listener;
}

function updateListenerPosition(listener: SpatialListener): void {
    if (vecEquals(listener._lastPosition, listener._position)) {
        return;
    }
    const p = listener._position;
    if (listener._hasParams) {
        // Skip while a ramp is in flight for an attached listener (another update is coming).
        if (listener._attached && (isRamping(listener._positionX!) || isRamping(listener._positionY!) || isRamping(listener._positionZ!))) {
            return;
        }
        setRampTarget(listener._positionX!, p.x);
        setRampTarget(listener._positionY!, p.y);
        setRampTarget(listener._positionZ!, p.z);
    } else {
        listener._listener.setPosition(p.x, p.y, p.z);
    }
    listener._lastPosition = { x: p.x, y: p.y, z: p.z };
}

function updateListenerRotation(listener: SpatialListener): void {
    if (quatEquals(listener._lastQuat, listener._rotationQuaternion)) {
        return;
    }
    // NB: the Web Audio API is right-handed — forward is -Z, matching AudioV2.
    const forward = rotateByQuat(listener._rotationQuaternion, 0, 0, -1);
    const up = rotateByQuat(listener._rotationQuaternion, 0, 1, 0);
    if (listener._hasParams) {
        if (
            listener._attached &&
            (isRamping(listener._forwardX!) ||
                isRamping(listener._forwardY!) ||
                isRamping(listener._forwardZ!) ||
                isRamping(listener._upX!) ||
                isRamping(listener._upY!) ||
                isRamping(listener._upZ!))
        ) {
            return;
        }
        setRampTarget(listener._forwardX!, forward.x);
        setRampTarget(listener._forwardY!, forward.y);
        setRampTarget(listener._forwardZ!, forward.z);
        setRampTarget(listener._upX!, up.x);
        setRampTarget(listener._upY!, up.y);
        setRampTarget(listener._upZ!, up.z);
    } else {
        listener._listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
    listener._lastQuat = { x: listener._rotationQuaternion.x, y: listener._rotationQuaternion.y, z: listener._rotationQuaternion.z, w: listener._rotationQuaternion.w };
}

function attachListener(listener: SpatialListener, target: SpatialTarget, type: SpatialAttachmentType | undefined): void {
    detachListener(listener);
    listener._attached = target;
    listener._attachmentType = toAttachmentFlags(type);
    if (target.onDispose) {
        listener._attachUnsub = target.onDispose.add(() => detachListener(listener));
    }
    listener._engine._spatialUpdaters.add(listener._update);
    updateAttachedListener(listener);
}

function detachListener(listener: SpatialListener): void {
    listener._attachUnsub?.();
    listener._attachUnsub = null;
    listener._attached = null;
    listener._engine._spatialUpdaters.delete(listener._update);
}

function updateAttachedListener(listener: SpatialListener): void {
    const target = listener._attached;
    if (!target) {
        return;
    }
    const { translation, rotation } = mat4Decompose(target.worldMatrix);
    if (listener._attachmentType & ATTACH_POSITION) {
        listener._position = translation;
        updateListenerPosition(listener);
    }
    if (listener._attachmentType & ATTACH_ROTATION) {
        listener._rotationQuaternion = rotation;
        updateListenerRotation(listener);
    }
}

function disposeSpatialListener(listener: SpatialListener): void {
    detachListener(listener);
    listener._engine._listener = null;
}
