# Fairbay Heat

**An open-world 3D street racer in the browser, built without a game engine.**
Inspired by *Need for Speed: Most Wanted* (2013): drive freely around a city,
find parked cars and jack them, drift to fill your nitro, hit jumps, and
outrun the Fairbay PD.

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

Every car has its own detailing styled after the real car: headlight and tail-light graphics, grille pattern, wheel design and colour, brake caliper colour, door seams and handles, splitter, side skirts, diffuser and number plates. Each car also has its own steering feel, set by five numbers: lock, how quickly the wheel winds on, how quickly it re-centres, how calm it gets at high speed, and how loose the rear is. Examples: the Mustanger is heavy and tail-happy, the Aventura razor-sharp, the Veyrone calm and planted. The garage shows a steering description for each car, and **Settings > Steering sensitivity** scales all of them. Traffic vehicles have shaped bodies too (sloped screens, rooflines, wheel arches, mirrors, bumpers, taxi signs, bus destination boards).

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

Fairbay is a **hand-designed, asymmetric map** (no grid, no rings), in the
spirit of GTA / NFS Most Wanted: 143 named roads and 83 junctions,
31.5 km of road, all defined in `src/game/mapdata.ts`.

- **Interstate 9** crosses the whole map west to east. It bridges the Fair River, then runs on an **elevated viaduct** through Midtown (level deck, 7.5 m over the streets, column bents) to the Airfield.
- **Frontage (service) roads** run underneath the viaduct on both sides: one-way, 2 lanes, with signals at every avenue. **On/off ramps** connect them to I-9 at both ends.
- **Route 7 Bayshore Expressway** runs north from the container port to I-9.
- Wherever a highway crosses a street without a junction, the road network automatically lifts it onto an **overpass**. The physics, traffic and camera all understand stacked roads, so you can drive on the deck or underneath it.
- **Downtown** towers stand on the shore of Fairbay Bay, with Waterfront Drive along the water. **Midtown** has avenues running under the viaduct, the curving Kingsway and the diagonal Grand Avenue.
- **Old Town** has winding streets around a small roundabout square, plus **Central Park**. Further out are the **Hillcrest** suburbs and **Ridge Parkway** along the northern hills.
- The **Fairbay Airfield** has a 460 m runway (a top-speed strip) with a jump at the end. **Ironworks** has tank farms, **Port Fairbay** has containers and cranes, and the **Coast Highway** runs along **Sunset Beach**.
- The **Calder Pass** hairpins climb over Mount Calder (150 m) and down to **Westside** across the river.
- Lanes are **4.0-4.2 m wide** (freeway 4.1 m with 2.8 m shoulders, the roundabout ring 7.6 m), about 15% wider than real-world minimums, so there is room to weave through traffic at speed.

## Stage 2: traffic

Up to 48 vehicles (sedans, hatchbacks, SUVs, taxis, vans, pickups, buses) drive
around the player on the lane graph (`src/game/traffic.ts`):

- **Car following** uses the Intelligent Driver Model (the standard model in traffic research): safe time gap, smooth acceleration, harder braking when close.
- They **stop at red lights** (2-phase signals at 24 junctions), **give way** at priority junctions and when entering the roundabout, slow for curves, use **indicators**, and show **brake lights**.
- A junction reservation system stops them driving through each other; left-turners clear on yellow; a deadlock breaker creeps through after a long wait.
- They brake for you if you stop in their lane, **honk**, and get **knocked away** with hazard lights when you ram them.
- Like real cars they **turn about their rear axle**: the rear wheels follow the lane while the nose swings into the turn (no spinning about the middle).

## Stage 3: police chases

The Fairbay PD (`src/game/police.ts`, `src/game/heat.ts`):

