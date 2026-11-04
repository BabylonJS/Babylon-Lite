import { clearBoneOverride, getBoneByName as getLiteBoneByName, setBonePosition, setBoneRotationQuaternion, setBoneScaling } from "babylon-lite";
import type { Bone as LiteBone, Skeleton as LiteSkeleton } from "babylon-lite";

import { unsupported } from "../error.js";
import type { Quaternion } from "../math/quaternion.js";
import type { Vector3 } from "../math/vector.js";
import type { Scene } from "../scene/scene.js";

export class Skeleton {
    public readonly name!: string;
    public readonly id!: string;
    public readonly bones!: Bone[];

    /** @internal Underlying loader-produced Babylon Lite skeleton. */
    public readonly _lite!: LiteSkeleton;

    public constructor(_name?: string, _id?: string, _scene?: Scene) {
        return unsupported(
            "Skeleton",
            "Babylon Lite exposes loader-produced skeletons but has no public API for manually constructing a skeleton. Load a skinned glTF and use the returned skeleton."
        );
    }

    /** @internal Wrap a loader-produced Babylon Lite skeleton. */
    public static _fromLite(lite: LiteSkeleton, index: number): Skeleton {
        const skeleton = Object.create(Skeleton.prototype) as Skeleton;
        Object.defineProperties(skeleton, {
            name: { value: `skeleton${index}`, enumerable: true },
            id: { value: `skeleton${index}`, enumerable: true },
            _lite: { value: lite },
            bones: { value: lite.bones.map((bone) => Bone._fromLite(bone, skeleton)) },
        });
        return skeleton;
    }

    public getBoneIndexByName(name: string): number {
        const bone = getLiteBoneByName(this._lite, name);
        return bone ? this._lite.bones.indexOf(bone) : -1;
    }

    public getBoneByName(name: string): Bone | null {
        const index = this.getBoneIndexByName(name);
        return index < 0 ? null : this.bones[index]!;
    }
}

export class Bone {
    private _enabled = true;

    public readonly name!: string;

    /** @internal Underlying loader-produced Babylon Lite bone. */
    public readonly _lite!: LiteBone;
    /** @internal Owning compat skeleton. */
    public readonly _skeleton!: Skeleton;

    public constructor(_name?: string, _skeleton?: Skeleton) {
        return unsupported(
            "Bone",
            "Babylon Lite exposes loader-produced bones but has no public API for manually constructing a bone. Use Skeleton.bones from a loaded skinned glTF."
        );
    }

    /** @internal Wrap a loader-produced Babylon Lite bone. */
    public static _fromLite(lite: LiteBone, skeleton: Skeleton): Bone {
        const bone = Object.create(Bone.prototype) as Bone;
        Object.defineProperties(bone, {
            name: { value: lite.name, enumerable: true },
            _lite: { value: lite },
            _skeleton: { value: skeleton },
            _enabled: { value: true, writable: true },
        });
        return bone;
    }

    public getName(): string {
        return this.name;
    }

    public getSkeleton(): Skeleton {
        return this._skeleton;
    }

    public setPosition(position: Vector3, space = 0): this {
        if (space !== 0) {
            return unsupported("Bone.setPosition", "Babylon Lite's bone-control API currently exposes local-space position overrides only.");
        }
        setBonePosition(this._skeleton._lite, this._lite, position.x, position.y, position.z);
        return this;
    }

    public setRotationQuaternion(rotation: Quaternion, space = 0): this {
        if (space !== 0) {
            return unsupported("Bone.setRotationQuaternion", "Babylon Lite's bone-control API currently exposes local-space rotation overrides only.");
        }
        setBoneRotationQuaternion(this._skeleton._lite, this._lite, rotation.x, rotation.y, rotation.z, rotation.w);
        return this;
    }

    public setScale(scale: Vector3): this {
        setBoneScaling(this._skeleton._lite, this._lite, scale.x, scale.y, scale.z);
        return this;
    }

    public setEnabled(value: boolean): void {
        this._enabled = value;
    }

    public isEnabled(): boolean {
        return this._enabled;
    }

    public returnToRest(): void {
        clearBoneOverride(this._skeleton._lite, this._lite);
    }
}
