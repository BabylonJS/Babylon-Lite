/**
 * Shader / program compilation helpers. Pure functions — they take a raw
 * `WebGL2RenderingContext` and never touch the cache layer. Used by
 * `effect.ts` during `createEffect` and during the context-restored
 * re-compile path.
 */

/** Submit a shader stage without querying compilation results. Returns null
 *  only on allocation failure; shader diagnostics are collected after a
 *  completed program link fails. */
export function compileShader(gl: WebGL2RenderingContext, source: string, stage: GLenum): WebGLShader | null {
    const shader = gl.createShader(stage);
    if (shader === null) {
        return null;
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
}

/** Attach + bind + link. Returns the program handle. Does NOT block on
 *  link completion — callers use `isLinkComplete` to drive the parallel-
 *  shader-compile state machine. */
export function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader, attributeNames: readonly string[]): WebGLProgram | null {
    const program = gl.createProgram();
    if (program === null) {
        return null;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    // Bind every declared attribute, but in particular guarantee that the FIRST
    // attribute (`position`) maps to location 0 — the shared fullscreen-quad VAO
    // depends on this so the same VAO works across every effect's program.
    // Must run BEFORE linkProgram. The GLSL conversion also emits
    // `layout(location = N)` as belt-and-suspenders.
    for (let i = 0; i < attributeNames.length; i++) {
        const name = attributeNames[i];
        if (name !== undefined) {
            gl.bindAttribLocation(program, i, name);
        }
    }
    gl.linkProgram(program);
    return program;
}

/** Returns `true` when the program has finished linking and can be queried.
 *  When the `KHR_parallel_shader_compile` extension is present, this is the
 *  cheap async-friendly poll; without it, the subsequent LINK_STATUS query
 *  may block until linking completes. */
export function isLinkComplete(gl: WebGL2RenderingContext, program: WebGLProgram, parallel: { COMPLETION_STATUS_KHR: number } | null): boolean {
    if (parallel === null) {
        return true;
    }
    return Boolean(gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR));
}

/** Query a completed link. Only on failure, collect the program log and any
 *  failed shader stages' logs; never query shader status on the success path. */
export function getLinkError(gl: WebGL2RenderingContext, program: WebGLProgram, vs: WebGLShader, fs: WebGLShader): string | null {
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        return null;
    }
    let error = `link failed: ${gl.getProgramInfoLog(program) || "no program info log"}`;
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        error += `\nvertex compile failed: ${gl.getShaderInfoLog(vs) || "no shader info log"}`;
    }
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        error += `\nfragment compile failed: ${gl.getShaderInfoLog(fs) || "no shader info log"}`;
    }
    return error;
}
