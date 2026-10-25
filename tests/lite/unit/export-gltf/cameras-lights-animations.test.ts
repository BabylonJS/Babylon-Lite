import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, exportAndParse, readAccessor, readBufferView } from "./export-test-utils";
import type { ParsedGlb } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import type { SceneNode } from "../../../../packages/babylon-lite/src/scene/scene-node";
import { createFreeCamera } from "../../../../packages/babylon-lite/src/camera/free-camera";
import { enableOrthographicCamera } from "../../../../packages/babylon-lite/src/camera/orthographic";
import { createPointLight } from "../../../../packages/babylon-lite/src/light/point-light";
import { createDirectionalLight } from "../../../../packages/babylon-lite/src/light/directional-light";
import { createSpotLight } from "../../../../packages/babylon-lite/src/light/spot-light";
import { createHemisphericLight } from "../../../../packages/babylon-lite/src/light/hemispheric";
import {
    INTERP_CUBICSPLINE,
    INTERP_LINEAR,
    INTERP_STEP,
    PATH_POINTER,
    PATH_ROTATION,
    PATH_SCALE,
    PATH_TRANSLATION,
    PATH_WEIGHTS,
} from "../../../../packages/babylon-lite/src/animation/types";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core";

type AnimationGroups = SceneContext["animationGroups"];

function expectClose(actual: ArrayLike<number> | undefined, expected: number[]): void {
    expect(actual).toBeDefined();
    expect(actual!.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
        expect(actual![i]).toBeCloseTo(expected[i]!, 5);
    }
}

