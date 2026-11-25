# Fairbay Heat

**An open-world 3D street racer in the browser, built without a game engine.**
Inspired by *Need for Speed: Most Wanted* (2013): drive freely around a city,
find parked cars and jack them, drift to fill your nitro, hit jumps.

![Drifting downtown](docs/screenshots/04-drift.png)

## Play

**Live: https://fairbay-heat.vercel.app** (deployed on Vercel; every push to `main` on
[GitHub](https://github.com/DIVYAPRIYADHARSHINI-GIT/fairbay-heat) auto-deploys).

Run locally:

```bash
npm install
npm run dev        # http://localhost:5173
# or the production build:
npm run build && npm run preview   # http://localhost:4173
```

Click once into the page if keys don't respond, then use the keyboard.

| Key | Action |
| --- | --- |
| **W / ↑** | Accelerate |
| **S / ↓** | Brake, then reverse |
| **A D / ← →** | Steer |
| **Space** | Handbrake (start a drift) |
| **Shift** | Nitro |
| **E** | Jack a parked car you've pulled up next to |
| **G** | Garage: switch between found cars, change paint |
| **C** | Camera: chase, far chase, bumper |
| **Tab** | City map |
| **R** | Put the car back on the road |
| **T** | Skip time +3 h |
| **M** | Mute · **F** FPS counter · **H** Controls |
| **Esc / P** | Pause |

Menus are fully keyboard-driven (↑↓ choose, ←→ change, Enter select, Esc back).
Progress (found cars, current car, position, bests, settings) saves
automatically in the browser.

## Cars

Stylised, fictional takes on Most Wanted 2013 cars. The names resemble the
real cars but are not the trademarks. 0–100 km/h time and top speed are
calibrated per car and verified by unit tests.

| In game | Inspired by | Class | 0–100 | Top speed |
| --- | --- | --- | --- | --- |
| Fjord Mustanger GT (starter) | Ford Mustang GT | Muscle, RWD | 4.8 s | 250 km/h |
| Porsa 911 Carrara S | Porsche 911 Carrera S | Sports, RWD | 4.3 s | 304 km/h |
| Ashton Marvin V12 Vantis | Aston Martin V12 Vantage | Sports, RWD | 4.2 s | 305 km/h |
| Nissun GT-Arr Premium | Nissan GT-R | Sports, AWD | 3.2 s | 315 km/h |
| Lamborgino Aventura LP700 | Lamborghini Aventador | Super, AWD | 2.9 s | 350 km/h |
| Bugarri Veyrone 16.4 | Bugatti Veyron | Hyper, AWD | 2.5 s | 407 km/h |

There are 12 jack spots across the map, parked at the kerb of named roads (orange dots on the minimap and map).

## The map

Fairbay is a **hand-designed map** (no grid): 72 named, curving roads and
42 junctions over ~2.6 x 2.6 km, all defined in `src/game/mapdata.ts`.

- **Fairbay Circle**: a six-exit roundabout with a fountain at the heart of Downtown.
- Six curving avenues radiate from it, crossed by the inner **Crescent** and the outer **Ring Road** boulevard, so blocks are wedges and curves.
- The **Fairbay Loop** freeway (3 lanes each way, concrete median) circles everything, with 8 interchanges.
- **Old Town** and **Hillcrest** to the north, **Ironworks** (tank farms) to the east, **Port Fairbay** (containers, gantry cranes) and **Sunset Beach** on the south coast.
- The **Fair River** runs from a mountain lake to the sea; the **Riverside Bridge** and the **Coast Highway** bridge cross it to **Westside**.
- **Calder Pass**: a hairpin mountain road with guard rails over Mount Calder (150 m summit) down to Westside.
- Real terrain (hills, river valley, beaches), road embankments, 7 off-road jump ramps, ~3,900 trees, traffic lights, street signs, a full day/night cycle.

## Stage 2: traffic

~64 vehicles (sedans, hatchbacks, SUVs, taxis, vans, pickups, buses) drive
around the player on the lane graph (`src/game/traffic.ts`):

- **Car following** uses the Intelligent Driver Model (the standard model in traffic research): safe time gap, smooth acceleration, harder braking when close.
- They **stop at red lights** (2-phase signals at 24 junctions), **give way** at priority junctions and when entering the roundabout, slow for curves, use **indicators**, and show **brake lights**.
- A junction reservation system stops them driving through each other; left-turners clear on yellow; a deadlock breaker creeps through after a long wait.
- They brake for you if you stop in their lane, **honk**, and get **knocked away** with hazard lights when you ram them.

## Sound

The engine is a **physically-modelled synthesiser** (`src/audio/engineSynth.ts`)
running on the audio thread. It simulates each cylinder firing in order, with
per-cylinder and per-cycle variation, into exhaust pipe resonators, a tail
pipe and a muffler:

- Each car has its own engine: cross-plane V8 burble (Mustanger), flat-6 (Carrara), V12s (Vantis, Aventura), twin-turbo V6 (GT-Arr) and quad-turbo W16 (Veyrone).
- A real 6-speed gearbox: the revs drop on each upshift and blip on downshifts; there is a rev limiter.
- Turbo whistle and blow-off "pssh", overrun pops and crackles, intake roar.
- Tyre squeal, road and gravel noise, wind, echo off buildings downtown, traffic engines with Doppler, horns, crash and landing sounds.

## How it's built: no game engine

Three.js is used **only to draw triangles** (WebGL renderer, materials,
bloom post-processing, the sky shader). Everything that makes it a game is
plain TypeScript in this repo:

| Module | What it does |
| --- | --- |
| `src/game/physics.ts` | Arcade car physics: engine curve auto-calibrated to each car's 0–100 / top speed, braking/reverse, bicycle-model steering with a grip limit, handbrake + power-over drifts, nitro, ramps/jumps, wall collisions with wall-riding. Fixed 120 Hz timestep. |
| `src/game/collision.ts` | Circle-vs-box / circle-vs-circle tests with a spatial hash |
| `src/game/mapdata.ts`, `roads.ts`, `world.ts` | The hand-made map, road network (curves, junctions, elevation, bridges, lane graph, signals) and the world (terrain, water, buildings along curved roads, props, ground/surface queries) |
| `src/game/traffic.ts` | Traffic AI (IDM car-following, signals, give-way, junction reservation, collisions) |
| `src/game/jack.ts`, `save.ts`, `scoring.ts` | Jack spots, defensive localStorage save, drift and jump scoring |
| `src/render/carModel.ts` | Cars generated from body dimensions: lofted body with cut wheel arches, greenhouse, lights, spoilers, wheels |
| `src/render/worldMesh.ts`, `trafficView.ts` | Road ribbons with markings, junctions, bridges, terrain, water, buildings merged into chunks, instanced props and traffic |
| `src/render/textures.ts` | Every texture is drawn on a canvas at load time. No image files. |
| `src/render/environment.ts`, `effects.ts`, `cameraRig.ts` | Day/night, tyre smoke, skid marks, sparks, nitro flames, speed lines, chase/bumper cameras |
| `src/audio/engineSynth.ts`, `audio.ts` | Physically-modelled engine (AudioWorklet), tyres, wind, traffic, horns, crashes: all synthesised. No audio files. |
| `src/core/input.ts` | Held-key + pressed-edge keyboard input by physical key code |

The whole game is a 0.7 MB static site (185 KB gzipped) with no assets to download.

## Tests

```bash
npm test     # typecheck + unit + e2e
```

- **81 unit tests** (Vitest) covering:
  - **Physics:** 0-100 km/h and top speed for each car, braking, steering, drifting, timestep independence, walls, jumps.
  - **Map:** every lane reachable both ways, grades within 10% (15% on the pass), no step in the surface anywhere along any lane, no building on a road or in water or overlapping another, lanes clear of obstacles, bridges over the river, signal phases never both green.
  - **Traffic:** IDM behaviour, plus a 5-minute headless soak with 110 cars: **zero** cars passing through each other, **zero** red-light runs, no gridlock. Also braking for the player, ramming and determinism.
  - **Engine sound**, rendered offline and analysed: the firing frequency is the dominant tone, pitch follows rpm, the V8 has 3x more burble than the V12/W16, full throttle is louder than overrun, the rev limiter chops the sound, the turbo spools and blows off, crackles on lift-off, and different cars sound different.
  - Save files, jack spots and scoring.
- **82 end-to-end checks** (`tests/e2e.mjs`) run the real build in Chrome with **real key presses**. They cover menus, driving, braking and reversing, drift, nitro, crashing into a building, a ramp jump and jacking a car. They check that the engine runs on the audio thread, that the engine model matches the car, that throttle is louder than idle, that the revs drop on each upshift and that M mutes. For traffic they check it populates and moves, includes several vehicle types, stays on the roads, and that ramming a car knocks it out. They also drive up the mountain, cross the bridge, test the camera/map/pause/time/garage keys, persistence across reload and night mode, require 60 fps, and fail on any console error.

Measured: **60 fps at 1440 x 900** with traffic (Apple M1, Chrome, High quality).

## Roadmap

1. ✅ **Stage 1**: driving physics, 6 cars, jack spots, garage, day/night, HUD
2. ✅ **Stage 2**: hand-made map, traffic AI, realistic engine sound
3. Stage 3: police chases, heat levels, roadblocks, escapes
4. Stage 4: races against AI, speed cameras, speed-trap events, more cars
