/**
 * Minimal Web Audio API mock for Tier-1 (wiring / ramp / lifecycle) audio tests.
 *
 * Node has no Web Audio implementation, so these mocks record graph connections
 * and `AudioParam` scheduling calls so the audio engine's behaviour can be
 * asserted without a real audio backend. Tier-2 (real PCM via OfflineAudioContext)
 * is a separate, browser/native-backed concern.
 */

export class MockAudioParam {
    public value: number;
    public readonly calls: Array<{ method: string; args: unknown[] }> = [];

    public constructor(initial = 0) {
        this.value = initial;
    }

    public cancelScheduledValues(time: number): void {
        this.calls.push({ method: "cancelScheduledValues", args: [time] });
    }

    public setValueAtTime(value: number, time: number): void {
        this.value = value;
        this.calls.push({ method: "setValueAtTime", args: [value, time] });
    }

    public setValueCurveAtTime(curve: Float32Array, time: number, duration: number): void {
        this.value = curve[curve.length - 1]!;
        this.calls.push({ method: "setValueCurveAtTime", args: [curve.slice(), time, duration] });
    }

    public setTargetAtTime(value: number, time: number, constant: number): void {
        this.calls.push({ method: "setTargetAtTime", args: [value, time, constant] });
    }
}

export class MockAudioNode {
    public readonly connections = new Set<MockAudioNode>();

    public connect(node: MockAudioNode): MockAudioNode {
        this.connections.add(node);
        return node;
    }

    public disconnect(node?: MockAudioNode): void {
        if (node) {
            this.connections.delete(node);
        } else {
            this.connections.clear();
        }
    }
}

export class MockGainNode extends MockAudioNode {
    public readonly gain = new MockAudioParam(1);
    public constructor(public readonly context: MockBaseAudioContext) {
        super();
    }
}

export class MockPannerNode extends MockAudioNode {
    public readonly positionX = new MockAudioParam(0);
    public readonly positionY = new MockAudioParam(0);
    public readonly positionZ = new MockAudioParam(0);
    public readonly orientationX = new MockAudioParam(1);
    public readonly orientationY = new MockAudioParam(0);
    public readonly orientationZ = new MockAudioParam(0);
    public coneInnerAngle = 360;
    public coneOuterAngle = 360;
    public coneOuterGain = 0;
    public distanceModel: "linear" | "inverse" | "exponential" = "inverse";
    public panningModel: "equalpower" | "HRTF" = "equalpower";
    public maxDistance = 10000;
    public refDistance = 1;
    public rolloffFactor = 1;
    public constructor(public readonly context: MockBaseAudioContext) {
        super();
    }
}

export class MockStereoPannerNode extends MockAudioNode {
    public readonly pan = new MockAudioParam(0);
    public constructor(public readonly context: MockBaseAudioContext) {
        super();
    }
}

export class MockAnalyserNode extends MockAudioNode {
    public fftSize = 2048;
    public minDecibels = -100;
    public maxDecibels = -30;
    public smoothingTimeConstant = 0.8;
    public constructor(public readonly context: MockBaseAudioContext) {
        super();
    }

    public get frequencyBinCount(): number {
        return this.fftSize / 2;
    }

    public getByteFrequencyData(array: Uint8Array): void {
        array.fill(0);
    }

    public getFloatFrequencyData(array: Float32Array): void {
        array.fill(this.minDecibels);
    }

    public getByteTimeDomainData(array: Uint8Array): void {
        array.fill(128);
    }

    public getFloatTimeDomainData(array: Float32Array): void {
        array.fill(0);
    }
}

export class MockAudioListener {
    public readonly positionX = new MockAudioParam(0);
    public readonly positionY = new MockAudioParam(0);
    public readonly positionZ = new MockAudioParam(0);
    public readonly forwardX = new MockAudioParam(0);
    public readonly forwardY = new MockAudioParam(0);
    public readonly forwardZ = new MockAudioParam(-1);
    public readonly upX = new MockAudioParam(0);
    public readonly upY = new MockAudioParam(1);
    public readonly upZ = new MockAudioParam(0);
}

export class MockAudioBuffer {
    public constructor(
        public readonly duration = 1,
        public readonly sampleRate = 48000,
        public readonly numberOfChannels = 2,
        public readonly length = 48000
    ) {}

