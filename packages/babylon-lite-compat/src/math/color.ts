/**
 * Babylon.js-compatible colour classes (`Color3`, `Color4`).
 *
 * Mutable, backed by `r`/`g`/`b`/`a` fields. `asArray()` yields the tuple shape
 * (`[r, g, b]` / `[r, g, b, a]`) consumed by the Babylon Lite material and light
 * APIs.
 */

export class Color3 {
    public constructor(
        public r: number = 0,
        public g: number = 0,
        public b: number = 0
    ) {}

    public set(r: number, g: number, b: number): this {
        this.r = r;
        this.g = g;
        this.b = b;
        return this;
    }

    public copyFrom(source: Color3): this {
        this.r = source.r;
        this.g = source.g;
        this.b = source.b;
        return this;
    }

    public scale(scale: number): Color3 {
        return new Color3(this.r * scale, this.g * scale, this.b * scale);
    }

    public scaleInPlace(scale: number): this {
        this.r *= scale;
        this.g *= scale;
        this.b *= scale;
        return this;
    }

    public multiply(other: Color3): Color3 {
        return new Color3(this.r * other.r, this.g * other.g, this.b * other.b);
    }

    public add(other: Color3): Color3 {
        return new Color3(this.r + other.r, this.g + other.g, this.b + other.b);
    }

    public clone(): Color3 {
        return new Color3(this.r, this.g, this.b);
    }

    public equals(other: Color3): boolean {
        return this.r === other.r && this.g === other.g && this.b === other.b;
    }

    public asArray(): [number, number, number] {
        return [this.r, this.g, this.b];
    }

    public toColor4(alpha = 1): Color4 {
        return new Color4(this.r, this.g, this.b, alpha);
    }

    public toHexString(): string {
        const intR = Math.round(Math.min(Math.max(this.r, 0), 1) * 255);
        const intG = Math.round(Math.min(Math.max(this.g, 0), 1) * 255);
        const intB = Math.round(Math.min(Math.max(this.b, 0), 1) * 255);
        return "#" + toHex(intR) + toHex(intG) + toHex(intB);
    }

    public static Black(): Color3 {
        return new Color3(0, 0, 0);
    }

    public static White(): Color3 {
        return new Color3(1, 1, 1);
    }

    public static Red(): Color3 {
        return new Color3(1, 0, 0);
    }

    public static Green(): Color3 {
        return new Color3(0, 1, 0);
    }

    public static Blue(): Color3 {
        return new Color3(0, 0, 1);
    }

    public static FromArray(array: ArrayLike<number>, offset = 0): Color3 {
        return new Color3(array[offset] ?? 0, array[offset + 1] ?? 0, array[offset + 2] ?? 0);
    }

    public static FromInts(r: number, g: number, b: number): Color3 {
        return new Color3(r / 255, g / 255, b / 255);
    }

    public static FromHexString(hex: string): Color3 {
        if (hex.charAt(0) !== "#" || hex.length < 7) {
            return new Color3(0, 0, 0);
        }
        const r = parseInt(hex.substring(1, 3), 16);
        const g = parseInt(hex.substring(3, 5), 16);
        const b = parseInt(hex.substring(5, 7), 16);
        return Color3.FromInts(r, g, b);
    }

    public static Lerp(start: Color3, end: Color3, amount: number): Color3 {
        return new Color3(start.r + (end.r - start.r) * amount, start.g + (end.g - start.g) * amount, start.b + (end.b - start.b) * amount);
    }
}

export class Color4 {
    public constructor(
        public r: number = 0,
        public g: number = 0,
        public b: number = 0,
        public a: number = 1
    ) {}

    public set(r: number, g: number, b: number, a: number): this {
        this.r = r;
        this.g = g;
        this.b = b;
        this.a = a;
        return this;
    }

    public copyFrom(source: Color4): this {
        this.r = source.r;
        this.g = source.g;
        this.b = source.b;
        this.a = source.a;
        return this;
    }

    public scale(scale: number): Color4 {
        return new Color4(this.r * scale, this.g * scale, this.b * scale, this.a * scale);
    }

    public add(other: Color4): Color4 {
        return new Color4(this.r + other.r, this.g + other.g, this.b + other.b, this.a + other.a);
    }

    public clone(): Color4 {
        return new Color4(this.r, this.g, this.b, this.a);
    }

    public equals(other: Color4): boolean {
        return this.r === other.r && this.g === other.g && this.b === other.b && this.a === other.a;
    }

    public toColor3(): Color3 {
        return new Color3(this.r, this.g, this.b);
    }

    public asArray(): [number, number, number, number] {
        return [this.r, this.g, this.b, this.a];
    }

    public static FromArray(array: ArrayLike<number>, offset = 0): Color4 {
        return new Color4(array[offset] ?? 0, array[offset + 1] ?? 0, array[offset + 2] ?? 0, array[offset + 3] ?? 1);
    }

    public static FromInts(r: number, g: number, b: number, a: number): Color4 {
        return new Color4(r / 255, g / 255, b / 255, a / 255);
    }
}

function toHex(value: number): string {
    const hex = value.toString(16).toUpperCase();
    return hex.length === 1 ? "0" + hex : hex;
}
