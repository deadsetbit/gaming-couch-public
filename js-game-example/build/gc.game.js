/**
 * gc.game.js — the required entry point for a Gaming Couch JavaScript game.
 *
 * Gaming Couch loads this module and calls the four lifecycle hooks on its
 * default export (setup, play, inputs, pause), passing in *contexts* with the
 * data each one needs. Your game needs no extra library and makes no outside
 * requests — it only consumes what it is handed.
 *
 * The example game is intentionally tiny but real: every player drives a colored
 * dot with the analog stick; whoever collects the seeded coin first to TARGET
 * points wins. It exercises players, colors, the deterministic seed, controller
 * inputs, the HUD, gameOver and pause — the whole contract surface.
 */

// First player to reach this score ends the round.
const TARGET = 5;

// Visual sizes (in CSS pixels).
const PLAYER_RADIUS = 36;
const COIN_RADIUS = 14;
const PLAYER_SPEED = 3; // px per frame at full stick deflection

// Coin spawn margins (CSS px). The platform draws the HUD over the play field — the
// scoreboard down the LEFT and player status along the TOP — so inset the spawn area
// more on those two edges than on the right and bottom to keep coins clear of it.
const COIN_MARGIN = COIN_RADIUS * 2; // right & bottom: just keep it fully on-screen
const COIN_MARGIN_LEFT = 190; // clear the left-side scoreboard
const COIN_MARGIN_TOP = 80; // clear the top status row

// Bot tuning. Bots (players whose PlayerGameData.type is "bot") are driven by the
// game itself — the platform sends no controller input for them. Each frame a bot
// steers toward the coin but blends in a little wander, so it drifts off course and
// misses sometimes, which reads as more human than a perfect beeline.
const BOT_WANDER = 0.4; // 0 = laser-perfect to coin, 1 = pure aimless wander
const BOT_WANDER_TURN = 0.5; // max radians the wander heading drifts per frame
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
 * seeded PRNG (never Math.random) means the coin sequence is identical for every
 * client in a match, which is what the platform's `seed` is for.
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

/** Place (or respawn) the coin at the next seeded position inside the arena. */
function respawnCoin() {
  const { canvas, rng, coin, botRng } = game;
  coin.x = COIN_MARGIN_LEFT + rng() * (canvas.width - COIN_MARGIN_LEFT - COIN_MARGIN);
  coin.y = COIN_MARGIN_TOP + rng() * (canvas.height - COIN_MARGIN_TOP - COIN_MARGIN);

  // Give each bot a brief, randomized "spotting" delay before it charges the new coin.
  const span = BOT_REACTION_MAX_FRAMES - BOT_REACTION_MIN_FRAMES;
  for (const p of game.players.values()) {
    if (p.isBot) p.chargeDelay = BOT_REACTION_MIN_FRAMES + botRng() * span;
  }
}

/**
 * Steer one bot for this frame and RETURN its {a0,a1} stick vector: mostly pointing
 * at the coin with some wander mixed in, normalized to full-stick magnitude (so bots
 * move at player speed, they just don't always aim straight). Randomness comes from
 * the seeded botRng, never Math.random, so a bot's path is reproducible from the seed.
 *
 * It returns the vector rather than writing p.input, so p.input stays reserved for a
 * real controller — that's what lets the dev harness "grab" a bot (see tick()), and it
 * means the bot re-steers from scratch every frame instead of coasting on a stale aim.
 */
function botSteer(p) {
  const { coin, botRng } = game;

  // Drift the wander heading a little each frame, then take its unit vector. This is
  // both the bot's whole motion during the post-spawn delay and its wander component
  // afterwards.
  p.wanderAngle += (botRng() - 0.5) * 2 * BOT_WANDER_TURN;
  const wanderX = Math.cos(p.wanderAngle);
  const wanderY = Math.sin(p.wanderAngle);

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

/** Build the HUD payload: players sorted best→worst, with placement + score. */
function buildHudPlayers() {
  return [...game.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, index) => ({
      playerId: p.id,
      placement: index,
      value: p.score,
    }));
}