- **Patrol cars** drive in traffic like everyone else (lanes, lights, car following). Each one watches a 140 m, 150-degree cone ahead, and buildings block its view.
- **Offences only count if a cop sees them:** speeding (over 95 km/h in town, 140 km/h on highways), hitting traffic, ramming a police car, smashing lamp posts. The patrol that saw it turns into a pursuit unit on the spot, siren on.
- **Heat levels 1-5** rise with your bounty and with how long the chase lasts. More heat means more units (2 up to 6), faster **Enforcer** cars alongside the **Interceptors**, and from heat 3 **roadblocks**: police cars parked at an angle across the road ahead of you, out of sight, with one gap about 3 m wide at a kerb.
- **Units are real physics cars** with the same arcade physics as yours. They follow the roads to you (A* route over the road network, braking for every corner) and use lead pursuit when they can see you. At heat 1 they tail you; from heat 2 they get alongside and **PIT** the rear quarter. They steer around traffic, crash through it if they have to, back out when stuck, and are taken out if you ram them hard enough (a takedown adds bounty).
- **Escape:** break line of sight with every unit. After 5 s the **cooldown** starts: hide until the bar fills (longer at high heat, faster the further away you are). Any unit or patrol that spots you restarts the pursuit. Escaping banks the bounty.
- **Busted:** stop with a unit alongside, or get boxed in by two, and the busted meter fills in about 3 s (it drains when you get moving). You lose the chase's bounty.
- **Presentation:** black-and-white livery with POLICE doors, a roof light bar flashing red/blue (per car, instanced: the whole police force costs a fixed number of draw calls), siren glow, red/blue light splashing on the street at night, a synthesised **wail/yelp siren** with Doppler shift and panning, a heat meter with stars, the bounty and an evade/cooldown bar, a busted meter, flashing police blips on the minimap, and BUSTED / ESCAPED screens.
- **Settings > Police chases** turns them off for free roaming.

## Sound

The engine is a **physically-modelled synthesiser** (`src/audio/engineSynth.ts`)
running on the audio thread. It simulates each cylinder firing in order, with
per-cylinder and per-cycle variation, into exhaust pipe resonators, a tail
pipe and a muffler:

- Each car has its own engine: cross-plane V8 burble (Mustanger), flat-6 (Carrara), V12s (Vantis, Aventura), twin-turbo V6 (GT-Arr) and quad-turbo W16 (Veyrone).
- A real 6-speed gearbox: the revs drop on each upshift and blip on downshifts; there is a rev limiter.
- Turbo whistle, overrun pops and crackles, intake roar. There is no hiss on gear changes; a unit test asserts the high-frequency energy does not jump after an upshift.
- Tyre squeal, road and gravel noise, wind, echo off buildings downtown, traffic engines with Doppler, horns, crash and landing sounds.

## How it's built: no game engine

Three.js is used **only to draw triangles** (WebGL renderer, materials,
bloom post-processing, the sky shader). Everything that makes it a game is
plain TypeScript in this repo:

| Module | What it does |
| --- | --- |
| `src/game/physics.ts` | Arcade car physics: engine curve auto-calibrated to each car's 0–100 / top speed, braking/reverse, bicycle-model steering with a grip limit, the car turns about its rear axle (tyre cornering force keeps the rear wheels rolling along their heading), handbrake + power-over drifts, nitro, ramps/jumps, wall collisions with wall-riding. Fixed 120 Hz timestep. |
| `src/game/collision.ts` | Circle-vs-box / circle-vs-circle tests with a spatial hash |
| `src/game/mapdata.ts`, `roads.ts`, `world.ts` | The hand-made map, road network (curves, junctions, elevation, bridges, lane graph, signals) and the world (terrain, water, buildings along curved roads, props, ground/surface queries) |
| `src/game/traffic.ts` | Traffic AI (IDM car-following, signals, give-way, junction reservation, collisions) |
| `src/game/heat.ts`, `police.ts` | Wanted system (offences, heat levels, cooldown, busted) and police AI (patrols, road-following pursuit, PIT, roadblocks, line of sight) |
| `src/game/jack.ts`, `save.ts`, `scoring.ts` | Jack spots, defensive localStorage save, drift and jump scoring |
| `src/render/carModel.ts` | Cars generated from body dimensions: lofted body with cut wheel arches, greenhouse, lights, spoilers, wheels |
| `src/render/worldMesh.ts`, `trafficView.ts`, `policeView.ts` | Road ribbons with markings, junctions, bridges, terrain, water, buildings merged into chunks, instanced props, traffic and police cars |
| `src/render/textures.ts` | Every texture is drawn on a canvas at load time. No image files. |
| `src/render/environment.ts`, `effects.ts`, `cameraRig.ts` | Day/night, tyre smoke, skid marks, sparks, nitro flames, speed lines, chase/bumper cameras |
| `src/audio/engineSynth.ts`, `audio.ts` | Physically-modelled engine (AudioWorklet), tyres, wind, traffic, horns, sirens, crashes: all synthesised. No audio files. |
| `src/core/input.ts` | Held-key + pressed-edge keyboard input by physical key code |

