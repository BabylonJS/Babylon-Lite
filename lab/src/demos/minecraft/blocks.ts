// Block registry: numeric ids -> visual + behavioral properties. Face textures
// reference tile names from the Kenney Voxel Pack (see atlas.ts). Flags are split
// per the design review so culling, AO, collision and render-mode are independent.

export const enum Block {
    AIR = 0,
    STONE = 1,
    DIRT = 2,
    GRASS = 3,
    SAND = 4,
    SNOW = 5,
    WATER = 6,
    LOG = 7,
    LEAVES = 8,
    PLANKS = 9,
    GLASS = 10,
    BRICK = 11,
    COAL_ORE = 12,
    IRON_ORE = 13,
    GOLD_ORE = 14,
    DIAMOND_ORE = 15,
    GRAVEL = 16,
    ICE = 17,
    CACTUS = 18,
    BEDROCK = 19,
    WOOL_RED = 20,
    WOOL_GREEN = 21,
    WOOL_BLUE = 22,
    GLOWSTONE = 23,
}

export type RenderMode = "opaque" | "cutout" | "blend";

export interface BlockDef {
    id: Block;
    name: string;
    /** Tile names for the three face groups. side is used for the 4 lateral faces. */
    faces: { top: string; side: string; bottom: string };
    renderMode: RenderMode;
    /** Fully hides the touching face of an opaque neighbor (and is itself hidden by opaque neighbors). */
    hidesNeighborFaces: boolean;
    /** Contributes to ambient-occlusion darkening of adjacent geometry. */
    castsAO: boolean;
    /** Blocks player movement (creative walk mode). */
    collidable: boolean;
    /** Liquid: rendered translucent, non-collidable, slightly lowered top. */
    fluid: boolean;
    /** Foliage that sways gently in the wind (leaves). */
    sway: boolean;
    /** Light emitted by this block, 0..15 (0 = not a light source). */
    light: number;
    /** Cannot be broken or replaced by the player (e.g. bedrock world floor). */
    indestructible: boolean;
}

function def(id: Block, name: string, faces: Partial<BlockDef["faces"]> & { all?: string }, opts: Partial<BlockDef> = {}): BlockDef {
    const all = faces.all ?? "stone";
    return {
        id,
        name,
        faces: { top: faces.top ?? all, side: faces.side ?? all, bottom: faces.bottom ?? all },
        renderMode: opts.renderMode ?? "opaque",
        hidesNeighborFaces: opts.hidesNeighborFaces ?? true,
        castsAO: opts.castsAO ?? true,
        collidable: opts.collidable ?? true,
        fluid: opts.fluid ?? false,
        sway: opts.sway ?? false,
        light: opts.light ?? 0,
        indestructible: opts.indestructible ?? false,
    };
}

const DEFS: Record<number, BlockDef> = {
    [Block.STONE]: def(Block.STONE, "Stone", { all: "stone" }),
    [Block.DIRT]: def(Block.DIRT, "Dirt", { all: "dirt" }),
    [Block.GRASS]: def(Block.GRASS, "Grass", { top: "grass_top", side: "dirt_grass", bottom: "dirt" }),
    [Block.SAND]: def(Block.SAND, "Sand", { all: "sand" }),
    [Block.SNOW]: def(Block.SNOW, "Snow", { top: "snow", side: "dirt_snow", bottom: "dirt" }),
    [Block.WATER]: def(Block.WATER, "Water", { all: "water" }, { renderMode: "blend", hidesNeighborFaces: false, castsAO: false, collidable: false, fluid: true }),
    [Block.LOG]: def(Block.LOG, "Wood Log", { top: "trunk_top", side: "trunk_side", bottom: "trunk_top" }),
    [Block.LEAVES]: def(Block.LEAVES, "Leaves", { all: "leaves_transparent" }, { renderMode: "cutout", hidesNeighborFaces: false, castsAO: false, sway: true }),
    [Block.PLANKS]: def(Block.PLANKS, "Planks", { all: "wood" }),
    [Block.GLASS]: def(Block.GLASS, "Glass", { all: "glass" }, { renderMode: "blend", hidesNeighborFaces: false, castsAO: false }),
    [Block.BRICK]: def(Block.BRICK, "Brick", { all: "brick_red" }),
    [Block.COAL_ORE]: def(Block.COAL_ORE, "Coal Ore", { all: "stone_coal" }),
    [Block.IRON_ORE]: def(Block.IRON_ORE, "Iron Ore", { all: "stone_iron" }),
    [Block.GOLD_ORE]: def(Block.GOLD_ORE, "Gold Ore", { all: "stone_gold" }),
    [Block.DIAMOND_ORE]: def(Block.DIAMOND_ORE, "Diamond Ore", { all: "stone_diamond" }),
    [Block.GRAVEL]: def(Block.GRAVEL, "Gravel", { all: "gravel_stone" }),
    [Block.ICE]: def(Block.ICE, "Ice", { all: "ice" }, { renderMode: "blend", hidesNeighborFaces: false, castsAO: false }),
    [Block.CACTUS]: def(Block.CACTUS, "Cactus", { top: "cactus_top", side: "cactus_side", bottom: "cactus_top" }, { renderMode: "cutout", hidesNeighborFaces: false }),
    [Block.BEDROCK]: def(Block.BEDROCK, "Bedrock", { all: "greystone" }, { indestructible: true }),
    [Block.WOOL_RED]: def(Block.WOOL_RED, "Red Wool", { all: "cotton_red" }),
    [Block.WOOL_GREEN]: def(Block.WOOL_GREEN, "Green Wool", { all: "cotton_green" }),
    [Block.WOOL_BLUE]: def(Block.WOOL_BLUE, "Blue Wool", { all: "cotton_blue" }),
    [Block.GLOWSTONE]: def(Block.GLOWSTONE, "Glowstone", { all: "lava" }, { light: 15 }),
};

