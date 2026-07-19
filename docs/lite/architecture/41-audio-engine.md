# Module: Audio Engine

> Package path: `packages/babylon-lite/src/audio/`

> **Status: Implemented.**
> This is a faithful _behavioral_ port of the Babylon.js AudioV2 engine
> (`packages/dev/core/src/AudioV2/`) re-architected to Babylon Lite idioms:
> pure-state interfaces + standalone functions, zero module-level side effects,
> single Web Audio backend (no abstract/concrete split), and opt-in feature
> modules. The **Web Audio API node graph, parameter-ramp math, and spatial
> panner math are preserved 1:1** — only the code _shape_ changes, never the
> audible behavior.
>
> The shipped module differs from the original one-shot design below in a few
> places (most notably: feature sub-nodes are enabled by **explicit
> `enable*`/`set*` functions** rather than presence of an option field, and the
> file layout is **flat**, not nested). The **authoritative API is the exported
> TSDoc** in `packages/babylon-lite/src/audio/` and the barrel
> `audio/index.ts`; the "As-Built API & Divergences" section below records the
> deltas from this design doc.

---

## Purpose

The Audio module wraps the browser **Web Audio API** to provide sound playback,
mixing/routing (buses), 3D spatial audio, stereo panning, FFT analysis,
microphone capture, and an optional unmute UI. It is fully decoupled from the
WebGPU render stack: it has **no GPU, scene-graph, or render-loop dependency**.
Spatial audio optionally reads a Lite `Mesh`/transform's world position so a
sound can follow an object, but audio never holds a reference to the scene
(Pillar 4b — one-way data ownership).

The module is **100% opt-in and tree-shakable**. A scene that imports nothing
from `audio/` pays zero bytes. Spatial, streaming, stereo, analyzer, microphone,
and unmute-UI are each separable feature modules pulled in only when their
factory/option is used.

---

## Design Mapping: AudioV2 → Lite

| AudioV2 (Babylon.js)                              | Babylon Lite                                             |
| ------------------------------------------------- | -------------------------------------------------------- |
| `abstract AudioEngineV2` + `_WebAudioEngine`      | one `AudioEngine` state interface + functions            |
| `abstract AbstractSound` + `_WebAudioStaticSound` | one `StaticSound` state interface + functions            |
| 29 abstract classes + 21 `_WebAudio*` concretes   | flat set of pure-state interfaces; no inheritance        |
| Class methods (`sound.play()`)                    | standalone functions (`playSound(sound)`)                |
| `new Observable()` event fields                   | lightweight callback-set (`AudioSignal<T>`) on the state |
| Module-level `Instances[]`, `OnCreatedObservable` | **removed** — caller owns the `AudioEngine` handle       |
| Module-level `new RegExp`, cached `ExpCurve`      | lazy-init inside functions (no module side effects)      |
| `WebRequest.FetchAsync` + custom headers          | plain `fetch()` (matches every other Lite loader)        |
| `Vector3`/`Quaternion` from core Maths            | Lite `math/` vec3/quat                                   |
| `Logger.Warn`                                     | `console.warn`                                           |
| `EngineStore.LastCreatedEngine` (unmute UI)       | explicit `parentElement` option                          |
| `PrecisionDate.Now`                               | `performance.now()`                                      |
| `Node` / `AbstractMesh` (spatial attach)          | Lite `Mesh` / `{ worldMatrix }` transform                |

### Why collapse the abstract layer

AudioV2's abstract/concrete split exists so Babylon can swap audio backends.
Babylon Lite targets one backend (Web Audio) that will ever exist, so the
indirection is pure overhead and conflicts with Pillars 2 and 4b′. We keep a
single implementation. The Web Audio graph construction is copied faithfully;
the class scaffolding is not.

---

## Public API Surface

> **Original design sketch.** The block below is the pre-implementation API
> design. It is kept for context; where it disagrees with the shipped code, the
> shipped code wins. See **"As-Built API & Divergences"** immediately after for
> the corrections.

All public types are **pure state** (no methods). Behavior is in functions.