/** Rotate vector `v` by the unit quaternion `q` (xyzw). */
function rotate(q: ArrayLike<number>, v: number[]): number[] {
    const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
    const [vx, vy, vz] = v as [number, number, number];
    // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

function loaderRoot(): SceneNode {
    return createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
}

function setParent(object: object, parent: unknown): void {
    (object as { parent: unknown }).parent = parent;
}

// ─── Cameras ─────────────────────────────────────────────────────────

describe("camera", () => {
    const lookingAlongZ = () => createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

    it("exports perspective yfov, znear and zfar", async () => {
        const camera = lookingAlongZ();
        camera.fov = 0.5;
        camera.nearPlane = 0.25;
        camera.farPlane = 500;
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras).toEqual([{ type: "perspective", perspective: { yfov: 0.5, znear: 0.25, zfar: 500 } }]);
        expect(glb.json.nodes[0].camera).toBe(0);
        expect(glb.json.scenes[0].nodes).toEqual([0]);
    });

    it("names the camera and its node", async () => {
        const camera = lookingAlongZ();
        camera.name = "main";
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras[0].name).toBe("main");
        expect(glb.json.nodes[0].name).toBe("main");
    });

    it("omits zfar when farPlane is at least 1e6", async () => {
        const camera = lookingAlongZ();
        camera.farPlane = 1e6;
        const atSentinel = await exportAndParse(createScene({ camera }));
        expect(atSentinel.json.cameras[0].perspective.zfar).toBeUndefined();
        camera.farPlane = 5e6;
        const above = await exportAndParse(createScene({ camera }));
        expect(above.json.cameras[0].perspective.zfar).toBeUndefined();
        camera.farPlane = 999999;
        const below = await exportAndParse(createScene({ camera }));
        expect(below.json.cameras[0].perspective.zfar).toBe(999999);
    });

    it("derives aspectRatio from the canvas and omits it without one", async () => {
        const camera = lookingAlongZ();
        const withCanvas = await exportAndParse(createScene({ camera, canvas: { width: 800, height: 400 } }));
        expect(withCanvas.json.cameras[0].perspective.aspectRatio).toBe(2);
        const without = await exportAndParse(createScene({ camera }));
        expect(without.json.cameras[0].perspective.aspectRatio).toBeUndefined();
        const zeroHeight = await exportAndParse(createScene({ camera, canvas: { width: 800, height: 0 } }));
        expect(zeroHeight.json.cameras[0].perspective.aspectRatio).toBeUndefined();
    });

    it("omits aspectRatio unless both canvas dimensions are positive", async () => {
        const camera = lookingAlongZ();
        for (const canvas of [
            { width: 0, height: 400 },
            { width: 800, height: 0 },
            { width: 0, height: 0 },
            { width: -10, height: 400 },
        ]) {
            const glb = await exportAndParse(createScene({ camera, canvas }));
            expect(glb.json.cameras[0].perspective.aspectRatio).toBeUndefined();
        }
        const ok = await exportAndParse(createScene({ camera, canvas: { width: 300, height: 100 } }));
        expect(ok.json.cameras[0].perspective.aspectRatio).toBe(3);
    });

    it("omits zfar unless nearPlane < farPlane < 1e6", async () => {
        const camera = lookingAlongZ();
        camera.nearPlane = 2;
        for (const far of [2, 1, -5, Number.NaN, Infinity]) {
            camera.farPlane = far;
            const glb = await exportAndParse(createScene({ camera }));
            expect(glb.json.cameras[0].perspective.zfar, `farPlane ${far}`).toBeUndefined();
        }
        camera.farPlane = 2.5;
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras[0].perspective.zfar).toBe(2.5);
    });

    it("keeps a small real camera translation", async () => {
        const camera = createFreeCamera({ x: 0.0005, y: 0, z: 0 }, { x: 0.0005, y: 0, z: 1 });
        const glb = await exportAndParse(createScene({ camera }));
        expectClose(glb.json.nodes[0].translation, [-0.0005, 0, 0]);
    });

    it("exports the orthographic plane form", async () => {
        const camera = lookingAlongZ();
        camera.nearPlane = 0.5;
        camera.farPlane = 80;
        enableOrthographicCamera(camera, { left: -4, right: 4, bottom: -2, top: 2 });
        const glb = await exportAndParse(createScene({ camera, canvas: { width: 100, height: 100 } }));
        expect(glb.json.cameras[0]).toEqual({ type: "orthographic", orthographic: { xmag: 4, ymag: 2, znear: 0.5, zfar: 80 } });
        expect(glb.warnings).toEqual([]);
    });

    it("derives the orthographic halfHeight form from the canvas aspect", async () => {
        const camera = lookingAlongZ();
        enableOrthographicCamera(camera, { halfHeight: 3 });
        const glb = await exportAndParse(createScene({ camera, canvas: { width: 800, height: 400 } }));
        expect(glb.json.cameras[0].orthographic).toMatchObject({ xmag: 6, ymag: 3 });
        expect(glb.warnings).toEqual([]);
    });

    it("warns and exports xmag = ymag for a halfHeight orthographic camera without a canvas", async () => {
        const camera = lookingAlongZ();
        enableOrthographicCamera(camera, { halfHeight: 3 });
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras[0].orthographic).toMatchObject({ xmag: 3, ymag: 3 });
        expect(glb.warnings).toContain("Orthographic camera aspect is unavailable under a null engine; exporting xmag = ymag.");
    });

    it("warns about off-center orthographic bounds and exports a symmetric projection", async () => {
        const camera = lookingAlongZ();
        camera.name = "ortho";
        enableOrthographicCamera(camera, { left: -1, right: 3, bottom: -2, top: 2 });
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras[0].orthographic).toMatchObject({ xmag: 2, ymag: 2 });
        expect(glb.warnings).toContain('Orthographic camera "ortho" has off-center bounds; exporting a symmetric projection.');
    });

    it("places a converting camera so it looks along the right-handed image of its Lite view direction", async () => {
        // Lite is left-handed: looking along +Z stays +Z after the X mirror; looking along +X becomes -X.
        const cases: { name: string; position: [number, number, number]; target: [number, number, number]; direction: number[] }[] = [
            { name: "+Z", position: [0, 0, 0], target: [0, 0, 1], direction: [0, 0, 1] },
            { name: "-Z", position: [0, 0, 0], target: [0, 0, -1], direction: [0, 0, -1] },
            { name: "+X", position: [1, 2, 3], target: [2, 2, 3], direction: [-1, 0, 0] },
            { name: "-X", position: [1, 2, 3], target: [0, 2, 3], direction: [1, 0, 0] },
            { name: "pitched up", position: [0, 0, 0], target: [0, 1, 1], direction: [0, Math.SQRT1_2, Math.SQRT1_2] },
        ];
        for (const c of cases) {
            const camera = createFreeCamera({ x: c.position[0], y: c.position[1], z: c.position[2] }, { x: c.target[0], y: c.target[1], z: c.target[2] });
            const glb = await exportAndParse(createScene({ camera }));
            const node = glb.json.nodes[0];
            const rotation = node.rotation ?? [0, 0, 0, 1];
            const view = rotate(rotation, [0, 0, -1]);
            expectClose(view, c.direction);
            expectClose(node.translation ?? [0, 0, 0], [-c.position[0], c.position[1], c.position[2]]);
        }
    });

    it("applies Rotate180Y to a camera at the origin looking along +Z", async () => {
        const glb = await exportAndParse(createScene({ camera: lookingAlongZ() }));
        // A camera node with identity rotation would look along -Z; looking along +Z needs a 180 degree yaw.
        expectClose(glb.json.nodes[0].rotation, [0, 1, 0, 0]);
        expect(glb.json.nodes[0].translation).toBeUndefined();
    });

    describe("fixup nodes", () => {
        function fixupScene(fixup: SceneNode) {
            const holder = createTransformNode("holder");
            const mesh = attach(createMesh("m"), holder);
            attach(fixup, holder);
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
            setParent(camera, fixup);
            return { camera, scene: createScene({ meshes: [mesh], camera }) };
        }

        it("collapses a camera under a pristine fixup onto the fixup's parent node", async () => {
            const { scene } = fixupScene(createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1));
            const glb = await exportAndParse(scene);
            expect(glb.json.nodes).toHaveLength(1);
            expect(glb.json.nodes[0].name).toBe("holder");
            expect(glb.json.nodes[0].camera).toBe(0);
            expect(glb.json.nodes[0].rotation).toBeUndefined();
            expect(glb.json.nodes[0].translation).toBeUndefined();
            expect(glb.json.cameras).toHaveLength(1);
            expect(glb.warnings).toEqual([]);
        });

        it("never exports the fixup node itself", async () => {
            const { scene } = fixupScene(createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1));
            const glb = await exportAndParse(scene);
            expect(glb.json.nodes.map((n: { name: string }) => n.name)).not.toContain("cam_fixup");
        });

        it("warns and gives a camera its own node when the fixup carries a translation", async () => {
            const { scene } = fixupScene(createTransformNode("cam_fixup", 1, 0, 0, 0, 0, 0, 1, -1, 1, 1));
            const glb = await exportAndParse(scene);
            expect(glb.warnings).toContain('Camera fixup node "cam_fixup" carries extra transform; exporting the camera as its own node.');
            expect(glb.json.nodes).toHaveLength(2);
            expect(glb.json.nodes[0].camera).toBeUndefined();
            expect(glb.json.nodes[0].children).toEqual([1]);
            expect(glb.json.nodes[1].camera).toBe(0);
        });

        it("does not collapse onto a parent whose glTF frame is mirrored (a loader root kept under an app node)", async () => {
            const app = createTransformNode("app");
            const root = attach(loaderRoot(), app);
            const holder = attach(createTransformNode("holder", 0, 1, 0), root);
            const mesh = attach(createMesh("m"), holder);
            const fixup = attach(createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1), holder);
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
            setParent(camera, fixup);
            const glb = await exportAndParse(createScene({ meshes: [mesh], camera }));
            expect(glb.warnings).toContain('Camera parent "holder" has a mirrored glTF frame; exporting the camera as a scene root.');
            const cameraNode = glb.json.nodes.findIndex((n: { camera?: number }) => n.camera === 0);
            expect(glb.json.nodes[cameraNode].name).not.toBe("holder");
            expect(glb.json.scenes[0].nodes).toContain(cameraNode);
            // A scene-root camera node is a pure TRS without scale, so its global basis is proper (det +1).
            expect(glb.json.nodes[cameraNode].scale).toBeUndefined();
            const w = camera.worldMatrix as unknown as number[];
            expectClose(glb.json.nodes[cameraNode].translation, [-w[12]!, w[13]!, w[14]!]);
        });

        it("exports a camera under a fixup with no exported parent as its own scene root", async () => {
            const fixup = createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
            setParent(camera, fixup);
            const glb = await exportAndParse(createScene({ camera }));
            expect(glb.json.nodes).toHaveLength(1);
            expect(glb.json.nodes[0].camera).toBe(0);
            expect(glb.json.scenes[0].nodes).toEqual([0]);
        });
    });
});

