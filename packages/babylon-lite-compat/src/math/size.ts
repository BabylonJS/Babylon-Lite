/** Babylon.js-compatible `Size` and `Viewport` (pure JS). */

export class Size {
    public constructor(
        public width: number = 0,
        public height: number = 0
    ) {}

    public get surface(): number {
        return this.width * this.height;
    }

    public clone(): Size {
        return new Size(this.width, this.height);
    }

    public equals(other: Size): boolean {
        return this.width === other.width && this.height === other.height;
    }

    public add(other: Size): Size {
        return new Size(this.width + other.width, this.height + other.height);
    }

    public static Zero(): Size {
        return new Size(0, 0);
    }
}

export class Viewport {
    public constructor(
        public x: number,
        public y: number,
        public width: number,
        public height: number
    ) {}

    /** Resolve this normalized viewport to pixel coordinates for a render target. */
    public toGlobal(renderWidth: number, renderHeight: number): Viewport {
        return new Viewport(this.x * renderWidth, this.y * renderHeight, this.width * renderWidth, this.height * renderHeight);
    }

    public clone(): Viewport {
        return new Viewport(this.x, this.y, this.width, this.height);
    }
}