```typescript
// ─── Engine ──────────────────────────────────────────────────────────
export interface AudioEngineOptions {
    /** Provide an existing context. Pass an `OfflineAudioContext` for deterministic,
     *  headless, faster-than-real-time rendering to PCM (Tier-2/3 tests, parity).
     *  Default: new AudioContext(). */
    audioContext?: BaseAudioContext;
    /** Ramp smoothing for all parameter changes, in seconds. Default 0.01 (10 ms). */
    parameterRampDuration?: number;
    /** Initial master output volume. Default 1. */
    volume?: number;
    /** Resume the context on the first user gesture (click). Default true. */
    resumeOnInteraction?: boolean;
    /** Periodically retry resume() while suspended/interrupted. Default true. */
    resumeOnPause?: boolean;
    /** Retry period for resumeOnPause, in ms. Default 1000. */
    resumeOnPauseRetryInterval?: number;
    /** Spatial listener defaults (position/orientation). */
    listener?: Partial<SpatialListenerOptions>;
}

export type AudioEngineState = "closed" | "interrupted" | "running" | "suspended";

/** Handle to the audio engine. Pure state. GPU-style internals are @internal. */
export interface AudioEngine {
    readonly state: AudioEngineState;
    /** Fires on every state transition. */
    readonly onStateChanged: AudioSignal<AudioEngineState>;
    /** @internal */ readonly _ctx: BaseAudioContext;
    /** @internal */ readonly _mainOut: GainNode;
    /** @internal */ readonly _mainBus: MainBus;
    /** @internal */ readonly _listener: SpatialListener | null;
    /** @internal */ _rampDuration: number;
    /** @internal */ readonly _disposers: Array<() => void>;
}

export function createAudioEngineAsync(options?: AudioEngineOptions): Promise<AudioEngine>;
export function disposeAudioEngine(engine: AudioEngine): void;
/** Resume a suspended/interrupted context (e.g. from a user-gesture handler). */
export function unlockAudioEngineAsync(engine: AudioEngine): Promise<void>;
export function setMasterVolume(engine: AudioEngine, value: number, options?: RampOptions): void;

// ─── Sounds (static) ─────────────────────────────────────────────────
export type SoundSource = string | string[] | ArrayBuffer | AudioBuffer | SoundBuffer;

export interface StaticSoundOptions {
    autoplay?: boolean; // default false
    loop?: boolean; // default false
    startOffset?: number; // seconds, default 0
    maxInstances?: number; // default Infinity
    volume?: number; // default 1
    outBus?: AudioBus | MainBus; // default engine main bus
    // feature opt-ins (presence triggers the sub-node):
    spatial?: Partial<SpatialSoundOptions>;
    stereo?: { pan: number };
    analyzer?: { fftSize: number };
}

export interface StaticSound {
    readonly name: string;
    readonly state: SoundState;
    loop: boolean;
    startOffset: number;
    maxInstances: number;
    readonly onEnded: AudioSignal<StaticSound>;
    /** @internal */ readonly _engine: AudioEngine;
    /** @internal */ readonly _buffer: AudioBuffer;
    /** @internal */ readonly _graph: SoundSubGraph;
    /** @internal */ readonly _instances: Set<StaticSoundInstance>;
    /** @internal */ readonly _options: StaticSoundOptions;
}

export function createSoundAsync(engine: AudioEngine, source: SoundSource, options?: StaticSoundOptions): Promise<StaticSound>;
export function createSoundBufferAsync(engine: AudioEngine, source: SoundSource): Promise<SoundBuffer>;
export function playSound(sound: StaticSound, options?: PlaySoundOptions): void;
export function pauseSound(sound: StaticSound): void;
export function resumeSound(sound: StaticSound, options?: PlaySoundOptions): void;
export function stopSound(sound: StaticSound): void;
export function disposeSound(sound: StaticSound): void;

// ─── Streaming sounds (HTMLAudioElement path) ───────────────────────
export interface StreamingSoundOptions extends Omit<StaticSoundOptions, "maxInstances"> {
    preloadCount?: number; // default 1
}
export interface StreamingSound {
    /* mirrors StaticSound, no loopStart/pitch/playbackRate */
}
export function createStreamingSoundAsync(engine: AudioEngine, source: string | string[] | HTMLAudioElement, options?: StreamingSoundOptions): Promise<StreamingSound>;
export function preloadStreamingInstanceAsync(sound: StreamingSound): Promise<void>;
// play/pause/resume/stop/dispose share the StaticSound functions via a common SoundLike union.

// ─── Buses (routing / mixing) ───────────────────────────────────────
export interface AudioBusOptions {
    volume?: number;
    outBus?: AudioBus | MainBus;
    spatial?: Partial<SpatialSoundOptions>;
    stereo?: { pan: number };
}
export interface AudioBus {
    readonly name: string;
    /** @internal */ _graph: SoundSubGraph;
    /** @internal */ _in: GainNode;
}
export interface MainBus {
    readonly name: string;
    /** @internal */ _gain: GainNode;
}
export function createAudioBusAsync(engine: AudioEngine, name: string, options?: AudioBusOptions): Promise<AudioBus>;
export function createMainBusAsync(engine: AudioEngine, name: string, options?: { volume?: number }): Promise<MainBus>;
export function setBusVolume(bus: AudioBus | MainBus, value: number, options?: RampOptions): void;

// ─── Spatial (3D) ───────────────────────────────────────────────────
export interface SpatialSoundOptions {
    position: Vec3;
    orientation: Vec3;
    rotationQuaternion?: Quat;
    panningEnabled: boolean; // default true
    panningModel: "equalpower" | "HRTF"; // default "equalpower"
    distanceModel: "linear" | "inverse" | "exponential"; // default "inverse"
    minDistance: number;
    maxDistance: number;
    rolloffFactor: number;
    coneInnerAngle: number;
    coneOuterAngle: number;
    coneOuterVolume: number;
    /** Follow a Lite mesh/transform's world position (and optionally rotation). */
    attachedTo?: SpatialTarget;
    attachmentType?: "position" | "rotation" | "positionAndRotation";
    useBoundingBox?: boolean;
}
export interface SpatialListenerOptions {
    position: Vec3;
    orientation: Vec3;
    rotationQuaternion?: Quat;
    attachedTo?: SpatialTarget;
}
/** Anything exposing a world transform — typically a Lite Mesh or camera. */
export interface SpatialTarget {
    readonly worldMatrix: Mat4;
    readonly onDispose?: AudioSignal<unknown>;
}
export function setSpatialPosition(sound: StaticSound | AudioBus, p: Vec3): void;
export function attachSpatialTarget(soundOrListener: StaticSound | AudioBus | AudioEngine, target: SpatialTarget, type?: SpatialSoundOptions["attachmentType"]): void;
export function detachSpatialTarget(soundOrListener: StaticSound | AudioBus | AudioEngine): void;
/** Pump per-frame spatial updates. Call from your render loop OR enable auto-RAF. */
export function updateSpatialAudio(engine: AudioEngine): void;
export function setSpatialAutoUpdate(engine: AudioEngine, enabled: boolean, minUpdateMs?: number): void;

// ─── Analyzer ───────────────────────────────────────────────────────
export interface AudioAnalyzer {
    /** @internal */ _node: AnalyserNode;
}
export function getByteFrequencyData(sound: StaticSound | AudioBus, out: Uint8Array): void;
export function getFloatFrequencyData(sound: StaticSound | AudioBus, out: Float32Array): void;

// ─── Microphone source ──────────────────────────────────────────────
export interface MicrophoneSound {
    readonly name: string;
    /** @internal */ _stream: MediaStream;
}
export function createMicrophoneSoundSourceAsync(engine: AudioEngine, name: string, options?: { outBus?: AudioBus | MainBus }): Promise<MicrophoneSound>;

// ─── Unmute UI ──────────────────────────────────────────────────────
export interface UnmuteUiOptions {
    parentElement?: HTMLElement;
}
export function createUnmuteUi(engine: AudioEngine, options?: UnmuteUiOptions): { dispose(): void };

// ─── Parameter ramps ────────────────────────────────────────────────
export type AudioRampShape = "none" | "linear" | "exponential" | "logarithmic";
export interface RampOptions {
    shape?: AudioRampShape;
    duration?: number;
}

// ─── Shared signal (replaces core Observable) ───────────────────────
export interface AudioSignal<T> {
    add(cb: (v: T) => void): () => void;
    addOnce(cb: (v: T) => void): () => void;
}

// ─── Enums (re-exported, identical semantics) ───────────────────────
export const enum SoundState {
    Stopped,
    Starting,
    Started,
    Stopping,
    Paused,
    FailedToStart,
}
```