    public getChannelData(): Float32Array {
        return new Float32Array(this.length);
    }
}

export class MockAudioBufferSourceNode extends MockAudioNode {
    public buffer: MockAudioBuffer | null;
    public readonly detune = new MockAudioParam(0);
    public readonly playbackRate = new MockAudioParam(1);
    public loop = false;
    public loopStart = 0;
    public loopEnd = 0;
    public started: { when?: number; offset?: number; duration?: number } | null = null;
    public stopped: { when?: number } | null = null;
    private _listeners: Array<() => void> = [];

    public constructor(
        public readonly context: MockBaseAudioContext,
        options?: { buffer?: MockAudioBuffer }
    ) {
        super();
        this.buffer = options?.buffer ?? null;
    }

    public start(when?: number, offset?: number, duration?: number): void {
        this.started = { when, offset, duration };
    }

    public stop(when?: number): void {
        this.stopped = { when };
    }

    public addEventListener(type: string, cb: () => void): void {
        if (type === "ended") {
            this._listeners.push(cb);
        }
    }

    public removeEventListener(type: string, cb: () => void): void {
        if (type === "ended") {
            this._listeners = this._listeners.filter((l) => l !== cb);
        }
    }

    /** Test helper — fire the "ended" event. */
    public fireEnded(): void {
        for (const cb of this._listeners.slice()) {
            cb();
        }
    }
}

export class MockBaseAudioContext {
    public currentTime = 0;
    public readonly destination = new MockAudioNode();
    public readonly listener = new MockAudioListener();
    public readonly stateListeners: Array<() => void> = [];

    public decodeAudioData(_data: ArrayBuffer): Promise<MockAudioBuffer> {
        return Promise.resolve(new MockAudioBuffer());
    }
}

export class MockAudioContext extends MockBaseAudioContext {
    public state: "running" | "suspended" | "closed" = "running";

    public addEventListener(type: string, cb: () => void): void {
        if (type === "statechange") {
            this.stateListeners.push(cb);
        }
    }

    public removeEventListener(type: string, cb: () => void): void {
        if (type === "statechange") {
            const i = this.stateListeners.indexOf(cb);
            if (i !== -1) {
                this.stateListeners.splice(i, 1);
            }
        }
    }

    public async resume(): Promise<void> {
        this._setState("running");
    }

    public async suspend(): Promise<void> {
        this._setState("suspended");
    }

    public async close(): Promise<void> {
        this._setState("closed");
    }

    /** Test helper — change state and fire statechange listeners. */
    public _setState(state: "running" | "suspended" | "closed"): void {
        this.state = state;
        for (const cb of this.stateListeners.slice()) {
            cb();
        }
    }
}

export class MockOfflineAudioContext extends MockBaseAudioContext {
    public constructor(
        public readonly numberOfChannels = 2,
        public readonly bufferLength = 48000,
        public readonly sampleRate = 48000
    ) {
        super();
    }
}

export class MockSourceElement {
    public src = "";
}

export class MockMediaElement {
    public src: string;
    public currentSrc: string;
    public crossOrigin: string | null = null;
    public controls = false;
    public loop = false;
    public preload = "";
    public currentTime = 0;
    public loaded = false;
    public playing = false;
    public paused = true;
    public readonly children: MockSourceElement[] = [];
    private _listeners: { [type: string]: Array<() => void> } = {};

    public constructor(src?: string) {
        this.src = src ?? "";
        this.currentSrc = src ?? "";
    }

    public addEventListener(type: string, cb: () => void): void {
        (this._listeners[type] ??= []).push(cb);
    }

    public removeEventListener(type: string, cb: () => void): void {
        const list = this._listeners[type];
        if (list) {
            const i = list.indexOf(cb);
            if (i !== -1) {
                list.splice(i, 1);
            }
        }
    }

    public appendChild(node: MockSourceElement): MockSourceElement {
        this.children.push(node);
        return node;
    }

    public removeChild(node: MockSourceElement): void {
        const i = this.children.indexOf(node);
        if (i !== -1) {
            this.children.splice(i, 1);
        }
    }

