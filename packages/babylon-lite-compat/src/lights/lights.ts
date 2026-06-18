/**
 * Babylon.js-compatible light classes implemented over the Babylon Lite light
 * factories.
 *
 * Babylon.js lights take the scene in their constructor and auto-register; these
 * wrappers do the same by calling `addToScene` when a scene is supplied. The
 * underlying Lite light is exposed as `_lite` for advanced interop.
 *
 * Colour properties (`diffuse`, `specular`, `groundColor`) are write-through on
 * assignment: `light.diffuse = new Color3(...)` propagates immediately. In-place
 * mutation of a returned colour (`light.diffuse.r = x`) does not propagate; assign
 * a new colour instead. Direction/position are backed by Lite's observable vectors
 * and propagate on `.x/.y/.z` writes.
 */

import { addToScene, createHemisphericLight, createDirectionalLight, createPointLight, createSpotLight } from "babylon-lite";
import type {
    HemisphericLight as LiteHemisphericLight,
    DirectionalLight as LiteDirectionalLight,
    PointLight as LitePointLight,
    SpotLight as LiteSpotLight,
    LightBase,
} from "babylon-lite";

import { Color3 } from "../math/color.js";
import { Vector3 } from "../math/vector.js";
import { Node } from "../node/node.js";
import type { Scene } from "../scene/scene.js";

type Tuple3 = [number, number, number];

/** Babylon.js `Light` — base class for all lights (derives from `Node`). */
export abstract class Light extends Node {
    /** @internal Underlying Babylon Lite light. */
    public abstract readonly _lite: LightBase;

    protected constructor(name: string, scene?: Scene) {
        super(name, scene);
        scene?._registerLight(this);
    }

    public override getClassName(): string {
        return "Light";
    }

    public abstract get intensity(): number;
    public abstract set intensity(value: number);

    /** Detach this light's shadow generator (compat for `light.shadowEnabled = false`). */
    public set shadowEnabled(enabled: boolean) {
        if (!enabled) {
            this._lite.shadowGenerator = undefined;
        }
    }

    public override dispose(): void {
        // Lite removes lights through the scene; without a back-reference the
        // caller should use `removeFromScene`. Detaching the shadow generator is
        // the safe, scene-free cleanup we can do here.
        this._lite.shadowGenerator = undefined;
        super.dispose();
    }
}

function readColor(tuple: Tuple3): Color3 {
    return new Color3(tuple[0], tuple[1], tuple[2]);
}

function writeColor(tuple: Tuple3, value: Color3): void {
    tuple[0] = value.r;
    tuple[1] = value.g;
    tuple[2] = value.b;
}

function readVector(vec: { x: number; y: number; z: number }): Vector3 {
    return new Vector3(vec.x, vec.y, vec.z);
}

export class HemisphericLight extends Light {
    /** @internal Underlying Babylon Lite hemispheric light. */
    public readonly _lite: LiteHemisphericLight;

    public constructor(name: string, direction: Vector3, scene?: Scene) {
        super(name, scene);
        this._lite = createHemisphericLight(direction.asArray());
        if (scene) {
            addToScene(scene._lite, this._lite);
        }
    }

    public override getClassName(): string {
        return "HemisphericLight";
    }

    public get intensity(): number {
        return this._lite.intensity;
    }
    public set intensity(value: number) {
        this._lite.intensity = value;
    }

    public get direction(): Vector3 {
        return readVector(this._lite.direction);
    }
    public set direction(value: Vector3) {
        this._lite.direction.set(value.x, value.y, value.z);
    }

    public get diffuse(): Color3 {
        return readColor(this._lite.diffuseColor);
    }
    public set diffuse(value: Color3) {
        writeColor(this._lite.diffuseColor, value);
    }

    public get specular(): Color3 {
        return readColor(this._lite.specularColor);
    }
    public set specular(value: Color3) {
        writeColor(this._lite.specularColor, value);
    }

    public get groundColor(): Color3 {
        return readColor(this._lite.groundColor);
    }
    public set groundColor(value: Color3) {
        writeColor(this._lite.groundColor, value);
    }
}

