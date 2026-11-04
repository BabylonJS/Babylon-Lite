/** @internal Protocol-v5 missing-reference sentinel. */
export const USD_NONE = 0xffffffff;
/** @internal Shared C++ protocol opcodes; keep the native runtime unchanged. */
export const UsdOp = {
    Scene: 1,
    Texture: 2,
    Material: 3,
    Node: 4,
    Skeleton: 5,
    Geometry: 6,
    Mesh: 7,
    Instance: 8,
    Animation: 9,
    Analytic: 10,
    ThinInstances: 11,
    MorphTarget: 12,
} as const;
const payloadSizes = [0, 12, 48, 96, 20, 20, 60, 40, 16, 32, 44, 12, 32];

/** @internal A bounds-checked command payload, in little-endian field order. */
export interface UsdRecord {
    op: number;
    payload: DataView;
}

/** @internal Validate the complete command envelope before allocating GPU resources. */
export function readUsdCommands(buffer: ArrayBuffer): UsdRecord[] {
    const view = new DataView(buffer);
    if (buffer.byteLength < 16 || view.getUint32(0, true) !== 0x42445355) {
        throw new Error("Invalid USD command buffer");
    }
    if (view.getUint16(4, true) !== 5) {
        throw new Error("Unsupported USD command protocol version");
    }
    const count = view.getUint32(8, true);
    const records: UsdRecord[] = [];
    let offset = 16;
    for (let i = 0; i < count; i++) {
        if (offset + 8 > buffer.byteLength) {
            throw new Error("Truncated USD command header");
        }
        const op = view.getUint16(offset, true);
        const size = view.getUint32(offset + 4, true);
        offset += 8;
        if (!payloadSizes[op] || size !== payloadSizes[op] || size > buffer.byteLength - offset) {
            throw new Error(`Invalid USD command ${op} payload`);
        }
        records.push({ op, payload: new DataView(buffer, offset, size) });
        offset += size;
    }
    if (offset !== buffer.byteLength) {
        throw new Error("Unexpected trailing USD commands");
    }
    return records;
}

function range(data: ArrayBuffer, offset: number, count: number, width: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 0 || offset % width || count > (data.byteLength - offset) / width) {
        throw new Error("Invalid USD data range");
    }
}
/** @internal Read an aligned float stream without copying. */
export function usdFloats(data: ArrayBuffer, offset: number, count: number): Float32Array {
    range(data, offset, count, 4);
    return new Float32Array(data, offset, count);
}
/** @internal Read an aligned uint32 stream without copying. */
export function usdUints(data: ArrayBuffer, offset: number, count: number): Uint32Array {
    range(data, offset, count, 4);
    return new Uint32Array(data, offset, count);
}
/** @internal Read an aligned uint16 stream without copying. */
export function usdU16(data: ArrayBuffer, offset: number, count: number): Uint16Array {
    range(data, offset, count, 2);
    return new Uint16Array(data, offset, count);
}
/** @internal Read an encoded image or string span. */
export function usdBytes(data: ArrayBuffer, offset: number, count: number): Uint8Array<ArrayBuffer> {
    range(data, offset, count, 1);
    return new Uint8Array(data, offset, count);
}
let decoder: TextDecoder | undefined;
/** @internal Decode a name. Lazy initialization preserves import-time purity. */
export function usdString(data: ArrayBuffer, offset: number, count: number): string {
    return (decoder ??= new TextDecoder()).decode(usdBytes(data, offset, count));
}
/** @internal Read a uint32 command field. */
export function usdField(record: UsdRecord, index: number): number {
    return record.payload.getUint32(index * 4, true);
}