---

## As-Built API & Divergences

The shipped surface is the barrel `audio/index.ts`. It matches the design above
in spirit; the concrete differences are:

**Feature enablement is explicit, not option-presence.** There are no
`spatial?`/`stereo?`/`analyzer?` fields on `StaticSoundOptions`,
`StreamingSoundOptions`, or `AudioBusOptions`. Instead each feature is turned on
by its own function on a host (`AudioGraphHost = StaticSound | StreamingSound |
AudioBus | AudioInputSource`), which lazily builds/rebuilds the sub-graph:

```typescript
// Stereo
export function enableStereo(host: AudioGraphHost, options?: StereoSoundOptions): void;
export function setStereoPan(host: AudioGraphHost, pan: number, options?: RampOptions): void;

// Spatial (3D)
export function enableSpatial(host: AudioGraphHost, options?: SpatialSoundOptions): void;
export function setSpatialPosition(host: AudioGraphHost, position: Vec3): void;
export function setSpatialOrientation(host: AudioGraphHost, orientation: Vec3): void;
export function attachSpatialTarget(target: AudioGraphHost | AudioEngine, worldTarget: SpatialTarget, type?: SpatialAttachmentType): void;
export function detachSpatialTarget(target: AudioGraphHost | AudioEngine): void;
export function setSpatialListener(engine: AudioEngine, options?: SpatialListenerOptions): void;
export function setSpatialListenerPosition(engine: AudioEngine, position: Vec3): void;
export function updateSpatialAudio(engine: AudioEngine): void;
export function setSpatialAutoUpdate(engine: AudioEngine, enabled: boolean, minUpdateMs?: number): void;

// Analyzer — frequency AND time-domain readback
export function enableAnalyzer(host: AudioGraphHost, options?: AudioAnalyzerOptions): void;
export function getByteFrequencyData(host: AudioGraphHost, out: Uint8Array): void;
export function getFloatFrequencyData(host: AudioGraphHost, out: Float32Array): void;
export function getByteTimeDomainData(host: AudioGraphHost, out: Uint8Array): void;
export function getFloatTimeDomainData(host: AudioGraphHost, out: Float32Array): void;
```

