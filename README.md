
# Badger Grand Prix

A 3D arcade kart racer featuring Wisconsin badgers competing against college mascots on a Madison-themed circuit. Supports up to four local players, kart customization, power-ups, and AI opponents whose performance is influenced by real college football rankings.

## Gameplay Demo

[![Badger Grand Prix Gameplay](https://img.youtube.com/vi/XjU-OOyqINQ/maxresdefault.jpg)](https://youtu.be/XjU-OOyqINQ)

[Watch gameplay on YouTube](https://youtu.be/XjU-OOyqINQ)

## Getting Started

No build step is required.

Start a local server using Python 3:

```bash
python -m http.server 8000 --bind 127.0.0.1
```

Open http://localhost:8000 in your browser. Press Ctrl+C to stop the server.

Alternatively, use BrowserSync:

```bash
npx browser-sync start --server . --port 8000
```

A local server is required because ES modules cannot be loaded directly from `file://`.

## Features

- Eight karts per race with options for 2, 3, or 5 laps
- Three difficulty levels
- Local split-screen multiplayer for up to four players
- Character and kart selection, including starting power-ups and bonuses
- Drifting, rechargeable nitro boost, and mini-boosts
- Seven collectible items and power-ups
- Speed boost pads, jumps, and kart collision physics
- AI opponents with speed modifiers based on college football rankings
- Keyboard, gamepad, and mobile touch controls
- Adaptive graphics settings and offline caching

## Gameplay

### Boost and Drifting

The boost meter recharges automatically, taking approximately 12.5 seconds to refill from empty when not boosting.

Players can spend boost for additional speed. Drifting through corners increases the recharge rate, and releasing a sufficiently long drift activates a mini-boost.

Gold speed pads provide a temporary speed increase and additional boost charge. One pad also launches the kart into a jump.

### Items

Item boxes provide one of seven items:

| Item | Effect |
|---|---|
| Cheese Curd | Throwable item |
| Homing Football | Homing projectile |
| Butter Slick | Track hazard |
| Ice Cream Boost | Temporary speed boost |
| Cheesehead Shield | Defensive protection |
| Jump Around | Temporary invincibility |
| Blizzard | Area-effect power-up |

Kart collisions apply knockback to both racers. Heavier karts are less affected, and knockback decreases over time.

## Controls

| Action | Solo Keyboard | Player 1 | Player 2 | Gamepad | Mobile |
|---|---|---|---|---|---|
| Steer | A/D or Left/Right | A/D | Left/Right | Left stick | Tilt or on-screen arrows |
| Accelerate | W or Up | W | Up | RT | Automatic |
| Brake | S or Down | S | Down | LT | BRAKE |
| Drift | Shift | Left Shift | Right Shift | RB | DRIFT |
| Boost | E | E | / | Y | NITRO |
| Item | Space | Q | Enter | X | ITEM |

Additional controls:

- `Esc`: Pause
- `M`: Toggle audio

Mobile tilt steering requires HTTPS on iOS and must be enabled through the on-screen prompt.

## College Football Rankings

The game retrieves live college football data from ESPN's public API when it loads.

AI opponent speeds are adjusted using the following rules:

- AP Top 25 teams receive a speed increase ranging from 4.0% for the first-ranked team to 1.6% for the 25th-ranked team.
- Teams defeated by Wisconsin during the current season receive a 2.5% speed reduction.
- Ranked teams that lost to Wisconsin retain a minimum 0.5% speed advantage.
- A randomly selected group of rivals receives an additional 2% speed increase for each race.

If the API is unavailable, races continue without ranking-based modifiers. The starting grid indicates when live data could not be retrieved.

## Graphics and Performance

The game always runs the **HD** path: soft sun shadows, MSAA, HDR bloom, and sky-based reflections. There is no Low / Medium picker.

To hold 60 FPS without dropping visual features, the renderer:

- Scales internal resolution silently when frames slip (never demotes the HD tier)
- Updates the sun shadow map every other frame
- Keeps foliage on cheap blob shadows so hundreds of trees do not fill the shadow map
- Batches static scenery into world cells for frustum culling
- Precaches the shell in a service worker for instant reloads

Additional optimizations include:

- Instanced trees with cell-based culling
- Pre-rendered sky cubemap (mipmapped) for background + reflections
- Shader compilation during loading
- Frozen matrices on static meshes

## Demo and Debug Options

An automated race can be started using URL parameters:

```text
http://localhost:8000/?auto=4
```

Available parameters:

| Parameter | Description |
|---|---|
| `auto=N` | Starts an AI-controlled demonstration with N badgers |
| `skip=S` | Fast-forwards S seconds |
| `q=high` | HD is always on (kept for debug URLs) |
| `front=1` | Enables a front-facing camera |
| `stats=45` | Logs frame time, draw calls, and triangle counts |
| `noadapt=1` | Disables automatic resolution scaling |
| `scale=0.7` | Fixes rendering resolution at 70% |
| `nosw=1` | Disables service worker registration |

## Testing

Collision physics tests use the built-in Node.js test runner.

Run the tests from the project directory:

```bash
node --test tests/collision.test.mjs
```

## Project Structure

```text
src/
  gfx.js        Rendering, lighting, shadows, bloom, and split-screen
  track.js      Circuit geometry, road mesh, and scenery
  kart.js       Kart models and driving physics
  race.js       AI opponents, items, collisions, and standings
  rankings.js   ESPN data integration and speed modifiers
  input.js      Keyboard, gamepad, tilt, and touch input
  bake.js       Static geometry batching
  show.js       Grandstands, spectators, and race presentation
  main.js       Menus, cameras, and HUD

vendor/         Three.js r160 and related addons
sw.js           Service worker for asset caching
tests/          Collision physics tests
```

## Dependencies

The game uses Three.js r160 for 3D rendering, along with its post-processing and geometry addons.

Dependencies are included in `vendor/`, so no package installation or build process is necessary.

Three.js is distributed under the MIT License.
