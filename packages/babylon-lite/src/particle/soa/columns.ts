/**
 * Shared feature-column names for the data-oriented particle runtime — SPIKE.
 *
 * Contextual sources (readers) and blocks (writers) must agree on column names so they resolve the same
 * `column()` on a buffer. Base columns (position, direction, age, lifeTime, id) live on {@link ParticleBuffer}
 * directly; everything here is a feature column, allocated on demand only when a graph references it — so a
 * system that never uses colour, size, etc. allocates none of them.
 */
export const COL_SIZE = "size";
export const COL_ANGLE = "angle";
export const COL_SCALE_X = "scale.x";
export const COL_SCALE_Y = "scale.y";

export const COL_COLOR_R = "color.r";
export const COL_COLOR_G = "color.g";
export const COL_COLOR_B = "color.b";
export const COL_COLOR_A = "color.a";

export const COL_COLOR_STEP_R = "colorStep.r";
export const COL_COLOR_STEP_G = "colorStep.g";
export const COL_COLOR_STEP_B = "colorStep.b";
export const COL_COLOR_STEP_A = "colorStep.a";
