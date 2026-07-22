/**
 * mock-platform.js — a small local test harness for the example game.
 *
 * WHAT THIS IS
 * This file lets you run the example game in a plain browser. It loads the game
 * module, hands it mock data (players, colors, a seed), and maps the keyboard to
 * controller inputs, then drives the game's four lifecycle hooks
 * (setup → play → inputs → pause/gameOver). When your game runs on Gaming Couch
 * the platform does the equivalent for you — you do NOT ship this file.
 *
 * Each mocked piece below is annotated with what it stands in for at runtime.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * LIMITATIONS (this is a local stand-in, not the real run)
 * - No real controller. At runtime each player uses the controller layout you
 *   configure in the dashboard, whose widgets map to the {a0,a1,b0,b1} input
 *   properties. Here the keyboard stands in: arrows / WASD drive the two axes only;
 *   the buttons (b0,b1) are always 0. The arrow keys can be pointed at any player
 *   with number keys 1..N (grabbing a bot off its AI while you hold them); WASD
 *   stays on player 2.
 * - No networking or multiplayer session — everything runs locally in one tab.
 * - Player/bot counts and the seed are set in the top bar (persisted to localStorage):
 *   the seed is either rolled randomly each run or pinned to a fixed value. At runtime
 *   Gaming Couch supplies the lobby's actual players, which are bots, and the seed.
 * ──────────────────────────────────────────────────────────────────────────────
 */

// Loads your game module's default export — the four lifecycle hooks. At runtime
// Gaming Couch loads it the same way.
import game from "../build/gc.game.js";

// ── Overlay elements (this harness's chrome; not part of the contract) ──────────
const scoreboardList = document.getElementById("scoreboard-list");
const screenPoints = document.getElementById("screen-points");
const banner = document.getElementById("banner");
const bannerTitle = document.getElementById("banner-title");
const bannerSub = document.getElementById("banner-sub");

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// The eight assignable colors (white = "unset", so it's not used here). With 8 we
// can give every player a distinct color, which also lines up with number keys 1..8.
const COLOR_KEYS = [
  "blue",
  "red",
  "green",
  "cyan",
  "yellow",
  "purple",
  "pink",
  "brown",
];

/**
 * Player/bot counts and the seed are edited in the top bar and persisted to
 * localStorage, so they survive a reload. Changing them needs a restart (players and
 * seed are fixed once a round starts), which the top bar's Restart button does. The
 * platform builds the equivalent list — and picks a per-match seed — at runtime.
 */
const STORE_KEY = "gc-dev-harness";

// Pick a fresh seed, standing in for the platform's per-match seed. Math.random is
// fine HERE (this is the platform stand-in) — the game itself must stay deterministic
// off the seed and never call Math.random.
function randomSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    // ignore malformed storage
  }
  const playerCount = clamp(Number(saved.players) || 4, 1, 8);
  // `?? 2` so an unset value defaults to 2 bots, but an explicit 0 stays 0.
  const botCount = clamp(Number(saved.bots ?? 2) || 0, 0, playerCount);
  const seedRandom = saved.seedRandom ?? true; // random by default
  const fixedSeed = Number.isFinite(Number(saved.seed)) ? Number(saved.seed) : 12345;
  // Random mode rolls a new seed every run; fixed mode reuses the stored value.
  const seed = seedRandom ? randomSeed() : fixedSeed;
  return { playerCount, botCount, seedRandom, seed };
}
function saveConfig(cfg) {
  localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
}

const { playerCount, botCount, seedRandom, seed: SEED } = loadConfig();
const humanCount = playerCount - botCount;

/**
 * Mock players for the game, shaped like the platform's player data: bots fill from
 * the END of the list (type:"bot"). There is NO `name` here — the platform's HUD
 * draws names, so the game is never handed them. The game drives the bots itself,
 * but you can still point the keyboard at one to grab control (see below).
 */
const players = Array.from({ length: playerCount }, (_, i) => ({
  type: i >= humanCount ? "bot" : "player",
  playerId: i + 1,
  color: COLOR_KEYS[i % COLOR_KEYS.length],
}));