/**
 * Build the overhead nametag anchors: one `playerOverhead` point per player, in
 * normalized screen coordinates (x 0..1 left→right, y 0..1 bottom→top). The
 * platform draws the actual nametag; the game only says where each one belongs.
 */
function buildScreenPoints() {
  const { canvas } = game;
  return [...game.players.values()].map((p) => ({
    type: "playerOverhead",
    playerId: p.id,
    x: p.x / canvas.width,
    y: 1 - p.y / canvas.height,
    isOffScreen: false,
  }));
}

/** The per-frame simulation + render step driven by requestAnimationFrame. */
function tick() {
  if (!game || !game.running) return;

  const { canvas, ctx, coin } = game;

  // 1) Integrate each player's position from its input axes. A bot steers itself
  //    UNLESS a controller is feeding it input — that's how the dev harness grabs a
  //    bot. At runtime bots never get controller input, so they always self-steer.
  for (const p of game.players.values()) {
    const controlled = p.input.a0 !== 0 || p.input.a1 !== 0;
    const input = p.isBot && !controlled ? botSteer(p) : p.input;
    p.x += input.a0 * PLAYER_SPEED;
    p.y += input.a1 * PLAYER_SPEED;
    // Clamp to the arena so dots never leave the canvas.
    p.x = Math.max(PLAYER_RADIUS, Math.min(canvas.width - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(canvas.height - PLAYER_RADIUS, p.y));

    // 2) Coin collection: circle-vs-circle overlap test.
    const dx = p.x - coin.x;
    const dy = p.y - coin.y;
    if (Math.hypot(dx, dy) <= PLAYER_RADIUS + COIN_RADIUS) {
      p.score += 1;
      respawnCoin();

      // 3) Win check — end the round via the platform's gameOver callback.
      if (p.score >= TARGET) {
        game.running = false;
        const idsByPlacement = [...game.players.values()]
          .sort((a, b) => b.score - a.score)
          .map((pl) => pl.id);
        game.gameOver(idsByPlacement);
        return;
      }
    }
  }

  // 4) Push HUD state to the platform — the game never draws these itself:
  //    - updatePlayers: the scoreboard (placement + score per player)
  //    - updateScreenPoints: the overhead nametag anchored above each player
  game.hud.updatePlayers({ players: buildHudPlayers() });
  game.hud.updateScreenPoints({ points: buildScreenPoints() });

  // 5) Render the frame — only world objects (coin + player dots). Names,
  //    scores and the rest of the HUD are drawn by the platform from step 4.
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Coin.
  ctx.fillStyle = "#ffd34d";
  ctx.beginPath();
  ctx.arc(coin.x, coin.y, COIN_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  // Players.
  for (const p of game.players.values()) {
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  game.rafHandle = requestAnimationFrame(tick);
}

/** Start the raf loop if it is not already running. */
function startLoop() {
  if (!game || game.running) return;
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
    // If your build exposes more than one minigame (multiple `gameEntries` in
    // gc.metadata.json), branch on gameModeId here to boot the right one, e.g.:
    //   switch (setupContext.gameModeId) {
    //     case "collect": /* set up the collect minigame */ break;
    //     case "race":    /* set up the race minigame */    break;
    //   }
    setupContext.hud.setup({ players: { valueType: "pointsSmall" } });

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

    // Build per-player state, spreading start positions evenly around a ring.
    const players = new Map();
    const count = playContext.players.length;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const ringR = Math.min(canvas.width, canvas.height) * 0.3;
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
      });
    });

    game = {
      canvas,
      ctx,
      players,
      rng,
      // A second seeded stream just for bot wander, so consuming it every frame
      // never disturbs the coin sequence `rng` produces on collection.
      botRng: mulberry32((playContext.seed ^ 0x9e3779b9) >>> 0),
      coin: { x: 0, y: 0 },
      running: false,
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
