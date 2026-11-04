import {
    addSphericalToRef,
    divideSphericalToRef,
    multiplySphericalToRef,
    scaleSphericalToRef,
    sphericalFromVec3ToRef,
    sphericalToVec3ToRef,
    subtractSphericalToRef,
} from "babylon-lite";

import { Vector3 } from "./vector.js";

/** Babylon.js-compatible spherical-coordinate value object. */
export class Spherical {
    public constructor(
        public radius: number,
        public theta: number,
        public phi: number
    ) {}

    public getClassName(): string {
        return "Spherical";
    }

    public toString(): string {
        return JSON.stringify(this);
    }

    public asArray(): number[] {
        return [this.radius, this.theta, this.phi];
    }

    public addToRef(spherical: Spherical, ref: Spherical): Spherical {
        return addSphericalToRef(this, spherical, ref);
    }

    public add(spherical: Spherical): Spherical {
        return this.addToRef(spherical, new Spherical(0, 0, 0));
    }

    public addInPlace(spherical: Spherical): this {
        this.addToRef(spherical, this);
        return this;
    }

    public addInPlaceFromFloats(radius: number, theta: number, phi: number): this {
        return this.addInPlace(new Spherical(radius, theta, phi));
    }

    public subtractToRef(spherical: Spherical, ref: Spherical): Spherical {
        return subtractSphericalToRef(this, spherical, ref);
    }

    public subtract(spherical: Spherical): Spherical {
        return this.subtractToRef(spherical, new Spherical(0, 0, 0));
    }

    public subtractInPlace(spherical: Spherical): this {
        this.subtractToRef(spherical, this);
        return this;
    }

    public subtractFromFloatsToRef(radius: number, theta: number, phi: number, ref: Spherical): Spherical {
        return this.subtractToRef(new Spherical(radius, theta, phi), ref);
    }

    public subtractFromFloats(radius: number, theta: number, phi: number): Spherical {
        return this.subtractFromFloatsToRef(radius, theta, phi, new Spherical(0, 0, 0));
    }

    public multiplyToRef(spherical: Spherical, ref: Spherical): Spherical {
        return multiplySphericalToRef(this, spherical, ref);
    }

    public multiply(spherical: Spherical): Spherical {
        return this.multiplyToRef(spherical, new Spherical(0, 0, 0));
    }

    public multiplyInPlace(spherical: Spherical): this {
        this.multiplyToRef(spherical, this);
        return this;
    }

    public divideToRef(spherical: Spherical, ref: Spherical): Spherical {
        return divideSphericalToRef(this, spherical, ref);
    }

    public divide(spherical: Spherical): Spherical {
        return this.divideToRef(spherical, new Spherical(0, 0, 0));
    }

    public divideInPlace(spherical: Spherical): this {
        this.divideToRef(spherical, this);
        return this;
    }

    public clone(): Spherical {
        return new Spherical(this.radius, this.theta, this.phi);
    }

    public copyFrom(source: Spherical): this {
        return this.copyFromFloats(source.radius, source.theta, source.phi);
    }

    public copyFromFloats(radius: number, theta: number, phi: number): this {
        this.radius = radius;
        this.theta = theta;
        this.phi = phi;
        return this;
    }

    public scaleToRef(scale: number, ref: Spherical): Spherical {
        return scaleSphericalToRef(this, scale, ref);
    }

    public scale(scale: number): Spherical {
        return this.scaleToRef(scale, new Spherical(0, 0, 0));
    }

    public scaleInPlace(scale: number): this {
        this.scaleToRef(scale, this);
        return this;
    }

    public set(radius: number, theta: number, phi: number): this {
        return this.copyFromFloats(radius, theta, phi);
    }

    public setAll(value: number): this {
        return this.set(value, value, value);
    }

    public toVector3ToRef(ref: Vector3): Vector3 {
        return sphericalToVec3ToRef(this, ref);
    }

    public toVector3(): Vector3 {
        return this.toVector3ToRef(new Vector3());
    }

    public static FromVector3ToRef(vector: Vector3, ref: Spherical): Spherical {
        return sphericalFromVec3ToRef(vector, ref);
    }

    public static FromVector3(vector: Vector3): Spherical {
        return Spherical.FromVector3ToRef(vector, new Spherical(0, 0, 0));
    }

    public static FromArray(array: number[]): Spherical {
        return new Spherical(array[0]!, array[1]!, array[2]!);
    }
}
