/**
 * Right-handed feature pairs — each handedness-dependent feature runs in both builds, side by side.
 *
 * Every test loads the same engine modules twice, once per `#coordinate-system` variant, feeds both the same
 * input and requires the right-handed result to be exactly the Babylon.js right-handed transform of the
 * left-handed one. A left-handed change that is not carried to the right-handed path breaks the relation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bothBuilds, resetBuild, SRC } from "./right-handed-builds";

/** A WebGPU device that accepts everything and records the render pipelines and shader modules it is asked to create. */
function fakeDevice(): { device: GPUDevice; pipelines: GPURenderPipelineDescriptor[]; modules: string[] } {
    const pipelines: GPURenderPipelineDescriptor[] = [];
    const modules: string[] = [];
    const anything = (): unknown =>
        new Proxy(function () {}, {
            get: (_target, key) => (key === "then" ? undefined : anything()),
            apply: () => anything(),
        });
    const device = new Proxy(
        {
            createBuffer: (descriptor: GPUBufferDescriptor) => ({
                size: descriptor.size,
                getMappedRange: () => new ArrayBuffer(descriptor.size),
                unmap: () => undefined,
                destroy: () => undefined,
            }),
            createShaderModule: (descriptor: GPUShaderModuleDescriptor) => (modules.push(descriptor.code), anything()),
            createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => (pipelines.push(descriptor), anything()),
            createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => (pipelines.push(descriptor), anything()),
        },
        { get: (target, key) => (key in target ? target[key as keyof typeof target] : key === "then" ? undefined : anything()) }
    ) as unknown as GPUDevice;
    return { device, pipelines, modules };
}

afterEach(() => {
    vi.doUnmock(`${SRC}scene/scene-core`);
    resetBuild();
});

interface FakeCanvas {
    canvas: HTMLCanvasElement;
    fire(type: string, event: Record<string, unknown>): void;
}

function fakeCanvas(): FakeCanvas {
    const listeners = new Map<string, EventListener[]>();
    const canvas = {
        tabIndex: -1,
        addEventListener: (type: string, listener: EventListener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        removeEventListener: () => undefined,
        hasAttribute: () => false,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
    } as unknown as HTMLCanvasElement;
    const fire = (type: string, event: Record<string, unknown>): void => {
        for (const listener of listeners.get(type) ?? []) {
            listener({ button: 0, clientX: 0, clientY: 0, pointerId: 1, pointerType: "mouse", preventDefault: () => undefined, ...event } as unknown as Event);
        }
    };
    return { canvas, fire };
}

/** A pointer drag and a held key, then a few frames. */
function drive(input: FakeCanvas, scene: { _beforeRender: ((deltaMs: number) => void)[] }, button: number, key?: string): void {
    input.fire("pointerdown", { button, clientX: 100, clientY: 100 });
    input.fire("pointermove", { button, clientX: 130, clientY: 110 });
    input.fire("pointerup", { button });
    if (key) {
        input.fire("keydown", { code: key });
    }
    for (let frame = 0; frame < 5; frame++) {
        for (const callback of scene._beforeRender) {
            callback(16);
        }
    }
}

type Vec = { x: number; y: number; z: number };
const xyz = (v: Vec): [number, number, number] => [v.x, v.y, v.z];

function expectClose(actual: number[], expected: number[]): void {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 9));
}

