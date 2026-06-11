# 🎹 PULSEFALL

**Every track is born the moment you press play.**

A 4-lane rhythm game with no audio files. The music — synthwave kicks, snares, basslines, pads, and lead melodies — is composed and synthesized **live in your browser** with the Web Audio API. The beatmap is derived from the same generated score, so every note you hit is perfectly synced to the sound by construction.

![PULSEFALL gameplay](screenshot.png)

## How to play

- Notes fall down four lanes — hit **D F J K** (or arrow keys, or tap the lanes) when they cross the line
- **PERFECT / GREAT / GOOD / MISS** timing judgment with early/late hints
- Chain hits to build combo; finish for a grade (**SS / S / A / B / C / D**) and a Full Combo badge
- **Calibrate** — tap along to a metronome for 8 beats and the game measures your personal audio latency

## Tracks

| Track | BPM | Mood |
|---|---|---|
| Neon Runner | 122 | classic drive |
| Midnight Drive | 100 | late-night chill |
| Overdrive | 146 | peak-hour chaos |
| **Daily Drop** | varies | a brand-new track every day, same for everyone — share your grade |

Three difficulties (Easy / Normal / Hard) with different note density, approach speed, and chords on Hard.

## Tech

Zero engine, zero assets — vanilla JavaScript, Canvas 2D, Web Audio:

- **Procedural composer**: seeded PRNG generates a full song structure (intro → verse → chorus → bridge → outro) over a chord progression, with a pentatonic random-walk melody that snaps to chord tones on strong beats
- **Synthesized instruments**: pitch-dropping sine kick, noise-burst snare, filtered saw bass, detuned-saw leads through a feedback echo bus, slow-attack pads
- **Sample-accurate scheduling** via the Web Audio clock (lookahead scheduler) — the game clock *is* the audio clock, so judgment never drifts
- **Beatmap generator**: music events become note candidates (melody > snare > kick > hats), filtered by per-difficulty minimum gaps, lanes assigned by melodic contour
- Tap-to-calibrate latency offset, audio-reactive synthwave background (grid and sun pulse on the actual beat)

## Run locally

```bash
npm install
npm start
# → http://localhost:4311
```

## License

MIT
