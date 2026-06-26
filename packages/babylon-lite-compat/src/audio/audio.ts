/**
 * Babylon.js AudioV2 (`AudioEngineV2` and friends) implemented on top of the
 * Babylon Lite audio port.
 *
 * The Lite audio API is pure state + standalone functions (`createAudioEngineAsync`,
 * `playSound`, `setBusVolume`, …); Babylon.js AudioV2 is a class hierarchy of
 * `AbstractAudioNode` subclasses with mutable properties. This module reproduces
 * the BJS class names, inheritance chain, and public members exactly, holding the
 * corresponding Lite handle as `_lite` and proxying property get/set + methods to
 * the Lite functions.
 *
 * Inheritance chain mirrored from `@babylonjs/core`:
 *
 *   AbstractAudioNode
 *     └─ AbstractNamedAudioNode
 *          └─ AbstractAudioOutNode            (volume / analyzer)
 *               ├─ AbstractAudioBus → AudioBus / MainAudioBus
 *               └─ AbstractSoundSource
 *                    └─ AbstractSound → StaticSound / StreamingSound
 *
 * No module-level Web Audio allocation happens at import time, so a consumer that
 * never touches audio pays nothing.
 */

import {
    createAudioEngineAsync,
    disposeAudioEngine,
    unlockAudioEngineAsync,
    setMasterVolume,
    getMasterVolume,
    createSoundAsync,
    playSound,
    pauseSound,
    resumeSound,
    stopSound,
    disposeSound,
    setSoundVolume,
    createStreamingSoundAsync,
    preloadStreamingInstanceAsync,
    preloadStreamingInstancesAsync,
    playStreamingSound,
    pauseStreamingSound,
    resumeStreamingSound,
    stopStreamingSound,
    disposeStreamingSound,
    setStreamingSoundVolume,
    createAudioBusAsync,
    disposeAudioBus,
    setBusVolume,
    createSoundBufferAsync,
    createSoundSourceAsync,
    createMicrophoneSoundSourceAsync,
    setSoundSourceVolume,
    disposeSoundSource,
    enableSpatial,
    setSpatialPosition,
    setSpatialOrientation,
    setSpatialListener,
    setSpatialListenerPosition,
    updateSpatialAudio,
    enableStereo,
    setStereoPan,
    enableAnalyzer,
    getByteFrequencyData,
    getFloatFrequencyData,
    getByteTimeDomainData,
    getFloatTimeDomainData,
} from "babylon-lite";
import type {
    AudioEngine as LiteAudioEngine,
    AudioEngineOptions as LiteAudioEngineOptions,
    StaticSound as LiteStaticSound,
    StreamingSound as LiteStreamingSound,
    AudioBus as LiteAudioBus,
    MainBus as LiteMainBus,
    SoundBuffer as LiteSoundBuffer,
    AudioInputSource as LiteAudioInputSource,
    PrimaryAudioBus as LitePrimaryAudioBus,
    StaticSoundOptions as LiteStaticSoundOptions,
    StreamingSoundOptions as LiteStreamingSoundOptions,
    SpatialSoundOptions as LiteSpatialSoundOptions,
    AudioGraphHost as LiteHost,
} from "babylon-lite";

import { Observable } from "../misc/observable.js";
import { Vector3 } from "../math/vector.js";
import { Quaternion } from "../math/quaternion.js";
import { unsupported } from "../error.js";
import { SpatialAudioAttachmentType, toLiteRamp, type SoundState, type AudioAnalyzerFFTSizeType, type AudioEngineV2State, type IAudioParameterRampOptions } from "./audio-enums.js";

/** A bus a sound or bus can output to (mirrors AudioV2 `PrimaryAudioBus`). */
export type PrimaryAudioBus = MainAudioBus | AudioBus;

/** A node that can have a world transform (subset of the compat `Node`). */
export interface SpatialNodeLike {
    getAbsolutePosition?: () => { x: number; y: number; z: number };
    absolutePosition?: { x: number; y: number; z: number };
    position?: { x: number; y: number; z: number };
    rotationQuaternion?: { x: number; y: number; z: number; w: number } | null;
}

function readNodePosition(node: SpatialNodeLike | null): { x: number; y: number; z: number } | null {
    if (!node) {
        return null;
    }
    return node.getAbsolutePosition?.() ?? node.absolutePosition ?? node.position ?? null;
}

function readNodeRotation(node: SpatialNodeLike | null): { x: number; y: number; z: number; w: number } | null {
    return node?.rotationQuaternion ?? null;
}

// ───────────────────────────── Options interfaces ────────────────────────────

/** Babylon.js `IAudioEngineV2Options` (subset backed by Lite). */
export interface IAudioEngineV2Options {
    /** Default parameter ramp duration, in seconds. Defaults to `0.01`. */
    parameterRampDuration: number;
    /** Initial output volume. Defaults to `1`. */
    volume: number;
}

/** Babylon.js `IWebAudioEngineOptions`. */
export interface IWebAudioEngineOptions extends IAudioEngineV2Options {
    /** An existing audio context (pass an `OfflineAudioContext` for headless rendering). */
    audioContext: BaseAudioContext;
    /** Auto-resume the context on user interaction. Defaults to `true`. */
    resumeOnInteraction: boolean;
    /** Auto-resume the context if the browser pauses playback. Defaults to `true`. */
    resumeOnPause: boolean;
    /** Retry interval (ms) for `resumeOnPause`. Defaults to `1000`. */
    resumeOnPauseRetryInterval: number;
}

/** Babylon.js `IVolumeAudioOptions`. */
export interface IVolumeAudioOptions {
    /** Volume / gain. Defaults to `1`. */
    volume: number;
}

/** Babylon.js `IAudioAnalyzerOptions`. */
export interface IAudioAnalyzerOptions {
    /** Build the analyzer immediately. Defaults to `false`. */
    analyzerEnabled: boolean;
    /** FFT window size. Defaults to `2048`. */
    analyzerFFTSize: AudioAnalyzerFFTSizeType;
    /** Minimum dB. Defaults to `-100`. */
    analyzerMinDecibels: number;
    /** Maximum dB. Defaults to `-30`. */
    analyzerMaxDecibels: number;
    /** Time-averaging constant `[0, 1]`. Defaults to `0.8`. */
    analyzerSmoothing: number;
}

/** Babylon.js `IStereoAudioOptions`. */
export interface IStereoAudioOptions {
    /** Build stereo immediately. Defaults to `false`. */
    stereoEnabled: boolean;
    /** Pan `-1` (left) to `1` (right). Defaults to `0`. */
    stereoPan: number;
}

/** Babylon.js `ISpatialAudioOptions` (subset backed by Lite). */
export interface ISpatialAudioOptions {
    /** Build spatial immediately. */
    spatialEnabled: boolean;
    /** Cone inner angle, radians. */
    spatialConeInnerAngle: number;
    /** Cone outer angle, radians. */
    spatialConeOuterAngle: number;
    /** Volume outside the cone. */
    spatialConeOuterVolume: number;
    /** Distance attenuation model. */
    spatialDistanceModel: DistanceModelType;
    /** Max distance. */
    spatialMaxDistance: number;
    /** Reference / min distance. */
    spatialMinDistance: number;
    /** Source facing direction. */
    spatialOrientation: Vector3;
    /** Enable left/right panning. */
    spatialPanningEnabled: boolean;
    /** Panning algorithm. */
    spatialPanningModel: PanningModelType;
    /** Source world position. */
    spatialPosition: Vector3;
    /** Roll-off factor. */
    spatialRolloffFactor: number;
    /** Source rotation quaternion. */
    spatialRotationQuaternion: Quaternion;
}