// The camera controls must move the picture the same way on screen in both builds. A right-handed build draws the
// picture mirrored, so from a camera looking along a mirror plane of the scene, the same input must leave the
// right-handed camera at the mirror image of the left-handed one.
describe("right-handed feature pairs: camera controls", () => {
    it("free camera: the same drag and strafe leave the camera mirrored across its X = 0 view plane", async () => {
        for (const configurable of [false, true]) {
            const [lh, rh] = await bothBuilds(async () => {
                const { createFreeCamera } = await import(`${SRC}camera/free-camera`);
                const camera = createFreeCamera({ x: 0, y: 1, z: -10 }, { x: 0, y: 1, z: 0 });
                camera.inertia = 0;
                const scene = { _beforeRender: [] as ((deltaMs: number) => void)[] };
                const input = fakeCanvas();
                if (configurable) {
                    const { attachConfigurableFreeControl } = await import(`${SRC}camera/configurable-free-camera-controls`);
                    attachConfigurableFreeControl(camera, input.canvas, scene);
                } else {
                    const { attachFreeControl } = await import(`${SRC}camera/free-camera-controls`);
                    attachFreeControl(camera, input.canvas, scene);
                }
                drive(input, scene, 0, "KeyD");
                return { position: xyz(camera.position), target: xyz(camera.target), yaw: camera._yaw as number };
            });
            expect(lh.position[0], "the left-handed camera actually moved sideways").not.toBeCloseTo(0, 3);
            expectClose(rh.position, [-lh.position[0], lh.position[1], lh.position[2]]);
            expectClose(rh.target, [-lh.target[0], lh.target[1], lh.target[2]]);
            expect(rh.yaw).toBeCloseTo(-lh.yaw, 9);
        }
    });

    it("arc-rotate camera: the same rotate and pan drags leave the camera mirrored across its Z = 0 view plane", async () => {
        for (const button of [0, 2]) {
            const [lh, rh] = await bothBuilds(async () => {
                const { createArcRotateCamera } = await import(`${SRC}camera/arc-rotate`);
                const { attachControl } = await import(`${SRC}camera/arc-rotate-controls`);
                const camera = createArcRotateCamera(0, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
                const scene = { _beforeRender: [] as ((deltaMs: number) => void)[] };
                const input = fakeCanvas();
                attachControl(camera, input.canvas, scene as never);
                drive(input, scene, button);
                return { alpha: camera.alpha as number, beta: camera.beta as number, target: xyz(camera.target) };
            });
            if (button === 0) {
                expect(lh.alpha, "the left-handed camera actually orbited").not.toBeCloseTo(0, 3);
            } else {
                expect(lh.target[2], "the left-handed camera actually panned").not.toBeCloseTo(0, 3);
            }
            expect(rh.alpha).toBeCloseTo(-lh.alpha, 9);
            expect(rh.beta).toBeCloseTo(lh.beta, 9);
            expectClose(rh.target, [lh.target[0], lh.target[1], -lh.target[2]]);
        }
    });
});

describe("right-handed feature pairs: gizmos", () => {
    it("gizmo follow scale measures depth along the camera's real forward (local -Z when right-handed)", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { createFreeCamera } = await import(`${SRC}camera/free-camera`);
            const { attachFollowTarget } = await import(`${SRC}gizmo/gizmo-core`);
            const scaling: number[] = [];
            const root = { position: { set: () => undefined }, scaling: { set: (x: number) => scaling.push(x) } };
            const target = { worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
            const scene = { _beforeRender: [] as ((deltaMs: number) => void)[], camera: createFreeCamera({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 }) };
            attachFollowTarget(scene as never, root as never, () => target as never, 0.5);
            scene._beforeRender[0]!(16);
            return scaling[0]!;
        });
        expect(lh).toBeCloseTo(5, 9);
        expect(rh).toBeCloseTo(lh, 9);
    });

    it("plane rotation gizmo turns the node the same way and draws its sector with Babylon.js's right-handed sign", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            // The gizmo meshes only need to exist: keep them out of a scene that would need a GPU.
            vi.doMock(`${SRC}scene/scene-core`, async (original) => ({ ...(await original<object>()), addToScene: () => undefined }));
            const { createPlaneRotationGizmo } = await import(`${SRC}gizmo/plane-rotation-gizmo`);
            const { getShaderUniform } = await import(`${SRC}material/shader/shader-material`);
            const engine = { canvas: {}, _device: fakeDevice().device } as never;
            const gizmo = createPlaneRotationGizmo(engine, { scene: { _beforeRender: [] } } as never, { planeNormal: { x: 0, y: 1, z: 0 } });
            const rotation = {
                x: 0,
                y: 0,
                z: 0,
                w: 1,
                set(x: number, y: number, z: number, w: number) {
                    Object.assign(rotation, { x, y, z, w });
                },
            };
            gizmo.attachedNode = { worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), rotationQuaternion: rotation, parent: null } as never;
            gizmo.drag.onDragStart.notify({ dragPlanePoint: { x: 1, y: 0, z: 0 } } as never);
            gizmo.drag.onDrag.notify({ dragPlanePoint: { x: 0, y: 0, z: 1 } } as never);
            return { rotation: [rotation.x, rotation.y, rotation.z, rotation.w], sector: Array.from(getShaderUniform(gizmo.rotationDisplayMaterial, "angles") as Float32Array) };
        });
        expect(Math.abs(lh.sector[1]!), "the left-handed drag swept a sector").toBeCloseTo(Math.PI / 2, 5);
        expectClose(rh.rotation, lh.rotation);
        expect(rh.sector[1]).toBeCloseTo(-lh.sector[1]!, 6);
    });
});