Other deltas:

- **Per-sound volume helper.** `setSoundVolume(sound, value, options?)` and
  `setStreamingSoundVolume(...)` exist (the design only listed master/bus
  volume).
- **Buses.** `MainBus` is created and owned by the engine; there is **no public
  `createMainBusAsync`**. `disposeAudioBus(bus)` is public. `PrimaryAudioBus` is
  the public union (`AudioBus | MainBus`) used by `outBus`/spatial/stereo hosts.
- **Sound sources & microphone.** Generic input sources are exposed via
  `createSoundSourceAsync(engine, node, options?)`,
  `createMicrophoneSoundSourceAsync(engine, options?)`,
  `setSoundSourceVolume(...)`, and `disposeSoundSource(...)`, returning an
  `AudioInputSource` handle (the design's `MicrophoneSound` was folded into
  this).
- **Unmute UI.** `createUnmuteUI(engine, { parentElement? })` plus
  `setUnmuteUIEnabled(ui, enabled)` and `disposeUnmuteUI(ui)` (capitalized `UI`,
  and a richer handle than `{ dispose() }`).
- **Media-stream output (Lite-only).** The final post-master mix can be mirrored
  into browser media pipelines without affecting speaker output:

  ```typescript
  export interface AudioEngineMediaStream {
      readonly stream: MediaStream;
      /** @internal */ readonly _engine: AudioEngine;
      /** @internal */ readonly _source: GainNode;
      /** @internal */ readonly _destination: MediaStreamAudioDestinationNode;
      /** @internal */ readonly _engineDisposer: () => void;
      /** @internal */ _registered: boolean;
      /** @internal */ _disposed: boolean;
      /** @internal */ _dispose(): void;
  }

  export function createAudioEngineMediaStream(engine: AudioEngine): AudioEngineMediaStream;
  export function disposeAudioEngineMediaStream(output: AudioEngineMediaStream): void;
  ```

  Creation requires a real-time `AudioContext`, connects a
  `MediaStreamAudioDestinationNode` in parallel with the audible destination,
  and registers idempotent engine-owned cleanup. Disposal disconnects only this
  tap, stops every track in its stream, and unregisters the engine cleanup
  closure so repeated recording sessions do not accumulate retained handles.
- **Visualizer (Lite-only, no AudioV2 counterpart).** A small canvas-2D
  waveform/bars helper for the demo and manual use:
  `createAudioVisualizer(host, canvas, options?)`,
  `renderAudioVisualizerFrame(viz)`, `startAudioVisualizer(viz)`,
  `stopAudioVisualizer(viz)`, `disposeAudioVisualizer(viz)`. Documented as an
  intentional adaptation (the runtime visualizer is presentation glue, not a
  port of audible behavior).