// Display names live with the HUD mock (the platform owns names from the lobby), NOT
// in the game-facing player data above. Humans are P1.., bots Bot 1...
const nameById = new Map(
  Array.from({ length: playerCount }, (_, i) => [
    i + 1,
    i >= humanCount ? `Bot ${i + 1 - humanCount}` : `P${i + 1}`,
  ]),
);

// Display colors (id → hex) for the HUD mock, resolved from gameProperties in boot().
let colorById = new Map();

// Latest per-player HUD data (id → { value, meter, eliminated, ... }) from the most
// recent hud.updatePlayers(). The overhead renderer reads it so the floating nametag
// can show the score + meter above the head, the way the platform does.
const hudDataById = new Map();

// The last HudConfig from hud.setup(), so the renderers know how to draw `value`
// (e.g. valueType "pointsSmall" → segmented points).
let hudConfig = {};

/**
 * Render a pointsSmall value ("current/max", e.g. "3/5") as a row of segments — max
 * cells with the first `points` filled — mirroring the platform's pointsSmall display.
 */
function renderPointsSegments(value, color) {
  const [points, maxPoints] = String(value).split("/").map(Number);
  if (!Number.isFinite(points) || !Number.isFinite(maxPoints) || maxPoints <= 0) {
    return `<span class="score">${value}</span>`;
  }
  let cells = "";
  for (let i = 0; i < maxPoints; i++) {
    cells += `<span class="seg" style="background: ${i < points ? color : "rgba(255,255,255,0.25)"}"></span>`;
  }
  return `<div class="points">${cells}</div>`;
}

// Which player the FIRST key binds (arrow keys) currently drive. Switchable to any
// player with number keys 1..N; starts on player 1.
let selectedPlayerId = 1;

// The SECOND key binds (WASD) are pinned to player 2, regardless of the selection.
const SECOND_BIND_PLAYER_ID = 2;

// Tracks the current pause flag so the "p" key can toggle it (mirrors the platform
// pausing/resuming the game).
let isPaused = false;

// Once gameOver fires we stop forwarding inputs to the game.
let gameRunning = false;

/**
 * Boot: load the properties JSON the same way it is loaded at runtime, then hand
 * the parsed `.properties` object to the game as `gameProperties`. (gc.properties.json
 * wraps the palette under a top-level "properties" key; your game receives the inner
 * object, which is the { player: { color: {...} } } shape it reads colors from.)
 */
fetch("../build/gc.properties.json")
  .then((res) => res.json())
  .then((json) => boot(json.properties))
  .catch((err) => {
    console.error("[mock-platform] failed to load gc.properties.json", err);
  });

function boot(gameProperties) {
  // Resolve each player's display color (the same source the game uses) so the HUD
  // mock can tint the scoreboard to match the dots on screen.
  colorById = new Map(
    players.map((p) => [
      p.playerId,
      gameProperties.player.color[p.color].hex.base,
    ]),
  );

  // ── setupContext ──────────────────────────────────────────────────────────
  // Mirrors what game.setup() receives at runtime. During setup only hud.setup()
  // is legal; the other HUD calls throw, matching the real setup-phase semantics
  // so a game that misuses them fails the same way locally as on the platform.
  const setupContext = {
    clientId: 0, // we're the only (host) client locally
    gameId: "examplejs",
    gameModeId: "collect",
    isHost: true,
    isDevMode: true,
    gameProperties,
    hud: {
      setup(cfg) {
        // At runtime this configures the on-screen HUD from this config.
        hudConfig = cfg || {};
        console.log("[mock-platform] hud.setup", cfg);
      },
      updatePlayers() {
        throw new Error("hud.updatePlayers is not available during setup");
      },
      updateScreenPoints() {
        throw new Error("hud.updateScreenPoints is not available during setup");
      },
      clear() {
        throw new Error("hud.clear is not available during setup");
      },
    },
    // The game calls this when setup finishes; the platform then moves to play.
    setupDone() {
      startPlay(gameProperties);
    },
  };

  game.setup(setupContext);
}