/** Babylon.js `IStaticSoundBufferOptions`. */
export interface IStaticSoundBufferOptions {
    /** Skip codec checks when the source is a URL list. Defaults to `false`. */
    skipCodecCheck: boolean;
}

/** Babylon.js `IAbstractSoundOptions` (subset). */
export interface IAbstractSoundOptions extends Partial<IVolumeAudioOptions> {
    /** Play immediately once ready. Defaults to `false`. */
    autoplay?: boolean;
    /** Maximum simultaneous instances. Defaults to `Infinity`. */
    maxInstances?: number;
    /** Loop playback. Defaults to `false`. */
    loop?: boolean;
    /** Start offset in seconds. Defaults to `0`. */
    startOffset?: number;
    /** Output bus. */
    outBus?: PrimaryAudioBus;
}

/** Babylon.js `IStaticSoundOptions`. */
export interface IStaticSoundOptions extends IAbstractSoundOptions, Partial<IStaticSoundBufferOptions> {
    /** Play duration in seconds (`0` = full). */
    duration?: number;
    /** Loop end, seconds. */
    loopEnd?: number;
    /** Loop start, seconds. */
    loopStart?: number;
    /** Detune in cents. */
    pitch?: number;
    /** Playback rate multiplier. */
    playbackRate?: number;
}

/** Babylon.js `IStaticSoundPlayOptions`. */
export interface IStaticSoundPlayOptions {
    /** Loop playback. */
    loop?: boolean;
    /** Start offset in seconds. */
    startOffset?: number;
    /** Play duration in seconds. */
    duration?: number;
    /** Loop start, seconds. */
    loopStart?: number;
    /** Loop end, seconds. */
    loopEnd?: number;
    /** Per-instance volume. */
    volume?: number;
    /** Delay before playback, seconds. */
    waitTime?: number;
}

/** Babylon.js `IStaticSoundStopOptions`. */
export interface IStaticSoundStopOptions {
    /** Delay before stopping, seconds. */
    waitTime?: number;
}

/** Babylon.js `IStaticSoundCloneOptions`. */
export interface IStaticSoundCloneOptions {
    /** Clone the underlying buffer (Lite reuses the same buffer). Defaults to `false`. */
    cloneBuffer?: boolean;
    /** Output bus for the clone. */
    outBus?: PrimaryAudioBus | null;
}

/** Babylon.js `IStreamingSoundOptions`. */
export interface IStreamingSoundOptions extends IAbstractSoundOptions {
    /** Number of instances to preload. Defaults to `1`. */
    preloadCount?: number;
}

/** Babylon.js `IStreamingSoundPlayOptions`. */
export interface IStreamingSoundPlayOptions {
    /** Loop playback. */
    loop?: boolean;
    /** Start offset in seconds. */
    startOffset?: number;
    /** Per-instance volume. */
    volume?: number;
}

/** Babylon.js `IAudioBusOptions` (subset). */
export interface IAudioBusOptions extends Partial<IVolumeAudioOptions> {
    /** Output bus. Defaults to the engine's default main bus. */
    outBus?: PrimaryAudioBus;
}

/** Babylon.js `IMainAudioBusOptions`. */
export interface IMainAudioBusOptions extends Partial<IVolumeAudioOptions> {}

/** Babylon.js `ISoundSourceOptions` (subset). */
export interface ISoundSourceOptions extends Partial<IVolumeAudioOptions> {
    /** Name. */
    name?: string;
    /** Output bus. */
    outBus?: PrimaryAudioBus | null;
    /** Auto-assign the default main bus when `outBus` is null. */
    outBusAutoDefault?: boolean;
}

// ───────────────────────────── Node base classes ─────────────────────────────

/** Babylon.js `AbstractAudioNode` — the root of the AudioV2 node hierarchy. */
export abstract class AbstractAudioNode {
    /** The engine that owns this node. */
    public readonly engine: AudioEngineV2;
    /** Fires when this node is disposed. */
    public readonly onDisposeObservable = new Observable<AbstractAudioNode>();

    protected constructor(engine: AudioEngineV2) {
        this.engine = engine;
    }

    /** Disposes the node. */
    public dispose(): void {
        this.onDisposeObservable.notifyObservers(this);
        this.onDisposeObservable.clear();
    }

    /** The class name (mirrors Babylon.js `getClassName()`). */
    public abstract getClassName(): string;
}

/** Payload for `AbstractNamedAudioNode.onNameChangedObservable`. */
export interface IAudioNodeNameChange {
    /** The new name. */
    newName: string;
    /** The previous name. */
    oldName: string;
    /** The node whose name changed. */
    node: AbstractNamedAudioNode;
}

/** Babylon.js `AbstractNamedAudioNode` — an `AbstractAudioNode` with a mutable name. */
export abstract class AbstractNamedAudioNode extends AbstractAudioNode {
    /** Fires when {@link name} changes. */
    public readonly onNameChangedObservable = new Observable<IAudioNodeNameChange>();
    private _name: string;

    protected constructor(name: string, engine: AudioEngineV2) {
        super(engine);
        this._name = name;
        engine._addNode(this);
    }

    /** The node name. */
    public get name(): string {
        return this._name;
    }
    public set name(value: string) {
        const oldName = this._name;
        if (oldName === value) {
            return;
        }
        this._name = value;
        this.onNameChangedObservable.notifyObservers({ newName: value, oldName, node: this });
    }

    public override dispose(): void {
        this.engine._removeNode(this);
        this.onNameChangedObservable.clear();
        super.dispose();
    }
}

/**
 * Babylon.js `AbstractAudioOutNode` — a named node with a volume and a lazily
 * created analyzer.
 */
export abstract class AbstractAudioOutNode extends AbstractNamedAudioNode {
    protected _volume = 1;
    private _analyzer: AbstractAudioAnalyzer | null = null;

    /** The node output volume. */
    public get volume(): number {
        return this._volume;
    }
    public set volume(value: number) {
        this.setVolume(value);
    }

    /** Lazily-built audio analyzer for this node's output. */
    public get analyzer(): AbstractAudioAnalyzer {
        return (this._analyzer ??= new AbstractAudioAnalyzer(this._spatialHost()));
    }

    /** Sets the volume, optionally ramping. */
    public setVolume(value: number, options?: Partial<IAudioParameterRampOptions> | null): void {
        this._volume = value;
        this._applyVolume(value, options);
    }

    public override dispose(): void {
        this._analyzer?.dispose();
        this._analyzer = null;
        super.dispose();
    }

    /** @internal Apply the volume to the backing Lite handle. */
    protected abstract _applyVolume(value: number, options?: Partial<IAudioParameterRampOptions> | null): void;
    /** @internal The Lite host used to back spatial/stereo/analyzer sub-nodes. */
    protected abstract _spatialHost(): LiteHost;
}

// ───────────────────────────── Sub-properties ────────────────────────────────

