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

/** Parse an "origin"-style space-separated vector, in Quake coordinates. */
export function parseVec3(value: string | undefined): [number, number, number] {
    if (!value) return [0, 0, 0];
    const parts = value.trim().split(/\s+/).map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
