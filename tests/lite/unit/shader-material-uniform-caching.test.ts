import { describe, expect, it, vi } from "vitest";
import type { ShaderCustomUniformWriter, ShaderSystemUniformWriter } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";

const installed = vi.hoisted(() => ({
    system: undefined as ShaderSystemUniformWriter | undefined,
    custom: undefined as ShaderCustomUniformWriter | undefined,
}));

// Only `_installShaderUniformWriters` is replaced — everything else stays real.
// The caching module also imports `_shaderWorldMatrix` (the floating-origin
// rebasing shared with the default writer), and a mock that dropped it would
// leave the FO test below asserting against a stub instead of the shipping code.
vi.mock("../../../packages/babylon-lite/src/material/shader/shader-renderable.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/material/shader/shader-renderable.js")>()),
    _installShaderUniformWriters(system: ShaderSystemUniformWriter, custom: ShaderCustomUniformWriter) {
        installed.system = system;
        installed.custom = custom;
    },
}));

import { enableShaderMaterialUniformCaching } from "../../../packages/babylon-lite/src/material/shader/enable-shader-material-uniform-caching";
import { createShaderMaterial, setShaderFloat } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { UboSpec } from "../../../packages/babylon-lite/src/shader/fragment-types";

describe("ShaderMaterial uniform caching", () => {
    it("installs cached writers and skips unchanged vector serialization", () => {
        const material = createShaderMaterial({
            vertexSource: "@vertex fn mainVertex(input:VertexInput)->@builtin(position) vec4<f32>{return vec4<f32>(input.position,1.0);}",
            fragmentSource: "@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(1.0);}",
            attributes: ["position"],
            uniforms: [
                { name: "tint", type: "vec4<f32>", defaultValue: [1, 1, 1, 1] },
                { name: "amount", type: "f32", defaultValue: 0 },
            ],
        });
        const spec = {
            _offsets: new Map([
                ["tint", 0],
                ["amount", 16],
            ]),
        } as unknown as UboSpec;
        const data = new ArrayBuffer(32);
        const bytes = new Uint8Array(data);
        const writeBuffer = vi.fn();
        const engine = { _device: { queue: { writeBuffer } } } as unknown as EngineContext;
        const ubo = {} as GPUBuffer;
        const set = vi.spyOn(Float32Array.prototype, "set");

        enableShaderMaterialUniformCaching();
        expect(installed.system).toBeTypeOf("function");
        expect(installed.custom).toBeTypeOf("function");

        installed.custom!(engine, material, spec, data, ubo, bytes);
        expect(set).toHaveBeenCalledTimes(1);
        expect(writeBuffer).toHaveBeenCalledTimes(1);

        set.mockClear();
        setShaderFloat(material, "amount", 0.5);
        installed.custom!(engine, material, spec, data, ubo, bytes);
        expect(set).not.toHaveBeenCalled();
        expect(writeBuffer).toHaveBeenCalledTimes(2);

        installed.custom!(engine, material, spec, data, ubo, bytes);
        expect(writeBuffer).toHaveBeenCalledTimes(2);
        set.mockRestore();
    });

    it("rebases the mesh world matrix onto the camera under floating origin", () => {
        // Caching changes how OFTEN uniforms are serialized, never what they
        // say. This writer had the same missing floating-origin rebasing as the
        // default one — see `shader-material-floating-origin.test.ts` for what
        // that looked like on screen (a planet you could never reach).
        const material = createShaderMaterial({
            vertexSource: "@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }",
            fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }",
            attributes: ["position"],
            uniforms: ["world", "cameraPosition"],
        });
        const spec = {
            _offsets: new Map([
                ["world", 0],
                ["cameraPosition", 64],
            ]),
        } as unknown as UboSpec;

        const PLANET_X = 4_600_000;
        const DISTANCE = 4_561_405;
        const mesh = { worldMatrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, PLANET_X, 0, 0, 1]) } as unknown as Mesh;
        const camera = createFreeCamera({ x: PLANET_X - DISTANCE, y: 0, z: 0 }, { x: PLANET_X, y: 0, z: 0 });

        enableShaderMaterialUniformCaching();

        const relative = new Float32Array(32);
        camera._useFloatingOrigin = true;
        installed.system!(relative, spec, material, mesh, camera, 1600, 900);
        expect(relative[12]).toBeCloseTo(DISTANCE, 0);
        // The eye sits at the origin of the frame `world` is now expressed in.
        expect(relative[16]).toBe(0);

        // Control: the same camera without the flag keeps absolute coordinates,
        // so this is testing the rebasing and not just the offsets.
        const absolute = new Float32Array(32);
        const plainCamera = createFreeCamera({ x: PLANET_X - DISTANCE, y: 0, z: 0 }, { x: PLANET_X, y: 0, z: 0 });
        installed.system!(absolute, spec, material, mesh, plainCamera, 1600, 900);
        expect(absolute[12]).toBe(PLANET_X);
        expect(absolute[16]).toBeCloseTo(PLANET_X - DISTANCE, 0);
    });
});