function startPlay(gameProperties) {
  // ── playContext ───────────────────────────────────────────────────────────
  // Mirrors what game.play() receives once a round begins. During play
  // updatePlayers/updateScreenPoints/clear are usable but hud.setup() throws.
  const playContext = {
    isPaused: false,
    seed: SEED,
    players,
    gameProperties,
    hud: {
      setup() {
        throw new Error("hud.setup is not available during play");
      },
      // At runtime this renders the scoreboard from this payload; here we
      // render it into the #scoreboard overlay.
      updatePlayers(data) {
        renderScoreboard(data.players);
      },
      // At runtime this draws the per-player overhead nametags and off-screen
      // indicators; here we render the nametags into the #screen-points overlay.
      updateScreenPoints(data) {
        renderScreenPoints(data.points);
      },
      clear() {
        scoreboardList.innerHTML = "";
        screenPoints.innerHTML = "";
      },
    },
    // The platform ends the round with player ids ordered best→worst placement.
    gameOver(idsByPlacement) {
      showResult(idsByPlacement);
    },
  };

  gameRunning = true;
  game.play(playContext);
}

/**
 * Render the player HUD boxes from PlayersHudData.players: name, the `value` (segmented
 * points for the "pointsSmall" valueType, else the raw value text), a `meter` bar, and
 * an eliminated state. The real platform renders these richer (see PlayersHud.tsx);
 * this is a faithful-enough stand-in.
 */
function renderScoreboard(hudPlayers) {
  // Cache the latest data so renderScreenPoints() can show the score/meter overhead.
  hudDataById.clear();
  for (const p of hudPlayers) hudDataById.set(p.playerId, p);

  const valueType = hudConfig.players && hudConfig.players.valueType;

  // Order by placement (0 = best) for a stable stack.
  const ordered = [...hudPlayers].sort((a, b) => a.placement - b.placement);
  scoreboardList.innerHTML = ordered
    .map((p) => {
      const name = nameById.get(p.playerId) ?? `#${p.playerId}`;
      const color = colorById.get(p.playerId) ?? "#888";

      // `value`: segmented points for the "pointsSmall" type, otherwise the raw text.
      let valueHtml = "";
      if (p.value != null && p.value !== "") {
        valueHtml =
          valueType === "pointsSmall"
            ? renderPointsSegments(p.value, color)
            : `<span class="score">${p.value}</span>`;
      }

      // meter is 0..100; the platform treats undefined/null/-1 as "no meter".
      const hasMeter = typeof p.meter === "number" && p.meter >= 0;
      const meter = hasMeter
        ? `<div class="meter"><div class="meter-fill" style="width: ${p.meter}%; background: ${color}"></div></div>`
        : "";
      return (
        `<div class="player-box${p.eliminated ? " eliminated" : ""}" style="border-left-color: ${color}">` +
        `<span class="name" style="color: ${color}">${name}</span>` +
        valueHtml +
        meter +
        `</div>`
      );
    })
    .join("");
}

/**
 * Render the screen-space HUD from HudScreenPointData.points. Mirrors the platform's
 * two point types (x 0..1 left→right, y 0..1 bottom→top, so CSS top uses 1 - y):
 *   - playerOverhead — the floating HUD above the head (name + score + meter, the way
 *     the platform stacks them overhead); shown only while on-screen.
 *   - playerPosition — an off-screen indicator, shown only when isOffScreen is true,
 *     clamped to the nearest screen edge (the platform draws a player avatar here).
 */
