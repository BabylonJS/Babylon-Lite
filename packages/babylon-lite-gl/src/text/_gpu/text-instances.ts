import type { GLEngineContext } from "../../context.js";
import { createVertexBuffer, disposeBuffer, updateVertexBuffer } from "../../mesh.js";
import type { GLTextData, TextDataGpu } from "../text-data.js";
import { TEXT_INSTANCE_BYTES, TEXT_INSTANCE_FLOATS, TEXT_STYLE_FLOATS } from "../text-data.js";
import { createTextTexture, packTable, TABLE_WIDTH, uploadTextTexture } from "./text-textures.js";

/** @internal One upload per data mutation, even when several layers share the data. */
export function ensureTextDataGpu(engine: GLEngineContext, data: GLTextData): TextDataGpu {
    let gpu = data._gpu;
    if (gpu && gpu._engine !== engine) {
        throw new Error("lite-gl: text data cannot be drawn on multiple engines. Create separate text data for each engine.");
    }
    if (!gpu) {
        const pixels = packTable(data._styles, data._styleCount * TEXT_STYLE_FLOATS);
        const buffer = createVertexBuffer(engine, data._instances, true);
        try {
            gpu = {
                _engine: engine,
                _instanceBuf: buffer,
                _styleTex: createTextTexture(engine, pixels, TABLE_WIDTH, pixels.length / (TABLE_WIDTH * 4)),
                _stylePixels: pixels,
                _uploadedVersion: data._version,
                _uploadedStyleVersion: data._styleVersion,
            };
            data._gpu = gpu;
        } catch (error) {
            disposeBuffer(buffer);
            throw error;
        }
    } else if (gpu._instanceBuf._data !== data._instances) {
        // Retain the live CPU pool, including partial edits, for context restoration.
        const buffer = createVertexBuffer(engine, data._instances, true);
        disposeBuffer(gpu._instanceBuf);
        gpu._instanceBuf = buffer;
        gpu._uploadedVersion = data._version;
    } else if (gpu._uploadedVersion !== data._version) {
        if (data._dirtyEnd > data._dirtyStart) {
            const start = data._dirtyStart * TEXT_INSTANCE_FLOATS;
            const end = data._dirtyEnd * TEXT_INSTANCE_FLOATS;
            const source = start === 0 && end === data._instances.length ? data._instances : data._instances.subarray(start, end);
            updateVertexBuffer(gpu._instanceBuf, source, data._dirtyStart * TEXT_INSTANCE_BYTES);
        } else {
            updateVertexBuffer(gpu._instanceBuf, data._instances);
        }
        gpu._uploadedVersion = data._version;
    }
    data._dirtyStart = data._dirtyEnd = 0;
    if (gpu._uploadedStyleVersion !== data._styleVersion) {
        const pixels = packTable(data._styles, data._styleCount * TEXT_STYLE_FLOATS, gpu._stylePixels);
        uploadTextTexture(engine, gpu._styleTex, pixels, TABLE_WIDTH, pixels.length / (TABLE_WIDTH * 4));
        gpu._stylePixels = pixels;
        gpu._uploadedStyleVersion = data._styleVersion;
    }
    return gpu;
}