/** Babylon.js `AbstractStereoAudio` — the `sound.stereo` / `bus.stereo` sub-property. */
export class AbstractStereoAudio {
    private readonly _host: LiteHost;
    private _pan = 0;
    private _enabled = false;

    /** @internal */
    public constructor(host: LiteHost) {
        this._host = host;
    }

    /** Stereo pan, `-1` (left) to `1` (right). */
    public get pan(): number {
        return this._pan;
    }
    public set pan(value: number) {
        this._pan = value;
        if (!this._enabled) {
            enableStereo(this._host, { pan: value });
            this._enabled = true;
        } else {
            setStereoPan(this._host, value);
        }
    }
}

/** Babylon.js `AbstractAudioAnalyzer` — the `sound.analyzer` / `bus.analyzer` sub-property. */
export class AbstractAudioAnalyzer {
    private readonly _host: LiteHost;
    private _fftSize: AudioAnalyzerFFTSizeType = 2048;
    private _minDecibels = -100;
    private _maxDecibels = -30;
    private _smoothing = 0.8;
    private _enabled = false;

    /** @internal */
    public constructor(host: LiteHost) {
        this._host = host;
    }

    /** FFT window size. */
    public get fftSize(): AudioAnalyzerFFTSizeType {
        return this._fftSize;
    }
    public set fftSize(value: AudioAnalyzerFFTSizeType) {
        this._fftSize = value;
        this._reapply();
    }

    /** Number of frequency bins (`fftSize / 2`). */
    public get frequencyBinCount(): number {
        return this._fftSize / 2;
    }

    /** Whether the analyzer is enabled. */
    public get isEnabled(): boolean {
        return this._enabled;
    }

    /** Minimum dB. */
    public get minDecibels(): number {
        return this._minDecibels;
    }
    public set minDecibels(value: number) {
        this._minDecibels = value;
        this._reapply();
    }

    /** Maximum dB. */
    public get maxDecibels(): number {
        return this._maxDecibels;
    }
    public set maxDecibels(value: number) {
        this._maxDecibels = value;
        this._reapply();
    }

    /** Time-averaging constant `[0, 1]`. */
    public get smoothing(): number {
        return this._smoothing;
    }
    public set smoothing(value: number) {
        this._smoothing = value;
        this._reapply();
    }

    /** Builds (enables) the analyzer tap. */
    public async enableAsync(): Promise<void> {
        this._apply();
    }

    /** Returns the byte frequency-domain data. Empty when disabled. */
    public getByteFrequencyData(): Uint8Array {
        if (!this._enabled) {
            return new Uint8Array(0);
        }
        const out = new Uint8Array(this.frequencyBinCount);
        getByteFrequencyData(this._host, out);
        return out;
    }

    /** Returns the float frequency-domain data. Empty when disabled. */
    public getFloatFrequencyData(): Float32Array {
        if (!this._enabled) {
            return new Float32Array(0);
        }
        const out = new Float32Array(this.frequencyBinCount);
        getFloatFrequencyData(this._host, out);
        return out;
    }

    /** Returns the byte time-domain data. Empty when disabled. */
    public getByteTimeDomainData(): Uint8Array {
        if (!this._enabled) {
            return new Uint8Array(0);
        }
        const out = new Uint8Array(this._fftSize);
        getByteTimeDomainData(this._host, out);
        return out;
    }

    /** Returns the float time-domain data. Empty when disabled. */
    public getFloatTimeDomainData(): Float32Array {
        if (!this._enabled) {
            return new Float32Array(0);
        }
        const out = new Float32Array(this._fftSize);
        getFloatTimeDomainData(this._host, out);
        return out;
    }

    /** Disposes the analyzer (Lite tears it down with the host). */
    public dispose(): void {
        this._enabled = false;
    }

    private _apply(): void {
        enableAnalyzer(this._host, {
            fftSize: this._fftSize,
            minDecibels: this._minDecibels,
            maxDecibels: this._maxDecibels,
            smoothing: this._smoothing,
        });
        this._enabled = true;
    }

    private _reapply(): void {
        if (this._enabled) {
            this._apply();
        }
    }
}

/** Babylon.js `AbstractSpatialAudio` — the `sound.spatial` / `bus.spatial` sub-property. */
export class AbstractSpatialAudio {
    private readonly _host: LiteHost;
    private _enabled = false;

    private _position = new Vector3(0, 0, 0);
    private _orientation = new Vector3(1, 0, 0);
    private _rotationQuaternion = new Quaternion(0, 0, 0, 1);

    /** Cone inner angle, radians. */
    public coneInnerAngle = 2 * Math.PI;
    /** Cone outer angle, radians. */
    public coneOuterAngle = 2 * Math.PI;
    /** Volume outside the cone. */
    public coneOuterVolume = 0;
    /** Distance attenuation model. */
    public distanceModel: DistanceModelType = "linear";
    /** Max distance. */
    public maxDistance = 10000;
    /** Reference / min distance. */
    public minDistance = 1;
    /** Minimum time between auto-updates, seconds. */
    public minUpdateTime = 0;
    /** Enable left/right panning. */
    public panningEnabled = true;
    /** Panning algorithm. */
    public panningModel: PanningModelType = "equalpower";
    /** Roll-off factor. */
    public rolloffFactor = 1;
    /** Whether following a scene node. */
    public useBoundingBox = false;
    /** Which transform components are followed. */
    public attachmentType: SpatialAudioAttachmentType = SpatialAudioAttachmentType.PositionAndRotation;

    private _attachedNode: SpatialNodeLike | null = null;

    /** @internal */
    public constructor(host: LiteHost) {
        this._host = host;
    }

    /** Source world position. */
    public get position(): Vector3 {
        return this._position;
    }
    public set position(value: Vector3) {
        this._position = value;
        this._ensure();
        setSpatialPosition(this._host, value);
    }

    /** Source facing direction. */
    public get orientation(): Vector3 {
        return this._orientation;
    }
    public set orientation(value: Vector3) {
        this._orientation = value;
        this._ensure();
        setSpatialOrientation(this._host, value);
    }

    /** Source rotation quaternion. */
    public get rotationQuaternion(): Quaternion {
        return this._rotationQuaternion;
    }
    public set rotationQuaternion(value: Quaternion) {
        this._rotationQuaternion = value;
        this._reapply();
    }

    /** Whether attached to a scene node. */
    public get isAttached(): boolean {
        return this._attachedNode !== null;
    }

    /** The scene node this source follows, if any. */
    public get attachedNode(): SpatialNodeLike | null {
        return this._attachedNode;
    }

    /** Follows a scene node's world transform. */
    public attach(sceneNode: SpatialNodeLike | null, useBoundingBox = false, attachmentType: SpatialAudioAttachmentType = SpatialAudioAttachmentType.PositionAndRotation): void {
        this._attachedNode = sceneNode;
        this.useBoundingBox = useBoundingBox;
        this.attachmentType = attachmentType;
        this._ensure();
        this.update();
    }

    /** Stops following a scene node. */
    public detach(): void {
        this._attachedNode = null;
    }