function renderScreenPoints(points) {
  const html = [];
  const valueType = hudConfig.players && hudConfig.players.valueType;

  for (const pt of points) {
    const name = nameById.get(pt.playerId) ?? `#${pt.playerId}`;
    const color = colorById.get(pt.playerId) ?? "#888";

    if (pt.type === "playerOverhead" && !pt.isOffScreen) {
      const left = pt.x * 100;
      const top = (1 - pt.y) * 100;
      // Pull the player's value/meter from the latest hud.updatePlayers() payload and
      // stack them above the head, the way the platform composes the overhead.
      const data = hudDataById.get(pt.playerId);

      // Value sits below the name (segmented points for pointsSmall, else raw text),
      // and the meter bar sits under that.
      let valueBelow = "";
      if (data && data.value != null && data.value !== "") {
        valueBelow =
          valueType === "pointsSmall"
            ? renderPointsSegments(data.value, color)
            : `<div class="oh-value">${data.value}</div>`;
      }
      const meter =
        data && typeof data.meter === "number" && data.meter >= 0
          ? `<div class="oh-meter"><div class="oh-meter-fill" style="width: ${data.meter}%; background: ${color}"></div></div>`
          : "";
      html.push(
        `<div class="overhead" style="left: ${left}%; top: ${top}%">` +
          `<div class="oh-name" style="color: ${color}">${name}</div>` +
          valueBelow +
          meter +
          `</div>`,
      );
    } else if (pt.type === "playerPosition" && pt.isOffScreen) {
      // Pin the indicator just inside the nearest edge.
      const left = clamp(pt.x, 0.03, 0.97) * 100;
      const top = clamp(1 - pt.y, 0.06, 0.94) * 100;
      html.push(
        `<div class="offscreen" style="left: ${left}%; top: ${top}%; border-color: ${color}">` +
          `<span style="color: ${color}">${name}</span>` +
          `</div>`,
      );
    }
  }
  screenPoints.innerHTML = html.join("");
}

/** Show the result banner with the winner (first id in placement order). */
function showResult(idsByPlacement) {
  gameRunning = false; // stop sending inputs
  const winnerName = nameById.get(idsByPlacement[0]);
  bannerTitle.textContent = winnerName ? `${winnerName} wins!` : "Game over";
  bannerSub.textContent = `placement order: ${idsByPlacement.join(" → ")}`;
  banner.classList.add("show");
}

/**
 * ── Keyboard → controller inputs ───────────────────────────────────────────────
 * Stands in for the controller forwarding its state. We keep a per-player axis
 * state and, on every change, send the full {a0,a1,b0,b1} object via
 * game.inputs(playerId, ...) — the same call the platform makes per frame.
 *
 * There are two independent bind sets, each driving the two axes (keydown sets the
 * axis, keyup clears it back to 0; buttons b0/b1 have no mapping — see Limitations):
 *   FIRST  (arrow keys) → the SELECTED player; number keys 1..N pick who that is.
 *   SECOND (WASD)       → player 2, always.
 * Either can target a bot: the game yields control to a bot for as long as it
 * receives input here, so holding keys grabs it and releasing hands it back to AI.
 */
const FIRST_BINDS = {
  ArrowLeft: { axis: "a0", value: -1 },
  ArrowRight: { axis: "a0", value: 1 },
  ArrowUp: { axis: "a1", value: -1 },
  ArrowDown: { axis: "a1", value: 1 },
};
const SECOND_BINDS = {
  // Use KeyboardEvent.code so the layout is independent of shift/caps.
  KeyA: { axis: "a0", value: -1 },
  KeyD: { axis: "a0", value: 1 },
  KeyW: { axis: "a1", value: -1 },
  KeyS: { axis: "a1", value: 1 },
};

// Per-player live axis/button state, seeded to the neutral input for every player.
const inputState = new Map(
  players.map((p) => [p.playerId, { a0: 0, a1: 0, b0: 0, b1: 0 }]),
);

/**
 * Resolve a key event to { axis, value, playerId }, or null. FIRST binds target the
 * currently selected player; SECOND binds target player 2 (null if it doesn't exist).
 */
function bindingFor(e) {
  const first = FIRST_BINDS[e.code] ?? FIRST_BINDS[e.key];
  if (first) return { ...first, playerId: selectedPlayerId };

  const second = SECOND_BINDS[e.code] ?? SECOND_BINDS[e.key];
  if (second && SECOND_BIND_PLAYER_ID <= playerCount) {
    return { ...second, playerId: SECOND_BIND_PLAYER_ID };
  }
  return null;
}

function sendInputs(playerId) {
  if (!gameRunning) return;
  game.inputs(playerId, inputState.get(playerId));
}

/** Zero a player's axes and push the neutral state (used when switching control). */
function neutralize(playerId) {
  const state = inputState.get(playerId);
  if (!state) return;
  state.a0 = 0;
  state.a1 = 0;
  sendInputs(playerId);
}

