/**
 * Shader / program compilation helpers. Pure functions — they take a raw
 * `WebGL2RenderingContext` and never touch the cache layer. Used by
 * `effect.ts` during `createEffect` and during the context-restored
 * re-compile path.
 */

/** Compile a single shader stage. Returns the shader handle; sets the
 *  `errorOut` array's element 0 to a non-null string on failure. */
export function compileShader(gl: WebGL2RenderingContext, source: string, stage: GLenum, errorOut: (string | null)[]): WebGLShader | null {
    const shader = gl.createShader(stage);
    if (shader === null) {
        errorOut[0] = "gl.createShader returned null";
        return null;
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        errorOut[0] = gl.getShaderInfoLog(shader) ?? "shader compile failed";
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

/** Attach + bind + link. Returns the program handle. Does NOT block on
 *  link completion — callers use `pollLinkStatus` to drive the parallel-
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
 *  cheap async-friendly poll; without it, link is synchronous so the answer
 *  is always `true`. */
export function isLinkComplete(gl: WebGL2RenderingContext, program: WebGLProgram, parallel: { COMPLETION_STATUS_KHR: number } | null): boolean {
    if (parallel === null) {
        return true;
    }
    return Boolean(gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR));
}

/** Returns null on success, the info log on failure. */
export function getLinkError(gl: WebGL2RenderingContext, program: WebGLProgram): string | null {
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        return null;
    }
    return gl.getProgramInfoLog(program) ?? "link failed";
}
