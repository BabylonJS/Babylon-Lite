/**
 * Rigid Body — interface for world objects that block character movement.
 *
 * Any object that the physics and movement controllers should collide with
 * implements this interface.  The AABB is queried every frame so it may
 * change over time (e.g. a draggable block).
 */

export interface RigidBodyAABB {
    readonly minX: number;
    readonly minY: number;
    readonly minZ: number;
    readonly maxX: number;
    readonly maxY: number;
    readonly maxZ: number;
}

export interface RigidBody {
    getAABB(): RigidBodyAABB;
}
