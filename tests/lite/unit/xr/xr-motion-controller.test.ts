import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the glTF loader so `loadMotionController` runs its resolve/fetch/bind logic
// without touching the GPU. `fetch` is stubbed per-test for the registry JSON.
const { loadGltf } = vi.hoisted(() => ({ loadGltf: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/loader-gltf/load-gltf", () => ({ loadGltf }));

import { loadMotionController, updateMotionController, DEFAULT_PROFILES_BASE_URL } from "../../../../packages/babylon-lite/src/xr/xr-motion-controller";
import type { MotionController } from "../../../../packages/babylon-lite/src/xr/xr-motion-controller";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine";

// ─── Tiny node/model doubles ────────────────────────────────────────────────

function vec(x = 0, y = 0, z = 0, w?: number) {
    return {
        x,
        y,
        z,
        w,
        set(nx: number, ny: number, nz: number, nw?: number) {
            this.x = nx;
            this.y = ny;
            this.z = nz;
            if (nw !== undefined) this.w = nw;
        },
    };
}

function node(name: string, opts: { px?: number; sx?: number; qx?: number } = {}) {
    return {
        name,
        children: [] as unknown[],
        visible: true,
        position: vec(opts.px ?? 0, 0, 0),
        scaling: vec(opts.sx ?? 1, 1, 1),
        rotationQuaternion: vec(opts.qx ?? 0, 0, 0, 1),
    };
}

/** Build a MotionController with one bound transform response over a button. */
function buttonModel() {
    const valueNode = node("value");
    const minNode = node("min", { px: 0, sx: 1, qx: 0 });
    const maxNode = node("max", { px: 10, sx: 3, qx: 0 });
    const mc = {
        container: {} as never,
        root: valueNode as never,
        profileId: "test",
        _responses: [
            {
                valueNode,
                minNode,
                maxNode,
                property: "transform",
                source: "button",
                states: ["default", "touched", "pressed"],
                buttonIndex: 0,
                xAxisIndex: -1,
                yAxisIndex: -1,
            },
        ],
    } as unknown as MotionController;
    return { mc, valueNode };
}

function gamepad(buttons: Partial<GamepadButton>[], axes: number[] = []): Gamepad {
    return { buttons: buttons as GamepadButton[], axes } as unknown as Gamepad;
}

describe("updateMotionController — animation", () => {
    it("lerps a transform response between min and max by the button value", () => {
        const { mc, valueNode } = buttonModel();
        updateMotionController(mc, gamepad([{ value: 0.5, pressed: false, touched: false }]));
        expect(valueNode.position.x).toBeCloseTo(5); // 0→10 at 0.5
        expect(valueNode.scaling.x).toBeCloseTo(2); // 1→3 at 0.5
    });

    it("maps a full press to the max node and no press to the min node", () => {
        const { mc, valueNode } = buttonModel();
        updateMotionController(mc, gamepad([{ value: 1, pressed: true, touched: true }]));
        expect(valueNode.position.x).toBeCloseTo(10);
        updateMotionController(mc, gamepad([{ value: 0, pressed: false, touched: false }]));
        expect(valueNode.position.x).toBeCloseTo(0);
    });

    it("normalizes an axis [-1,1] to [0,1] for the interpolation weight", () => {
        const valueNode = node("value");
        const minNode = node("min", { px: 0 });
        const maxNode = node("max", { px: 8 });
        const mc = {
            _responses: [{ valueNode, minNode, maxNode, property: "transform", source: "xAxis", states: [], buttonIndex: -1, xAxisIndex: 0, yAxisIndex: -1 }],
        } as unknown as MotionController;
        updateMotionController(mc, gamepad([], [-1]));
        expect(valueNode.position.x).toBeCloseTo(0); // -1 → weight 0
        updateMotionController(mc, gamepad([], [0]));
        expect(valueNode.position.x).toBeCloseTo(4); // 0 → weight 0.5
        updateMotionController(mc, gamepad([], [1]));
        expect(valueNode.position.x).toBeCloseTo(8); // 1 → weight 1
    });

    it("toggles a visibility response by button state membership", () => {
        const valueNode = node("touch-dot");
        const mc = {
            _responses: [
                {
                    valueNode,
                    minNode: null,
                    maxNode: null,
                    property: "visibility",
                    source: "state",
                    states: ["touched", "pressed"],
                    buttonIndex: 0,
                    xAxisIndex: -1,
                    yAxisIndex: -1,
                },
            ],
        } as unknown as MotionController;
        updateMotionController(mc, gamepad([{ pressed: false, touched: true }]));
        expect(valueNode.visible).toBe(true);
        updateMotionController(mc, gamepad([{ pressed: false, touched: false }]));
        expect(valueNode.visible).toBe(false);
    });

    it("is a no-op when the gamepad is null", () => {
        const { mc, valueNode } = buttonModel();
        updateMotionController(mc, null);
        expect(valueNode.position.x).toBe(0);
    });
});

describe("loadMotionController — resolve + bind", () => {
    const engine = {} as EngineContext;

    beforeEach(() => {
        loadGltf.mockReset();
    });

    function mockFetchOk(profilesList: unknown, profile: unknown) {
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve(url.endsWith("profilesList.json") ? profilesList : profile),
                })
            )
        );
    }

    it("picks the first published profile, fetches its handedness GLB, and binds nodes", async () => {
        mockFetchOk(
            { "oculus-touch-v3": { path: "oculus-touch-v3/profile.json" } },
            {
                profileId: "oculus-touch-v3",
                layouts: {
                    left: {
                        assetPath: "left.glb",
                        components: {
                            trigger: {
                                type: "trigger",
                                gamepadIndices: { button: 0 },
                                visualResponses: {
                                    r: { componentProperty: "button", states: ["default"], valueNodeProperty: "transform", valueNodeName: "v", minNodeName: "n", maxNodeName: "x" },
                                },
                            },
                        },
                    },
                },
            }
        );
        const root = node("root");
        root.children = [node("v"), node("n"), node("x")] as never[];
        loadGltf.mockResolvedValue({ entities: [root] });

        const source = { profiles: ["unknown-first", "oculus-touch-v3"] } as unknown as XRInputSource;
        const mc = await loadMotionController(engine, source, "left");

        expect(mc).toBeTruthy();
        expect(mc!.profileId).toBe("oculus-touch-v3");
        // GLB URL resolved relative to the profile.json under the default CDN.
        expect(loadGltf).toHaveBeenCalledWith(engine, `${DEFAULT_PROFILES_BASE_URL}oculus-touch-v3/left.glb`);
        expect(mc!._responses.length).toBe(1);
        expect(mc!._responses[0]!.buttonIndex).toBe(0);
    });

    it("returns null when the source advertises no known profile", async () => {
        mockFetchOk({ "oculus-touch-v3": { path: "oculus-touch-v3/profile.json" } }, {});
        const mc = await loadMotionController(engine, { profiles: ["nope"] } as unknown as XRInputSource, "right");
        expect(mc).toBeNull();
        expect(loadGltf).not.toHaveBeenCalled();
    });

    it("returns null (never throws) when a fetch fails", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }))
        );
        const mc = await loadMotionController(engine, { profiles: ["oculus-touch-v3"] } as unknown as XRInputSource, "left");
        expect(mc).toBeNull();
    });
});