    /** Pulls the attached node's current world position/rotation into the source. */
    public update(): void {
        const node = this._attachedNode;
        if (!node) {
            return;
        }
        let dirty = false;
        if ((this.attachmentType & SpatialAudioAttachmentType.Position) !== 0) {
            const pos = readNodePosition(node);
            if (pos) {
                this._position = new Vector3(pos.x, pos.y, pos.z);
                dirty = true;
            }
        }
        if ((this.attachmentType & SpatialAudioAttachmentType.Rotation) !== 0) {
            const quat = readNodeRotation(node);
            if (quat) {
                this._rotationQuaternion = new Quaternion(quat.x, quat.y, quat.z, quat.w);
                dirty = true;
            }
        }
        if (dirty) {
            enableSpatial(this._host, this._options());
            this._enabled = true;
        }
    }

    /** Disposes the spatial sub-node (Lite tears it down with the host). */
    public dispose(): void {
        this._attachedNode = null;
        this._enabled = false;
    }

    private _ensure(): void {
        if (!this._enabled) {
            enableSpatial(this._host, this._options());
            this._enabled = true;
        }
    }

    private _reapply(): void {
        if (this._enabled) {
            enableSpatial(this._host, this._options());
        }
    }

    private _options(): LiteSpatialSoundOptions {
        return {
            position: this._position,
            orientation: this._orientation,
            rotationQuaternion: this._rotationQuaternion,
            panningEnabled: this.panningEnabled,
            panningModel: this.panningModel,
            distanceModel: this.distanceModel,
            minDistance: this.minDistance,
            maxDistance: this.maxDistance,
            rolloffFactor: this.rolloffFactor,
            coneInnerAngle: this.coneInnerAngle,
            coneOuterAngle: this.coneOuterAngle,
            coneOuterVolume: this.coneOuterVolume,
        };
    }
}

/** Babylon.js `AbstractSpatialAudioListener` — the engine's `listener` (the "ears"). */
export class AbstractSpatialAudioListener {
    private readonly _engine: LiteAudioEngine;
    private _position = new Vector3(0, 0, 0);
    private _rotation = new Vector3(0, 0, 0);
    private _rotationQuaternion = new Quaternion(0, 0, 0, 1);
    private _attachedNode: SpatialNodeLike | null = null;

    /** Minimum time between auto-updates, seconds. */
    public minUpdateTime = 0;

    /** @internal */
    public constructor(engine: LiteAudioEngine) {
        this._engine = engine;
    }

    /** Whether attached to a scene node. */
    public get isAttached(): boolean {
        return this._attachedNode !== null;
    }

    /** The scene node the listener follows, if any. */
    public get attachedNode(): SpatialNodeLike | null {
        return this._attachedNode;
    }

    /** Listener world position. */
    public get position(): Vector3 {
        return this._position;
    }
    public set position(value: Vector3) {
        this._position = value;
        setSpatialListenerPosition(this._engine, value);
    }

    /** Listener Euler rotation. */
    public get rotation(): Vector3 {
        return this._rotation;
    }
    public set rotation(value: Vector3) {
        this._rotation = value;
    }

    /** Listener rotation quaternion. */
    public get rotationQuaternion(): Quaternion {
        return this._rotationQuaternion;
    }
    public set rotationQuaternion(value: Quaternion) {
        this._rotationQuaternion = value;
        setSpatialListener(this._engine, { rotationQuaternion: value });
    }

    /** Follows a scene node's world transform. */
    public attach(sceneNode: SpatialNodeLike | null): void {
        this._attachedNode = sceneNode;
        this.update();
    }

    /** Stops following a scene node. */
    public detach(): void {
        this._attachedNode = null;
    }

    /** Pulls the attached node's current world position/rotation into the listener. */
    public update(): void {
        const node = this._attachedNode;
        const pos = readNodePosition(node);
        if (pos) {
            this._position = new Vector3(pos.x, pos.y, pos.z);
            setSpatialListenerPosition(this._engine, pos);
        }
        const quat = readNodeRotation(node);
        if (quat) {
            this._rotationQuaternion = new Quaternion(quat.x, quat.y, quat.z, quat.w);
            setSpatialListener(this._engine, { rotationQuaternion: this._rotationQuaternion });
        }
        updateSpatialAudio(this._engine);
    }
}

// ───────────────────────────── Buses ─────────────────────────────────────────

/** Babylon.js `AbstractAudioBus` — base class for both bus kinds. */
export abstract class AbstractAudioBus extends AbstractAudioOutNode {}

/** Babylon.js `AudioBus` — a generic mixer bus. */
export class AudioBus extends AbstractAudioBus {
    /** @internal The backing Lite bus. */
    public readonly _lite: LiteAudioBus;
    private _spatial: AbstractSpatialAudio | null = null;
    private _stereo: AbstractStereoAudio | null = null;
    private _outBus: PrimaryAudioBus | null;

    /** @internal */
    public constructor(engine: AudioEngineV2, lite: LiteAudioBus, outBus: PrimaryAudioBus | null, volume = 1) {
        super(lite.name, engine);
        this._lite = lite;
        this._outBus = outBus;
        this._volume = volume;
    }

    /** The output bus this bus routes to. */
    public get outBus(): PrimaryAudioBus | null {
        return this._outBus;
    }
    public set outBus(value: PrimaryAudioBus | null) {
        if (this._outBus === value) {
            return;
        }
        rerouteLiteOutBus(this._lite, unwrapBus(value) ?? null);
        this._outBus = value;
    }

    /** Lazily-built spatial sub-property. */
    public get spatial(): AbstractSpatialAudio {
        return (this._spatial ??= new AbstractSpatialAudio(this._lite));
    }

    /** Lazily-built stereo sub-property. */
    public get stereo(): AbstractStereoAudio {
        return (this._stereo ??= new AbstractStereoAudio(this._lite));
    }

    public getClassName(): string {
        return "AudioBus";
    }

    public override dispose(): void {
        disposeAudioBus(this._lite);
        super.dispose();
    }

    protected _applyVolume(value: number, options?: Partial<IAudioParameterRampOptions> | null): void {
        setBusVolume(this._lite, value, toLiteRamp(options));
    }

    protected _spatialHost(): LiteHost {
        return this._lite;
    }
}

/** Babylon.js `MainAudioBus` — a bus that connects directly to the engine output. */
export class MainAudioBus extends AbstractAudioBus {
    /** @internal The backing Lite main bus. */
    public readonly _lite: LiteMainBus;

    /** @internal */
    public constructor(engine: AudioEngineV2, lite: LiteMainBus) {
        super(lite.name, engine);
        this._lite = lite;
    }

    public getClassName(): string {
        return "MainAudioBus";
    }

    protected _applyVolume(value: number, options?: Partial<IAudioParameterRampOptions> | null): void {
        setBusVolume(this._lite as LitePrimaryAudioBus, value, toLiteRamp(options));
    }

    protected _spatialHost(): LiteHost {
        // The Lite main bus is not an `AudioGraphHost`; spatial/stereo/analyzer
        // are not available on a main bus (matching the BJS `MainAudioBus`, which
        // exposes neither). Accessing `.analyzer` on a main bus is unsupported.
        return unsupported("MainAudioBus.analyzer", "Main buses have no analyzer; attach one to a sound or generic AudioBus instead.");
    }
}

// ───────────────────────────── Sound source / sounds ─────────────────────────