/** Point the arrow keys at any player (1..N); ignore out-of-range number keys. */
function selectPlayer(n) {
  if (n < 1 || n > playerCount || n === selectedPlayerId) return;
  // Stop the player we're leaving so it doesn't keep coasting on a held key (a bot
  // we leave simply resumes its AI, since its input falls back to neutral).
  neutralize(selectedPlayerId);
  selectedPlayerId = n;
  updateSelectedDisplay();
}

/** Reflect the currently selected player in the top bar. */
function updateSelectedDisplay() {
  const el = document.getElementById("cfg-selected");
  if (el) el.textContent = nameById.get(selectedPlayerId) ?? `#${selectedPlayerId}`;
}

/**
 * Wire up the top bar. The players/bots inputs persist to localStorage (bots are
 * auto-clamped to the player count); Restart reloads so the new counts take effect.
 * Counts can't change mid-round — the player list is fixed once a round starts.
 */
function setupTopBar() {
  const playersInput = document.getElementById("cfg-players");
  const botsInput = document.getElementById("cfg-bots");
  const seedRandomInput = document.getElementById("cfg-seed-random");
  const seedInput = document.getElementById("cfg-seed");
  const restartButton = document.getElementById("cfg-restart");
  if (!playersInput || !botsInput || !seedRandomInput || !seedInput || !restartButton) {
    return;
  }

  playersInput.value = playerCount;
  botsInput.value = botCount;
  botsInput.max = playerCount;
  seedRandomInput.checked = seedRandom;
  seedInput.value = SEED; // show the seed actually in use this run
  seedInput.disabled = seedRandom; // random mode auto-rolls it; nothing to type

  const persist = () => {
    const p = clamp(Number(playersInput.value) || 1, 1, 8);
    const b = clamp(Number(botsInput.value) || 0, 0, p);
    // Reflect any clamping back into the inputs (bots can't exceed players).
    playersInput.value = p;
    botsInput.value = b;
    botsInput.max = p;
    seedInput.disabled = seedRandomInput.checked;
    saveConfig({
      players: p,
      bots: b,
      seedRandom: seedRandomInput.checked,
      seed: Number(seedInput.value) || 12345,
    });
  };
  [playersInput, botsInput, seedRandomInput, seedInput].forEach((el) =>
    el.addEventListener("change", persist),
  );
  restartButton.addEventListener("click", () => {
    persist();
    location.reload();
  });

  updateSelectedDisplay();
}

setupTopBar();

// The placement banner's Restart button (the Enter key does the same — see keydown).
document
  .getElementById("banner-restart")
  ?.addEventListener("click", () => location.reload());

window.addEventListener("keydown", (e) => {
  // Don't hijack typing in the top bar (number inputs, etc.).
  if (e.target.closest?.("#topbar")) return;

  // Enter restarts the round — a reload re-reads the top bar config and rolls a
  // fresh seed when random mode is on.
  if (e.key === "Enter") {
    e.preventDefault();
    location.reload();
    return;
  }

  // Pause toggle.
  if (e.code === "KeyP" || e.key === "p" || e.key === "P") {
    e.preventDefault();
    isPaused = !isPaused;
    game.pause(isPaused);
    return;
  }

  // Number keys 1..8 point the arrow keys at that player.
  const digit = e.code.startsWith("Digit") ? e.code.slice(5) : e.key;
  if (/^[1-8]$/.test(digit)) {
    e.preventDefault();
    selectPlayer(parseInt(digit, 10));
    return;
  }

  const b = bindingFor(e);
  if (!b) return;
  e.preventDefault(); // stop arrow keys from scrolling the page
  if (e.repeat) return; // ignore auto-repeat; the axis is already set

  const state = inputState.get(b.playerId);
  state[b.axis] = b.value;
  sendInputs(b.playerId);
});

window.addEventListener("keyup", (e) => {
  if (e.target.closest?.("#topbar")) return;
  const b = bindingFor(e);
  if (!b) return;
  e.preventDefault();

  const state = inputState.get(b.playerId);
  // Only clear if the released key owns the current axis value, so releasing
  // (say) Left while Right is still held doesn't wrongly zero the axis.
  if (state[b.axis] === b.value) state[b.axis] = 0;
  sendInputs(b.playerId);
});
