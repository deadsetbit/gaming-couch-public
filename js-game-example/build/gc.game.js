/**
 * gc.game.js — the required entry point for a Gaming Couch JavaScript game.
 *
 * Gaming Couch loads this module and calls the four lifecycle hooks on its
 * default export (setup, play, inputs, pause), passing in *contexts* with the
 * data each one needs. Your game needs no extra library and makes no outside
 * requests — it only consumes what it is handed.
 *
 * The example game is intentionally tiny but real: every player drives a colored
 * dot around an arena that is bigger than the screen; a camera follows the pack.
 * Collect the seeded coin to score (each pickup briefly SLOWS you), first to TARGET
 * wins — but a bomb periodically detonates, and anyone caught in the blast (harder to
 * escape while slowed) is eliminated for the round.
 *
 * It exercises the whole contract surface a game touches:
 *   - players, colors, the deterministic seed, controller inputs, pause, gameOver
 *   - hud.setup() value + meter types
 *   - hud.updatePlayers(): placement, `value` (score as points), `meter` (the coin
 *     slowdown draining down while active), `eliminated`
 *   - hud.updateScreenPoints(): `playerOverhead` (nametag anchor) AND `playerPosition`
 *     (the off-screen edge indicator — meaningful only because the world is larger
 *     than the viewport, so players actually leave the screen)
 */

// First player to reach this score ends the round.
const TARGET = 5;

// Visual sizes (in world pixels — see the world/camera note below).
const PLAYER_RADIUS = 36;
const COIN_RADIUS = 14;
const COIN_COLOR = "#ffd34d";
const PLAYER_SPEED = 3; // px per frame at full stick deflection
const OVERHEAD_OFFSET = 14; // world px above the head to anchor the overhead nametag

// Off-screen coin indicator: when the coin scrolls out of view the game draws an edge
// arrow (in screen space, in the coin's color) pointing toward it. The arrow is inset
// from the screen edges so it never hides under the platform HUD — a LOT more on the
// LEFT, where the scoreboard sits, and enough at the TOP to clear the status row.
const ARROW_INSET_LEFT = 210;
const ARROW_INSET_TOP = 96;
const ARROW_INSET_RIGHT = 44;
const ARROW_INSET_BOTTOM = 44;
const ARROW_SIZE = 20; // arrowhead half-length in screen px

// Slowdown penalty: collecting a coin briefly slows you down, and the HUD `meter` shows
// the remaining slow time draining from 100 back to 0 (it rests at 0, an empty bar, when
// not slowed). That makes `meter` an independent quantity from the `value` (score) — and
// a real risk/reward, since a slowed player can't flee a bomb as easily.
const SLOW_DURATION_FRAMES = 90; // ~1.5s of slowdown per coin (~60fps)
const SLOW_SPEED_FACTOR = 0.4; // move at 40% speed while slowed

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ── World & camera ──────────────────────────────────────────────────────────
// The play field (the "world") is deliberately LARGER than the visible viewport,
// and a camera follows the centroid of the living players. That is what makes the
// off-screen `playerPosition` HUD indicator meaningful: in a screen-sized arena no
// one is ever off-screen, so the platform would never draw the edge indicator. The
// world is sized as a multiple of the viewport (with a floor) so there is always
// off-screen room no matter the screen size.
const WORLD_SCALE = 1.7; // world is this * viewport in each axis…
const WORLD_MIN_W = 2200; // …but never smaller than this
const WORLD_MIN_H = 1500;
const WORLD_MARGIN = 60; // keep coins/bombs off the very edge
const CAM_LERP = 0.08; // how quickly the camera eases toward the pack (0..1)