describe("right-handed feature pairs: standard material", () => {
    it("cube reflections negate the lookup Z (REFLECTIONMAP_OPPOSITEZ)", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { createStdCubeReflectionFragment } = await import(`${SRC}material/standard/fragments/std-cube-reflection-fragment`);
            return String(createStdCubeReflectionFragment()._fragmentSlots.AD);
        });
        expect(lh).toContain("reflect(v,normalW))");
        expect(rh).toBe(lh.replace("reflect(v,normalW))", "reflect(v,normalW)*vec3f(1.,1.,-1.))"));
    });
});

describe("right-handed feature pairs: shader text", () => {
    it("skybox cube lookup negates Z (REFLECTIONMAP_OPPOSITEZ)", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { buildSkyboxCubeMapGPU } = await import(`${SRC}material/standard/skybox-cubemap`);
            const gpu = fakeDevice();
            buildSkyboxCubeMapGPU({ canvas: {}, _device: gpu.device } as never, new Float32Array(16), {} as never, {} as never);
            return gpu.modules.find((code) => code.includes("vPositionLocal)"))!;
        });
        expect(lh).toBeDefined();
        expect(rh).toBe(lh.replace("vPositionLocal)", "vPositionLocal)*vec3f(1.,1.,-1.)"));
    });

    it("PBR cubemap skybox negates its lookup Z after the environment patches", async () => {
        const fragment = "fn f(){let c=textureSampleLevel(t,s,normalize(d),0.);}";
        const [lh, rh] = await bothBuilds(async () => {
            const { composeSkyboxFragment } = await import(`${SRC}material/pbr/cubemap-skybox-material`);
            const scene = { _environmentSkyboxShaderComposer: async (code: string) => code.replace("normalize(d)", "rotY(normalize(d))") };
            return (await composeSkyboxFragment(scene as never, fragment, "env" as never)) as string;
        });
        expect(lh).toBe("fn f(){let c=textureSampleLevel(t,s,rotY(normalize(d)),0.);}");
        expect(rh).toBe("fn f(){let c=textureSampleLevel(t,s,(rotY(normalize(d)))*vec3f(1.,1.,-1.),0.);}");
    });

    it("mesh-LoD PBR negates Z after the environment rotation and reverses its cotangent frame", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { composeMeshLoDWgsl } = await import(`${SRC}material/pbr/pbr-mesh-lod-compose`);
            return composeMeshLoDWgsl({ hasNormalMap: true, hasEmissiveTexture: false, hasIbl: true, hasSpecularAA: false, doubleSided: false, unlit: false }) as string;
        });
        expect(lh).toContain("-v.x * s + v.z * c");
        expect(rh).toBe(
            lh
                .replace("-v.x * s + v.z * c", "v.x * s - v.z * c")
                .replace("let Tt = dp2perp * duv1.x + dp1perp * duv2.x;", "let Tt = -(dp2perp * duv1.x + dp1perp * duv2.x);")
                .replace("let Bt = -(dp2perp * duv1.y + dp1perp * duv2.y);", "let Bt = dp2perp * duv1.y + dp1perp * duv2.y;")
        );
    });

    it("derivative normal view swaps its cross product so the normal faces the viewer", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { buildNormalFragment } = await import(`${SRC}material/shader/normal-view`);
            return buildNormalFragment("vWorldPos", 0, "view", 10) as string;
        });
        expect(lh).toMatch(/cross\(dpdx\(input\.vWorldPos\),\s*dpdy\(input\.vWorldPos\)\)/);
        expect(rh).toBe(lh.replace(/cross\(dpdx\(input\.vWorldPos\),(\s*)dpdy\(input\.vWorldPos\)\)/, "cross(dpdy(input.vWorldPos),$1dpdx(input.vWorldPos))"));
    });

    it("billboards sample their texture mirrored horizontally, built-in, custom and picking alike", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { makeBillboardWgsl } = await import(`${SRC}sprite/billboard-pipeline`);
            const { makeCustomBillboardWgsl } = await import(`${SRC}sprite/billboard-custom-shader`);
            const { makeBillboardPickWgsl } = await import(`${SRC}picking/billboard-pick-pipeline`);
            return [
                makeBillboardWgsl("axis-locked", "cutout", true),
                makeCustomBillboardWgsl("facing", [], "return vec4f(1.0);"),
                makeBillboardPickWgsl("facing", true, true),
            ] as string[];
        });
        const squash = (code: string): string => code.replace(/\s+/g, "");
        lh.forEach((code, i) => {
            expect(code).toMatch(/mix\(in\.a,\s*in\.b,\s*q\)/);
            expect(squash(rh[i]!)).toBe(squash(code).replace("mix(in.a,in.b,q)", "mix(in.a,in.b,vec2f(1.0-q.x,q.y))"));
        });
    });
});