// ─── Lights ──────────────────────────────────────────────────────────

describe("lights", () => {
    it("omits block defaults", async () => {
        const glb = await exportAndParse(createScene({ lights: [createPointLight([0, 0, 0])] }));
        expect(glb.json.extensions.KHR_lights_punctual.lights).toEqual([{ type: "point" }]);
    });

    it("exports name, color, intensity and range when they differ from the defaults", async () => {
        const point = createPointLight([0, 0, 0], 2.5);
        point.name = "lamp";
        point.diffuse = [1, 0.5, 0.25];
        point.range = 12;
        const directional = createDirectionalLight([0, -1, 0], 3);
        const glb = await exportAndParse(createScene({ lights: [point, directional] }));
        expect(glb.json.extensions.KHR_lights_punctual.lights).toEqual([
            { name: "lamp", type: "point", color: [1, 0.5, 0.25], intensity: 2.5, range: 12 },
            { type: "directional", intensity: 3 },
        ]);
    });

    it("divides a light color with a component above 1 by its peak and multiplies the intensity by the peak", async () => {
        const light = createPointLight([0, 0, 0], 3);
        light.diffuse = [4, 2, 1];
        const bright = createDirectionalLight([0, -1, 0], 1);
        bright.diffuse = [2, 2, 2];
        const glb = await exportAndParse(createScene({ lights: [light, bright] }));
        const [a, b] = glb.json.extensions.KHR_lights_punctual.lights;
        expectClose(a.color, [1, 0.5, 0.25]);
        expect(a.intensity).toBe(12);
        expect(b.color).toBeUndefined();
        expect(b.intensity).toBe(2);
    });

    it("leaves a color with every component at most 1 alone", async () => {
        const light = createPointLight([0, 0, 0], 3);
        light.diffuse = [1, 0.5, 0.25];
        const glb = await exportAndParse(createScene({ lights: [light] }));
        const [a] = glb.json.extensions.KHR_lights_punctual.lights;
        expect(a.color).toEqual([1, 0.5, 0.25]);
        expect(a.intensity).toBe(3);
    });

    it("lists KHR_lights_punctual in extensionsUsed only", async () => {
        const glb = await exportAndParse(createScene({ lights: [createPointLight([0, 0, 0])] }));
        expect(glb.json.extensionsUsed).toEqual(["KHR_lights_punctual"]);
        expect(glb.json.extensionsRequired).toBeUndefined();
    });

    it("exports outerConeAngle as half the Lite cone angle and omits the default", async () => {
        const wide = createSpotLight([0, 0, 0], [0, 0, -1], 1, 1);
        const standard = createSpotLight([0, 0, 0], [0, 0, -1], Math.PI / 2, 1);
        const glb = await exportAndParse(createScene({ lights: [wide, standard] }));
        const [a, b] = glb.json.extensions.KHR_lights_punctual.lights;
        expect(a.type).toBe("spot");
        expect(a.spot.outerConeAngle).toBeCloseTo(0.5, 6);
        expect(b.spot).toEqual({});
        expect(glb.warnings).toEqual([]);
    });

    it("clamps a cone wider than 180 degrees with a warning", async () => {
        const light = createSpotLight([0, 0, 0], [0, 0, -1], 4, 1);
        light.name = "wide";
        const glb = await exportAndParse(createScene({ lights: [light] }));
        expect(glb.json.extensions.KHR_lights_punctual.lights[0].spot.outerConeAngle).toBeCloseTo(Math.PI / 2, 6);
        expect(glb.warnings).toContain('Spot light "wide" has a cone wider than KHR_lights_punctual allows; exporting a 180° cone.');
    });

    it("clamps a degenerate spot cone (angle / 2 below 1e-4, or NaN) to 1e-4 with a warning", async () => {
        const zero = createSpotLight([0, 0, 0], [0, 0, -1], 0, 1);
        zero.name = "zero";
        const tiny = createSpotLight([0, 0, 0], [0, 0, -1], 1e-4, 1);
        tiny.name = "tiny";
        const nan = createSpotLight([0, 0, 0], [0, 0, -1], Number.NaN, 1);
        nan.name = "nan";
        const glb = await exportAndParse(createScene({ lights: [zero, tiny, nan] }));
        for (const block of glb.json.extensions.KHR_lights_punctual.lights) {
            expect(block.spot.outerConeAngle).toBe(1e-4);
        }
        for (const name of ["zero", "tiny", "nan"]) {
            expect(glb.warnings).toContain(`Spot light "${name}" has an empty cone; exporting the narrowest cone KHR_lights_punctual allows.`);
        }
    });

    it("does not clamp or warn for a cone whose half angle is exactly 1e-4", async () => {
        const glb = await exportAndParse(createScene({ lights: [createSpotLight([0, 0, 0], [0, 0, -1], 2e-4, 1)] }));
        expect(glb.json.extensions.KHR_lights_punctual.lights[0].spot.outerConeAngle).toBeCloseTo(1e-4, 12);
        expect(glb.warnings).toEqual([]);
    });

    it("warns about a spot light exponent other than 1", async () => {
        const glb = await exportAndParse(createScene({ lights: [createSpotLight([0, 0, 0], [0, 0, -1], 1, 2)] }));
        expect(glb.warnings).toContain("Spot light exponent falloff is approximated by KHR_lights_punctual cone angles.");
        expect(glb.json.extensions.KHR_lights_punctual.lights).toHaveLength(1);
    });

    it("skips a hemispheric light with a warning", async () => {
        const glb = await exportAndParse(createScene({ lights: [createHemisphericLight()] }));
        expect(glb.warnings).toContain("Hemispheric light is not representable in KHR_lights_punctual; skipping.");
        expect(glb.json.extensions).toBeUndefined();
        expect(glb.json.extensionsUsed).toBeUndefined();
        expect(glb.json.nodes).toBeUndefined();
    });

    it("collapses a light with identity-like local state onto its exported parent node", async () => {
        const holder = createTransformNode("holder", 1, 2, 3);
        const mesh = attach(createMesh("m"), holder);
        const point = createPointLight([0, 0, 0]);
        const directional = createDirectionalLight([0, 0, -1]);
        setParent(point, holder);
        const dirHolder = createTransformNode("dirHolder");
        setParent(directional, dirHolder);
        const glb = await exportAndParse(createScene({ meshes: [mesh], lights: [point, directional] }));
        expect(glb.json.nodes.map((n: { name: string }) => n.name)).toEqual(["holder", "dirHolder"]);
        expect(glb.json.nodes[0].extensions.KHR_lights_punctual).toEqual({ light: 0 });
        expect(glb.json.nodes[1].extensions.KHR_lights_punctual).toEqual({ light: 1 });
        expect(glb.json.scenes[0].nodes).toEqual([0, 1]);
    });

    it("gives a light with local translation a dedicated child node", async () => {
        const holder = createTransformNode("holder");
        const mesh = attach(createMesh("m"), holder);
        const point = createPointLight([2, 3, 4]);
        point.name = "lamp";
        setParent(point, holder);
        const glb = await exportAndParse(createScene({ meshes: [mesh], lights: [point] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.nodes[0].extensions).toBeUndefined();
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes[1]).toMatchObject({ name: "lamp", translation: [-2, 3, 4], extensions: { KHR_lights_punctual: { light: 0 } } });
        expect(glb.json.nodes[1].rotation).toBeUndefined();
    });

    it("gives a directional light with a non-default direction a dedicated node whose -Z axis points along the converted direction", async () => {
        const holder = createTransformNode("holder");
        const mesh = attach(createMesh("m"), holder);
        const light = createDirectionalLight([0, -1, 0]);
        setParent(light, holder);
        const glb = await exportAndParse(createScene({ meshes: [mesh], lights: [light] }));
        expect(glb.json.nodes).toHaveLength(2);
        expectClose(rotate(glb.json.nodes[1].rotation, [0, 0, -1]), [0, -1, 0]);
        expect(glb.json.nodes[1].translation).toBeUndefined();
    });

    it("converts the direction X of a dedicated spot light node", async () => {
        const holder = createTransformNode("holder");
        const mesh = attach(createMesh("m"), holder);
        const light = createSpotLight([0, 0, 0], [1, 0, 0], 1, 1);
        setParent(light, holder);
        const glb = await exportAndParse(createScene({ meshes: [mesh], lights: [light] }));
        expectClose(rotate(glb.json.nodes[1].rotation, [0, 0, -1]), [-1, 0, 0]);
    });

    it("exports a parentless light as a world-placed root with the direction converted", async () => {
        const point = createPointLight([1, 2, 3]);
        const directional = createDirectionalLight([1, 0, 0]);
        const glb = await exportAndParse(createScene({ lights: [point, directional] }));
        expect(glb.json.scenes[0].nodes).toEqual([0, 1]);
        expect(glb.json.nodes[0].translation).toEqual([-1, 2, 3]);
        expect(glb.json.nodes[0].rotation).toBeUndefined();
        expect(glb.json.nodes[0].extensions.KHR_lights_punctual.light).toBe(0);
        expect(glb.json.nodes[1].translation).toBeUndefined();
        expectClose(rotate(glb.json.nodes[1].rotation, [0, 0, -1]), [-1, 0, 0]);
    });

    it("places a parentless light at the world transform of an unexported parent", async () => {
        const camera = createFreeCamera({ x: 5, y: 0, z: 0 }, { x: 5, y: 0, z: 1 });
        const light = createPointLight([0, 1, 0]);
        setParent(light, camera);
        const glb = await exportAndParse(createScene({ lights: [light] }));
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        expectClose(glb.json.nodes[0].translation, [-5, 1, 0]);
    });

    it("places a light parented to another light as a world-placed scene root", async () => {
        const parentLight = createPointLight([5, 0, 0]);
        const child = createPointLight([0, 2, 0]);
        setParent(child, parentLight);
        const glb = await exportAndParse(createScene({ lights: [parentLight, child] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.scenes[0].nodes).toEqual([0, 1]);
        expect(glb.json.nodes[0].children).toBeUndefined();
        expectClose(glb.json.nodes[1].translation, [-5, 2, 0]);
        expect(glb.json.nodes[1].extensions.KHR_lights_punctual.light).toBe(1);
    });

    it("places a light parented to a camera as a world-placed scene root, not as a child of the camera node", async () => {
        const camera = createFreeCamera({ x: 5, y: 0, z: 0 }, { x: 5, y: 0, z: 1 });
        const light = createPointLight([0, 1, 0]);
        setParent(light, camera);
        const glb = await exportAndParse(createScene({ lights: [light], camera }));
        const lightNode = glb.json.nodes.find((n: { extensions?: unknown }) => n.extensions);
        expect(glb.json.scenes[0].nodes).toContain(glb.json.nodes.indexOf(lightNode));
        expect(glb.json.nodes.every((n: { children?: number[] }) => n.children === undefined)).toBe(true);
        expectClose(lightNode.translation, [-5, 1, 0]);
    });

    it("collapses onto the parent only when the light's local state is identity within 1e-9", async () => {
        const make = (x: number) => {
            const holder = createTransformNode("holder");
            const mesh = attach(createMesh("m"), holder);
            const light = createPointLight([x, 0, 0]);
            setParent(light, holder);
            return { mesh, light };
        };
        const noise = make(1e-12);
        const collapsed = await exportAndParse(createScene({ meshes: [noise.mesh], lights: [noise.light] }));
        expect(collapsed.json.nodes).toHaveLength(1);
        expect(collapsed.json.nodes[0].extensions.KHR_lights_punctual).toEqual({ light: 0 });
        const small = make(0.0005);
        const separate = await exportAndParse(createScene({ meshes: [small.mesh], lights: [small.light] }));
        expect(separate.json.nodes).toHaveLength(2);
        expect(separate.json.nodes[0].extensions).toBeUndefined();
        expectClose(separate.json.nodes[1].translation, [-0.0005, 0, 0]);
    });

    it("does not collapse a directional light whose direction is slightly off the default", async () => {
        const holder = createTransformNode("holder");
        const mesh = attach(createMesh("m"), holder);
        const light = createDirectionalLight([0.0005, 0, -1]);
        setParent(light, holder);
        const glb = await exportAndParse(createScene({ meshes: [mesh], lights: [light] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.nodes[1].rotation).toBeDefined();
    });

    it("puts at most one light on a node", async () => {
        const holder = createTransformNode("holder");
        const mesh = attach(createMesh("m"), holder);
        const first = createPointLight([0, 0, 0]);
        const second = createPointLight([0, 0, 0]);
        setParent(first, holder);
        setParent(second, holder);
        const glb = await exportAndParse(createScene({ meshes: [mesh], lights: [first, second] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.nodes[0].extensions.KHR_lights_punctual.light).toBe(0);
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes[1].extensions.KHR_lights_punctual.light).toBe(1);
        expect(glb.json.extensions.KHR_lights_punctual.lights).toHaveLength(2);
    });

    it("exports a light under a stripped loader root in pass-through (no X mirror)", async () => {
        const root = loaderRoot();
        const holder = attach(createTransformNode("holder"), root);
        const mesh = attach(createMesh("m", { authoredSign: -1 }), holder);
        const light = createPointLight([2, 3, 4]);
        setParent(light, holder);
        const glb = await exportAndParse(createScene({ meshes: [mesh], lights: [light] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.nodes[1].translation).toEqual([2, 3, 4]);
    });
});

// ─── Animations ──────────────────────────────────────────────────────

interface SamplerSpec {
    input: number[];
    output: number[];
    interpolation?: number;
}

interface ChannelSpec {
    target: object;
    /** `targetedAnimations[].path`. */
    path: string;
    /** The clip channel's numeric path. */
    clipPath: number;
    samplerIdx: number;
}

function group(name: string, channels: ChannelSpec[], samplers: SamplerSpec[]): AnimationGroups[number] {
    const clip = {
        name,
        channels: channels.map((c, i) => ({ samplerIdx: c.samplerIdx, nodeIdx: i, path: c.clipPath })),
        samplers: samplers.map((s) => ({ input: new Float32Array(s.input), output: new Float32Array(s.output), interpolation: s.interpolation ?? INTERP_LINEAR })),
        duration: 1,
    };
    return { name, targetedAnimations: channels.map((c) => ({ target: c.target, path: c.path })), _gltfMixer: [clip, [], []] } as unknown as AnimationGroups[number];
}

const channel = (target: object, path: "translation" | "rotation" | "scale" | "weights", samplerIdx = 0): ChannelSpec => ({
    target,
    path,
    clipPath: { translation: PATH_TRANSLATION, rotation: PATH_ROTATION, scale: PATH_SCALE, weights: PATH_WEIGHTS }[path],
    samplerIdx,
});

const exportGroups = (groups: AnimationGroups, extra: Partial<Parameters<typeof createScene>[0]> = {}): Promise<ParsedGlb> =>
    exportAndParse(createScene({ animationGroups: groups, ...extra }));

/** Unit quaternions (xyzw), so rotation tests exercise conversion rather than renormalization. */
const UNIT_A: [number, number, number, number] = [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)];
const UNIT_B: [number, number, number, number] = [-0.4, 0.5, 0.6, Math.sqrt(1 - 0.77)];

describe("animations", () => {
    it("emits one glTF animation per _gltfMixer group and warns for groups without one", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const propertyGroup = { name: "props", targetedAnimations: [{ target: a, path: "position" }] } as unknown as AnimationGroups[number];
        const glb = await exportGroups([
            group("first", [channel(a, "translation")], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }]),
            propertyGroup,
            group("second", [channel(b, "scale")], [{ input: [0, 1], output: [1, 1, 1, 2, 2, 2] }]),
        ]);
        expect(glb.json.animations.map((x: { name: string }) => x.name)).toEqual(["first", "second"]);
        expect(glb.warnings).toContain('Animation group "props" has no glTF-clip data; skipping.');
    });

    it("negates translation X on converting values and CUBICSPLINE tangents", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "translation", 1)],
                [
                    { input: [0, 1], output: [1, 2, 3, -4, 5, 6] },
                    // in-tangent, value, out-tangent per key
                    { input: [0, 1], output: [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6], interpolation: INTERP_CUBICSPLINE },
                ]
            ),
        ]);
        const samplers = glb.json.animations[0].samplers;
        expectClose(readAccessor(glb, samplers[0].output), [-1, 2, 3, 4, 5, 6]);
        expectClose(readAccessor(glb, samplers[1].output), [-1, 1, 1, -2, 2, 2, -3, 3, 3, -4, 4, 4, -5, 5, 5, -6, 6, 6]);
        expect(glb.json.accessors[samplers[0].output]).toMatchObject({ type: "VEC3", count: 2 });
        expect(glb.json.accessors[samplers[1].output]).toMatchObject({ type: "VEC3", count: 6 });
    });

    it("maps converting rotations with (x, -y, -z, w), including CUBICSPLINE tangents", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "rotation", 0), channel(b, "rotation", 1)],
                [
                    { input: [0, 1], output: [...UNIT_A, ...UNIT_B] },
                    { input: [0, 1], output: [0.1, 0.2, 0.3, 0.4, 1, 2, 3, 4, 5, 6, 7, 8, 0.1, 0.2, 0.3, 0.4, 9, 8, 7, 6, 5, 4, 3, 2], interpolation: INTERP_CUBICSPLINE },
                ]
            ),
        ]);
        const samplers = glb.json.animations[0].samplers;
        expectClose(readAccessor(glb, samplers[0].output), [UNIT_A[0], -UNIT_A[1], -UNIT_A[2], UNIT_A[3], UNIT_B[0], -UNIT_B[1], -UNIT_B[2], UNIT_B[3]]);
        expectClose(readAccessor(glb, samplers[1].output), [0.1, -0.2, -0.3, 0.4, 1, -2, -3, 4, 5, -6, -7, 8, 0.1, -0.2, -0.3, 0.4, 9, -8, -7, 6, 5, -4, -3, 2]);
        expect(glb.json.accessors[samplers[0].output].type).toBe("VEC4");
    });

    it("leaves converting scale and weights values unchanged", async () => {
        const node = createTransformNode("a");
        const mesh = createMesh("m", {
            extra: { morphTargets: { targets: [{ positions: new Float32Array(12), normals: null }], weights: new Float32Array([0]), count: 1 } },
        });
        const glb = await exportGroups(
            [
                group(
                    "g",
                    [channel(node, "scale", 0), channel(mesh, "weights", 1)],
                    [
                        { input: [0, 1], output: [1, 2, 3, 4, 5, 6] },
                        { input: [0, 1], output: [0, 1] },
                    ]
                ),
            ],
            { meshes: [mesh] }
        );
        const animation = glb.json.animations[0];
        expectClose(readAccessor(glb, animation.samplers[0].output), [1, 2, 3, 4, 5, 6]);
        expectClose(readAccessor(glb, animation.samplers[1].output), [0, 1]);
        expect(glb.json.accessors[animation.samplers[1].output].type).toBe("SCALAR");
        expect(animation.channels.map((c: { target: { path: string } }) => c.target.path)).toEqual(["scale", "weights"]);
    });

    it("exports pass-through targets with byte-identical sampler data", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n"), root);
        const translation = new Float32Array([1, 2, 3, -4, 5, 6]);
        const rotation = new Float32Array([...UNIT_A, ...UNIT_B]);
        const animationGroup = group(
            "g",
            [channel(node, "translation", 0), channel(node, "rotation", 1)],
            [
                { input: [0, 1], output: Array.from(translation) },
                { input: [0, 1], output: Array.from(rotation) },
            ]
        );
        const glb = await exportGroups([animationGroup]);
        const samplers = glb.json.animations[0].samplers;
        const bytesOf = (accessor: number) => {
            const a = glb.json.accessors[accessor];
            return Array.from(readBufferView(glb, a.bufferView).subarray(a.byteOffset ?? 0, (a.byteOffset ?? 0) + a.count * (a.type === "VEC4" ? 16 : 12)));
        };
        const expected = (f: Float32Array) => Array.from(new Uint8Array(f.buffer));
        expect(bytesOf(samplers[0].output)).toEqual(expected(translation));
        expect(bytesOf(samplers[1].output)).toEqual(expected(rotation));
    });

    it("renormalizes non-unit LINEAR and STEP rotation keys in the converting pass", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "rotation", 0), channel(b, "rotation", 1)],
                [
                    { input: [0, 1], output: [0, 0, 0, 2, 0.2, 0.4, 0.4, 0.8] },
                    { input: [0, 1], output: [0, 0, 0, 0.5, 0, 0, 3, 4], interpolation: INTERP_STEP },
                ]
            ),
        ]);
        const [linear, step] = glb.json.animations[0].samplers;
        // Mirrored (x, -y, -z, w), then divided by the length.
        expectClose(readAccessor(glb, linear.output), [0, 0, 0, 1, 0.2 / 1, -0.4, -0.4, 0.8]);
        expectClose(readAccessor(glb, step.output), [0, 0, 0, 1, 0, 0, -0.6, 0.8]);
    });

    it("renormalizes non-unit rotation keys in the pass-through pass and leaves unit keys byte-identical", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n"), root);
        const unit = new Float32Array([...UNIT_A]);
        const glb = await exportGroups([group("g", [channel(node, "rotation", 0)], [{ input: [0, 1, 2], output: [...unit, 0, 0, 3, 4, 0, 0, 0, 0.5] }])]);
        const out = readAccessor(glb, glb.json.animations[0].samplers[0].output);
        expect(out.slice(0, 4)).toEqual(Array.from(unit));
        expectClose(out.slice(4, 8), [0, 0, 0.6, 0.8]);
        expectClose(out.slice(8, 12), [0, 0, 0, 1]);
    });

    it("keeps keys within 0.0005 of unit length unchanged", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n"), root);
        const nearUnit = new Float32Array([0, 0, 0, 1.0004]);
        const glb = await exportGroups([group("g", [channel(node, "rotation", 0)], [{ input: [0], output: Array.from(nearUnit) }])]);
        expect(readAccessor(glb, glb.json.animations[0].samplers[0].output)).toEqual(Array.from(nearUnit));
    });

    it("does not renormalize CUBICSPLINE rotation values or tangents", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n"), root);
        const output = [1, 1, 1, 1, 2, 0, 0, 0, 3, 3, 3, 3, 4, 4, 4, 4, 5, 0, 0, 0, 6, 6, 6, 6];
        const glb = await exportGroups([group("g", [channel(node, "rotation", 0)], [{ input: [0, 1], output, interpolation: INTERP_CUBICSPLINE }])]);
        expect(readAccessor(glb, glb.json.animations[0].samplers[0].output)).toEqual(output);
    });

    it("skips a channel whose sampler has no keys", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "translation", 1)],
                [
                    { input: [], output: [] },
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                ]
            ),
        ]);
        expect(glb.warnings).toContain('Animation "g" has a sampler whose key and value counts do not match; skipping channel.');
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.node).toBe(1);
    });

    it("skips a channel whose output length does not match keys x components", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const c = createTransformNode("c");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "rotation", 1), channel(c, "scale", 2)],
                [
                    { input: [0, 1], output: [0, 0, 0, 1, 1] },
                    { input: [0, 1], output: [0, 0, 0, 1, 0, 0, 0] },
                    { input: [0, 1], output: [1, 1, 1, 2, 2, 2] },
                ]
            ),
        ]);
        // Identical warnings are logged once.
        expect(glb.warnings.filter((w) => w.includes("key and value counts do not match"))).toHaveLength(1);
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.path).toBe("scale");
    });

    it("requires three outputs per key for CUBICSPLINE", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "translation", 1)],
                [
                    // Two keys need 2 * 3 * 3 = 18 values; a plain 6 is wrong for a spline.
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: INTERP_CUBICSPLINE },
                    { input: [0, 1], output: new Array(18).fill(1), interpolation: INTERP_CUBICSPLINE },
                ]
            ),
        ]);
        expect(glb.warnings.filter((w) => w.includes("key and value counts do not match"))).toHaveLength(1);
        expect(glb.json.animations[0].channels.map((c: { target: { node: number } }) => c.target.node)).toEqual([1]);
    });

    it("requires one output per key and morph target for weights", async () => {
        const target = (): { positions: Float32Array; normals: null } => ({ positions: new Float32Array(12), normals: null });
        const mesh = createMesh("m", { extra: { morphTargets: { targets: [target(), target()], weights: new Float32Array([0, 0]), count: 2 } } });
        const other = createMesh("o", { extra: { morphTargets: { targets: [target(), target()], weights: new Float32Array([0, 0]), count: 2 } } });
        const glb = await exportGroups(
            [
                group(
                    "g",
                    [channel(mesh, "weights", 0), channel(other, "weights", 1)],
                    [
                        // One value per key matches a single target only.
                        { input: [0, 1], output: [0, 1] },
                        { input: [0, 1], output: [0, 0, 1, 1] },
                    ]
                ),
            ],
            { meshes: [mesh, other] }
        );
        expect(glb.warnings.filter((w) => w.includes("key and value counts do not match"))).toHaveLength(1);
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.node).toBe(1);
        expect(readAccessor(glb, glb.json.animations[0].samplers[0].output)).toEqual([0, 0, 1, 1]);
    });

    it("writes input accessor min and max", async () => {
        const node = createTransformNode("a");
        const glb = await exportGroups([group("g", [channel(node, "translation")], [{ input: [0.5, 1, 2.5], output: [0, 0, 0, 1, 1, 1, 2, 2, 2] }])]);
        const input = glb.json.accessors[glb.json.animations[0].samplers[0].input];
        expect(input).toMatchObject({ type: "SCALAR", componentType: 5126, count: 3, min: [0.5], max: [2.5] });
        expect(readAccessor(glb, glb.json.animations[0].samplers[0].input)).toEqual([0.5, 1, 2.5]);
    });

    it("writes STEP and CUBICSPLINE interpolation and omits LINEAR", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const c = createTransformNode("c");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "translation", 1), channel(c, "translation", 2)],
                [
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: INTERP_STEP },
                    { input: [0, 1], output: new Array(18).fill(1), interpolation: INTERP_CUBICSPLINE },
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: INTERP_LINEAR },
                ]
            ),
        ]);
        const samplers = glb.json.animations[0].samplers;
        expect(samplers.map((s: { interpolation?: string }) => s.interpolation)).toEqual(["STEP", "CUBICSPLINE", undefined]);
        expect("interpolation" in samplers[2]).toBe(false);
    });

    it("skips pointer channels with a warning", async () => {
        const node = createTransformNode("a");
        const glb = await exportGroups([
            group(
                "g",
                [{ target: node, path: "pointer", clipPath: PATH_POINTER, samplerIdx: 0 }, channel(node, "translation", 1)],
                [
                    { input: [0, 1], output: [0, 1] },
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                ]
            ),
        ]);
        expect(glb.warnings).toContain('KHR_animation_pointer channel in "g" is skipped on export.');
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.path).toBe("translation");
    });

    it("skips a channel whose target is not exported", async () => {
        const node = createTransformNode("a");
        const stranger = { name: "not a node" };
        const glb = await exportGroups([
            group(
                "g",
                [{ target: stranger, path: "translation", clipPath: PATH_TRANSLATION, samplerIdx: 0 }, channel(node, "translation", 1)],
                [
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                    { input: [0, 1], output: [2, 2, 2, 3, 3, 3] },
                ]
            ),
        ]);
        expect(glb.warnings).toContain("Animation channel target (node 0) is not in the exported scene; skipping channel.");
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.node).toBe(0);
    });

    it("skips a duplicate (node, path) channel", async () => {
        const node = createTransformNode("a");
        const glb = await exportGroups([
            group(
                "g",
                [channel(node, "translation", 0), channel(node, "translation", 1)],
                [
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                    { input: [0, 1], output: [5, 5, 5, 6, 6, 6] },
                ]
            ),
        ]);
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expectClose(readAccessor(glb, glb.json.animations[0].samplers[glb.json.animations[0].channels[0].sampler].output), [0, 0, 0, -1, 1, 1]);
        expect(glb.warnings.some((w) => w.includes("more than once"))).toBe(true);
    });

    it("skips a weights channel on a node without morph targets", async () => {
        const node = createTransformNode("a");
        const plain = createMesh("plain");
        const glb = await exportGroups(
            [
                group(
                    "g",
                    [channel(node, "weights", 0), channel(plain, "weights", 0), channel(node, "translation", 1)],
                    [
                        { input: [0, 1], output: [0, 1] },
                        { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                    ]
                ),
            ],
            { meshes: [plain] }
        );
        expect(glb.json.animations[0].channels.map((c: { target: { path: string } }) => c.target.path)).toEqual(["translation"]);
        expect(glb.warnings.filter((w) => w.includes("morph weights on a node without morph targets"))).toHaveLength(1);
    });

    it("deduplicates samplers shared by several channels", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([group("g", [channel(a, "translation", 0), channel(b, "translation", 0)], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }])]);
        const animation = glb.json.animations[0];
        expect(animation.samplers).toHaveLength(1);
        expect(animation.channels.map((c: { sampler: number }) => c.sampler)).toEqual([0, 0]);
        expect(animation.channels.map((c: { target: { node: number } }) => c.target.node)).toEqual([0, 1]);
        // The shared input/output arrays also share their accessors.
        expect(glb.json.accessors.filter((x: { type: string; count: number }) => x.type === "SCALAR" && x.count === 2)).toHaveLength(1);
    });

    it("drops an animation with no surviving channel", async () => {
        const node = createTransformNode("a");
        const glb = await exportGroups([
            group("allPointers", [{ target: node, path: "pointer", clipPath: PATH_POINTER, samplerIdx: 0 }], [{ input: [0, 1], output: [0, 1] }]),
            group("orphans", [{ target: { name: "x" }, path: "translation", clipPath: PATH_TRANSLATION, samplerIdx: 0 }], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }]),
        ]);
        expect(glb.json.animations).toBeUndefined();
    });

    it("never folds a mesh bound by a clip channel, whatever the group's string path says", async () => {
        const holder = createTransformNode("holder");
        const bound = attach(createMesh("bound"), holder);
        // Animated nodes are detected from the clip channel's numeric path, so the mesh keeps its own
        // node (a folded mesh would have no node for the channel to target).
        const glb = await exportGroups(
            [group("g", [{ target: bound, path: "visibility", clipPath: PATH_TRANSLATION, samplerIdx: 0 }], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }])],
            { meshes: [bound] }
        );
        expect(glb.json.nodes.map((n: { name: string }) => n.name)).toEqual(["holder", "bound"]);
        expect(glb.json.animations[0].channels[0].target.node).toBe(1);
    });

    it("keeps a mesh child that a node-path channel animates as its own node", async () => {
        const holder = createTransformNode("holder");
        const a = attach(createMesh("a"), holder);
        const animated = attach(createMesh("animated"), holder);
        const glb = await exportGroups([group("g", [channel(animated, "translation")], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }])], { meshes: [a, animated] });
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.animations[0].channels[0].target.node).toBe(1);
    });
});