- **Spatial defaults match AudioV2 `_SpatialAudioDefaults`** — note the
  `distanceModel` default is **`"linear"`** (the prose in the design sketch said
  "inverse").
- **Streaming** exposes both `preloadStreamingInstanceAsync` and
  `preloadStreamingInstancesAsync`, and dedicated
  `play/pause/resume/stop/disposeStreamingSound` functions (not shared with the
  static functions).
- **`createSoundBufferAsync(engine, source, options?)`** and the `SoundBuffer` /
  `SoundSource` / `SoundBufferOptions` types are public.

Everything else (engine lifecycle, ramps, `AudioSignal`, `SoundState`, pure-state
interfaces, one-way spatial data ownership) is as designed.

### Sound sub-graph (signal flow)

Faithful reproduction of `_WebAudioBusAndSoundSubGraph`. Each sound/bus owns a
`SoundSubGraph` — a lazily-built chain of Web Audio nodes. Nodes exist only when
their feature is requested:

```
source/instance ─▶ [root Gain (only if spatial+stereo both present)]
                      ├─▶ Spatial (PannerNode [+ attenuation GainNode])
                      └─▶ Stereo  (StereoPannerNode)
                            ▼
                          Volume (GainNode)            ← always present
                            ▼
                          [Analyzer (AnalyserNode)]    ← only if fftSize given
                            ▼
                          out → outBus.in → … → mainBus → mainOut → ctx.destination
```

`SoundSubGraph` is plain state:

```typescript
interface SoundSubGraph {
    readonly _ctx: BaseAudioContext;
    _volume: GainNode; // always
    _stereo: StereoPannerNode | null;
    _spatial: SpatialSubNode | null;
    _analyzer: AnalyserNode | null;
    _root: GainNode | null; // only when spatial+stereo coexist
    _in: AudioNode; // current head of chain (where instances connect)
    _out: AudioNode; // tail (volume or analyzer)
}
```

`rebuildSubGraph(graph)` re-wires connections when a feature node is added or
removed (mirrors `_onSubNodesChanged`). Adding a feature is the _only_ way to
grow the graph — there is no hardcoded `if (spatial)` in core sound code; each
feature module exposes an `ensureXSubNode(graph, opts)` that the option parser
calls (Pillar 4c′ extension pattern, applied to audio sub-nodes).

### Parameter ramp component

`audio-param.ts` — pure, side-effect-free. `applyRamp(param, ctx, value, shape, duration, rampDuration)`:

- `"none"`: `param.value = value`.
- `"linear"`: `param.setValueCurveAtTime([from, to], ctx.currentTime, duration)`.
- `"exponential"` / `"logarithmic"`: build a 100-point curve via
  `getRampCurve(shape, from, to)` and `param.setValueCurveAtTime(curve, …)`.
  Below `MIN_RAMP_DURATION = 1e-6` s, fall back to `setValueAtTime`.
- Always `param.cancelScheduledValues(0)` before scheduling.

The exp/log normalized curves are cached via **lazy-init** (`let expCurve: Float32Array | null = null; function getExpCurve() {…}`) — never at module scope. Math copied verbatim from `audioUtils.ts` (`Math.exp(-11.512925464970227 * (1 - x))`, `1 + Math.log10(x)/Math.log10(100)`).

### Instances

A `StaticSound` spawns a `StaticSoundInstance` per `playSound` call, each wrapping
a fresh `AudioBufferSourceNode` (`start(when, offset)` / `stop(when)`), respecting
`loop`, `loopStart`/`loopEnd`, `startOffset`, pitch (cents → `detune`), and
`playbackRate`. `maxInstances` trims oldest started instances. Pause stores the
elapsed time and stops the source; resume creates a new source at the stored
offset. Streaming instances wrap an `HTMLAudioElement` +
`MediaElementAudioSourceNode` and support `preloadCount` look-ahead instances.

---

## State Machine / Lifecycle

### Engine

