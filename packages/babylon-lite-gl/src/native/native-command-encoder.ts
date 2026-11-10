/**
 * Command-stream machinery for the native backend — a faithful port of Babylon
 * Native's `NativeDataStream` (nativeDataStream.ts) and the `CommandBufferEncoder`
 * (thinNativeEngine.pure.ts). Every device mutation on the native backend
 * (bind/draw/state/uniform) is encoded as a tagged command into a growable
 * `Uint32Array` view that the host drains via `writeBuffer`, then flushed with
 * `submitCommands`.
 *
 * These are `@internal` — only native-device.ts / native-context.ts use them.
 */
import type { INativeDataStream, INativeEngine, NativeData } from "./native-types.js";

/** Backing buffer size, in bytes. Must be a multiple of 4. Mirrors Babylon. */
const DEFAULT_BUFFER_SIZE = 65536;

/**
 * A CPU-side ring of the native command bytes. Values are written through the
 * uint32 / int32 / float32 views over one shared `ArrayBuffer`; when it fills,
 * `_flush` hands the filled prefix to the host and rewinds.
 * @internal
 */
export class NativeDataStream {
    /** @internal */ private readonly _uint32s: Uint32Array;
    /** @internal */ private readonly _int32s: Int32Array;
    /** @internal */ private readonly _float32s: Float32Array;
    /** @internal */ private readonly _length: number;
    /** @internal */ private _position: number;
    /** @internal The raw host command stream the buffered words are flushed into.
     *  The host's `setCommandDataStream` unwraps this by the exact property NAME
     *  `_nativeDataStream` off the wrapper (see NativeEngine.cpp
     *  `Get("_nativeDataStream")`), so this name is a host ABI contract — it must
     *  not be renamed or property-mangled. `@internal` only strips it from the
     *  emitted `.d.ts`; the runtime `.js` property name is preserved. Mirrors
     *  core's `NativeDataStream`. */
    public readonly _nativeDataStream: INativeDataStream;

    /** Allocate the stream and register it with the host's flush callback. */
    public constructor() {
        const buffer = new ArrayBuffer(DEFAULT_BUFFER_SIZE);
        this._uint32s = new Uint32Array(buffer);
        this._int32s = new Int32Array(buffer);
        this._float32s = new Float32Array(buffer);
        this._length = DEFAULT_BUFFER_SIZE / 4;
        this._position = 0;
        this._nativeDataStream = new _native.NativeDataStream(() => {
            this._flush();
        });
    }

    /** Write a single uint32. */
    public writeUint32(value: number): void {
        this._flushIfNecessary(1);
        this._uint32s[this._position++] = value;
    }

    /** Write a single int32. */
    public writeInt32(value: number): void {
        this._flushIfNecessary(1);
        this._int32s[this._position++] = value;
    }

    /** Write a single float32. */
    public writeFloat32(value: number): void {
        this._flushIfNecessary(1);
        this._float32s[this._position++] = value;
    }

    /** Write a length-prefixed int32 array. */
    public writeInt32Array(values: Int32Array): void {
        this._flushIfNecessary(1 + values.length);
        this._uint32s[this._position++] = values.length;
        this._int32s.set(values, this._position);
        this._position += values.length;
    }

    /** Write a length-prefixed float32 array. */
    public writeFloat32Array(values: Float32Array | number[]): void {
        this._flushIfNecessary(1 + values.length);
        this._uint32s[this._position++] = values.length;
        this._float32s.set(values, this._position);
        this._position += values.length;
    }

    /** Write an opaque native handle (a small run of uint32s). */
    public writeNativeData(handle: NativeData): void {
        this._flushIfNecessary(handle.length);
        this._uint32s.set(handle, this._position);
        this._position += handle.length;
    }

    /** @internal Flush when the next write of `required` words would overflow. */
    private _flushIfNecessary(required: number): void {
        if (this._position + required > this._length) {
            this._flush();
        }
    }

    /** @internal Hand the filled prefix to the host and rewind. */
    private _flush(): void {
        this._nativeDataStream.writeBuffer(this._uint32s.buffer as ArrayBuffer, this._position);
        this._position = 0;
    }
}

/**
 * Encodes tagged commands into a {@link NativeDataStream} and submits them. A
 * "command scope" batches a whole frame's commands and submits ONCE at
 * `endCommandScope`; outside a scope each command self-submits (matching
 * Babylon's `finishEncodingCommand`).
 * @internal
 */
export class CommandBufferEncoder {
    /** @internal */ private readonly _stream: NativeDataStream;
    /** @internal */ private _scopeActive = false;

    /** Create the stream and install it on the engine. The host unwraps the raw
     *  stream by the `_nativeDataStream` property off the passed wrapper, so pass
     *  the wrapper itself (NOT `_stream._nativeDataStream`) — matching core. */
    public constructor(private readonly _engine: INativeEngine) {
        this._stream = new NativeDataStream();
        this._engine.setCommandDataStream(this._stream);
    }

    /** Open a batching scope — commands accumulate until {@link endCommandScope}. */
    public beginCommandScope(): void {
        if (this._scopeActive) {
            throw new Error("lite-gl: native command scope already active");
        }
        this._scopeActive = true;
    }

    /** Close the batching scope and submit everything recorded within it. */
    public endCommandScope(): void {
        if (!this._scopeActive) {
            throw new Error("lite-gl: native command scope is not active");
        }
        this._scopeActive = false;
        this._engine.submitCommands();
    }

    /** Submit the commands recorded so far in an open scope (the scope stays
     *  open). Call before an IMMEDIATE host call that destroys or replaces a
     *  resource (e.g. `deleteTexture`) so queued commands that still reference
     *  it are processed first. No-op outside a scope (commands self-submit). */
    public submitPending(): void {
        if (this._scopeActive) {
            this._engine.submitCommands();
        }
    }

    /** Begin a command with its tag. */
    public startEncodingCommand(command: NativeData): void {
        this._stream.writeNativeData(command);
    }

    /** Append a uint32 argument. */
    public encodeCommandArgAsUInt32(value: number): void {
        this._stream.writeUint32(value);
    }

    /** Append an int32 argument. */
    public encodeCommandArgAsInt32(value: number): void {
        this._stream.writeInt32(value);
    }

    /** Append an int32-array argument. */
    public encodeCommandArgAsInt32s(value: Int32Array): void {
        this._stream.writeInt32Array(value);
    }

    /** Append a float32 argument. */
    public encodeCommandArgAsFloat32(value: number): void {
        this._stream.writeFloat32(value);
    }

    /** Append a float32-array argument. */
    public encodeCommandArgAsFloat32s(value: Float32Array | number[]): void {
        this._stream.writeFloat32Array(value);
    }

    /** Append an opaque native-handle argument. */
    public encodeCommandArgAsNativeData(value: NativeData): void {
        this._stream.writeNativeData(value);
    }

    /** Finish a command; self-submits when no batching scope is open. */
    public finishEncodingCommand(): void {
        if (!this._scopeActive) {
            this._engine.submitCommands();
        }
    }
}