// ── Bomb hazard (the elimination mechanic) ──────────────────────────────────
// A bomb spawns near the pack, telegraphs with a fuse + a growing danger ring, then
// detonates. Anyone still inside the blast when it goes off is eliminated for the
// rest of the round (frozen, and flagged `eliminated` in the HUD). After it blows,
// a cooldown passes before the next one spawns.
const BOMB_FUSE_FRAMES = 120; // ~2s telegraph before detonation (~60fps)
const BOMB_COOLDOWN_FRAMES = 150; // ~2.5s between bombs
const BOMB_BLAST_RADIUS = 150; // world px; a player within this is caught
const BOMB_CORE_RADIUS = 18; // the bomb's solid core (visual)
const BOMB_JITTER = 220; // how far from the pack centroid a bomb can land

// Bot tuning. Bots (players whose PlayerGameData.type is "bot") are driven by the
// game itself — the platform sends no controller input for them. Each frame a bot
// steers toward the coin but blends in a little wander, so it drifts off course and
// misses sometimes, which reads as more human than a perfect beeline. Bots also flee
// an armed bomb so they don't walk into an obvious death.
const BOT_WANDER = 0.4; // 0 = laser-perfect to coin, 1 = pure aimless wander
const BOT_WANDER_TURN = 0.5; // max radians the wander heading drifts per frame
const BOT_FLEE_MARGIN = 70; // start fleeing when this close to the blast edge
// When a coin (re)spawns, a bot wanders aimlessly for a beat — like it's spotting the
// coin — before charging it, so it doesn't snap over instantly. In frames (~60/s, the
// same per-frame basis as the speeds above): ~0.25s to ~1s.
const BOT_REACTION_MIN_FRAMES = 15;
const BOT_REACTION_MAX_FRAMES = 60;

/**
 * Module-level game state. It is created fresh in play() and read by the raf
 * loop, inputs() and pause(). `null` until a round starts.
 */
let game = null;

/**
 * The canvas/ctx are created in setup() (before we know the players) and reused
 * by each round's `game` state built in play(). Kept module-level so both hooks
 * can reach them.
 */
let stage = null;

/**
 * mulberry32 — a tiny deterministic PRNG seeded from playContext.seed. Using a
 * seeded PRNG (never Math.random) means the coin/bomb sequence is identical for
 * every client in a match, which is what the platform's `seed` is for.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every player still in the round (not eliminated). */
function livingPlayers() {
  return [...game.players.values()].filter((p) => !p.eliminated);
}

/** Centroid of the living players, in world coords — what the camera follows. */
function livingCentroid() {
  const living = livingPlayers();
  if (living.length === 0) {
    return { x: game.world.w / 2, y: game.world.h / 2 };
  }
  let x = 0;
  let y = 0;
  for (const p of living) {
    x += p.x;
    y += p.y;
  }
  return { x: x / living.length, y: y / living.length };
}

/**
 * Players ranked best→worst. Living players rank above eliminated ones; among the
 * living the higher score wins, and among the eliminated whoever went out LATER
 * ranks higher. This single ordering drives both the HUD placement and the final
 * gameOver placement array.
 */
function rankedPlayers() {
  return [...game.players.values()].sort((a, b) => {
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
    if (a.eliminated) return b.eliminationOrder - a.eliminationOrder;
    return b.score - a.score;
  });
}

/** Place (or respawn) the coin at the next seeded position inside the world. */
function respawnCoin() {
  const { world, rng, coin, botRng } = game;
  coin.x = WORLD_MARGIN + rng() * (world.w - WORLD_MARGIN * 2);
  coin.y = WORLD_MARGIN + rng() * (world.h - WORLD_MARGIN * 2);

  // Give each bot a brief, randomized "spotting" delay before it charges the new coin.
  const span = BOT_REACTION_MAX_FRAMES - BOT_REACTION_MIN_FRAMES;
  for (const p of game.players.values()) {
    if (p.isBot) p.chargeDelay = BOT_REACTION_MIN_FRAMES + botRng() * span;
  }
}

/**
 * Convert a world point to the platform's normalized screen coordinates: x 0..1
 * left→right, y 0..1 BOTTOM→top (note the flip). `isOffScreen` is true when the
 * point falls outside the visible viewport — that is the flag the platform uses to
 * decide whether to draw the off-screen edge indicator for a `playerPosition`.
 */