The whole game is a 0.86 MB static site (237 KB gzipped) with no assets to download.

## Tests

```bash
npm test     # typecheck + unit + e2e
```

- **114 unit tests** (Vitest) covering:
  - **Physics:** 0-100 km/h and top speed for each car, braking, steering (per-car feel, and the car turning about its rear axle - the instantaneous turn centre is measured on the rear-axle line), drifting, timestep independence, walls, jumps.
  - **Map:** every lane reachable both ways, grades within 10% (15% on the pass), no step in the surface anywhere along any lane, no building on a road or in water or overlapping another, lanes clear of obstacles, bridges over the river, signal phases never both green.
  - **Traffic:** IDM behaviour, plus a 5-minute headless soak with 110 cars: **zero** cars passing through each other, **zero** red-light runs, no gridlock. Rear axles stay on the lane path through turns. Also braking for the player, ramming and determinism.
  - **Engine sound**, rendered offline and analysed: the firing frequency is the dominant tone, pitch follows rpm, the V8 has 3x more burble than the V12/W16, full throttle is louder than overrun, the rev limiter chops the sound, the turbo spools up, gear changes make no hiss, crackles on lift-off, and different cars sound different.
  - **Police and heat:** offences only count when seen, rate limits, heat rising with bounty and time, cooldown and escape, busted meter and boxing in. Headless chases with a scripted getaway driver: units follow the roads to a stopped player and bust them without ramming them away, a fast car escapes, a slow one is caught, heat 1 tails while heat 3 PITs, roadblocks leave a gap a car wide, patrols that see you speeding join the chase, buildings block vision, traffic brakes for police cars, and the player never ends up inside a police car in a chase through traffic.
  - Save files, jack spots and scoring.
- **103 end-to-end checks** (`tests/e2e.mjs`) run the real build in Chrome with **real key presses**. They cover menus, driving, braking and reversing, drift, nitro, crashing into a building, a ramp jump and jacking a car. They check that the engine runs on the audio thread, that the engine model matches the car, that throttle is louder than idle, that the revs drop on each upshift and that M mutes. For traffic they check it populates and moves, includes several vehicle types, stays on the roads, and that ramming a car knocks it out. They also drive up the mountain, cross the bridge, drive the viaduct and the frontage road under it, test the camera/map/pause/time/garage keys, the steering-sensitivity setting, a full police chase (speeding past a patrol starts it, the HUD heat meter and alert, getting busted, a heat-3 roadblock ahead of you, sirens, minimap blips, cooldown and escape), the police on/off setting, persistence across reload and night mode (headlights must not white out the view behind a car or facing a wall), require the display's full frame rate, and fail on any console error.

Measured: **60 fps at 1440 x 900** with traffic (Apple M1, Chrome, High quality).

## Roadmap

1. ✅ **Stage 1**: driving physics, 6 cars, jack spots, garage, day/night, HUD
2. ✅ **Stage 2**: hand-made map, traffic AI, realistic engine sound
3. ✅ **Stage 3**: police chases, heat levels, roadblocks, escapes
4. Stage 4: races against AI, speed cameras, speed-trap events, more cars
