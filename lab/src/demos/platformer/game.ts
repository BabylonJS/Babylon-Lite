/**
 * Platformer game orchestrator — owns the world state, the fixed-timestep update,
 * and all sprite bookkeeping. Everything draws through Lite's batched 2D sprite
 * renderer; the gameplay (physics, AI, power states, scoring) is hand-rolled in
 * this `platformer/` module folder.
 *
 * Sprite slots are pre-allocated and reused: `removeSprite2DIndex` swap-removes
 * (which would renumber indices), so entities own a stable slot for the whole
 * level and are hidden with `visible:false` rather than removed.
 */

import {
    addSprite2DIndex,
    createGridSpriteAtlas,
    createSprite2DLayer,
    createSpriteRenderer,
    loadTexture2D,
    registerSpriteRenderer,
    startEngine,
    updateSprite2DIndex,
    type EngineContext,
    type Sprite2DLayer,
} from "babylon-lite";

import { loadPlatformerSheet, type PlatformerSheet } from "./atlas.js";
import { PHYS, PLAYER_FRAMES, TILE } from "./frames.js";
import { createInput, type InputController } from "./input.js";
import { createSfx, type Sfx } from "./audio.js";
import { createHud, type Hud } from "./hud.js";
import { buildLevel, type BlockKind, type Level } from "./level.js";
import { moveAndCollide, overlaps, type AABB, type CollisionMap } from "./physics.js";

const SKY = { r: 0.38, g: 0.62, b: 0.95, a: 1 } as const;
const START_TIME = 300;
const ASSET_BASE = "/platformer";

interface BlockState {
    cx: number;
    cy: number;
    kind: BlockKind;
    used: boolean;
    broken: boolean;
    slot: number;
    /** Vertical bump offset (px) when hit from below; animates back to 0. */
    bump: number;
}

interface EnemyState {
    kind: "slime" | "snail";
    box: AABB;
    vx: number;
    vy: number;
    dir: -1 | 1;
    alive: boolean;
    /** snail-only: stomped into a shell. */
    shell: boolean;
    /** shell sliding speed sign, or 0 if idle. */
    shellDir: -1 | 0 | 1;
    dying: number; // >0 = death animation countdown
    slot: number;
    animT: number;
}

interface PickupState {
    kind: "coin-pop" | "mushroom" | "star";
    box: AABB;
    vx: number;
    vy: number;
    active: boolean;
    /** coin-pop only: lifetime countdown. */
    life: number;
    slot: number;
    /** The layer this pool entry's sprite lives on (atlas-specific). */
    layer: Sprite2DLayer;
}

type Phase = "ready" | "playing" | "dying" | "complete" | "gameover";

