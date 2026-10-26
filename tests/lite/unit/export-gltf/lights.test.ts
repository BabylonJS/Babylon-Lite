import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, expectClose, exportAndParse, loaderRoot, rotate, setParent } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import { createFreeCamera } from "../../../../packages/babylon-lite/src/camera/free-camera";
import { createPointLight } from "../../../../packages/babylon-lite/src/light/point-light";
import { createDirectionalLight } from "../../../../packages/babylon-lite/src/light/directional-light";
import { createSpotLight } from "../../../../packages/babylon-lite/src/light/spot-light";
import { createHemisphericLight } from "../../../../packages/babylon-lite/src/light/hemispheric";

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
