# Lumen Loom

A seated, hands-only light-weaving puzzle for Meta Quest, built with the Immersive Web SDK (WebXR).

Pinch a mirror and turn your wrist; the beam swings with you. Light every seed and the loom is woven, then stitched into a tapestry of light on your real table.

**Play:** open the GitHub Pages link of this repository in the Meta Quest Browser, sit at a table, press **Start Weaving**, and put the controllers down.

## How to play
- **Pinch + twist** a mirror: it turns in 22.5° clicks (about 15° of wrist per click).
- **Tap** the bead on a mirror with one finger: it steps one click. Every puzzle can be finished this way.
- **Pinch + carry** a loose mirror to a glowing socket.
- **Prisms** pass light and turn it at once; **twin seeds** need light twice.
- Poke the glowing orb to go to the next loom. After six looms comes the **Daily Weave** (a new puzzle every day, the same for everyone), then endless **Free Weave**.
- If your table is awkward, pinch the handle on the near edge to slide the loom.

## Mixed reality
The game starts an immersive AR session with hand tracking, plane detection and mesh detection. It looks for a scene mesh labelled table, desk or counter under the loom (falling back to detected horizontal planes, ignoring the floor) and settles the loom 10 cm above it. Beams, a light pool and the tapestry are drawn on that surface.

## Build
```
npm install
npm run dev      # IWSDK dev server with the Meta Quest 3 emulator
npm run build    # static build in dist/
```
The `docs/` folder holds the static build served by GitHub Pages.

## Code
- `src/loom/logic.ts` — pure puzzle logic: grid, beam tracing, levels, solver, Daily Weave generator.
- `src/loom/loom-system.ts` — rendering, hand interaction (pinch, wrist twist, carry, tap), table finding, tapestry, save.
- `src/loom/audio.ts` — procedural Web Audio sound (no audio files).

## License
MIT
