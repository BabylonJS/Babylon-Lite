import type { NativeEngine, NativeHandle, NativeRuntime } from "./runtime.js";

/** @internal */
export class CommandStream {
    private readonly words = new Uint32Array(16384);
    private readonly integers = new Int32Array(this.words.buffer);
    private readonly floats = new Float32Array(this.words.buffer);
    private position = 0;
    private frameActive = false;
    private readonly retained: NativeHandle[] = [];
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

    array(values: ArrayLike<number>): void {
        this.tag(this.runtime.NativeDataStream.VALIDATION_FLOAT_32_ARRAY);
        this.reserve(1 + values.length);
        this.words[this.position++] = values.length;
        for (let index = 0; index < values.length; index++) {
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

    private tag(value: number): void {
        if (this.runtime.NativeDataStream.VALIDATION_ENABLED) {
            this.reserve(1);
            this.words[this.position++] = value;
        }
    }

    private reserve(length: number): void {
        if (length > this.words.length) {
            throw new Error("Native Lite GL command exceeds its 64 KiB buffer.");
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
    }
}
