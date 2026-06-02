// Parses the Quake BSP ENTITIES lump: a flat text block of brace-delimited
// entity definitions, each a set of "key" "value" pairs. Example:
//   {
//   "classname" "info_player_start"
//   "origin" "480 -352 88"
//   "angle" "90"
//   }

export type QuakeEntity = Record<string, string>;

export function parseEntities(text: string): QuakeEntity[] {
    const entities: QuakeEntity[] = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        // Seek the next entity opening brace.
        while (i < n && text[i] !== "{") i++;
        if (i >= n) break;
        i++; // consume '{'
        const ent: QuakeEntity = {};
        while (i < n && text[i] !== "}") {
            // Read a quoted key.
            while (i < n && text[i] !== '"' && text[i] !== "}") i++;
            if (i >= n || text[i] === "}") break;
            i++; // opening quote
            let key = "";
            while (i < n && text[i] !== '"') key += text[i++];
            i++; // closing quote
            // Read a quoted value.
            while (i < n && text[i] !== '"') i++;
            i++; // opening quote
            let value = "";
            while (i < n && text[i] !== '"') value += text[i++];
            i++; // closing quote
            if (key) ent[key] = value;
        }
        i++; // consume '}'
        entities.push(ent);
    }
    return entities;
}

// Standard Quake spawnflag bits that exclude an entity from a game mode.
export const SPAWNFLAG_NOT_EASY = 256;
export const SPAWNFLAG_NOT_NORMAL = 512;
export const SPAWNFLAG_NOT_HARD = 1024;
export const SPAWNFLAG_NOT_DEATHMATCH = 2048;

/**
 * Mirror Quake's ED_LoadFromFile entity culling: before any entity spawns, the
 * engine discards those whose spawnflags exclude the active skill (single-player)
 * or deathmatch. This is not cosmetic — e.g. lq_e1m1 seals the single-player start
 * with deathmatch-only func_walls (spawnflags NOT_EASY|NOT_NORMAL|NOT_HARD); without
 * this cull they remain solid and the player cannot leave the spawn box.
 */
export function filterEntitiesBySkill(entities: QuakeEntity[], skill: number, deathmatch = false): QuakeEntity[] {
    return entities.filter((e) => {
        const flags = Number(e.spawnflags) || 0;
        if (deathmatch) return (flags & SPAWNFLAG_NOT_DEATHMATCH) === 0;
        if (skill <= 0) return (flags & SPAWNFLAG_NOT_EASY) === 0;
        if (skill === 1) return (flags & SPAWNFLAG_NOT_NORMAL) === 0;
        return (flags & SPAWNFLAG_NOT_HARD) === 0;
    });
}

/** Parse an "origin"-style space-separated vector, in Quake coordinates. */
export function parseVec3(value: string | undefined): [number, number, number] {
    if (!value) return [0, 0, 0];
    const parts = value.trim().split(/\s+/).map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