export async function startGame(canvas: HTMLCanvasElement, engine: EngineContext): Promise<void> {
    const level = buildLevel();
    const worldW = level.cols * TILE;
    const worldH = level.rows * TILE;

    // ── Load art (one cohesive CC0 Kenney set) ────────────────────────────────
    const [players, enemies, items, tiles, ground, bgTex] = await Promise.all([
        loadPlatformerSheet(engine, `${ASSET_BASE}/players`),
        loadPlatformerSheet(engine, `${ASSET_BASE}/enemies`),
        loadPlatformerSheet(engine, `${ASSET_BASE}/items`),
        // Tile + ground sheets tessellate edge-to-edge, so use nearest filtering:
        // linear bleeds a dark fringe at frame edges → thin black seams.
        loadPlatformerSheet(engine, `${ASSET_BASE}/tiles`, { filter: "nearest" }),
        loadPlatformerSheet(engine, `${ASSET_BASE}/ground`, { filter: "nearest" }),
        loadTexture2D(engine, `${ASSET_BASE}/backgrounds/colored_grass.png`, {
            invertY: false,
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            mipMaps: false,
            minFilter: "linear",
            magFilter: "linear",
        }),
    ]);

    // ── Layers (back → front) ─────────────────────────────────────────────────
    // Frame indices are atlas-specific, so each sheet needs its own layer(s).
    const bgAtlas = createGridSpriteAtlas(bgTex, { cellWidthPx: bgTex.width, cellHeightPx: bgTex.height });
    const bgLayer = createSprite2DLayer(bgAtlas, { capacity: 12, order: 0, pivot: [0, 0] });
    const terrainLayer = createSprite2DLayer(ground.atlas, { capacity: level.terrain.length + 4, order: 1, pivot: [0, 0] });
    const blockLayer = createSprite2DLayer(tiles.atlas, { capacity: level.blocks.length + 32, order: 2, pivot: [0, 0] });
    const itemLayer = createSprite2DLayer(items.atlas, { capacity: level.coins.length + 40, order: 3, pivot: [0.5, 0.5] });
    // Mushrooms come from the *tiles* sheet, so they need a centre-pivot tiles layer.
    const shroomLayer = createSprite2DLayer(tiles.atlas, { capacity: 8, order: 4, pivot: [0.5, 0.5] });
    const enemyLayer = createSprite2DLayer(enemies.atlas, { capacity: level.enemies.length + 4, order: 5, pivot: [0.5, 1] });
    const playerLayer = createSprite2DLayer(players.atlas, { capacity: 2, order: 6, pivot: [0.5, 1] });

    const renderer = createSpriteRenderer(engine, {
        layers: [bgLayer, terrainLayer, blockLayer, itemLayer, shroomLayer, enemyLayer, playerLayer],
        clearValue: SKY,
    });
    registerSpriteRenderer(renderer);

    // ── Background: horizontally tiled copies for parallax wrap (filled in
    //    `project` so they always cover the full canvas width) ────────────────
    const bgSlots: number[] = [];
    for (let i = 0; i < 12; i++) bgSlots.push(addSprite2DIndex(bgLayer, { positionPx: [0, 0], sizePx: [10, 10], visible: false }));

    // ── Static terrain sprites (frame fixed; position re-projected each frame) ─
    const terrainSlots = level.terrain.map((t) =>
        addSprite2DIndex(terrainLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: ground.frameOf(t.name) }),
    );

    // ── Interactive blocks ────────────────────────────────────────────────────
    const blockFrame = (kind: BlockKind): number => {
        switch (kind) {
            case "brick":
                return tiles.frameOf("brickBrown");
            case "coin-block":
                return tiles.frameOf("boxItem");
            case "mushroom-block":
                return tiles.frameOf("boxItem");
            case "star-block":
                return tiles.frameOf("boxItem");
        }
    };
    const blocks: BlockState[] = level.blocks.map((b) => {
        const slot = addSprite2DIndex(blockLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: blockFrame(b.kind) });
        return { cx: b.cx, cy: b.cy, kind: b.kind, used: false, broken: false, slot, bump: 0 };
    });

    // Flag pole: a column of chain tiles from the flag down to the ground.
    const flagX = level.flag.cx;
    const poleSlots: number[] = [];
    for (let cy = level.flag.cy + 1; cy < level.rows; cy++) {
        if (level.solid[cy * level.cols + flagX]) break;
        poleSlots.push(addSprite2DIndex(blockLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: tiles.frameOf("chain") }));
    }

    // ── Coins (floating, collectible) ─────────────────────────────────────────
    const coinFrame = items.frameOf("coinGold");
    const coins = level.coins.map((c) => ({
        x: c.cx * TILE + TILE / 2,
        y: c.cy * TILE + TILE / 2,
        collected: false,
        slot: addSprite2DIndex(itemLayer, { positionPx: [0, 0], sizePx: [TILE * 0.6, TILE * 0.6], frame: coinFrame, visible: false }),
    }));

    // Flag (animated) on the items layer.
    const flagSlot = addSprite2DIndex(itemLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: items.frameOf("flagGreen1"), visible: true });

    // Pickup pools. coin-pops and stars come from the items sheet; mushrooms from
    // the tiles sheet, so each kind lives on a pool bound to the matching atlas.
    const pickups: PickupState[] = [];
    const makePool = (count: number, kind: PickupState["kind"], layer: Sprite2DLayer, frame: number): void => {
        for (let i = 0; i < count; i++) {
            pickups.push({
                kind,
                box: { x: 0, y: 0, w: TILE * 0.7, h: TILE * 0.7 },
                vx: 0,
                vy: 0,
                active: false,
                life: 0,
                slot: addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [TILE * 0.7, TILE * 0.7], frame, visible: false }),
                layer,
            });
        }
    };
    makePool(8, "coin-pop", itemLayer, coinFrame);
    makePool(4, "mushroom", shroomLayer, tiles.frameOf("mushroomRed"));
    makePool(4, "star", itemLayer, items.frameOf("star"));

    const spawnPickup = (kind: PickupState["kind"], cx: number, cy: number): void => {
        const p = pickups.find((q) => !q.active && q.kind === kind);
        if (!p) return;
        p.active = true;
        p.box.x = cx * TILE + (TILE - p.box.w) / 2;
        p.box.y = cy * TILE;
        if (kind === "coin-pop") {
            p.box.w = p.box.h = TILE * 0.6;
            p.box.x = cx * TILE + (TILE - p.box.w) / 2;
            p.vx = 0;
            p.vy = -640;
            p.life = 0.5;
            updateSprite2DIndex(p.layer, p.slot, { sizePx: [p.box.w, p.box.h], visible: true });
        } else if (kind === "mushroom") {
            p.box.w = p.box.h = TILE * 0.8;
            p.box.x = cx * TILE + (TILE - p.box.w) / 2;
            p.vx = PHYS.enemySpeed * 1.6;
            p.vy = -260;
            updateSprite2DIndex(p.layer, p.slot, { sizePx: [p.box.w, p.box.h], visible: true });
        } else {
            p.box.w = p.box.h = TILE * 0.8;
            p.box.x = cx * TILE + (TILE - p.box.w) / 2;
            p.vx = PHYS.enemySpeed * 1.4;
            p.vy = -420;
            updateSprite2DIndex(p.layer, p.slot, { sizePx: [p.box.w, p.box.h], visible: true });
        }
    };

    // ── Enemies ───────────────────────────────────────────────────────────────
    const enemyList: EnemyState[] = level.enemies.map((e) => {
        const w = TILE * 0.72;
        const h = e.kind === "snail" ? TILE * 0.62 : TILE * 0.56;
        const slot = addSprite2DIndex(enemyLayer, { positionPx: [0, 0], sizePx: [w, h], frame: enemies.frameOf(e.kind === "snail" ? "snail_move" : "slimeGreen_move"), visible: false });
        return {
            kind: e.kind,
            box: { x: e.cx * TILE + (TILE - w) / 2, y: (e.cy + 1) * TILE - h, w, h },
            vx: -PHYS.enemySpeed,
            vy: 0,
            dir: -1,
            alive: true,
            shell: false,
            shellDir: 0,
            dying: 0,
            slot,
            animT: 0,
        };
    });

    // ── Player ────────────────────────────────────────────────────────────────
    const smallSize = { w: TILE * 0.56, h: TILE * 0.82 };
    const bigSize = { w: TILE * 0.62, h: TILE * 1.42 };
    const player = {
        box: { x: 0, y: 0, w: smallSize.w, h: smallSize.h } as AABB,
        vx: 0,
        vy: 0,
        big: false,
        onGround: false,
        facing: 1 as -1 | 1,
        ducking: false,
        invuln: 0,
        star: 0,
        coyote: 0,
        jumpBuf: 0,
        animT: 0,
        alive: true,
    };
    const playerSlot = addSprite2DIndex(playerLayer, { positionPx: [0, 0], sizePx: [smallSize.w, smallSize.h], frame: players.frameOf(PLAYER_FRAMES.stand) });

    const resetPlayer = (): void => {
        player.big = false;
        player.box.w = smallSize.w;
        player.box.h = smallSize.h;
        player.box.x = level.playerSpawn.cx * TILE + (TILE - player.box.w) / 2;
        player.box.y = (level.playerSpawn.cy + 1) * TILE - player.box.h;
        player.vx = 0;
        player.vy = 0;
        player.invuln = 0;
        player.star = 0;
        player.alive = true;
        player.facing = 1;
    };
    resetPlayer();

    // ── Collision map ─────────────────────────────────────────────────────────
    const isSolid = (cx: number, cy: number): boolean => {
        if (cx < 0 || cx >= level.cols) return true; // walls at the world edges
        if (cy < 0 || cy >= level.rows) return false;
        return level.solid[cy * level.cols + cx] === 1;
    };
    const collision: CollisionMap = { cols: level.cols, rows: level.rows, isSolid };

    // ── Run-state ─────────────────────────────────────────────────────────────
    const game = { phase: "ready" as Phase, score: 0, coins: 0, lives: 3, time: START_TIME, timer: 1.6, flagAnimT: 0 };

    const sfx: Sfx = createSfx();
    const input: InputController = createInput(document.body);
    const hud: Hud = createHud(document.body);
    hud.banner("WORLD 1-1", "Get ready!");
    const resumeAudio = (): void => sfx.resume();
    window.addEventListener("pointerdown", resumeAudio, { once: false });
    window.addEventListener("keydown", resumeAudio, { once: false });

    const cam = { x: 0, y: 0 };

    // ── Helpers ───────────────────────────────────────────────────────────────
    const addScore = (n: number): void => {
        game.score += n;
    };
    const gainCoin = (): void => {
        game.coins += 1;
        addScore(200);
        sfx.coin();
        if (game.coins >= 100) {
            game.coins -= 100;
            game.lives += 1;
            sfx.oneUp();
        }
    };

    const hurtPlayer = (): void => {
        if (player.invuln > 0 || player.star > 0 || game.phase !== "playing") return;
        if (player.big) {
            player.big = false;
            const feet = player.box.y + player.box.h;
            player.box.w = smallSize.w;
            player.box.h = smallSize.h;
            player.box.y = feet - player.box.h;
            player.invuln = 1.6;
            sfx.powerDown();
        } else {
            killPlayer();
        }
    };
    const killPlayer = (): void => {
        player.alive = false;
        game.phase = "dying";
        game.timer = 1.8;
        player.vy = -760;
        sfx.die();
        updateSprite2DIndex(playerLayer, playerSlot, { frame: players.frameOf(PLAYER_FRAMES.hit) });
    };

    const growPlayer = (): void => {
        if (!player.big) {
            const feet = player.box.y + player.box.h;
            player.big = true;
            player.box.w = bigSize.w;
            player.box.h = bigSize.h;
            player.box.y = feet - player.box.h;
            sfx.powerUp();
        } else {
            addScore(1000);
        }
    };

    // Bump a block from below: return contents, flip to used/broken.
    const bumpBlock = (cx: number, cy: number): void => {
        const b = blocks.find((q) => q.cx === cx && q.cy === cy && !q.broken);
        if (!b) return;
        b.bump = 12;
        if (b.kind === "brick") {
            if (player.big) {
                b.broken = true;
                level.solid[cy * level.cols + cx] = 0;
                updateSprite2DIndex(blockLayer, b.slot, { visible: false });
                addScore(50);
                sfx.bump();
            } else {
                sfx.bump();
            }
            return;
        }
        if (b.used) {
            sfx.bump();
            return;
        }
        b.used = true;
        updateSprite2DIndex(blockLayer, b.slot, { frame: tiles.frameOf("boxItem_disabled") });
        if (b.kind === "coin-block") {
            spawnPickup("coin-pop", cx, cy - 1);
            gainCoin();
        } else if (b.kind === "mushroom-block") {
            spawnPickup("mushroom", cx, cy - 1);
            sfx.powerUp();
        } else {
            spawnPickup("star", cx, cy - 1);
            sfx.powerUp();
        }
    };

    // ── Per-frame update ──────────────────────────────────────────────────────
    const updatePlaying = (dt: number): void => {
        const s = input.state;
        // Timers
        game.time -= dt;
        if (game.time <= 0) {
            game.time = 0;
            killPlayer();
            return;
        }
        if (player.invuln > 0) player.invuln -= dt;
        if (player.star > 0) player.star -= dt;

        // Horizontal input
        const wantRun = s.run;
        const maxSpeed = wantRun ? PHYS.maxRun : PHYS.maxWalk;
        const accel = player.onGround ? (wantRun ? PHYS.runAccel : PHYS.walkAccel) : PHYS.airAccel;
        player.ducking = player.onGround && s.down && !s.left && !s.right;

        let dir = 0;
        if (s.left) dir -= 1;
        if (s.right) dir += 1;
        if (player.ducking) dir = 0;

        if (dir !== 0) {
            player.vx += dir * accel * dt;
            player.facing = dir > 0 ? 1 : -1;
            if (player.vx > maxSpeed) player.vx = maxSpeed;
            if (player.vx < -maxSpeed) player.vx = -maxSpeed;
        } else if (player.onGround) {
            const f = PHYS.groundFriction * dt;
            if (player.vx > f) player.vx -= f;
            else if (player.vx < -f) player.vx += f;
            else player.vx = 0;
        }

        // Jump (coyote-time + input buffer)
        if (player.onGround) player.coyote = PHYS.coyote;
        else player.coyote -= dt;
        if (s.jumpPressed) player.jumpBuf = PHYS.jumpBuffer;
        else player.jumpBuf -= dt;

        if (player.jumpBuf > 0 && player.coyote > 0) {
            player.vy = -PHYS.jumpSpeed;
            player.onGround = false;
            player.coyote = 0;
            player.jumpBuf = 0;
            sfx.jump();
        }

        // Gravity (variable jump height while holding)
        const g = player.vy < 0 && s.jumpHeld ? PHYS.jumpHoldGravity : PHYS.gravity;
        player.vy += g * dt;
        if (player.vy > PHYS.maxFall) player.vy = PHYS.maxFall;

        // Integrate + collide
        const res = moveAndCollide(player.box, player.vx, player.vy, dt, collision);
        player.vx = res.vx;
        player.vy = res.vy;
        player.onGround = res.onGround;
        if (res.hitCeiling && res.ceilingCell) bumpBlock(res.ceilingCell.cx, res.ceilingCell.cy);

        // Fell into a pit
        if (player.box.y > worldH + TILE) {
            killPlayer();
            return;
        }

        // Enemies
        for (const e of enemyList) {
            if (!e.alive) continue;
            updateEnemy(e, dt);
            resolveEnemyVsPlayer(e);
        }

        // Pickups
        for (const p of pickups) {
            if (!p.active) continue;
            updatePickup(p, dt);
        }

        // Coins
        for (const c of coins) {
            if (c.collected) continue;
            const cb: AABB = { x: c.x - TILE * 0.3, y: c.y - TILE * 0.3, w: TILE * 0.6, h: TILE * 0.6 };
            if (overlaps(player.box, cb)) {
                c.collected = true;
                updateSprite2DIndex(itemLayer, c.slot, { visible: false });
                gainCoin();
            }
        }

        // Goal: reach the flag column
        if (player.box.x + player.box.w * 0.5 >= flagX * TILE) {
            game.phase = "complete";
            game.timer = 3.5;
            sfx.complete();
            hud.banner("LEVEL COMPLETE", "Thanks for playing!");
        }
    };

    const updateEnemy = (e: EnemyState, dt: number): void => {
        e.animT += dt;
        if (e.dying > 0) {
            e.dying -= dt;
            if (e.dying <= 0) {
                e.alive = false;
                updateSprite2DIndex(enemyLayer, e.slot, { visible: false });
            }
            return;
        }

        // Movement
        let speed = e.kind === "snail" && e.shell ? e.shellDir * PHYS.shellSpeed : e.dir * PHYS.enemySpeed;
        if (e.shell && e.shellDir === 0) speed = 0;
        e.vx = speed;
        e.vy += PHYS.gravity * dt;
        if (e.vy > PHYS.maxFall) e.vy = PHYS.maxFall;

        const res = moveAndCollide(e.box, e.vx, e.vy, dt, collision);
        e.vy = res.vy;
        if (res.hitWall !== 0) {
            if (e.shell && e.shellDir !== 0) {
                e.shellDir = (-e.shellDir) as -1 | 1;
                sfx.bump();
            } else {
                e.dir = (-e.dir) as -1 | 1;
            }
        }

        // Ledge avoidance for walkers (not sliding shells)
        if (res.onGround && !(e.shell && e.shellDir !== 0)) {
            const aheadX = e.dir > 0 ? e.box.x + e.box.w + 2 : e.box.x - 2;
            const footCy = Math.floor((e.box.y + e.box.h + 4) / TILE);
            const aheadCx = Math.floor(aheadX / TILE);
            if (!isSolid(aheadCx, footCy)) e.dir = (-e.dir) as -1 | 1;
        }

        // Pit death
        if (e.box.y > worldH + TILE) {
            e.alive = false;
            updateSprite2DIndex(enemyLayer, e.slot, { visible: false });
            return;
        }

        // Shell-vs-walker kills
        if (e.shell && e.shellDir !== 0) {
            for (const o of enemyList) {
                if (o === e || !o.alive || o.dying > 0) continue;
                if (overlaps(e.box, o.box)) {
                    o.dying = 0.4;
                    o.vy = -360;
                    updateSprite2DIndex(enemyLayer, o.slot, { frame: enemies.frameOf(o.kind === "snail" ? "snail_move" : "slimeGreen_dead"), flipY: true });
                    addScore(200);
                    sfx.kick();
                }
            }
        }
    };

    const resolveEnemyVsPlayer = (e: EnemyState): void => {
        if (!player.alive || e.dying > 0) return;
        if (!overlaps(player.box, e.box)) return;

        const stomping = player.vy > 0 && player.box.y + player.box.h - e.box.y < TILE * 0.5;

        if (player.star > 0) {
            e.dying = 0.4;
            e.vy = -360;
            updateSprite2DIndex(enemyLayer, e.slot, { frame: enemies.frameOf(e.kind === "snail" ? "snail_move" : "slimeGreen_dead"), flipY: true });
            addScore(200);
            sfx.kick();
            return;
        }

        if (stomping) {
            player.vy = -PHYS.stompBounce;
            player.box.y = e.box.y - player.box.h;
            if (e.kind === "snail" && !e.shell) {
                e.shell = true;
                e.shellDir = 0;
                e.box.h = TILE * 0.5;
                e.box.y = (Math.floor((e.box.y + e.box.h) / TILE) + 1) * TILE - e.box.h;
                updateSprite2DIndex(enemyLayer, e.slot, { frame: enemies.frameOf("snail_shell"), sizePx: [e.box.w, e.box.h] });
                addScore(100);
                sfx.stomp();
            } else if (e.kind === "snail" && e.shell) {
                // Kick a resting shell, or stop a moving one.
                e.shellDir = e.shellDir === 0 ? (player.facing as -1 | 1) : 0;
                addScore(100);
                sfx.kick();
            } else {
                e.dying = 0.35;
                updateSprite2DIndex(enemyLayer, e.slot, { frame: enemies.frameOf("slimeGreen_dead"), sizePx: [e.box.w, e.box.h * 0.6] });
                addScore(100);
                sfx.stomp();
            }
            return;
        }

        // A resting shell that the player walks into gets kicked, not hurt.
        if (e.kind === "snail" && e.shell && e.shellDir === 0) {
            e.shellDir = player.box.x < e.box.x ? 1 : -1;
            addScore(100);
            sfx.kick();
            return;
        }

        hurtPlayer();
    };

    const updatePickup = (p: PickupState, dt: number): void => {
        if (p.kind === "coin-pop") {
            p.box.y += p.vy * dt;
            p.vy += PHYS.gravity * 1.4 * dt;
            p.life -= dt;
            if (p.life <= 0) {
                p.active = false;
                updateSprite2DIndex(p.layer, p.slot, { visible: false });
            }
            return;
        }
        // Mushroom / star: gravity + ground/wall bounce
        p.vy += PHYS.gravity * dt;
        if (p.vy > PHYS.maxFall) p.vy = PHYS.maxFall;
        const res = moveAndCollide(p.box, p.vx, p.vy, dt, collision);
        p.vy = res.vy;
        if (res.hitWall !== 0) p.vx = -p.vx;
        if (p.kind === "star" && res.onGround) p.vy = -560; // star hops
        if (overlaps(player.box, p.box)) {
            p.active = false;
            updateSprite2DIndex(p.layer, p.slot, { visible: false });
            if (p.kind === "mushroom") {
                growPlayer();
                addScore(1000);
            } else {
                player.star = 8;
                sfx.powerUp();
                addScore(1000);
            }
        } else if (p.box.y > worldH + TILE) {
            p.active = false;
            updateSprite2DIndex(p.layer, p.slot, { visible: false });
        }
    };

    // ── Rendering projection ──────────────────────────────────────────────────
    const project = (): void => {
        const cw = canvas.width || 1;
        const ch = canvas.height || 1;
        const scale = ch / worldH;
        const viewW = cw / scale;
        // Camera follows the player, clamped to the level.
        const targetX = player.box.x + player.box.w / 2 - viewW / 2;
        cam.x = Math.max(0, Math.min(worldW - viewW, targetX));
        cam.y = 0;

        const sx = (wx: number): number => (wx - cam.x) * scale;
        const sy = (wy: number): number => (wy - cam.y) * scale;
        const ss = (w: number): number => w * scale;
        // Snap a whole tile to the integer device-pixel grid so adjacent tiles
        // tessellate exactly (no sub-pixel gap, no dark seam). Right/bottom edges
        // are derived from the *next* tile's snapped origin, not a rounded size.
        const snapTile = (cx: number, cy: number, yOffsetPx = 0): { pos: [number, number]; size: [number, number] } => {
            const x0 = Math.round(sx(cx * TILE));
            const x1 = Math.round(sx((cx + 1) * TILE));
            const y0 = Math.round(sy(cy * TILE) - yOffsetPx);
            const y1 = Math.round(sy((cy + 1) * TILE) - yOffsetPx);
            return { pos: [x0, y0], size: [x1 - x0, y1 - y0] };
        };

        // Background parallax: tile enough copies to span the whole canvas.
        const bgW = ch * (bgTex.width / bgTex.height);
        const scroll = cam.x * 0.35;
        const first = Math.floor(scroll / bgW);
        const needed = Math.ceil(cw / bgW) + 2;
        for (let i = 0; i < bgSlots.length; i++) {
            if (i < needed) {
                const x = (first + i) * bgW - scroll;
                // +1px width overlap hides any sub-pixel seam between copies.
                updateSprite2DIndex(bgLayer, bgSlots[i]!, { positionPx: [x, 0], sizePx: [bgW + 1, ch], visible: true });
            } else {
                updateSprite2DIndex(bgLayer, bgSlots[i]!, { visible: false });
            }
        }

        // Terrain
        for (let i = 0; i < terrainSlots.length; i++) {
            const t = level.terrain[i]!;
            const s = snapTile(t.cx, t.cy);
            updateSprite2DIndex(terrainLayer, terrainSlots[i]!, { positionPx: s.pos, sizePx: s.size });
        }

        // Blocks (with bump offset)
        for (const b of blocks) {
            if (b.broken) continue;
            if (b.bump > 0) b.bump = Math.max(0, b.bump - 1.4);
            const s = snapTile(b.cx, b.cy, b.bump * scale);
            updateSprite2DIndex(blockLayer, b.slot, { positionPx: s.pos, sizePx: s.size });
        }
        // Flag pole
        for (let i = 0; i < poleSlots.length; i++) {
            const cy = level.flag.cy + 1 + i;
            const s = snapTile(flagX, cy);
            updateSprite2DIndex(blockLayer, poleSlots[i]!, { positionPx: s.pos, sizePx: s.size });
        }

        // Coins (bob)
        const bob = Math.sin(game.flagAnimT * 6) * TILE * 0.06;
        for (const c of coins) {
            if (c.collected) continue;
            updateSprite2DIndex(itemLayer, c.slot, { positionPx: [sx(c.x), sy(c.y + bob)], sizePx: [ss(TILE * 0.6), ss(TILE * 0.6)], visible: true });
        }
        // Flag wave. The flag sprite's pole runs up its far-left edge (centre at
        // ~0.07 of the sprite width), so with a centre pivot we shift right by
        // ~0.43·TILE to sit the pole over the centred chain column.
        const flagName = Math.floor(game.flagAnimT * 6) % 2 === 0 ? "flagGreen1" : "flagGreen2";
        updateSprite2DIndex(itemLayer, flagSlot, {
            positionPx: [sx(flagX * TILE + TILE * 0.93), sy(level.flag.cy * TILE + TILE * 0.5)],
            sizePx: [ss(TILE), ss(TILE)],
            frame: items.frameOf(flagName),
        });

        // Pickups
        for (const p of pickups) {
            if (!p.active) continue;
            updateSprite2DIndex(p.layer, p.slot, {
                positionPx: [sx(p.box.x + p.box.w / 2), sy(p.box.y + p.box.h / 2)],
                sizePx: [ss(p.box.w), ss(p.box.h)],
            });
        }

        // Enemies
        for (const e of enemyList) {
            if (!e.alive) continue;
            let frame: number;
            if (e.shell) frame = enemies.frameOf("snail_shell");
            else if (e.kind === "snail") frame = enemies.frameOf(Math.floor(e.animT * 6) % 2 === 0 ? "snail_move" : "snail");
            else frame = enemies.frameOf(Math.floor(e.animT * 6) % 2 === 0 ? "slimeGreen_move" : "slimeGreen");
            updateSprite2DIndex(enemyLayer, e.slot, {
                positionPx: [sx(e.box.x + e.box.w / 2), sy(e.box.y + e.box.h)],
                sizePx: [ss(e.box.w), ss(e.box.h)],
                frame,
                visible: true,
                flipX: e.dir > 0,
            });
        }

        // Player
        let pf: string = PLAYER_FRAMES.stand;
        if (!player.alive) pf = PLAYER_FRAMES.hit;
        else if (player.ducking) pf = PLAYER_FRAMES.duck;
        else if (!player.onGround) pf = PLAYER_FRAMES.jump;
        else if (Math.abs(player.vx) > 20) pf = Math.floor(player.animT * 12) % 2 === 0 ? PLAYER_FRAMES.walk1 : PLAYER_FRAMES.walk2;
        const flashHide = player.invuln > 0 && Math.floor(player.invuln * 16) % 2 === 0;
        const starTint: [number, number, number, number] | undefined =
            player.star > 0 ? [1, 0.6 + 0.4 * Math.sin(game.flagAnimT * 20), 0.4, 1] : undefined;
        updateSprite2DIndex(playerLayer, playerSlot, {
            positionPx: [sx(player.box.x + player.box.w / 2), sy(player.box.y + player.box.h)],
            sizePx: [ss(player.box.w * 1.12), ss(player.box.h)],
            frame: players.frameOf(pf),
            flipX: player.facing < 0,
            visible: !flashHide,
            color: starTint ?? [1, 1, 1, 1],
        });
    };

    // ── Main loop ─────────────────────────────────────────────────────────────
    await startEngine(engine);

    let last = performance.now();
    const tick = (now: number): void => {
        const dt = Math.min(1 / 30, (now - last) / 1000);
        last = now;
        game.flagAnimT += dt;
        player.animT += dt;

        switch (game.phase) {
            case "ready":
                game.timer -= dt;
                if (game.timer <= 0) {
                    game.phase = "playing";
                    hud.banner(null);
                }
                break;
            case "playing":
                updatePlaying(dt);
                break;
            case "dying":
                player.vy += PHYS.gravity * dt;
                player.box.y += player.vy * dt;
                game.timer -= dt;
                if (game.timer <= 0) {
                    game.lives -= 1;
                    if (game.lives <= 0) {
                        game.phase = "gameover";
                        hud.banner("GAME OVER", "Press Enter / tap A to retry");
                    } else {
                        game.phase = "ready";
                        game.timer = 1.4;
                        game.time = START_TIME;
                        resetPlayer();
                        for (const e of enemyList) respawnEnemy(e);
                        for (const p of pickups) {
                            p.active = false;
                            updateSprite2DIndex(p.layer, p.slot, { visible: false });
                        }
                        updateSprite2DIndex(playerLayer, playerSlot, { frame: players.frameOf(PLAYER_FRAMES.stand) });
                        hud.banner("WORLD 1-1", "Get ready!");
                    }
                }
                break;
            case "complete":
                game.timer -= dt;
                player.box.x += 120 * dt; // stroll off
                break;
            case "gameover":
                if (input.state.startPressed) restartLevel();
                break;
        }

        project();
        hud.update({ score: game.score, coins: game.coins, lives: game.lives, time: game.time, world: "1-1" });
        input.endFrame();
        requestAnimationFrame(tick);
    };

    const respawnEnemy = (e: EnemyState): void => {
        const src = level.enemies.find((_, i) => enemyList[i] === e);
        if (!src) return;
        const w = TILE * 0.72;
        const h = src.kind === "snail" ? TILE * 0.62 : TILE * 0.56;
        e.box = { x: src.cx * TILE + (TILE - w) / 2, y: (src.cy + 1) * TILE - h, w, h };
        e.alive = true;
        e.shell = false;
        e.shellDir = 0;
        e.dying = 0;
        e.dir = -1;
        e.vx = -PHYS.enemySpeed;
        e.vy = 0;
    };

    const restartLevel = (): void => {
        game.score = 0;
        game.coins = 0;
        game.lives = 3;
        game.time = START_TIME;
        game.phase = "ready";
        game.timer = 1.4;
        resetPlayer();
        for (const b of blocks) {
            b.used = false;
            b.broken = false;
            b.bump = 0;
            if (b.kind !== "brick") level.solid[b.cy * level.cols + b.cx] = 1;
            updateSprite2DIndex(blockLayer, b.slot, { frame: blockFrame(b.kind), visible: true });
        }
        for (const c of coins) {
            c.collected = false;
            updateSprite2DIndex(itemLayer, c.slot, { visible: true });
        }
        for (const e of enemyList) respawnEnemy(e);
        for (const p of pickups) {
            p.active = false;
            updateSprite2DIndex(p.layer, p.slot, { visible: false });
        }
        updateSprite2DIndex(playerLayer, playerSlot, { frame: players.frameOf(PLAYER_FRAMES.stand) });
        hud.banner("WORLD 1-1", "Get ready!");
    };

    requestAnimationFrame(tick);
    canvas.dataset.ready = "true";
}

// Keep an explicit reference so unused-import linters see the sheet types.
export type { PlatformerSheet, Level, Sprite2DLayer };