describe("right-handed feature pairs: glTF skeletons", () => {
    it("bone-control bake keeps glTF's native space: the left-handed world is the right-handed one mirrored in X", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { computeNodeWorldMatrices, computeTopoOrder } = await import(`${SRC}skeleton/skeleton-pose`);
            const node = (parentIdx: number, tx: number, ry: number) => ({ parentIdx, tx, ty: 1, tz: 2, rx: 0, ry, rz: 0, rw: Math.sqrt(1 - ry * ry), sx: 1, sy: 2, sz: 1 });
            const nodes = [node(-1, 3, 0.3), node(0, -1, 0.5)];
            const trs = new Float32Array(24);
            nodes.forEach((n, i) => trs.set([n.tx, n.ty, n.tz, n.rx, n.ry, n.rz, n.rw, n.sx, n.sy, n.sz], i * 12));
            const world = new Float32Array(32);
            computeNodeWorldMatrices(nodes as never, 2, computeTopoOrder(nodes), trs, new Float32Array(32), world);
            return Array.from(world);
        });
        expectClose(
            lh,
            rh.map((value, i) => (i % 4 === 0 ? -value : value))
        );
    });

    it("a world-space bone override applies the glTF root's reflection: an X mirror left-handed, none right-handed", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { setBoneWorldPoseDeferred } = await import(`${SRC}skeleton/bone-control`);
            const skeleton = { _worldOverrides: new Map<number, Float32Array>() };
            const ry = 0.4;
            setBoneWorldPoseDeferred(skeleton as never, { _nodeIndex: 0 } as never, 1, 2, 3, 0, ry, 0, Math.sqrt(1 - ry * ry));
            return Array.from(skeleton._worldOverrides.get(0)!);
        });
        const { composeMat4 } = await import(`${SRC}math/compose-mat4`);
        const ry = 0.4;
        expectClose(rh, Array.from(composeMat4(1, 2, 3, 0, ry, 0, Math.sqrt(1 - ry * ry), 1, 1, 1) as ArrayLike<number>));
        expectClose(
            lh,
            rh.map((value, i) => (i < 4 ? -value : value))
        );
    });
});