/** Babylon.js `AbstractSoundSource` — an out-node with an output bus + spatial/stereo. */
export abstract class AbstractSoundSource extends AbstractAudioOutNode {
    private _spatial: AbstractSpatialAudio | null = null;
    private _stereo: AbstractStereoAudio | null = null;
    protected _outBus: PrimaryAudioBus | null;

    protected constructor(name: string, engine: AudioEngineV2, outBus: PrimaryAudioBus | null) {
        super(name, engine);
        this._outBus = outBus;
    }

    /** The output bus this source routes to. */
    public get outBus(): PrimaryAudioBus | null {
        return this._outBus;
    }
    public set outBus(value: PrimaryAudioBus | null) {
        if (this._outBus === value) {
            return;
        }
        rerouteLiteOutBus(this._spatialHost(), unwrapBus(value) ?? null);
        this._outBus = value;
    }

    /** Lazily-built spatial sub-property. */
    public get spatial(): AbstractSpatialAudio {
        return (this._spatial ??= new AbstractSpatialAudio(this._spatialHost()));
    }

    /** Lazily-built stereo sub-property. */
    public get stereo(): AbstractStereoAudio {
        return (this._stereo ??= new AbstractStereoAudio(this._spatialHost()));
    }
}

/** A live input source (e.g. microphone) wrapping a Lite `AudioInputSource`. */
export class SoundSource extends AbstractSoundSource {
    /** @internal The backing Lite input source. */
    public readonly _lite: LiteAudioInputSource;

    /** @internal */
    public constructor(engine: AudioEngineV2, lite: LiteAudioInputSource, outBus: PrimaryAudioBus | null, volume = 1) {
        super(lite.name, engine, outBus);
        this._lite = lite;
        this._volume = volume;
    }

    public getClassName(): string {
        return "SoundSource";
    }

    public override dispose(): void {
        disposeSoundSource(this._lite);
        super.dispose();
    }

    protected _applyVolume(value: number, options?: Partial<IAudioParameterRampOptions> | null): void {
        setSoundSourceVolume(this._lite, value, toLiteRamp(options));
    }

    protected _spatialHost(): LiteHost {
        return this._lite;
    }
}

/** Babylon.js `AbstractSound` — a playable sound (static or streaming). */
export abstract class AbstractSound extends AbstractSoundSource {
    /** Fires when the sound finishes (all instances ended). */
    public readonly onEndedObservable = new Observable<AbstractSound>();

    protected constructor(name: string, engine: AudioEngineV2, outBus: PrimaryAudioBus | null) {
        super(name, engine, outBus);
        engine._addSound(this);
    }

    /** Number of live playing instances. */
    public abstract get activeInstancesCount(): number;
    /** Whether the sound auto-plays on creation. */
    public abstract get autoplay(): boolean;
    /** Current playback state. */
    public abstract get state(): SoundState;

    /** Whether the sound loops. */
    public abstract get loop(): boolean;
    public abstract set loop(value: boolean);

    /** Start offset, seconds. */
    public abstract get startOffset(): number;
    public abstract set startOffset(value: number);

    /** Maximum simultaneous instances. */
    public abstract get maxInstances(): number;
    public abstract set maxInstances(value: number);

    /** Current playback time of the newest instance, seconds. */
    public abstract get currentTime(): number;
    public abstract set currentTime(value: number);

    /** Plays the sound. */
    public abstract play(options?: Partial<IStaticSoundPlayOptions & IStreamingSoundPlayOptions>): void;
    /** Pauses the sound. */
    public abstract pause(): void;
    /** Resumes the sound. */
    public abstract resume(options?: Partial<IStaticSoundPlayOptions & IStreamingSoundPlayOptions>): void;
    /** Stops the sound. */
    public abstract stop(options?: Partial<IStaticSoundStopOptions>): void;

    public override dispose(): void {
        this.engine._removeSound(this);
        this.onEndedObservable.clear();
        super.dispose();
    }
}

/** Babylon.js `StaticSoundBuffer` — a decoded buffer wrapping a Lite `SoundBuffer`. */
export class StaticSoundBuffer {
    /** The engine that owns this buffer. */
    public readonly engine: AudioEngineV2;
    /** The buffer name. */
    public name: string;
    /** @internal The backing Lite sound buffer. */
    public readonly _lite: LiteSoundBuffer;

    /** @internal */
    public constructor(engine: AudioEngineV2, lite: LiteSoundBuffer, name = "StaticSoundBuffer") {
        this.engine = engine;
        this._lite = lite;
        this.name = name;
    }

    /** Sample rate, Hz. */
    public get sampleRate(): number {
        return this._lite.sampleRate;
    }
    /** Length in sample frames. */
    public get length(): number {
        return this._lite.length;
    }
    /** Duration, seconds. */
    public get duration(): number {
        return this._lite.duration;
    }
    /** Number of channels. */
    public get channelCount(): number {
        return this._lite.channelCount;
    }

    /** Clones the buffer. Lite buffers are immutable, so the clone shares the data. */
    public clone(options?: Partial<{ name: string }>): StaticSoundBuffer {
        return new StaticSoundBuffer(this.engine, this._lite, options?.name ?? this.name);
    }
}

/** Babylon.js `StaticSound` — a buffer-backed sound wrapping a Lite `StaticSound`. */
export class StaticSound extends AbstractSound {
    /** @internal The backing Lite static sound. */
    public readonly _lite: LiteStaticSound;
    private readonly _autoplay: boolean;
    private _buffer: StaticSoundBuffer;

    /** @internal */
    public constructor(engine: AudioEngineV2, lite: LiteStaticSound, buffer: StaticSoundBuffer, outBus: PrimaryAudioBus | null, autoplay: boolean, name?: string, volume = 1) {
        super(name ?? lite.name ?? "Sound", engine, outBus);
        this._lite = lite;
        this._buffer = buffer;
        this._autoplay = autoplay;
        this._volume = volume;
        lite.onEnded.add(() => this.onEndedObservable.notifyObservers(this));
    }

    /** The decoded buffer this sound plays. */
    public get buffer(): StaticSoundBuffer {
        return this._buffer;
    }

    public get activeInstancesCount(): number {
        return this._lite.instanceCount;
    }
    public get autoplay(): boolean {
        return this._autoplay;
    }
    public get state(): SoundState {
        return this._lite.state as SoundState;
    }

    public get loop(): boolean {
        return this._lite._options.loop;
    }
    public set loop(value: boolean) {
        this._lite._options.loop = value;
    }

    public get startOffset(): number {
        return this._lite._options.startOffset;
    }
    public set startOffset(value: number) {
        this._lite._options.startOffset = value;
    }

    public get maxInstances(): number {
        return this._lite._options.maxInstances;
    }
    public set maxInstances(value: number) {
        this._lite._options.maxInstances = value;
    }

    public get duration(): number {
        return this._lite._options.duration;
    }
    public set duration(value: number) {
        this._lite._options.duration = value;
    }

    public get loopStart(): number {
        return this._lite._options.loopStart;
    }
    public set loopStart(value: number) {
        this._lite._options.loopStart = value;
    }

    public get loopEnd(): number {
        return this._lite._options.loopEnd;
    }
    public set loopEnd(value: number) {
        this._lite._options.loopEnd = value;
    }

