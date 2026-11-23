import type { NativeEngine, NativeHandle, NativeRuntime } from "./runtime.js";

/** @internal Capacity of the reusable command buffer, in 32-bit words. */
export const COMMAND_STREAM_WORDS = 16384;

function capacityError(): Error {
    return new Error(`Native Lite GL command exceeds its ${(COMMAND_STREAM_WORDS * 4) / 1024} KiB buffer.`);
}

/** @internal */
export class CommandStream {
    /** Reusable copy of an array upload, read completely before any of its command is recorded. */
    readonly staging: number[] = [];
    /** Changes whenever an array upload claims `staging`, so an interrupted upload can detect the overwrite. */
    private stagingGeneration = 0;
    private readonly words = new Uint32Array(COMMAND_STREAM_WORDS);
    private readonly integers = new Int32Array(this.words.buffer);
    private readonly floats = new Float32Array(this.words.buffer);
    private position = 0;
    private frameActive = false;
    private readonly retained: NativeHandle[] = [];
    /** Host textures whose deletion waits until the commands recorded before it are submitted. */
    private readonly deletedTextures: NativeHandle[] = [];
    /** @internal */
    readonly _nativeDataStream;

    constructor(
        private readonly runtime: NativeRuntime,
        private readonly engine: NativeEngine
    ) {
        this._nativeDataStream = new runtime.NativeDataStream(() => this.flush());
        engine.setCommandDataStream(this);
    }

    begin(): void {
        if (this.frameActive) {
            throw new Error("Native Lite GL frame is already active.");
        }
        this.frameActive = true;
    }

    end(): void {
        if (!this.frameActive) {
            throw new Error("Native Lite GL frame is not active.");
        }
        this.frameActive = false;
        this.submit();
    }

    start(command: NativeHandle): void {
        this.handle(command);
    }

    uint(value: number): void {
        this.tag(this.runtime.NativeDataStream.VALIDATION_UINT_32);
        this.reserve(1);
        this.words[this.position++] = value;
    }

    int(value: number): void {
        this.tag(this.runtime.NativeDataStream.VALIDATION_INT_32);
        this.reserve(1);
        this.integers[this.position++] = value;
    }

    float(value: number): void {
        this.tag(this.runtime.NativeDataStream.VALIDATION_FLOAT_32);
        this.reserve(1);
        this.floats[this.position++] = value;
    }

    bool(value: boolean): void {
        this.tag(this.runtime.NativeDataStream.VALIDATION_BOOLEAN);
        this.reserve(1);
        this.words[this.position++] = value ? 1 : 0;
    }

    /** Encodes the first `length` values. */
    array(values: readonly number[], length: number): void {
        this.tag(this.runtime.NativeDataStream.VALIDATION_FLOAT_32_ARRAY);
        this.reserve(1 + length);
        this.words[this.position++] = length;
        for (let index = 0; index < length; index++) {
            this.floats[this.position++] = values[index] as number;
        }
    }

    handle(value: NativeHandle): void {
        this.tag(this.runtime.NativeDataStream.VALIDATION_NATIVE_DATA);
        this.reserve(value.length);
        this.words.set(value, this.position);
        this.position += value.length;
        this.retained.push(value);
    }

    finish(): void {
        if (!this.frameActive) {
            this.submit();
        }
    }

    /** Claims `staging` for an encodable float array of `length` values. */
    beginStaging(length: number): number {
        if (!Number.isInteger(length) || length < 0) {
            throw new RangeError(`Native Lite GL array length must be a nonnegative integer, got ${length}.`);
        }
        if (length + 1 > this.words.length) {
            throw capacityError();
        }
        return ++this.stagingGeneration;
    }

    /** Rejects an upload whose `staging` claim was taken by a nested upload. */
    endStaging(generation: number): void {
        if (generation !== this.stagingGeneration) {
            throw new Error("Native Lite GL array upload was interrupted by a nested array upload while reading its values.");
        }
    }

    /** Deletes host texture storage once every command recorded before this call has been submitted. */
    deleteTexture(texture: NativeHandle): void {
        this.deletedTextures.push(texture);
        this.finish();
    }

    private tag(value: number): void {
        if (this.runtime.NativeDataStream.VALIDATION_ENABLED) {
            this.reserve(1);
            this.words[this.position++] = value;
        }
    }

    private reserve(length: number): void {
        if (length > this.words.length) {
            throw capacityError();
        }
        if (this.position + length > this.words.length) {
            this.flush();
        }
    }

    private flush(): void {
        this._nativeDataStream.writeBuffer(this.words.buffer, this.position);
        this.position = 0;
    }

    private submit(): void {
        this.engine.submitCommands();
        this.retained.length = 0;
        for (let index = 0; index < this.deletedTextures.length; index++) {
            this.engine.deleteTexture(this.deletedTextures[index] as NativeHandle);
        }
        this.deletedTextures.length = 0;
    }
}