export class DirectionalLight extends Light {
    /** @internal Underlying Babylon Lite directional light. */
    public readonly _lite: LiteDirectionalLight;

    public constructor(name: string, direction: Vector3, scene?: Scene) {
        super(name, scene);
        this._lite = createDirectionalLight(direction.asArray());
        if (scene) {
            addToScene(scene._lite, this._lite);
        }
    }

    public override getClassName(): string {
        return "DirectionalLight";
    }

    public get intensity(): number {
        return this._lite.intensity;
    }
    public set intensity(value: number) {
        this._lite.intensity = value;
    }

    public get direction(): Vector3 {
        return readVector(this._lite.direction);
    }
    public set direction(value: Vector3) {
        this._lite.direction.set(value.x, value.y, value.z);
    }

    public get position(): Vector3 {
        return readVector(this._lite.position);
    }
    public set position(value: Vector3) {
        this._lite.position.set(value.x, value.y, value.z);
    }

    public get diffuse(): Color3 {
        return readColor(this._lite.diffuse);
    }
    public set diffuse(value: Color3) {
        writeColor(this._lite.diffuse, value);
    }

    public get specular(): Color3 {
        return readColor(this._lite.specular);
    }
    public set specular(value: Color3) {
        writeColor(this._lite.specular, value);
    }
}

export class PointLight extends Light {
    /** @internal Underlying Babylon Lite point light. */
    public readonly _lite: LitePointLight;

    public constructor(name: string, position: Vector3, scene?: Scene) {
        super(name, scene);
        this._lite = createPointLight(position.asArray());
        if (scene) {
            addToScene(scene._lite, this._lite);
        }
    }

    public override getClassName(): string {
        return "PointLight";
    }

    public get intensity(): number {
        return this._lite.intensity;
    }
    public set intensity(value: number) {
        this._lite.intensity = value;
    }

    public get range(): number {
        return this._lite.range;
    }
    public set range(value: number) {
        this._lite.range = value;
    }

    public get position(): Vector3 {
        return readVector(this._lite.position);
    }
    public set position(value: Vector3) {
        this._lite.position.set(value.x, value.y, value.z);
    }

    public get diffuse(): Color3 {
        return readColor(this._lite.diffuse);
    }
    public set diffuse(value: Color3) {
        writeColor(this._lite.diffuse, value);
    }

    public get specular(): Color3 {
        return readColor(this._lite.specular);
    }
    public set specular(value: Color3) {
        writeColor(this._lite.specular, value);
    }
}

export class SpotLight extends Light {
    /** @internal Underlying Babylon Lite spot light. */
    public readonly _lite: LiteSpotLight;

    public constructor(name: string, position: Vector3, direction: Vector3, angle: number, exponent: number, scene?: Scene) {
        super(name, scene);
        this._lite = createSpotLight(position.asArray(), direction.asArray(), angle, exponent);
        if (scene) {
            addToScene(scene._lite, this._lite);
        }
    }

    public override getClassName(): string {
        return "SpotLight";
    }

    public get intensity(): number {
        return this._lite.intensity;
    }
    public set intensity(value: number) {
        this._lite.intensity = value;
    }

    public get angle(): number {
        return this._lite.angle;
    }
    public set angle(value: number) {
        this._lite.angle = value;
    }

    public get exponent(): number {
        return this._lite.exponent;
    }
    public set exponent(value: number) {
        this._lite.exponent = value;
    }

    public get range(): number {
        return this._lite.range;
    }
    public set range(value: number) {
        this._lite.range = value;
    }

    public get position(): Vector3 {
        return readVector(this._lite.position);
    }
    public set position(value: Vector3) {
        this._lite.position.set(value.x, value.y, value.z);
    }

    public get direction(): Vector3 {
        return readVector(this._lite.direction);
    }
    public set direction(value: Vector3) {
        this._lite.direction.set(value.x, value.y, value.z);
    }

    public get diffuse(): Color3 {
        return readColor(this._lite.diffuse);
    }
    public set diffuse(value: Color3) {
        writeColor(this._lite.diffuse, value);
    }

    public get specular(): Color3 {
        return readColor(this._lite.specular);
    }
    public set specular(value: Color3) {
        writeColor(this._lite.specular, value);
    }
}