    public load(): void {
        this.loaded = true;
        // Auto-signal readiness on the next microtask so awaited preloads resolve.
        queueMicrotask(() => this.fire("canplaythrough"));
    }

    public async play(): Promise<void> {
        this.playing = true;
        this.paused = false;
    }

    public pause(): void {
        this.playing = false;
        this.paused = true;
    }

    public canPlayType(): string {
        return "probably";
    }

    /** Test helper — dispatch a registered event. */
    public fire(type: string): void {
        for (const cb of (this._listeners[type] ?? []).slice()) {
            cb();
        }
    }
}

export class MockMediaElementAudioSourceNode extends MockAudioNode {
    public constructor(
        public readonly context: MockBaseAudioContext,
        public readonly options: { mediaElement: MockMediaElement }
    ) {
        super();
    }
}

export class MockMediaStreamTrack {
    public stopped = false;
    public stop(): void {
        this.stopped = true;
    }
}

export class MockMediaStream {
    public constructor(public readonly tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack()]) {}
    public getTracks(): MockMediaStreamTrack[] {
        return this.tracks;
    }
}

export class MockMediaStreamAudioSourceNode extends MockAudioNode {
    public readonly mediaStream: MockMediaStream;
    public constructor(
        public readonly context: MockBaseAudioContext,
        options: { mediaStream: MockMediaStream }
    ) {
        super();
        this.mediaStream = options.mediaStream;
    }
}

/** Minimal DOM element mock for the unmute-UI tests. */
export class MockDomElement {
    public className = "";
    public id = "";
    public readonly style: Record<string, string> = {};
    public offsetTop = 0;
    public removed = false;
    public readonly children: unknown[] = [];
    private _listeners: { [type: string]: Array<() => void> } = {};

    public constructor(public readonly tagName = "") {}

    public appendChild(node: unknown): unknown {
        this.children.push(node);
        return node;
    }

    public remove(): void {
        this.removed = true;
    }

    public addEventListener(type: string, cb: () => void): void {
        (this._listeners[type] ??= []).push(cb);
    }

    public removeEventListener(type: string, cb: () => void): void {
        const list = this._listeners[type];
        if (list) {
            const i = list.indexOf(cb);
            if (i !== -1) {
                list.splice(i, 1);
            }
        }
    }

    /** Test helper — dispatch a registered event (e.g. "click"). */
    public fire(type: string): void {
        for (const cb of (this._listeners[type] ?? []).slice()) {
            cb();
        }
    }
}

/** Minimal `document` mock for the unmute-UI tests. */
export class MockDocument {
    public readonly head = new MockDomElement("head");
    public readonly body = new MockDomElement("body");
    public createElement(tag: string): MockDomElement {
        return new MockDomElement(tag);
    }
    public createTextNode(text: string): { nodeValue: string } {
        return { nodeValue: text };
    }
}

/** Records 2D-canvas draw calls for the visualizer tests. */
export class MockCanvasContext2D {
    public fillStyle = "";
    public strokeStyle = "";
    public lineWidth = 1;
    public fillRectCount = 0;
    public strokeCount = 0;
    public moveToCount = 0;
    public lineToCount = 0;
    public lastFillStyle = "";

    public fillRect(): void {
        this.fillRectCount++;
        this.lastFillStyle = this.fillStyle;
    }
    public beginPath(): void {}
    public moveTo(): void {
        this.moveToCount++;
    }
    public lineTo(): void {
        this.lineToCount++;
    }
    public stroke(): void {
        this.strokeCount++;
    }
    public clearRect(): void {}
}

/** Minimal `<canvas>` mock exposing a recording 2D context. */
export class MockCanvas {
    public width = 300;
    public height = 150;
    public readonly context2d = new MockCanvasContext2D();
    public getContext(type: string): MockCanvasContext2D | null {
        return type === "2d" ? this.context2d : null;
    }
}

interface InstalledGlobals {
    [key: string]: unknown;
}

const SAVED: InstalledGlobals = {};
const KEYS = ["AudioContext", "OfflineAudioContext", "GainNode", "AudioBufferSourceNode", "AudioBuffer", "Audio", "PannerNode", "StereoPannerNode", "AnalyserNode"];

