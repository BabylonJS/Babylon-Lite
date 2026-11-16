import type { GLEngineContext } from "../../context.js";
import type { GLVertexBuffer } from "../../mesh.js";
import { TEXT_INSTANCE_BYTES } from "../text-data.js";

/** @internal WebGL2 has no base-instance draw; cache the group's attribute offsets in a VAO. */
export interface TextVao {
    /** @internal */
    _handle: WebGLVertexArrayObject;
    /** @internal */
    _quad: WebGLBuffer;
    /** @internal */
    _instances: WebGLBuffer;
    /** @internal */
    _slotStart: number;
}

/** @internal */
export function disposeTextVao(engine: GLEngineContext, vao: TextVao): void {
    if (!engine._isLost && !engine._disposed) {
        if (engine._state.boundVao === vao._handle) {
            engine.gl.bindVertexArray(null);
            engine._state.boundVao = null;
            engine._state.boundElementBuffer = null;
        }
        engine.gl.deleteVertexArray(vao._handle);
    }
}

/** @internal */
export function bindTextVao(engine: GLEngineContext, quad: GLVertexBuffer, instances: GLVertexBuffer, slotStart: number, previous?: TextVao): TextVao {
    const gl = engine.gl;
    const state = engine._state;
    let vao = previous;
    if (!vao || vao._quad !== quad.handle || vao._instances !== instances.handle || vao._slotStart !== slotStart) {
        const handle = gl.createVertexArray();
        if (!handle) {
            throw new Error("lite-gl: gl.createVertexArray returned null (text)");
        }
        if (vao) {
            disposeTextVao(engine, vao);
        }
        vao = { _handle: handle, _quad: quad.handle, _instances: instances.handle, _slotStart: slotStart };
        gl.bindVertexArray(handle);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad.handle);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, instances.handle);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, TEXT_INSTANCE_BYTES, slotStart * TEXT_INSTANCE_BYTES);
        gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, TEXT_INSTANCE_BYTES, slotStart * TEXT_INSTANCE_BYTES + 8);
        gl.vertexAttribDivisor(2, 1);
        state.boundArrayBuffer = instances.handle;
        state.boundVao = handle;
        state.boundElementBuffer = null;
    } else if (state.boundVao !== vao._handle) {
        gl.bindVertexArray(vao._handle);
        state.boundVao = vao._handle;
        state.boundElementBuffer = null;
    }
    return vao;
}