```
createAudioEngineAsync
  → new AudioContext (or use provided)
  → build mainOut GainNode → ctx.destination
  → build default MainBus → mainOut
  → build SpatialListener (lazy; only if spatial used)
  → wire "statechange" listener → onStateChanged signal
  → if resumeOnInteraction: document.addEventListener("click", resumeOnce)   [disposer registered]
  → if resumeOnPause: setInterval(retryResume, interval) while !running       [disposer registered]
disposeAudioEngine
  → run every fn in engine._disposers (removes listeners, clears interval/RAF)
  → close ctx unless it was provided/offline

createAudioEngineMediaStream
  → require a real-time AudioContext
  → create MediaStreamAudioDestinationNode
  → connect mainOut GainNode → media-stream destination (speaker path remains connected)
  → register idempotent tap disposal in engine._disposers
disposeAudioEngineMediaStream
  → disconnect only the media-stream destination
  → stop every MediaStreamTrack owned by the tap
```

All global hooks (`document` click listener, `setInterval`, spatial `requestAnimationFrame`) are registered into `engine._disposers` so disposal is leak-free. **Nothing is registered at module load** — the engine handle owns it all.

### Sound

`Stopped → Starting → Started → (Stopping) → Stopped`, with `Paused` and
`FailedToStart` branches — identical to `soundState.ts`. `onEnded` fires when the
last instance ends (non-looping full play, or explicit stop).

---

## Babylon.js Equivalence Map

| Lite function/type                 | AudioV2 origin                                               |
| ---------------------------------- | ------------------------------------------------------------ |
| `createAudioEngineAsync`           | `CreateAudioEngineAsync` + `_WebAudioEngine` ctor/init       |
| `AudioEngine.state`                | `AudioEngineV2.state` (maps `ctx.state`)                     |
| `unlockAudioEngineAsync`           | `_WebAudioEngine.unlockAsync` / `resumeAsync`                |
| `createSoundAsync`                 | `CreateSoundAsync` + `_WebAudioStaticSound._initAsync`       |
| `createSoundBufferAsync`           | `CreateSoundBufferAsync` (`decodeAudioData`)                 |
| `playSound`/`stopSound`/…          | `AbstractSound.play/stop/pause/resume`                       |
| `SoundSubGraph` + rebuild          | `_WebAudioBusAndSoundSubGraph` + `_onSubNodesChanged`        |
| `applyRamp` / `getRampCurve`       | `_WebAudioParameterComponent` + `_GetAudioParamCurveValues`  |
| `SpatialSubNode` / panner          | `_SpatialWebAudioSubNode` (PannerNode config)                |
| `SpatialListener`                  | `_SpatialWebAudioListener(+Fallback)`                        |
| `attachSpatialTarget`              | `_SpatialAudioAttacherComponent.attach`                      |
| `updateSpatialAudio` / RAF         | `_SpatialWebAudioUpdaterComponent`                           |
| `createStreamingSoundAsync`        | `CreateStreamingSoundAsync` + `_WebAudioStreamingSound`      |
| `createMicrophoneSoundSourceAsync` | `_WebAudioSoundSource` (getUserMedia)                        |
| `createUnmuteUi`                   | `_WebAudioUnmuteUI` (parentElement injected, no EngineStore) |
| `createAudioEngineMediaStream`     | Lite-only `MediaStreamAudioDestinationNode` post-master tap  |

Behavior (node types, parameter mappings, ramp curves, panner/listener math)
is identical. Only ownership, side-effect timing, and call syntax change.

---

## Dependencies

- **Web Audio API** (`AudioContext`, `GainNode`, `PannerNode`,
  `StereoPannerNode`, `AnalyserNode`, `AudioBufferSourceNode`,
  `MediaElementAudioSourceNode`, `MediaStreamAudioSourceNode`,
  `MediaStreamAudioDestinationNode`).
- **Lite `math/`** — `Vec3`, `Quat`, `Mat4` (spatial only; static/streaming/bus
  pull no math).
- **`fetch()`** — same plain pattern as every other Lite loader (no WebRequest).
- No GPU, no scene, no render-loop dependency.

---

## Tree-Shaking / Bundle Strategy

- `audio/index.ts` re-exports only side-effect-free modules; nothing runs at import.
- Feature modules (`spatial/`, `streaming/`, `analyzer/`, `microphone/`,
  `media-stream-output/`, `unmute-ui/`) are reachable only through their own
  factory functions, so an app using just `createSoundAsync` + `playSound`
  drops every other module.
- The sub-node `ensureXSubNode` registration is wired through the option parser,
  not a global registry — unused sub-nodes are eliminated.
- Lazy-init for all caches (ramp curves, file-extension regex). **No
  module-level `new` of `Map`/`Set`/`Observable`/`RegExp`.**

---

## Test Specification

