import { addPolarToRef, dividePolarToRef, multiplyPolarToRef, polarFromVec2ToRef, polarToVec2ToRef, scalePolarToRef, subtractPolarToRef } from "babylon-lite";

import { Vector2 } from "./vector.js";

/** Babylon.js-compatible polar-coordinate value object. */
export class Polar {
    public constructor(
        public radius: number,
        public theta: number
    ) {}

    public getClassName(): string {
        return "Polar";
    }

    public toString(): string {
        return JSON.stringify(this);
    }

    public asArray(): number[] {
        return [this.radius, this.theta];
    }

    public addToRef(polar: Polar, ref: Polar): Polar {
        return addPolarToRef(this, polar, ref);
    }

    public add(polar: Polar): Polar {
        return this.addToRef(polar, new Polar(0, 0));
    }

    public addInPlace(polar: Polar): this {
        this.addToRef(polar, this);
        return this;
    }

    public addInPlaceFromFloats(radius: number, theta: number): this {
        return this.addInPlace(new Polar(radius, theta));
    }

    public subtractToRef(polar: Polar, ref: Polar): Polar {
        return subtractPolarToRef(this, polar, ref);
    }

    public subtract(polar: Polar): Polar {
        return this.subtractToRef(polar, new Polar(0, 0));
    }

    public subtractInPlace(polar: Polar): this {
        this.subtractToRef(polar, this);
        return this;
    }

    public subtractFromFloatsToRef(radius: number, theta: number, ref: Polar): Polar {
        return this.subtractToRef(new Polar(radius, theta), ref);
    }

    public subtractFromFloats(radius: number, theta: number): Polar {
        return this.subtractFromFloatsToRef(radius, theta, new Polar(0, 0));
    }

    public multiplyToRef(polar: Polar, ref: Polar): Polar {
        return multiplyPolarToRef(this, polar, ref);
    }

    public multiply(polar: Polar): Polar {
        return this.multiplyToRef(polar, new Polar(0, 0));
    }

    public multiplyInPlace(polar: Polar): this {
        this.multiplyToRef(polar, this);
        return this;
    }

    public divideToRef(polar: Polar, ref: Polar): Polar {
        return dividePolarToRef(this, polar, ref);
    }

    public divide(polar: Polar): Polar {
        return this.divideToRef(polar, new Polar(0, 0));
    }

    public divideInPlace(polar: Polar): this {
        this.divideToRef(polar, this);
        return this;
    }

    public clone(): Polar {
        return new Polar(this.radius, this.theta);
    }

    public copyFrom(source: Polar): this {
        return this.copyFromFloats(source.radius, source.theta);
    }

    public copyFromFloats(radius: number, theta: number): this {
        this.radius = radius;
        this.theta = theta;
        return this;
    }

    public scaleToRef(scale: number, ref: Polar): Polar {
        return scalePolarToRef(this, scale, ref);
    }

    public scale(scale: number): Polar {
        return this.scaleToRef(scale, new Polar(0, 0));
    }

    public scaleInPlace(scale: number): this {
        this.scaleToRef(scale, this);
        return this;
    }

    public set(radius: number, theta: number): this {
        return this.copyFromFloats(radius, theta);
    }

    public setAll(value: number): this {
        return this.set(value, value);
    }

    public toVector2ToRef(ref: Vector2): Vector2 {
        return polarToVec2ToRef(this, ref);
    }

    public toVector2(): Vector2 {
        return this.toVector2ToRef(new Vector2());
    }

    public static FromVector2ToRef(vector: Vector2, ref: Polar): Polar {
        return polarFromVec2ToRef(vector, ref);
    }

    public static FromVector2(vector: Vector2): Polar {
        return Polar.FromVector2ToRef(vector, new Polar(0, 0));
    }

    public static FromArray(array: number[]): Polar {
        return new Polar(array[0]!, array[1]!);
    }
}
