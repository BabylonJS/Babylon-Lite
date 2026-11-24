// Leaf module for enums shared by havok.ts and the runtimes it lazy-loads
// (havok-floating-origin.ts, havok-thin-instances.ts). Those lazy modules must
// not statically import havok.ts; see tests/lite/build/lazy-import-cycles.test.ts.

/** How a body moves: `STATIC` (immovable), `ANIMATED` (driven by the node transform), or `DYNAMIC` (simulated). */
export const PhysicsMotionType = {
    STATIC: 0,
    ANIMATED: 1,
    DYNAMIC: 2,
} as const;
export type PhysicsMotionType = (typeof PhysicsMotionType)[keyof typeof PhysicsMotionType];

/**
 * How a moved transform node is propagated to its physics body before each step.
 * `DISABLED` skips the sync, `TELEPORT` snaps the body to the node (`HP_Body_SetQTransform`),
 * and `ACTION` sets the body's velocity so it reaches the node (`HP_Body_SetTargetQTransform`,
 * dragging resting bodies via friction). Values match Babylon.js `PhysicsPrestepType`.
 */
export const PhysicsPrestepType = {
    DISABLED: 0,
    TELEPORT: 1,
    ACTION: 2,
} as const;
export type PhysicsPrestepType = (typeof PhysicsPrestepType)[keyof typeof PhysicsPrestepType];
