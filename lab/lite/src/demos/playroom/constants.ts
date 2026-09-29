export const GAME_SCALE = 0.2;
export const PHYSICS_STEP_MS = 1000 / 60;
export const THROW_TOTAL = 3;
export const SCORE_PER_BODY = 7;
export const THROW_FORCE = 500;
export const WORLD_LIMIT = 16;
export const POPPER_RADIUS = 1.6;
export const POPPER_POWER = 0.096;
export const POPPER_STRONG_POWER = 0.256;
export const POPPER_SPEED_THRESHOLD = 0.06;
export const PUSH_POWER_PER_MS = 0.0008;

export const CAMERA = {
    alpha: -1.25,
    beta: 1.2,
    radius: 10,
    aimingRadius: 1,
    watchingRadius: 2.4,
    minBeta: 0.8,
    maxBeta: 1.75,
    near: 0.002,
    far: 64,
    fov: Math.PI * 0.4,
} as const;

export const ACTIVE_RAGDOLL_BONES = ["root", "arm_r", "arm_l", "leg_r", "leg_l", "ear0_r", "ear0_l", "ear2_r", "ear2_l", "head"] as const;

export const AUDIO_FILES = [
    "bowling-ball-carpet-thump.mp3",
    "bowling-pin-hard-1.mp3",
    "bowling-pin-soft-1.mp3",
    "bowling-pin-soft-2.mp3",
    "chess-board-hard-1.mp3",
    "chess-piece-hard-1.mp3",
    "chess-piece-hard-2.mp3",
    "chess-piece-hard-3.mp3",
    "domino.mp3",
    "plastic-block-hard-1.mp3",
    "plastic-block-hard-2.mp3",
    "plastic-block-hard-3.mp3",
    "plastic-block-soft-1.mp3",
    "plastic-block-soft-2.mp3",
    "plastic-block-soft-3.mp3",
    "plastic-cup-hard-1.mp3",
    "plastic-cup-hard-2.mp3",
    "plastic-cup-hard-3.mp3",
    "plastic-cup-soft-1.mp3",
    "point-scored.mp3",
    "popper.mp3",
    "projectile-carpet-thump.mp3",
    "projectile-flight.mp3",
    "projectile-launch.mp3",
    "wood-block-hard-1.mp3",
    "wood-block-hard-2.mp3",
    "wood-block-soft-1.mp3",
    "wood-block-soft-2.mp3",
] as const;