    public get pitch(): number {
        return this._lite._options.pitch;
    }
    public set pitch(value: number) {
        this._lite._options.pitch = value;
        for (const instance of this._lite._instances) {
            if (instance._sourceNode) {
                instance._sourceNode.detune.value = value;
            }
        }
    }

    public get playbackRate(): number {
        return this._lite._options.playbackRate;
    }
    public set playbackRate(value: number) {
        this._lite._options.playbackRate = value;
        for (const instance of this._lite._instances) {
            if (instance._sourceNode) {
                instance._sourceNode.playbackRate.value = value;
            }
        }
    }

    public get currentTime(): number {
        return this.startOffset;
    }
    public set currentTime(value: number) {
        this.startOffset = value;
    }

    public play(options?: Partial<IStaticSoundPlayOptions>): void {
        playSound(this._lite, options);
    }

    public pause(): void {
        pauseSound(this._lite);
    }

    public resume(options?: Partial<IStaticSoundPlayOptions>): void {
        resumeSound(this._lite, options);
    }

    public stop(options?: Partial<IStaticSoundStopOptions>): void {
        stopSound(this._lite, options);
    }

    /** Clones the sound (shares the decoded buffer). */
    public async cloneAsync(options?: Partial<IStaticSoundCloneOptions>): Promise<StaticSound> {
        const outBus = (options?.outBus as PrimaryAudioBus | undefined) ?? this._outBus ?? undefined;
        return this.engine.createSoundAsync(this.name, this._buffer, { outBus });
    }

    public getClassName(): string {
        return "StaticSound";
    }

    public override dispose(): void {
        disposeSound(this._lite);
        super.dispose();
    }

    protected _applyVolume(value: number, options?: Partial<IAudioParameterRampOptions> | null): void {
        setSoundVolume(this._lite, value, toLiteRamp(options));
    }

    protected _spatialHost(): LiteHost {
        return this._lite;
    }
}

/** Babylon.js `StreamingSound` — a media-element-backed sound. */
export class StreamingSound extends AbstractSound {
    /** @internal The backing Lite streaming sound. */
    public readonly _lite: LiteStreamingSound;
    private readonly _autoplay: boolean;
    private _loop: boolean;
    private _startOffset: number;
    private _maxInstances: number;

    /** @internal */
    public constructor(engine: AudioEngineV2, lite: LiteStreamingSound, outBus: PrimaryAudioBus | null, options: Partial<IStreamingSoundOptions>, name?: string) {
        super(name ?? lite.name ?? "Sound", engine, outBus);
        this._lite = lite;
        this._autoplay = options.autoplay ?? false;
        this._loop = options.loop ?? false;
        this._startOffset = options.startOffset ?? 0;
        this._maxInstances = options.maxInstances ?? Infinity;
        this._volume = options.volume ?? 1;
        lite.onEnded.add(() => this.onEndedObservable.notifyObservers(this));
    }

    /** Number of instances configured to preload. */
    public get preloadCount(): number {
        return this._lite._options.preloadCount;
    }

    /** Number of instances that have finished preloading. */
    public get preloadCompletedCount(): number {
        return this._lite.preloadCompletedCount;
    }

    public get activeInstancesCount(): number {
        return this._lite.instanceCount;
    }
    public get autoplay(): boolean {
        return this._autoplay;
    }
    public get state(): SoundState {
        return this._lite.state as SoundState;
    }

    public get loop(): boolean {
        return this._loop;
    }
    public set loop(value: boolean) {
        this._loop = value;
        this._lite._options.loop = value;
    }

    public get startOffset(): number {
        return this._startOffset;
    }
    public set startOffset(value: number) {
        this._startOffset = value;
        this._lite._options.startOffset = value;
    }

    public get maxInstances(): number {
        return this._maxInstances;
    }
    public set maxInstances(value: number) {
        this._maxInstances = value;
        this._lite._options.maxInstances = value;
    }

    public get currentTime(): number {
        return this._startOffset;
    }
    public set currentTime(value: number) {
        this.startOffset = value;
    }

    public play(options?: Partial<IStreamingSoundPlayOptions>): void {
        playStreamingSound(this._lite, options);
    }

    public pause(): void {
        pauseStreamingSound(this._lite);
    }

    public resume(options?: Partial<IStreamingSoundPlayOptions>): void {
        resumeStreamingSound(this._lite, options);
    }

    public stop(): void {
        stopStreamingSound(this._lite);
    }

    /** Preloads a single instance. */
    public preloadInstanceAsync(): Promise<void> {
        return preloadStreamingInstanceAsync(this._lite);
    }

    /** Preloads `count` instances. */
    public preloadInstancesAsync(count: number): Promise<void> {
        return preloadStreamingInstancesAsync(this._lite, count);
    }

    public getClassName(): string {
        return "StreamingSound";
    }

    public override dispose(): void {
        disposeStreamingSound(this._lite);
        super.dispose();
    }

    protected _applyVolume(value: number, options?: Partial<IAudioParameterRampOptions> | null): void {
        setStreamingSoundVolume(this._lite, value, toLiteRamp(options));
    }

    protected _spatialHost(): LiteHost {
        return this._lite;
    }
}

// ───────────────────────────── Engine ────────────────────────────────────────

const FormatMimeTypes: { [key: string]: string } = {
    aac: "audio/aac",
    ac3: "audio/ac3",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: 'audio/mpeg; codecs="mp3"',
    mp4: "audio/mp4",
    ogg: 'audio/ogg; codecs="vorbis"',
    wav: "audio/wav",
    webm: 'audio/webm; codecs="vorbis"',
};

/** Source accepted by `createSoundAsync` / `createSoundBufferAsync`. */
export type StaticSoundSource = ArrayBuffer | AudioBuffer | StaticSoundBuffer | string | string[];

function unwrapBus(bus: PrimaryAudioBus | null | undefined): LitePrimaryAudioBus | undefined {
    if (!bus) {
        return undefined;
    }
    return (bus as AudioBus | MainAudioBus)._lite as LitePrimaryAudioBus;
}

/** The Web Audio input node a Lite primary bus exposes (mirrors Lite's internal `getBusInputNode`). */
function liteBusInputNode(bus: LitePrimaryAudioBus): AudioNode {
    return "_graph" in bus ? (bus as LiteAudioBus)._graph._in : (bus as LiteMainBus)._in;
}

/**
 * Re-routes a Lite graph-bearing handle (sound, source, or generic bus) from its
 * current output bus to `newOutBus`, mirroring AudioV2's `outBus` setter. Lite
 * exposes no public re-route entry point, so this rewires the single stable tail
 * link (the sub-graph's `_out` node to the target bus input) directly, exactly as
 * Lite wires it at creation time.
 */
function rerouteLiteOutBus(host: LiteHost, newOutBus: LitePrimaryAudioBus | null): void {
    const out = host._graph._out;
    const oldOutBus = host._outBus;
    if (oldOutBus) {
        try {
            out.disconnect(liteBusInputNode(oldOutBus));
        } catch {
            // The tail may not be connected yet (e.g. a microphone source created
            // without an output bus); ignore.
        }
    }
    if (newOutBus) {
        out.connect(liteBusInputNode(newOutBus));
    }
    (host as { _outBus: LitePrimaryAudioBus | null })._outBus = newOutBus;
}

