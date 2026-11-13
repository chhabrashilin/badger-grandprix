# Badger Grand Prix

A 3D arcade kart racer: badgers versus the nation's college mascots on a Madison-themed circuit.
It has no build step.

## Run

Serve this folder with Python 3:

```
python -m http.server 8000 --bind 127.0.0.1
```

Open http://localhost:8000. Press Ctrl+C to stop the server.
Alternatively, from this folder run `npx browser-sync start --server . --port 8000`.
ES modules do not load from `file://`, so a server is required.

## How it plays

- 8 karts, 2/3/5 laps, three difficulty levels.
- 1–4 players in split-screen. Everyone is a badger; only one player can be Bucky.
- First pick your character and kart, then choose a starting power-up and bonus. Each player's choices are highlighted.
- The blue BOOST bar refills automatically (12.5 seconds from empty to full when not boosting). Hold E on keyboard, Y on a gamepad, or BOOST on touch to spend it for extra speed. Player 2 uses / on keyboard.
- Hold drift through corners to charge boost faster; release after a long drift for a mini-boost.
- Item boxes give throwables and power-ups: Cheese Curd, Homing Football, Butter Slick,
  Ice Cream Boost, Cheesehead Shield, Jump Around (invincibility) and Blizzard.
- Gold arrow pads have SPEED BOOST signs: drive over them for a free burst of speed and extra boost charge. One pad also launches a jump.
- Kart collisions push both racers with fading knockback; heavier karts resist more.

Collision physics tests (Node.js): `node --test tests/collision.test.mjs` from this folder.

## Rival speed modifiers (live data)

On load the game calls ESPN's public college-football API:

- AP Top 25 teams are faster: +4.0% for #1 sliding to +1.6% for #25.
- Teams Wisconsin has beaten this season are 2.5% slower.
- A ranked team that lost to Wisconsin always keeps at least a +0.5% edge.
- A few random rivals each race get a +2% "hot streak".

If the API is unreachable the race runs with no ranking modifiers and the grid screen says so.

## Controls

| | Steer | Gas / Brake | Drift | Nitro | Item |
|---|---|---|---|---|---|
| Solo keyboard | A/D or ←/→ | W/S or ↑/↓ | Shift | E | Space |
| P1 keyboard | A/D | W/S | Left Shift | E | Q |
| P2 keyboard | ←/→ | ↑/↓ | Right Shift | / | Enter |
| Gamepad (P1–P4) | Left stick | RT / LT | RB | Y | X |
| Phone | Tilt (or ◀ ▶) | automatic / BRAKE | DRIFT | NITRO | ITEM |

Esc pauses, M mutes. Tilt steering needs HTTPS on iOS and a tap on "Enable tilt steering".

`?auto=N` starts an AI-driven demo race with N badgers (`&skip=S` fast-forwards S seconds, `&q=low|medium|high` sets graphics, `&front=1` is a front-facing photo camera).

## Graphics and performance

The title screen has a Graphics option: Auto (default), Low, Med, High.

- **Low** draws straight to the screen with baked contact shadows. **Med** adds real sun shadows.
  **High** adds 2048 px shadows, 4x anti-aliasing and HDR bloom (meant for dedicated GPUs).
- **Auto** picks a tier from the GPU (integrated graphics start on Low) and then scales the render
  resolution up or down every ~45 frames to hold 60 fps. Tier changes only happen between races,
  because they recompile shaders.
- Static scenery is merged into a few batches per 220 m world cell, trees are instanced per cell so
  off-screen ones are culled, the sky is rendered once into a cubemap, and all shaders are compiled
  behind the loading screen.
- A service worker (`sw.js`) caches the game for instant repeat loads and offline play.

Debug flags: `?stats=45` logs frame time, draw calls and triangles; `&noadapt=1` freezes the
scaler; `&scale=0.7` fixes the render scale; `&nosw=1` skips the service worker.

## Layout

- `src/gfx.js` renderer, sky shader, lighting, shadows, bloom, split-screen compositing

- `src/track.js` circuit spline, road mesh, scenery
- `src/kart.js` kart model and driving physics
- `src/race.js` AI, items, collisions, standings
- `src/rankings.js` ESPN data and speed modifiers
- `src/input.js` keyboard, gamepad, tilt, touch
- `src/bake.js` static batching
- `src/show.js` grandstands, fans, camera flashes, confetti, blimp, big screen
- `src/main.js` menus, cameras, HUD
- `vendor/` Three.js r160 and its post-processing/geometry addons (MIT)