const STREAMING_SAVED: InstalledGlobals = {};
const STREAMING_KEYS = ["Audio", "MediaElementAudioSourceNode", "document"];

/** Installs media-element mocks for streaming-sound tests. Call after {@link installWebAudioMock}. */
export function installStreamingMocks(): void {
    const g = globalThis as unknown as InstalledGlobals;
    for (const key of STREAMING_KEYS) {
        STREAMING_SAVED[key] = g[key];
    }
    g.Audio = MockMediaElement;
    g.MediaElementAudioSourceNode = MockMediaElementAudioSourceNode;
    // Minimal document for the multi-source (<source>) path. No addEventListener,
    // so the engine's user-gesture wiring stays disabled.
    g.document = { createElement: (_tag: string) => new MockSourceElement() };
}

/** Restores the globals modified by {@link installStreamingMocks}. */
export function uninstallStreamingMocks(): void {
    const g = globalThis as unknown as InstalledGlobals;
    for (const key of STREAMING_KEYS) {
        g[key] = STREAMING_SAVED[key];
    }
}

/** Installs the Web Audio mock onto `globalThis`. Call from `beforeEach`. */
export function installWebAudioMock(): void {
    const g = globalThis as unknown as InstalledGlobals;
    for (const key of KEYS) {
        SAVED[key] = g[key];
    }
    g.AudioContext = MockAudioContext;
    g.OfflineAudioContext = MockOfflineAudioContext;
    g.GainNode = MockGainNode;
    g.AudioBufferSourceNode = MockAudioBufferSourceNode;
    g.AudioBuffer = MockAudioBuffer;
    g.PannerNode = MockPannerNode;
    g.StereoPannerNode = MockStereoPannerNode;
    g.AnalyserNode = MockAnalyserNode;
    // Leave `Audio` undefined so `isAudioFormatValid` treats formats as valid in tests.
    g.Audio = undefined;
}

/** Restores the globals modified by {@link installWebAudioMock}. Call from `afterEach`. */
export function uninstallWebAudioMock(): void {
    const g = globalThis as unknown as InstalledGlobals;
    for (const key of KEYS) {
        g[key] = SAVED[key];
    }
}

const MIC_SAVED: InstalledGlobals = {};

/**
 * Installs microphone mocks: `MediaStreamAudioSourceNode` + a `navigator` with
 * `mediaDevices.getUserMedia`. Pass `{ deny: true }` to simulate denied access.
 */
export function installMicrophoneMocks(opts: { deny?: boolean; stream?: MockMediaStream } = {}): MockMediaStream {
    const g = globalThis as unknown as InstalledGlobals;
    MIC_SAVED.MediaStreamAudioSourceNode = g.MediaStreamAudioSourceNode;
    MIC_SAVED.navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

    const stream = opts.stream ?? new MockMediaStream();
    g.MediaStreamAudioSourceNode = MockMediaStreamAudioSourceNode;
    // `navigator` is a getter-only global in Node — redefine it.
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: {
            mediaDevices: {
                getUserMedia: async () => {
                    if (opts.deny) {
                        throw new Error("Permission denied");
                    }
                    return stream;
                },
            },
        },
    });
    return stream;
}

/** Restores the globals modified by {@link installMicrophoneMocks}. */
export function uninstallMicrophoneMocks(): void {
    const g = globalThis as unknown as InstalledGlobals;
    g.MediaStreamAudioSourceNode = MIC_SAVED.MediaStreamAudioSourceNode;
    const desc = MIC_SAVED.navigator as PropertyDescriptor | undefined;
    if (desc) {
        Object.defineProperty(globalThis, "navigator", desc);
    } else {
        delete (globalThis as unknown as Record<string, unknown>).navigator;
    }
}

const DOM_SAVED: InstalledGlobals = {};

/** Installs a minimal `document` mock for the unmute-UI tests; returns it. */
export function installDomMock(): MockDocument {
    const g = globalThis as unknown as InstalledGlobals;
    DOM_SAVED.document = g.document;
    const doc = new MockDocument();
    g.document = doc;
    return doc;
}

/** Restores the global `document` modified by {@link installDomMock}. */
export function uninstallDomMock(): void {
    const g = globalThis as unknown as InstalledGlobals;
    g.document = DOM_SAVED.document;
}