function unwrapBufferSource(source: StaticSoundSource): ArrayBuffer | AudioBuffer | LiteSoundBuffer | string | string[] {
    if (source instanceof StaticSoundBuffer) {
        return source._lite;
    }
    return source;
}

/**
 * Babylon.js `AudioEngineV2` — the AudioV2 engine. Backed by a Lite audio engine.
 * Created via {@link CreateAudioEngineAsync}.
 */
export class AudioEngineV2 {
    private static _Instances: AudioEngineV2[] = [];
    /** All live audio engines. */
    public static get Instances(): readonly AudioEngineV2[] {
        return AudioEngineV2._Instances;
    }

    /** Fires when a named node is added to the engine. */
    public readonly onNodeAddedObservable = new Observable<AbstractNamedAudioNode>();
    /** Fires when a named node is removed from the engine. */
    public readonly onNodeRemovedObservable = new Observable<AbstractNamedAudioNode>();
    /** Fires when the engine is disposed. */
    public readonly onDisposeObservable = new Observable<AudioEngineV2>();

    /** @internal The backing Lite audio engine. */
    public readonly _lite: LiteAudioEngine;

    private readonly _sounds = new Set<AbstractSound>();
    private readonly _nodes = new Set<AbstractNamedAudioNode>();
    private _defaultMainBus: MainAudioBus | null = null;
    private _listener: AbstractSpatialAudioListener | null = null;
    private _mainOut: AbstractAudioNode | null = null;

    /** @internal */
    public constructor(lite: LiteAudioEngine) {
        this._lite = lite;
        AudioEngineV2._Instances.push(this);
    }

    /** The audio context's current time, seconds. */
    public get currentTime(): number {
        return this._lite.currentTime;
    }

    /** The context state. */
    public get state(): AudioEngineV2State {
        return this._lite.state;
    }

    /** Master output volume. */
    public get volume(): number {
        return getMasterVolume(this._lite);
    }
    public set volume(value: number) {
        setMasterVolume(this._lite, value);
    }

    /** Default parameter ramp duration, seconds. */
    public get parameterRampDuration(): number {
        return this._lite._rampDuration;
    }
    public set parameterRampDuration(value: number) {
        this._lite._rampDuration = value;
    }

    /** The default main bus all sounds route to. */
    public get defaultMainBus(): MainAudioBus | null {
        return (this._defaultMainBus ??= new MainAudioBus(this, this._lite._mainBus));
    }

    /** The spatial-audio listener (the "ears"). */
    public get listener(): AbstractSpatialAudioListener {
        return (this._listener ??= new AbstractSpatialAudioListener(this._lite));
    }

    /** The engine output node. */
    public get mainOut(): AbstractAudioNode {
        return (this._mainOut ??= new MainOutNode(this));
    }

    /** All live sounds. */
    public get sounds(): readonly AbstractSound[] {
        return Array.from(this._sounds);
    }

    /** All live named nodes. */
    public get nodes(): ReadonlySet<AbstractNamedAudioNode> {
        return this._nodes;
    }

    /** Sets the master volume, optionally ramping. */
    public setVolume(value: number, options?: Partial<IAudioParameterRampOptions>): void {
        setMasterVolume(this._lite, value, toLiteRamp(options));
    }

    /** Whether the given audio format/extension can be decoded. */
    public isFormatValid(format: string): boolean {
        const mimeType = FormatMimeTypes[format.toLowerCase()];
        if (mimeType === undefined) {
            return false;
        }
        if (typeof Audio === "undefined") {
            return true;
        }
        return new Audio().canPlayType(mimeType) !== "";
    }

    /** Suspends the engine context. */
    public async pauseAsync(): Promise<void> {
        const ctx = this._lite._ctx as AudioContext;
        if (typeof ctx.suspend === "function" && ctx.state === "running") {
            await ctx.suspend();
        }
    }

    /** Resumes the engine context. */
    public async resumeAsync(): Promise<void> {
        await unlockAudioEngineAsync(this._lite);
    }

    /** Resumes the engine context (alias of {@link resumeAsync}). */
    public async unlockAsync(): Promise<void> {
        await unlockAudioEngineAsync(this._lite);
    }

    /** Creates a buffer-backed sound. */
    public async createSoundAsync(name: string, source: StaticSoundSource, options?: Partial<IStaticSoundOptions>): Promise<StaticSound> {
        const liteOptions = toLiteStaticSoundOptions(name, options);
        const lite = await createSoundAsync(this._lite, unwrapBufferSource(source), liteOptions);
        const buffer = new StaticSoundBuffer(this, lite.buffer, name);
        return new StaticSound(this, lite, buffer, (options?.outBus as PrimaryAudioBus | undefined) ?? this.defaultMainBus, options?.autoplay ?? false, name, options?.volume ?? 1);
    }

    /** Creates a decoded sound buffer. */
    public async createSoundBufferAsync(source: StaticSoundSource, options?: Partial<IStaticSoundBufferOptions>): Promise<StaticSoundBuffer> {
        const lite = await createSoundBufferAsync(this._lite, unwrapBufferSource(source), { skipCodecCheck: options?.skipCodecCheck });
        return new StaticSoundBuffer(this, lite);
    }

    /** Creates a streaming, media-element-backed sound. */
    public async createStreamingSoundAsync(name: string, source: HTMLMediaElement | string | string[], options?: Partial<IStreamingSoundOptions>): Promise<StreamingSound> {
        const liteOptions: LiteStreamingSoundOptions = {
            autoplay: options?.autoplay,
            loop: options?.loop,
            maxInstances: options?.maxInstances,
            outBus: unwrapBus(options?.outBus) as LitePrimaryAudioBus | undefined,
            preloadCount: options?.preloadCount,
            startOffset: options?.startOffset,
            volume: options?.volume,
        };
        const lite = await createStreamingSoundAsync(this._lite, source, liteOptions);
        return new StreamingSound(this, lite, (options?.outBus as PrimaryAudioBus | undefined) ?? this.defaultMainBus, options ?? {}, name);
    }

    /** Creates a generic mixer bus. */
    public async createBusAsync(name: string, options?: Partial<IAudioBusOptions>): Promise<AudioBus> {
        const lite = await createAudioBusAsync(this._lite, name, {
            volume: options?.volume,
            outBus: unwrapBus(options?.outBus) as LitePrimaryAudioBus | undefined,
        });
        return new AudioBus(this, lite, (options?.outBus as PrimaryAudioBus | undefined) ?? this.defaultMainBus, options?.volume ?? 1);
    }

    /**
     * Creates a main bus. Babylon Lite builds a single default main bus per engine
     * and does not expose creating additional ones, so this resolves the default
     * main bus.
     */
    public async createMainBusAsync(_name: string, _options?: Partial<IMainAudioBusOptions>): Promise<MainAudioBus> {
        return this.defaultMainBus as MainAudioBus;
    }

    /** Wraps an arbitrary Web Audio node as a sound source. */
    public async createSoundSourceAsync(name: string, source: AudioNode, options?: Partial<ISoundSourceOptions>): Promise<SoundSource> {
        const lite = await createSoundSourceAsync(this._lite, source, {
            name,
            outBus: unwrapBus(options?.outBus) as LitePrimaryAudioBus | undefined,
            outBusAutoDefault: options?.outBusAutoDefault,
            volume: options?.volume,
        });
        return new SoundSource(this, lite, (options?.outBus as PrimaryAudioBus | undefined) ?? null, options?.volume ?? 1);
    }

