# Gaming Couch — JavaScript game example

## Contents

- [Overview](#overview)
- [How your game runs](#how-your-game-runs)
- [The game module contract](#the-game-module-contract)
  - [Starter template](#starter-template)
  - [`setup(setupContext)`](#setupsetupcontext)
  - [`play(playContext)`](#playplaycontext)
  - [`inputs(playerId, inputs)`](#inputsplayerid-inputs)
  - [`pause(isPaused)`](#pauseispaused)
- [Players & colors](#players--colors)
- [The HUD](#the-hud)
  - [`hud.setup(HudConfig)` — setup phase](#hudsetuphudconfig--setup-phase)
  - [`hud.updatePlayers(PlayersHudData)` — play phase](#hudupdateplayersplayershuddata--play-phase)
  - [`hud.updateScreenPoints(HudScreenPointData)` — play phase](#hudupdatescreenpointshudscreenpointdata--play-phase)
  - [`hud.clear()` — play phase](#hudclear--play-phase)
- [The controller (configured in the dashboard, not shipped)](#the-controller-configured-in-the-dashboard-not-shipped)
- [Files you ship](#files-you-ship)
- [Local development](#local-development)
- [Publishing](#publishing)

## Overview

This is a temporary and minimal example and integration guide for shipping a **JavaScript** game to Gaming Couch. The `build/` files are exactly what you upload; the `dev/` files let you run the example locally in browser with keyboard as a controller.

The example game is small but exercises the whole contract surface a game touches. Every player drives a colored dot around an arena that is **larger than the screen**, with a camera that follows the pack; you collect a seeded coin to score, and the first to `TARGET` wins. Each pickup briefly **slows** you (a risk with bombs around), and a **bomb** periodically detonates — anyone caught in the blast is **eliminated** for the round. Along the way it drives every HUD feature: per-player **points** (`value`), a **meter** bar that shows the coin **slowdown** draining away, the **eliminated** state, floating **overhead** nametags, and the **off-screen indicator** (`playerPosition`) that only appears because the world is bigger than the viewport.

```
js-game-example/
  README.md                 # this guide
  build/
    gc.game.js              # your game module: export default { setup, play, inputs, pause }
    gc.properties.json      # standard player color palette, loaded at runtime (required to run)
  dev/
    README.md               # how to run the local harness (points back to this guide)
    index.html              # local test page (controls help + scoreboard overlay)
    mock-platform.js        # local test harness + keyboard inputs
```

## How your game runs

You write `build/gc.game.js` as an ES module whose `default` export has four lifecycle hooks. When your game runs, Gaming Couch loads that module, makes your `build/gc.properties.json` available to it, and calls the hooks in order — passing each one the data it needs (players, colors, inputs, and so on). Your game needs no extra library; it only reads the values it is handed.

Lifecycle:

1. `setup(setupContext)` → configure HUD, then call `setupContext.setupDone()`
2. `play(playContext)` → a round starts with players + seed
3. `inputs(playerId, inputs)` per frame / `pause(isPaused)` as needed
4. `gameOver(playerIdsByPlacement)` ends the round

## The game module contract

```js
export default {
  setup(setupContext) {}, // configure HUD; MUST call setupContext.setupDone()
  play(playContext) {}, // start a round with players, seed, colors
  inputs(playerId, inputs) {}, // per-frame controller input for one player
  pause(isPaused) {}, // pause / resume
};
```

### Starter template

> **New here? Start from the full example.** This repo ships a complete, working
> game in [`build/gc.game.js`](./build/gc.game.js) — read that first to see the
> whole contract in action. The skeleton below is just a blank starting point
> once you know your way around.

A blank `gc.game.js` to copy into your `build/` folder and fill in. It wires up
every hook without any game logic — drop your own simulation and rendering into
the marked spots:

```js
// gc.game.js — minimal Gaming Couch game skeleton (no game logic yet).

// Per-round state, built in play() and read by your loop. null between rounds.
let game = null;

export default {
  setup(setupContext) {
    // Only hud.setup() is allowed here. Configure how each player's value/meter
    // is shown (omit the arg for HUD defaults).
    setupContext.hud.setup({ players: { valueType: "pointsSmall" } });

    // Create your canvas / load assets here, before any round starts.
    // ...

    // REQUIRED: tell the platform setup is finished.
    setupContext.setupDone();
  },

  play(playContext) {
    const { players, seed, gameProperties, hud, gameOver } = playContext;

    // Build per-round state from the players + deterministic seed. Resolve each
    // player's color via gameProperties.player.color[player.color].hex.base.
    game = { players, hud, gameOver };

    // Start your loop (e.g. requestAnimationFrame), respecting the pause state.
    // From your loop, push HUD state with hud.updatePlayers(...) and
    // hud.updateScreenPoints(...), and call gameOver(idsByPlacement) to end the
    // round (player ids ordered best→worst).
    if (!playContext.isPaused) {
      // startLoop();
    }
  },

  inputs(playerId, inputs) {
    if (!game) return; // ignore inputs before a round has started
    // inputs = { a0, a1, b0, b1 } — store them for this player and read them
    // in your loop.
    // ...
  },

  pause(isPaused) {
    // Stop or restart your loop to match the platform's pause state.
    // ...
  },
};
```

### `setup(setupContext)`

Only `hud.setup()` is allowed here — `hud.updatePlayers` / `hud.updateScreenPoints` / `hud.clear` **throw** during setup. You **must** call `setupContext.setupDone()` when finished.

| Field            | Type         | Notes                                                                |
| ---------------- | ------------ | -------------------------------------------------------------------- |
| `gameId`         | `string`     | Your game's key (set in devspace)                                    |
| `gameModeId`     | `string`     | Which minigame to boot (set in devspace) — see below                 |
| `gameProperties` | `object`     | Parsed `properties` from `gc.properties.json` (see Players & colors) |
| `hud`            | `object`     | `{ setup(hudConfig?) }` — the only usable HUD call in setup          |
| `setupDone`      | `() => void` | Call when setup completes                                            |
| ~~`clientId`~~   | `number`     | Not currently used — ignore                                          |
| ~~`isHost`~~     | `boolean`    | Not currently used — ignore                                          |
| ~~`isDevMode`~~  | `boolean`    | Not currently used — ignore                                          |

> **One build, multiple minigames.** A single game build can contain several minigames. Each is a separate **game entry** (configured per game entry in devspace) that shares the same `gameId` but has its own `gameModeId`. Read `gameModeId` in `setup()` to decide which minigame to boot from your build.

### `play(playContext)`

| Field            | Type                                       | Notes                                                                                |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `isPaused`       | `boolean`                                  | Initial pause state — respect it before starting your loop                           |
| `seed`           | `number`                                   | Deterministic seed for this boot — feed it to your PRNG so anything random (coin spots, layout, …) is reproducible. The example uses it in `mulberry32`. |
| `players`        | `PlayerGameData[]`                         | The round's players                                                                  |
| `gameProperties` | `object`                                   | Same as in setup                                                                     |
| `hud`            | `object`                                   | `{ updatePlayers(PlayersHudData), updateScreenPoints(HudScreenPointData), clear() }` |
| `gameOver`       | `(playerIdsByPlacement: number[]) => void` | Ends the round. The array is player ids ordered best→worst placement.                |

### `inputs(playerId, inputs)`

The latest controller state for one player:

```js
inputs = { a0, a1, b0, b1 }; // all numbers
```

| Property   | Kind        | Range   |
| ---------- | ----------- | ------- |
| `a0`, `a1` | analog axes | ~ -1..1 |
| `b0`, `b1` | buttons     | 0 / 1   |

The **meaning** of each property depends on the controller layout configured in the dashboard — the game just reads the properties.

### `pause(isPaused)`

The platform toggles pause/resume — pause or resume your gameplay accordingly (the example stops/restarts its loop). Gaming Couch renders the paused UI itself (overlay, etc.); your game only needs to pause the gameplay, not draw anything.

## Players & colors

`playContext.players` is the list of players in the round:

| Field      | Type                         |
| ---------- | ---------------------------- |
| `type`     | `'player' \| 'bot'`          |
| `playerId` | `number`                     |
| `color`    | `PlayerColorKey` (see below) |

There is no player **name** here — the platform's HUD draws names (see [The HUD](#the-hud)), so your game only ever refers to players by `playerId`.

`PlayerColorKey` is one of: `white` (unset), `blue`, `red`, `green`, `cyan`, `yellow`, `purple`, `pink`, `brown`.

Resolve a player's display color from `gameProperties`:

```js
const hex = gameProperties.player.color[player.color].hex.base;
```

Each color exposes both `rgb` and `hex` maps, each with `base`, `light`, `dark`, and `offWhite` variants.

> **Disconnects aren't your concern.** The game is never notified when a player disconnects or quits — there is no player-removal event and no way to drop a player mid-round. Just keep honoring `pause()`.

## The HUD

Gaming Couch renders the on-screen HUD for you — player nametags, the scoreboard, off-screen indicators. Your game only feeds it data through the `hud` object on the contexts; you never draw any of it yourself.

Players recognize themselves on screen by their **color** and the **overhead nametag** above their character (bots currently show as "Bot X"). Drive each player's dot/sprite in its resolved color and anchor a `playerOverhead` point above it (see below) so this works.

### `hud.setup(HudConfig)` — setup phase

Configures the per-player HUD once, before the round starts:

```js
HudConfig = {
  players?: {
    valueType?: 'pointsSmall' | 'status' | 'lives' | 'text', // how each player's `value` is shown
    meterType?: 'bar',                                        // how each player's `meter` is shown
  }
}
```

### `hud.updatePlayers(PlayersHudData)` — play phase

Updates each player's standing. Call it whenever placement / value / meter change:

```js
PlayersHudData = {
  players: Array<{
    playerId: number,
    placement: number,        // 0 = leading
    eliminated?: boolean,     // greys the player out in the HUD (and plays a sfx)
    value?: number | string,  // shown per HudConfig.players.valueType
    meter?: number,           // 0..100, shown per HudConfig.players.meterType
  }>
}
```

Field notes:

- **`value`** — how it's rendered depends on `HudConfig.players.valueType`:
  - **`pointsSmall`** — the platform parses `value` as a **`"current/max"` string** (e.g. `"3/5"`) and draws that many filled segments; a bare number will break it. This example uses it for the score.
  - **`status`** — a **`"text/status"` string** (e.g. `"SLOWED/warning"`), where status is one of `neutral` / `pending` / `success` / `failure` / `warning` / `alert`. The left scoreboard shows the text as a colored badge for **any** status; **only `warning` / `alert` also surface above the head** (as pulsing text).
  - **`text`** — a plain string (left scoreboard only). **`lives`** — not implemented yet.
- **`meter`** — a `0..100` bar rendered in **both** the overhead and the left scoreboard. The bar shows for **any `meter >= 0`** (so `0` is a visible empty bar); only `-1` (or omitting it) hides it. There is **no per-location toggle** — it appears in both places or neither. This example uses it for the coin slowdown: it jumps to 100 on pickup, drains back to 0 as the slowdown wears off, and rests at 0 (empty) otherwise.
- **`eliminated`** — set `true` when a player is knocked out; the HUD dims/marks them but keeps them listed. It's a display flag only — your game still owns who is actually in play.

> **Two data channels per player.** The per-player HUD has exactly two value slots — `value` (rendered per the single, game-wide `valueType`) and `meter` — plus the name. So you can't show, e.g., segmented points **and** a status label at the same time: pick one for `value`, and use `meter` for the other quantity.

### `hud.updateScreenPoints(HudScreenPointData)` — play phase

Positions per-player overlays in screen space: a **nametag** above each player, and an **off-screen indicator** when a player moves out of view. Your game is what knows where each player is on screen, so send this every frame (or whenever positions change):

```js
HudScreenPointData = {
  points: Array<
    | { type: 'playerOverhead', playerId: number, x: number, y: number, isOffScreen: boolean }
    | { type: 'playerPosition', playerId: number, x: number, y: number, isOffScreen: boolean }
  >,
}
```

- **`playerOverhead`** anchors that player's overhead HUD — nametag, leader crown, and the `value` / `meter` from `updatePlayers` — at the given screen point. Use this for the floating nametag above a character.
- **`playerPosition`** tracks where the player is on screen. When `isOffScreen` is `true`, Gaming Couch shows an indicator pinned to the nearest screen edge so everyone can see where an off-screen rival is.
- **`x` / `y`** are normalized screen coordinates — `x` `0`→`1` left→right, `y` `0`→`1` bottom→top.
- **`isOffScreen`** is `true` when the player is outside the visible area.

> **The off-screen indicator only shows when players can actually leave the view.** The example's world is bigger than the viewport and a camera follows the pack, so `playerPosition` points genuinely go off-screen and the edge indicator appears (see `worldToScreen` / `buildScreenPoints` in `gc.game.js`). If your whole play field always fits on screen, `isOffScreen` stays `false` and the indicator never draws — that's expected.

### `hud.clear()` — play phase

Removes all HUD overlays.

## The controller (configured in the dashboard, not shipped)

The controller is **not** part of your build — you do not build or ship any controller UI yourself. You pick a layout and configure it per game-entry in the devspace dashboard via `controller_config`. Gaming Couch renders the chosen layout on each player's device and maps its widgets to the `a0/a1/b0/b1` properties your `inputs()` hook reads.

**Layouts:** `buttons-lr`, `buttons-lrc`, `stick-single`, `stick-double`.

**Controls:**

| Control                 | Fields                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `stick`                 | `axes: 'x' \| 'y' \| 'xy'`, `throw: 30..80`, `mode?: 'swipe'` |
| `primary` / `secondary` | `label`, `hint`, `labelSecondary`, `hintSecondary`            |

## Files you ship

You upload a zip of your `build/` output (plus any assets it loads).

| File                       | Required                                               | Purpose                                         |
| -------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| `build/gc.game.js`         | **Yes** (the only hard requirement enforced at upload) | Your game module                                |
| `build/gc.properties.json` | Required to run                                        | Fetched at runtime; the standard player palette |

Do **not** include a `gc.metadata.json` file: uploads that contain one are rejected. That file is gone — the platform-data file is now `gc.platform.json`, which the devspace tooling (DevApp / Dashboard) generates for you rather than something you hand-write. Nothing about your catalog listing is read from a file in your build at runtime.

The authoritative **live** catalog values — `name`, `players`, `categories`, `guide`, descriptions, and `controller_config` — are set in the devspace dashboard.

**Zip rules:** only files with allowed extensions are bundled. Limits: 150 MB zip, 500 MB extracted, 50 MB per file, 100 files.

## Local development

The `dev/` harness lets you run the example in a plain browser, with the keyboard standing in for the controller. It must be served over **http** (ES module imports — `file://` will not work). Serve from the **repository root** (not from `dev/`): the harness loads `../build/gc.game.js`, so the sibling `build/` folder has to be reachable. Pick one of the options below.

**Option 1 — Node**:

```sh
npx serve   # from the repository root
# then open <printed url>/js-game-example/dev/index.html
```

**Option 2 — Python**:

```sh
python -m http.server   # from the repository root
# then open <printed url>/js-game-example/dev/index.html
```

**Controls:**

- **Arrow keys** drive the currently selected player (starts on P1).
- **Number keys `1`–`N`** point the arrow keys at any player — including a bot, which you grab off its AI for as long as you hold the keys.
- **WASD** always drives player 2.
- **`P`** toggles pause.

The camera follows the pack, so a player can roam off the visible area — an off-screen indicator is then pinned to the nearest edge, and when the **coin** itself scrolls off-screen a gold arrow at the edge points toward it (inset so it stays clear of the HUD). Grabbing a coin briefly **slows** you (shown as a pale ring on the dot and a draining meter bar in the HUD) — awkward timing with a bomb about. Watch for the red **bomb**: it telegraphs with a growing danger ring, and any player still inside the blast when it detonates is eliminated (dimmed and struck out in the scoreboard) for the rest of the round.

**Top bar:**

The bar at the top of the page sets the **player count** (`1`–`8`), the **bot count** (`0`–player count, auto-clamped), and the **seed** — either rolled randomly each run or pinned to a fixed, editable value. All three persist to `localStorage`; because players and seed are fixed once a round starts, changes take effect when you hit **Restart**.

Bots fill from the **end** of the list — 8 players with 2 bots makes players 1–6 human and 7–8 bots. Bots are driven by the game itself (they chase the coin with a bit of wander); point the keyboard at one to grab control while you hold the keys.

## Publishing

1. **Request devspace access.** Ask for an invite in the [Gaming Couch Discord](https://discord.gg/gamingcouch).
2. **Create your game** in the [devspace dashboard](https://devspace.gamingcouch.com/) (if you haven't already).
3. **Upload your `build/` folder** via the devspace dashboard.
4. **Create a new game entry, or edit an existing one,** and set it to use your uploaded build.