function worldToScreen(wx, wy) {
  const { canvas, cam } = game;
  const sx = (wx - cam.x) / canvas.width; // 0..1 left→right
  const syTop = (wy - cam.y) / canvas.height; // 0..1 top→bottom
  return {
    x: sx,
    y: 1 - syTop, // the HUD wants y 0..1 bottom→top
    isOffScreen: sx < 0 || sx > 1 || syTop < 0 || syTop > 1,
  };
}

/** Ease the camera toward the pack centroid, clamped so it never shows past the world. */
function updateCamera() {
  const { canvas, world, cam } = game;
  const c = livingCentroid();
  const maxX = Math.max(0, world.w - canvas.width);
  const maxY = Math.max(0, world.h - canvas.height);
  const targetX = clamp(c.x - canvas.width / 2, 0, maxX);
  const targetY = clamp(c.y - canvas.height / 2, 0, maxY);
  if (!cam.initialized) {
    // Snap on the first frame so the round doesn't open with a camera swoop.
    cam.x = targetX;
    cam.y = targetY;
    cam.initialized = true;
  } else {
    cam.x += (targetX - cam.x) * CAM_LERP;
    cam.y += (targetY - cam.y) * CAM_LERP;
  }
}

/**
 * Steer one bot for this frame and RETURN its {a0,a1} stick vector. If an armed bomb
 * is close it runs straight away from it; otherwise it heads for the coin with some
 * wander mixed in, normalized to full-stick magnitude (so bots move at player speed,
 * they just don't always aim straight). Randomness comes from the seeded botRng, never
 * Math.random, so a bot's path is reproducible from the seed.
 *
 * It returns the vector rather than writing p.input, so p.input stays reserved for a
 * real controller — that's what lets the dev harness "grab" a bot (see tick()), and it
 * means the bot re-steers from scratch every frame instead of coasting on a stale aim.
 */
function botSteer(p) {
  const { coin, botRng, bomb } = game;

  // Drift the wander heading a little each frame, then take its unit vector. This is
  // both the bot's whole motion during the post-spawn delay and its wander component
  // afterwards.
  p.wanderAngle += (botRng() - 0.5) * 2 * BOT_WANDER_TURN;
  const wanderX = Math.cos(p.wanderAngle);
  const wanderY = Math.sin(p.wanderAngle);

  // Survival first: an armed bomb nearby means run directly away from it.
  if (bomb) {
    const awayX = p.x - bomb.x;
    const awayY = p.y - bomb.y;
    const bombDist = Math.hypot(awayX, awayY);
    if (bombDist < BOMB_BLAST_RADIUS + BOT_FLEE_MARGIN) {
      if (bombDist > 0) return { a0: awayX / bombDist, a1: awayY / bombDist };
      return { a0: wanderX, a1: wanderY }; // sitting on the bomb: any direction out
    }
  }

  // Still "spotting" a freshly spawned coin: wander aimlessly, don't charge yet.
  if (p.chargeDelay > 0) {
    p.chargeDelay -= 1;
    return { a0: wanderX, a1: wanderY };
  }

  // Unit vector pointing at the coin (fall back to no pull if right on top of it).
  let toCoinX = coin.x - p.x;
  let toCoinY = coin.y - p.y;
  const dist = Math.hypot(toCoinX, toCoinY);
  if (dist > 0) {
    toCoinX /= dist;
    toCoinY /= dist;
  }

  // Blend pursuit + wander, then normalize back to full-stick magnitude.
  let a0 = toCoinX * (1 - BOT_WANDER) + wanderX * BOT_WANDER;
  let a1 = toCoinY * (1 - BOT_WANDER) + wanderY * BOT_WANDER;
  const mag = Math.hypot(a0, a1);
  if (mag > 0) {
    a0 /= mag;
    a1 /= mag;
  }
  return { a0, a1 };
}