export function blockDef(id: number): BlockDef | undefined {
    return DEFS[id];
}

// Representative average colour per block (0..1 rgb), used to tint break particles.
const BLOCK_COLORS: Record<number, [number, number, number]> = {
    [Block.STONE]: [0.5, 0.5, 0.5],
    [Block.DIRT]: [0.45, 0.32, 0.2],
    [Block.GRASS]: [0.35, 0.6, 0.25],
    [Block.SAND]: [0.85, 0.78, 0.5],
    [Block.SNOW]: [0.92, 0.95, 0.98],
    [Block.WATER]: [0.25, 0.45, 0.85],
    [Block.LOG]: [0.45, 0.33, 0.2],
    [Block.LEAVES]: [0.25, 0.5, 0.2],
    [Block.PLANKS]: [0.7, 0.55, 0.35],
    [Block.GLASS]: [0.7, 0.85, 0.9],
    [Block.BRICK]: [0.7, 0.3, 0.25],
    [Block.COAL_ORE]: [0.3, 0.3, 0.3],
    [Block.IRON_ORE]: [0.7, 0.6, 0.5],
    [Block.GOLD_ORE]: [0.85, 0.75, 0.35],
    [Block.DIAMOND_ORE]: [0.5, 0.8, 0.85],
    [Block.GRAVEL]: [0.5, 0.48, 0.46],
    [Block.ICE]: [0.7, 0.85, 0.95],
    [Block.CACTUS]: [0.3, 0.5, 0.25],
    [Block.BEDROCK]: [0.25, 0.25, 0.25],
    [Block.WOOL_RED]: [0.8, 0.2, 0.2],
    [Block.WOOL_GREEN]: [0.3, 0.7, 0.3],
    [Block.WOOL_BLUE]: [0.25, 0.4, 0.8],
    [Block.GLOWSTONE]: [1.0, 0.78, 0.4],
};

/** Representative colour for a block, used to tint break particles. */
export function blockColor(id: number): [number, number, number] {
    return BLOCK_COLORS[id] ?? [0.6, 0.6, 0.6];
}

export function isAir(id: number): boolean {
    return id === Block.AIR;
}

/** True if a block cannot be broken or replaced by the player (e.g. bedrock). */
export function isIndestructible(id: number): boolean {
    return DEFS[id]?.indestructible === true;
}

/** Light emitted by a block (0..15). Air and non-source blocks emit 0. */
export function blockLight(id: number): number {
    return DEFS[id]?.light ?? 0;
}

/** True if a block fully blocks light propagation (solid opaque blocks). Air and
 *  transparent blocks (water/glass/leaves/ice/cactus) let light pass. */
export function lightOpaque(id: number): boolean {
    return DEFS[id]?.hidesNeighborFaces === true;
}

/** Every tile name referenced by any block — used to build the atlas. */
export function allReferencedTiles(): string[] {
    const set = new Set<string>();
    for (const id of Object.keys(DEFS)) {
        const d = DEFS[Number(id)];
        if (!d) continue;
        set.add(d.faces.top);
        set.add(d.faces.side);
        set.add(d.faces.bottom);
    }
    return [...set];
}

/** The blocks offered in the creative hotbar, in slot order. */
export const HOTBAR: Block[] = [
    Block.GRASS,
    Block.DIRT,
    Block.STONE,
    Block.SAND,
    Block.LOG,
    Block.PLANKS,
    Block.LEAVES,
    Block.GLASS,
    Block.BRICK,
    Block.GLOWSTONE,
];