describe("right-handed feature pairs: derivative tangent frames and reflections", () => {
    it("anisotropy without a normal map reverses both cotangent-frame axes", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { makeAnisotropyTBBlock } = await import(`${SRC}material/pbr/fragments/anisotropy-fragment`);
            return makeAnisotropyTBBlock(false, true) as string;
        });
        const t = "aniso_dp2perp*aniso_duv1.x+aniso_dp1perp*aniso_duv2.x";
        const b = "aniso_dp2perp*aniso_duv1.y+aniso_dp1perp*aniso_duv2.y";
        expect(lh).toContain(`let aniso_tct=${t};`);
        expect(rh).toBe(lh.replace(`let aniso_tct=${t};`, `let aniso_tct=-(${t});`).replace(`let aniso_bct=-(${b});`, `let aniso_bct=${b};`));
    });

    it("USD normal maps reverse both cotangent-frame axes", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { createUsdMaterialPlugin } = await import(`${SRC}loader-usd/usd-material-plugin`);
            const source = { texture: {}, scale: new Float32Array(4), bias: new Float32Array(4), sourceColorSpace: 0 };
            return String(createUsdMaterialPlugin({ normal: { source, channel: 0 } as never }).getCustomCode("fragment").CUSTOM_FRAGMENT_UPDATE_DIFFUSE);
        });
        const t = "usdDp2Perp*usdDuv1.x+usdDp1Perp*usdDuv2.x";
        const b = "usdDp2Perp*usdDuv1.y+usdDp1Perp*usdDuv2.y";
        expect(lh).toContain(`let usdTangent=${t};`);
        expect(rh).toBe(lh.replace(`let usdTangent=${t};`, `let usdTangent=-(${t});`).replace(`let usdBitangent=-(${b});`, `let usdBitangent=${b};`));
    });

    it("Standard spherical reflection mirrors the view-space reflection's Z", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { createStdReflectionFragment } = await import(`${SRC}material/standard/fragments/std-reflection-fragment`);
            return String(createStdReflectionFragment()._helperFunctions);
        });
        expect(lh).toContain("r.z = r.z - 1.0;");
        expect(rh).toBe(lh.replace("r.z = r.z - 1.0;", "r.z = -r.z - 1.0;"));
    });

    it("geometry renderer view depth and view normal are Babylon.js's right-handed view space", async () => {
        const squash = (code: string): string => code.replace(/\s+/g, "");
        const [lh, rh] = await bothBuilds(async () => {
            const { GeometryTextureType: T } = await import(`${SRC}frame-graph/geometry-types`);
            const pbr = await import(`${SRC}material/pbr/pbr-geometry-output-shader`);
            const std = await import(`${SRC}material/standard/standard-geometry-output-shader`);
            const node = await import(`${SRC}material/node/node-geometry-renderable`);
            const inputs = new Map([[T.WORLD_POSITION, { expr: "wp", type: "vec3f" }]]);
            return [T.VIEW_DEPTH, T.NORMALIZED_VIEW_DEPTH, T.VIEW_NORMAL].flatMap((t: number) => [
                String(pbr.attachmentExpr(t, "1.0", false)),
                String(std.attachmentExpr(t, "1.0", false, "uv")),
                t === T.VIEW_NORMAL ? "" : String(node.geomWrite(t, inputs, { needsGp: false })),
            ]);
        });
        const [depth, normalizedDepth, normal] = [lh.slice(0, 3), lh.slice(3, 6), lh.slice(6, 9)];
        for (const [i, code] of [...depth, ...normalizedDepth].entries()) {
            expect(code).toContain("((scene.view");
            expect(squash(rh[i]!)).toBe(squash(code.replace("((scene.view", "(-(scene.view")));
        }
        for (const [i, code] of normal.entries()) {
            expect(squash(rh[6 + i]!)).toBe(squash(code).replace(".xyz)", ".xyz*vec3<f32>(1.0,1.0,-1.0))"));
        }
    });
});