Audio produces **no pixels**, so the Playwright screenshot/MAD parity harness
does **not** apply directly. Instead, audio is tested in **four tiers**. Tier 1
(mocked Web Audio) is the always-on deterministic CI gate; Tiers 2–3 render
through a **real** `OfflineAudioContext` and are **opt-in** (see below); Tier 4
is a manual showcase. The cornerstone is **`OfflineAudioContext`**: the entire
Web Audio graph can be rendered faster-than-real-time, with **no user gesture
and no speakers**, into a reproducible `AudioBuffer`. This lets us assert on the
_actual rendered PCM_ — a stronger guarantee than any screenshot — and,
optionally, draw that PCM to a canvas for a deterministic _visual_ gate.

> **As-built (Tier 2–3 backend).** There is no in-browser run for these; they run
> headless in vitest against the native **`node-web-audio-api`** package, a
> **dev-only** dependency that supplies a real `OfflineAudioContext` and the Web
> Audio node constructors. The harness installs those classes as globals for the
> duration of a render and passes the offline context to
> `createAudioEngineAsync({ audioContext })`. Because the native prebuilt binary
> may be unavailable on some platforms, **every Tier-2/3 spec self-skips** via
> `describe.skipIf(!realWebAudioAvailable)`, so install/CI never hard-fail. The
> tiers live in their own opt-in vitest project `audio-offline`
> (`pnpm test:audio-offline`), separate from the `unit` project.
>
> The `createAudioEngineAsync` `audioContext` option accepts a
> `BaseAudioContext`, so passing an `OfflineAudioContext` is the supported entry
> point for offline rendering. The engine detects offline contexts and skips
> `close()`/gesture-unlock paths on them (mirrors AudioV2's
> `_isUsingOfflineAudioContext`).

### Tier 1 — Unit / behavioral (mocked Web Audio API), deterministic — always-on CI gate

**As-built:** `tests/lite/unit/audio/*.test.ts` (mocked Web Audio, runs in the
`unit` vitest project; no native dependency).

1. **Graph wiring** — assert the correct `connect()` topology for every feature
   combination (volume only; +stereo; +spatial; +spatial+stereo with root gain;
   +analyzer). Verify rebuild on add/remove.
2. **Ramps** — assert `setValueCurveAtTime` is called with the exact 2-point
   linear array and the 100-point exp/log curves (snapshot the curve values
   against the verbatim BJS math); assert `cancelScheduledValues(0)` precedes.
3. **Lifecycle** — state transitions; `onEnded` fires once on last-instance end;
   `maxInstances` trims oldest; pause/resume offset correctness.
4. **Spatial wiring** — panner `positionX/Y/Z`, `orientationX/Y/Z`, distance/cone
   params set from a fake `SpatialTarget.worldMatrix`; listener 9-param path +
   legacy `setPosition`/`setOrientation` fallback; `updateSpatialAudio` throttling.
5. **No side effects** — import every `audio/` module and assert no global
   mutation, no `document`/`setInterval`/`new AudioContext` at import time
   (guards the zero-side-effect pillar).
6. **Disposal** — `disposeAudioEngine` removes the click listener, clears the
   resume interval/RAF, stops registered media-stream output tracks, and closes
   only contexts it created. `disposeAudioEngineMediaStream` disconnects only
   its tap, stops its tracks, and is idempotent.

### Tier 2 — Output correctness (`OfflineAudioContext` → PCM), opt-in (native) ★ primary correctness tier

Render real sounds through a real (offline) Web Audio graph and assert on the
returned samples. This validates audible behavior, not just node wiring.
**As-built:** `tests/lite/audio/offline/*.test.ts` (15 tests).

7. **Playback** — render a known buffer (a 440 Hz sine) and assert peak/RMS,
   per-window silence, and total duration. Looping renders the expected repeats;
   `startOffset` shifts the first non-zero sample.
8. **Volume / ramps** — render a sound-volume ramp and assert the PCM envelope
   follows the linear fade in/out (monotonic across windows).
9. **Stereo** — assert left/right channel energy split matches the pan value
   (measured after the default pan ramp settles).
10. **Spatial** — render with the source panned left/right and assert the
    inter-channel level split, plus linear-distance-model attenuation (a distant
    source is measurably quieter than a near one).
11. **Bus routing** — attenuation through a bus chain matches the expected ratio
    of the direct output.

### Tier 3 — Visual parity (offline PCM → waveform canvas), opt-in (native)