    /** Creates a microphone-backed sound source. */
    public async createMicrophoneSoundSourceAsync(name: string, options?: Partial<ISoundSourceOptions>): Promise<SoundSource> {
        const lite = await createMicrophoneSoundSourceAsync(this._lite, {
            name,
            outBus: unwrapBus(options?.outBus) as LitePrimaryAudioBus | undefined,
            outBusAutoDefault: options?.outBusAutoDefault,
            volume: options?.volume,
        });
        return new SoundSource(this, lite, (options?.outBus as PrimaryAudioBus | undefined) ?? null, options?.volume ?? 1);
    }

    /** Disposes the engine and all its sounds/buses. */
    public dispose(): void {
        disposeAudioEngine(this._lite);
        this.onDisposeObservable.notifyObservers(this);
        this.onDisposeObservable.clear();
        this.onNodeAddedObservable.clear();
        this.onNodeRemovedObservable.clear();
        this._sounds.clear();
        this._nodes.clear();
        const i = AudioEngineV2._Instances.indexOf(this);
        if (i !== -1) {
            AudioEngineV2._Instances.splice(i, 1);
        }
        if (LastCreatedEngine === this) {
            LastCreatedEngine = null;
        }
    }

    /** @internal */
    public _addSound(sound: AbstractSound): void {
        this._sounds.add(sound);
    }
    /** @internal */
    public _removeSound(sound: AbstractSound): void {
        this._sounds.delete(sound);
    }
    /** @internal */
    public _addNode(node: AbstractNamedAudioNode): void {
        this._nodes.add(node);
        this.onNodeAddedObservable.notifyObservers(node);
    }
    /** @internal */
    public _removeNode(node: AbstractNamedAudioNode): void {
        if (this._nodes.delete(node)) {
            this.onNodeRemovedObservable.notifyObservers(node);
        }
    }
}

/** The engine output node returned by `engine.mainOut`. */
class MainOutNode extends AbstractAudioNode {
    public constructor(engine: AudioEngineV2) {
        super(engine);
    }
    public getClassName(): string {
        return "_MainAudioOut";
    }
}

// ───────────────────────────── Option mapping ────────────────────────────────

function toLiteStaticSoundOptions(_name: string, options?: Partial<IStaticSoundOptions>): LiteStaticSoundOptions {
    return {
        autoplay: options?.autoplay,
        duration: options?.duration,
        loop: options?.loop,
        loopEnd: options?.loopEnd,
        loopStart: options?.loopStart,
        maxInstances: options?.maxInstances,
        outBus: unwrapBus(options?.outBus) as LitePrimaryAudioBus | undefined,
        pitch: options?.pitch,
        playbackRate: options?.playbackRate,
        startOffset: options?.startOffset,
        volume: options?.volume,
        skipCodecCheck: options?.skipCodecCheck,
    };
}

function toLiteEngineOptions(options?: Partial<IWebAudioEngineOptions>): LiteAudioEngineOptions {
    return {
        audioContext: options?.audioContext,
        volume: options?.volume,
        parameterRampDuration: options?.parameterRampDuration,
        resumeOnInteraction: options?.resumeOnInteraction,
        resumeOnPause: options?.resumeOnPause,
        resumeOnPauseRetryInterval: options?.resumeOnPauseRetryInterval,
    };
}

// ───────────────────────────── Factory functions ─────────────────────────────

/**
 * Module-level "last created engine", mirroring Babylon.js. Assigning a primitive
 * default is bundler-safe (no allocation at import time) and the compat package is
 * excluded from Lite bundle ceilings.
 */
let LastCreatedEngine: AudioEngineV2 | null = null;

/** Babylon.js `OnAudioEngineV2CreatedObservable` — fires when an engine is created. */
export const OnAudioEngineV2CreatedObservable = new Observable<AudioEngineV2>();

/** Babylon.js `LastCreatedAudioEngine()` — the most recently created engine, if any. */
export function LastCreatedAudioEngine(): AudioEngineV2 | null {
    return LastCreatedEngine;
}

function resolveEngine(engine?: AudioEngineV2 | null): AudioEngineV2 {
    const resolved = engine ?? LastCreatedEngine;
    if (!resolved) {
        return unsupported("AudioV2 factory", "No audio engine available. Call CreateAudioEngineAsync(...) first or pass an engine.");
    }
    return resolved;
}

/** Babylon.js `CreateAudioEngineAsync` — creates and initialises an AudioV2 engine. */
export async function CreateAudioEngineAsync(options?: Partial<IWebAudioEngineOptions>): Promise<AudioEngineV2> {
    const lite = await createAudioEngineAsync(toLiteEngineOptions(options));
    const engine = new AudioEngineV2(lite);
    LastCreatedEngine = engine;
    OnAudioEngineV2CreatedObservable.notifyObservers(engine);
    return engine;
}

/** Babylon.js `CreateSoundAsync`. */
export function CreateSoundAsync(name: string, source: StaticSoundSource, options?: Partial<IStaticSoundOptions>, engine?: AudioEngineV2 | null): Promise<StaticSound> {
    return resolveEngine(engine).createSoundAsync(name, source, options);
}

/** Babylon.js `CreateSoundBufferAsync`. */
export function CreateSoundBufferAsync(source: StaticSoundSource, options?: Partial<IStaticSoundBufferOptions>, engine?: AudioEngineV2 | null): Promise<StaticSoundBuffer> {
    return resolveEngine(engine).createSoundBufferAsync(source, options);
}

/** Babylon.js `CreateStreamingSoundAsync`. */
export function CreateStreamingSoundAsync(
    name: string,
    source: HTMLMediaElement | string | string[],
    options?: Partial<IStreamingSoundOptions>,
    engine?: AudioEngineV2 | null
): Promise<StreamingSound> {
    return resolveEngine(engine).createStreamingSoundAsync(name, source, options);
}

/** Babylon.js `CreateAudioBusAsync`. */
export function CreateAudioBusAsync(name: string, options?: Partial<IAudioBusOptions>, engine?: AudioEngineV2 | null): Promise<AudioBus> {
    return resolveEngine(engine).createBusAsync(name, options);
}

/** Babylon.js `CreateMainAudioBusAsync`. */
export function CreateMainAudioBusAsync(name: string, options?: Partial<IMainAudioBusOptions>, engine?: AudioEngineV2 | null): Promise<MainAudioBus> {
    return resolveEngine(engine).createMainBusAsync(name, options);
}

/** Babylon.js `CreateSoundSourceAsync`. */
export function CreateSoundSourceAsync(name: string, source: AudioNode, options?: Partial<ISoundSourceOptions>, engine?: AudioEngineV2 | null): Promise<SoundSource> {
    return resolveEngine(engine).createSoundSourceAsync(name, source, options);
}

/** Babylon.js `CreateMicrophoneSoundSourceAsync`. */
export function CreateMicrophoneSoundSourceAsync(name: string, options?: Partial<ISoundSourceOptions>, engine?: AudioEngineV2 | null): Promise<SoundSource> {
    return resolveEngine(engine).createMicrophoneSoundSourceAsync(name, options);
}