/** Spawn a bomb near the pack (seeded jitter) and start its fuse. */
function spawnBomb() {
  const { world, bombRng } = game;
  const c = livingCentroid();
  const jitterX = (bombRng() - 0.5) * 2 * BOMB_JITTER;
  const jitterY = (bombRng() - 0.5) * 2 * BOMB_JITTER;
  game.bomb = {
    x: clamp(c.x + jitterX, WORLD_MARGIN, world.w - WORLD_MARGIN),
    y: clamp(c.y + jitterY, WORLD_MARGIN, world.h - WORLD_MARGIN),
    fuse: BOMB_FUSE_FRAMES,
  };
}

/** Detonate the active bomb: eliminate every living player caught in the blast. */
function detonateBomb() {
  const { bomb } = game;
  for (const p of game.players.values()) {
    if (p.eliminated) continue;
    if (Math.hypot(p.x - bomb.x, p.y - bomb.y) <= BOMB_BLAST_RADIUS + PLAYER_RADIUS) {
      p.eliminated = true;
      game.eliminationCounter += 1;
      p.eliminationOrder = game.eliminationCounter;
    }
  }
  game.bomb = null;
  game.bombCooldown = BOMB_COOLDOWN_FRAMES;
}

/**
 * Advance the bomb state machine one frame: count down to the next spawn, burn the
 * fuse of an armed bomb, and detonate when it hits zero. Returns true if the round
 * ended (everyone but one was eliminated), so the caller can stop the loop.
 */
function updateBomb() {
  if (game.bomb) {
    game.bomb.fuse -= 1;
    if (game.bomb.fuse <= 0) {
      detonateBomb();
      // A blast can end the round: last player standing, or nobody left.
      const living = livingPlayers().length;
      if (living === 0 || (game.initialLiving > 1 && living <= 1)) {
        endRound();
        return true;
      }
    }
    return false;
  }
  game.bombCooldown -= 1;
  if (game.bombCooldown <= 0) spawnBomb();
  return false;
}

/** End the round via the platform's gameOver callback (guarded against double-firing). */
function endRound() {
  if (game.ended) return;
  game.ended = true;
  game.running = false;
  game.gameOver(rankedPlayers().map((p) => p.id));
}

/**
 * Build the per-player HUD payload for hud.updatePlayers():
 *   - placement — 0 = leading (from the shared ranking)
 *   - value     — score as a "current/max" string; the `pointsSmall` value type parses
 *                 this exact format, so a bare number would break on the platform
 *   - meter     — 0..100 = the remaining coin slowdown; it rests at 0 (an empty bar)
 *                 when not slowed, since the platform draws the bar for any meter >= 0
 *                 (only -1/omitted hides it). Rendered in BOTH the overhead and the
 *                 left scoreboard (the platform has no per-location toggle).
 *   - eliminated — greys the player out in the HUD (and plays the elimination sfx)
 */
function buildHudPlayers() {
  return rankedPlayers().map((p, index) => ({
    playerId: p.id,
    placement: index,
    value: `${p.score}/${TARGET}`,
    meter: p.slowFrames > 0 ? Math.round((p.slowFrames / SLOW_DURATION_FRAMES) * 100) : 0,
    eliminated: p.eliminated,
  }));
}

/**
 * Build the screen-space anchors for hud.updateScreenPoints(), two per living player:
 *   - playerOverhead — anchors the floating nametag (+ crown, value, meter) ABOVE the
 *     head, not on the dot; anchor a point offset above the character so the HUD floats
 *     over it. The platform hides it automatically once the player is off-screen.
 *   - playerPosition — tracks the player's body; when isOffScreen is true the platform
 *     pins an indicator to the nearest screen edge so the pack can see off-screen rivals.
 * Eliminated players are out of play, so we stop anchoring HUD to them.
 */