12. Draw the Tier-2 rendered PCM to an image (a deterministic waveform raster)
    and diff against a committed golden. Because offline rendering is
    reproducible, the image is deterministic — this is the "show the waves" gate.
    **As-built:** `tests/lite/audio/visual/waveform-golden.test.ts` renders via a
    small dependency-light **pngjs** rasterizer (`_shared/waveform-png.ts`) —
    used instead of a DOM canvas, which Node lacks without an extra native
    dependency. The waveform band is drawn **thick** and the diff is
    **position-tolerant** (a pixel matches if any golden pixel within a 2 px
    radius is within tolerance), so cosmetic sub-pixel envelope shifts across
    platforms do not flake the gate; a companion `golden-robustness.test.ts`
    asserts a 2 px shift passes while a 12 px shift is still caught. Goldens live
    under `reference/lite/audio/<case>.png` and are regenerated only on explicit
    request (`UPDATE_AUDIO_GOLDENS=1`).

### Tier 4 — Live demo visualizer, NOT a gate

13. The interactive demo uses a real-time `AnalyserNode` to draw a waveform +
    frequency-bar visualizer. It requires a user gesture to unlock the context
    and is non-deterministic, so it is a **manual showcase only** — never a CI
    check.

### Behavioral parity against Babylon.js (optional, deterministic)

Render the same sound through BJS AudioV2 and through Lite, both on an
`OfflineAudioContext`, then diff the PCM. True behavioral parity, no ears
required. Useful for validating the spatial/ramp math during the port; not a
standing CI gate.

---

## File Manifest

As-built layout is **flat** (no per-feature subdirectories):

```
packages/babylon-lite/src/audio/
  index.ts                  # pure barrel
  audio-engine.ts           # createAudioEngineAsync, dispose, unlock, master volume, offline detect
  audio-signal.ts           # AudioSignal<T> (Observable replacement)
  audio-param.ts            # ramp shapes + curve math (lazy-init caches)
  audio-fetch.ts            # decode helpers over plain fetch()
  sound-buffer.ts           # createSoundBufferAsync (decodeAudioData) + SoundBuffer
  static-sound.ts           # StaticSound + instance lifecycle
  streaming-sound.ts        # StreamingSound (HTMLAudioElement path)
  sound-sub-graph.ts        # SoundSubGraph build/rebuild (core chain)
  bus.ts                    # MainBus (engine-owned)
  audio-bus.ts              # AudioBus (createAudioBusAsync / dispose)
  spatial.ts                # PannerNode + listener (+ legacy fallback) + attach/RAF updater
  stereo.ts                 # StereoPannerNode sub-node
  analyzer.ts               # AnalyserNode (frequency + time-domain readback)
  sound-source.ts           # createSoundSourceAsync / microphone (getUserMedia)
  media-stream-output.ts     # post-master MediaStream tap (recording / WebRTC)
  unmute-ui.ts              # DOM button (parentElement injected)
  visualizer.ts             # runtime canvas waveform/bars (demo + manual; Lite-only)
  host-types.ts             # AudioGraphHost union + shared sub-graph host plumbing
docs/lite/architecture/41-audio-engine.md      # this doc
tests/lite/unit/audio/*.test.ts                # Tier-1 vitest (mocked Web Audio; unit project)
tests/lite/audio/offline/*.test.ts             # Tier-2 vitest (real OfflineAudioContext → PCM; audio-offline project)
tests/lite/audio/visual/*.test.ts              # Tier-3 (offline PCM → pngjs waveform → golden diff)
tests/lite/audio/_shared/real-web-audio.ts     # node-web-audio-api harness (globals + renderOffline)
tests/lite/audio/_shared/waveform-png.ts       # pngjs rasterizer + position-tolerant golden compare
reference/lite/audio/<case>.png                # Tier-3 golden waveform images (flat)
lab/lite/...                                    # Tier-4 interactive showcase (real-time visualizer)
```

> The Tier-3 rasterizer (`tests/lite/audio/_shared/waveform-png.ts`) is a
> **test-only** pngjs stand-in for the runtime canvas `visualizer.ts`; it exists
> because Node has no DOM canvas. Tier-2/3 run headless in vitest against the
> native **`node-web-audio-api`** dev dependency (real `OfflineAudioContext`) and
> **self-skip** when its prebuilt binary is unavailable; Tier-4 uses the on-screen
> runtime visualizer.