function buildScreenPoints() {
  const points = [];
  for (const p of livingPlayers()) {
    // Smaller world y is higher on screen, so subtract to sit above the head.
    const head = worldToScreen(p.x, p.y - PLAYER_RADIUS - OVERHEAD_OFFSET);
    const body = worldToScreen(p.x, p.y);
    points.push({ type: "playerOverhead", playerId: p.id, x: head.x, y: head.y, isOffScreen: head.isOffScreen });
    points.push({ type: "playerPosition", playerId: p.id, x: body.x, y: body.y, isOffScreen: body.isOffScreen });
  }
  return points;
}

/** Draw the world bounds + a faint grid so the camera's movement is legible. */
function drawWorld() {
  const { ctx, world } = game;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, world.w, world.h);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 200;
  for (let x = step; x < world.w; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, world.h);
  }
  for (let y = step; y < world.h; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(world.w, y);
  }
  ctx.stroke();
}

/** Draw an armed bomb: a danger ring that fills red as the fuse burns down. */
function drawBomb() {
  const { ctx, bomb } = game;
  const progress = 1 - bomb.fuse / BOMB_FUSE_FRAMES; // 0 → 1 as it nears detonation

  // Blast outline.
  ctx.strokeStyle = "rgba(255, 80, 60, 0.8)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(bomb.x, bomb.y, BOMB_BLAST_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  // Filling danger zone (grows toward the full blast as the fuse runs out).
  ctx.fillStyle = "rgba(255, 80, 60, 0.22)";
  ctx.beginPath();
  ctx.arc(bomb.x, bomb.y, BOMB_BLAST_RADIUS * progress, 0, Math.PI * 2);
  ctx.fill();

  // Solid core.
  ctx.fillStyle = "#ff503c";
  ctx.beginPath();
  ctx.arc(bomb.x, bomb.y, BOMB_CORE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * When the coin is off-screen, draw an edge arrow pointing to it. Drawn in SCREEN space
 * (call it after the camera transform is restored), pinned inside the HUD-safe insets so
 * it never ends up under the platform's scoreboard (left) or top status row.
 */
function drawCoinArrow() {
  const { canvas, ctx, coin, cam } = game;
  // Coin position in screen pixels (y down), i.e. where it would draw if on-screen.
  const coinX = coin.x - cam.x;
  const coinY = coin.y - cam.y;
  const onScreen =
    coinX >= 0 && coinX <= canvas.width && coinY >= 0 && coinY <= canvas.height;
  if (onScreen) return;

  // Pin the arrow inside the safe rectangle, then aim it from there at the coin.
  const ax = clamp(coinX, ARROW_INSET_LEFT, canvas.width - ARROW_INSET_RIGHT);
  const ay = clamp(coinY, ARROW_INSET_TOP, canvas.height - ARROW_INSET_BOTTOM);
  const angle = Math.atan2(coinY - ay, coinX - ax);

  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(angle);
  ctx.fillStyle = COIN_COLOR;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ARROW_SIZE, 0); // tip points toward the coin (local +x, before rotation)
  ctx.lineTo(-ARROW_SIZE * 0.75, ARROW_SIZE * 0.7);
  ctx.lineTo(-ARROW_SIZE * 0.75, -ARROW_SIZE * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** The per-frame simulation + render step driven by requestAnimationFrame. */
function tick() {
  if (!game || !game.running) return;

  const { canvas, ctx, coin, world } = game;

  // 1) Bomb state machine (spawn / fuse / detonate). May end the round on a blast.
  if (updateBomb()) return;

  // 2) Integrate each living player's position from its input axes. A bot steers
  //    itself UNLESS a controller is feeding it input — that's how the dev harness
  //    grabs a bot. At runtime bots never get controller input, so they self-steer.
  //    Eliminated players are frozen and skipped entirely.
  for (const p of game.players.values()) {
    if (p.eliminated) continue;

    const controlled = p.input.a0 !== 0 || p.input.a1 !== 0;
    const input = p.isBot && !controlled ? botSteer(p) : p.input;
    // Move at reduced speed while the coin slowdown is active, then tick it down.
    const speed = p.slowFrames > 0 ? PLAYER_SPEED * SLOW_SPEED_FACTOR : PLAYER_SPEED;
    if (p.slowFrames > 0) p.slowFrames -= 1;
    p.x += input.a0 * speed;
    p.y += input.a1 * speed;
    // Clamp to the WORLD (not the viewport) so dots stay in bounds but can still
    // roam off the visible screen.
    p.x = clamp(p.x, PLAYER_RADIUS, world.w - PLAYER_RADIUS);
    p.y = clamp(p.y, PLAYER_RADIUS, world.h - PLAYER_RADIUS);

    // 3) Coin collection: circle-vs-circle overlap test.
    const dx = p.x - coin.x;
    const dy = p.y - coin.y;
    if (Math.hypot(dx, dy) <= PLAYER_RADIUS + COIN_RADIUS) {
      p.score += 1;
      p.slowFrames = SLOW_DURATION_FRAMES; // scoring costs you a brief slowdown
      respawnCoin();

      // 4) Win check — end the round via the platform's gameOver callback.
      if (p.score >= TARGET) {
        endRound();
        return;
      }
    }
  }

  // 5) Move the camera to follow the surviving pack.
  updateCamera();

  // 6) Push HUD state to the platform — the game never draws these itself:
  //    - updatePlayers: scoreboard (placement, points, meter, eliminated)
  //    - updateScreenPoints: overhead nametags + off-screen indicators
  game.hud.updatePlayers({ players: buildHudPlayers() });
  game.hud.updateScreenPoints({ points: buildScreenPoints() });

  // 7) Render the frame through the camera — only world objects (grid, coin, bomb,
  //    player dots). Names, scores and the rest of the HUD are drawn by the platform
  //    from step 6.
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(-game.cam.x, -game.cam.y);

  drawWorld();

  // Coin.
  ctx.fillStyle = COIN_COLOR;
  ctx.beginPath();
  ctx.arc(coin.x, coin.y, COIN_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  // Bomb (when armed).
  if (game.bomb) drawBomb();

  // Players (eliminated ones linger, dimmed; a pale ring marks a slowed player).
  for (const p of game.players.values()) {
    ctx.globalAlpha = p.eliminated ? 0.25 : 1;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    if (!p.eliminated && p.slowFrames > 0) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_RADIUS + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  // Screen-space overlay (drawn AFTER restore, on top of the world): an edge arrow to
  // the coin whenever it has scrolled off-screen.
  drawCoinArrow();

  game.rafHandle = requestAnimationFrame(tick);
}

/** Start the raf loop if it is not already running. */
function startLoop() {
  if (!game || game.running || game.ended) return;
  game.running = true;
  game.rafHandle = requestAnimationFrame(tick);
}

/** Stop the raf loop. */
function stopLoop() {
  if (!game) return;
  game.running = false;
  if (game.rafHandle != null) {
    cancelAnimationFrame(game.rafHandle);
    game.rafHandle = null;
  }
}

export default {
  /**
   * setup — configure the HUD and prepare the canvas, then signal readiness.
   * Only hud.setup() is legal here; updatePlayers/updateScreenPoints/clear throw
   * during setup. Must end by calling setupContext.setupDone().
   */
  setup(setupContext) {
    // This build ships a single minigame, so we ignore setupContext.gameModeId.
    // If your build exposes more than one minigame (each configured as a separate
    // game entry in devspace, sharing this gameId but with its own gameModeId),
    // branch on gameModeId here to boot the right one, e.g.:
    //   switch (setupContext.gameModeId) {
    //     case "collect": /* set up the collect minigame */ break;
    //     case "race":    /* set up the race minigame */    break;
    //   }
    //
    // valueType "pointsSmall" renders the `value` we send as segmented points and
    // expects it as a "current/max" string (see buildHudPlayers). meterType "bar"
    // renders the 0..100 `meter` (here the coin slowdown) as a bar. Both the value and
    // the meter appear overhead and in the left scoreboard.
    setupContext.hud.setup({ players: { valueType: "pointsSmall", meterType: "bar" } });

    const canvas = document.createElement("canvas");
    canvas.style.position = "fixed";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    document.body.appendChild(canvas);

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    // Stash the canvas/ctx so play() can pick them up. We keep this separate from
    // the per-round `game` state, which is built in play().
    stage = { canvas, ctx: canvas.getContext("2d") };

    setupContext.setupDone();
  },

  /**
   * play — start a round. Receives the players, deterministic seed, colors, the
   * play-phase HUD and the gameOver callback. Here updatePlayers/clear are legal
   * but hud.setup() throws. Drives the simulation via requestAnimationFrame.
   */
  play(playContext) {
    const canvas = stage.canvas;
    const ctx = stage.ctx;
    const rng = mulberry32(playContext.seed);

    // The world is a fixed size for the round, larger than the current viewport so
    // players can roam off-screen. Sized from the viewport at boot with a floor.
    const world = {
      w: Math.max(WORLD_MIN_W, canvas.width * WORLD_SCALE),
      h: Math.max(WORLD_MIN_H, canvas.height * WORLD_SCALE),
    };

    // Build per-player state, spreading start positions evenly around a ring at the
    // center of the WORLD.
    const players = new Map();
    const count = playContext.players.length;
    const cx = world.w / 2;
    const cy = world.h / 2;
    const ringR = Math.min(world.w, world.h) * 0.25;
    playContext.players.forEach((player, i) => {
      const angle = (i / count) * Math.PI * 2;
      players.set(player.playerId, {
        id: player.playerId,
        color: playContext.gameProperties.player.color[player.color].hex.base,
        x: cx + Math.cos(angle) * ringR,
        y: cy + Math.sin(angle) * ringR,
        score: 0,
        input: { a0: 0, a1: 0, b0: 0, b1: 0 },
        // Bots are steered by botSteer() instead of a controller; the rest of the loop
        // treats them identically. wanderAngle seeds each bot's drifting heading to its
        // spawn angle so they don't all wander in lockstep; chargeDelay is the spotting
        // delay before charging a coin (set per coin in respawnCoin).
        isBot: player.type === "bot",
        wanderAngle: angle,
        chargeDelay: 0,
        // Slowdown timer in frames; set on coin pickup, shown as the draining meter.
        slowFrames: 0,
        // Elimination state — set when a bomb catches this player (see detonateBomb).
        eliminated: false,
        eliminationOrder: 0,
      });
    });

    game = {
      canvas,
      ctx,
      world,
      cam: { x: 0, y: 0, initialized: false },
      players,
      rng,
      // A second seeded stream just for bot wander, so consuming it every frame
      // never disturbs the coin sequence `rng` produces on collection.
      botRng: mulberry32((playContext.seed ^ 0x9e3779b9) >>> 0),
      // A third seeded stream for bomb placement, kept separate for the same reason.
      bombRng: mulberry32((playContext.seed ^ 0x85ebca6b) >>> 0),
      coin: { x: 0, y: 0 },
      bomb: null,
      bombCooldown: BOMB_COOLDOWN_FRAMES,
      initialLiving: count, // last-one-standing only applies when we started with >1
      eliminationCounter: 0,
      running: false,
      ended: false,
      rafHandle: null,
      hud: playContext.hud,
      gameOver: playContext.gameOver,
    };

    respawnCoin();

    // Respect the platform's initial pause state.
    if (!playContext.isPaused) startLoop();
  },

  /**
   * inputs — latest controller state for one player, as { a0, a1, b0, b1 }.
   * a0/a1 are the analog axes (~-1..1); we map them to x/y velocity. Guard until
   * play() has built state.
   */
  inputs(playerId, inputs) {
    if (!game) {
      console.warn("Game state not initialized, can't process inputs");
      return;
    }
    const p = game.players.get(playerId);
    if (!p) return;
    p.input = inputs;
  },

  /**
   * pause — the platform toggles pause/resume; stop or restart the raf loop.
   */
  pause(isPaused) {
    if (isPaused) stopLoop();
    else startLoop();
  },
};
