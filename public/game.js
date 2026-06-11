'use strict';
/* PULSEFALL — every track is born the moment you press play.
   No audio files: the music is synthesized live with the Web Audio API,
   and the beatmap is derived from the same score, so sync is perfect
   by construction. */
(() => {

// ============================================================ helpers
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^= h >>> 16) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ============================================================ canvas
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const DPR = Math.min(window.devicePixelRatio || 1, 2);
let W = 0, H = 0;
let playX = 0, playW = 0, laneW = 0, hitY = 0, horizonY = 0;
let stars = [];

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  playW = Math.min(W * 0.94, 470);
  playX = (W - playW) / 2;
  laneW = playW / 4;
  hitY = H * 0.84;
  horizonY = H * 0.36;
  stars = [];
  const n = Math.round((W * horizonY) / 9000);
  for (let i = 0; i < n; i++) {
    stars.push({ x: Math.random() * W, y: Math.random() * horizonY * 0.92, r: Math.random() * 1.5 + 0.4, p: Math.random() * TAU });
  }
  buildNoteSprites();
}

// ============================================================ visuals: sprites
const LANE_COLORS = ['#4df3ff', '#ff4da6', '#b44dff', '#ffd166'];
const LANE_RGB = ['77,243,255', '255,77,166', '180,77,255', '255,209,102'];
let noteSprites = [];

function buildNoteSprites() {
  noteSprites = LANE_COLORS.map((col, i) => {
    const w = Math.max(40, Math.round(laneW * 0.84)), h = Math.max(16, Math.round(laneW * 0.21));
    const pad = 26;
    const c = document.createElement('canvas');
    c.width = w + pad * 2; c.height = h + pad * 2;
    const g = c.getContext('2d');
    g.shadowColor = col;
    g.shadowBlur = 18;
    g.fillStyle = col;
    roundRect(g, pad, pad, w, h, h / 2);
    g.fill();
    g.shadowBlur = 0;
    const grad = g.createLinearGradient(0, pad, 0, pad + h);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.45, `rgba(${LANE_RGB[i]},0.4)`);
    grad.addColorStop(1, 'rgba(0,0,0,0.25)');
    g.fillStyle = grad;
    roundRect(g, pad, pad, w, h, h / 2);
    g.fill();
    return { c, w: c.width, h: c.height, pad };
  });
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ============================================================ audio core
const AC = {
  ctx: null, master: null, delay: null, delayGain: null, noise: null,
  on: localStorage.getItem('pf_mute') !== '1',
  init() {
    if (this.ctx) return true;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      // shared echo bus for leads
      this.delay = this.ctx.createDelay(1);
      this.delayGain = this.ctx.createGain();
      this.delayGain.gain.value = 0.3;
      const fb = this.ctx.createGain();
      fb.gain.value = 0.34;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3200;
      this.delay.connect(fb); fb.connect(lp); lp.connect(this.delay);
      this.delay.connect(this.delayGain);
      this.delayGain.connect(this.master);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return true;
    } catch (e) { return false; }
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') return this.ctx.resume(); return Promise.resolve(); },
  running() { return !!this.ctx && this.ctx.state === 'running'; },
  env(when, peak, attack, dur, curve = 0.0001) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
    g.gain.exponentialRampToValueAtTime(curve, when + dur);
    g.connect(this.master);
    return g;
  },
  kick(when, v = 1) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, when);
    o.frequency.exponentialRampToValueAtTime(48, when + 0.11);
    o.connect(this.env(when, 0.85 * v, 0.004, 0.24));
    o.start(when); o.stop(when + 0.3);
  },
  snare(when, v = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.8;
    s.connect(bp); bp.connect(this.env(when, 0.4 * v, 0.003, 0.19));
    s.start(when); s.stop(when + 0.25);
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, when);
    o.frequency.exponentialRampToValueAtTime(140, when + 0.08);
    o.connect(this.env(when, 0.25 * v, 0.003, 0.1));
    o.start(when); o.stop(when + 0.15);
  },
  hat(when, open = false, v = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7800;
    const dur = open ? 0.22 : 0.045;
    s.connect(hp); hp.connect(this.env(when, 0.11 * v, 0.002, dur));
    s.start(when); s.stop(when + dur + 0.05);
  },
  bass(when, freq, dur, v = 1) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, when);
    lp.frequency.exponentialRampToValueAtTime(320, when + dur);
    lp.Q.value = 2;
    o.connect(lp);
    lp.connect(this.env(when, 0.3 * v, 0.008, dur));
    o.start(when); o.stop(when + dur + 0.05);
  },
  lead(when, freq, dur, v = 1) {
    const g = this.env(when, 0.22 * v, 0.012, dur, 0.001);
    for (const det of [-6, 6]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3400, when);
      lp.frequency.exponentialRampToValueAtTime(1100, when + dur);
      o.connect(lp); lp.connect(g);
      o.start(when); o.stop(when + dur + 0.05);
    }
    // echo send
    const send = this.ctx.createGain();
    send.gain.value = 0.5;
    g.connect(send); send.connect(this.delay);
  },
  arp(when, freq, v = 1) {
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    o.connect(lp); lp.connect(this.env(when, 0.07 * v, 0.005, 0.12));
    o.start(when); o.stop(when + 0.17);
  },
  pad(when, freqs, dur, v = 1) {
    for (const f of freqs) {
      for (const det of [-5, 4]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 1100;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.linearRampToValueAtTime(0.045 * v, when + dur * 0.3);
        g.gain.setValueAtTime(0.045 * v, when + dur * 0.75);
        g.gain.linearRampToValueAtTime(0.0001, when + dur);
        o.connect(lp); lp.connect(g); g.connect(this.master);
        o.start(when); o.stop(when + dur + 0.05);
      }
    }
  },
  sub(when, freq, dur, v = 1) {
    // 808-style sub: sine with a fast pitch drop and long decay
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 2.2, when);
    o.frequency.exponentialRampToValueAtTime(freq, when + 0.045);
    o.connect(this.env(when, 0.5 * v, 0.005, dur));
    o.start(when); o.stop(when + dur + 0.05);
  },
  keys(when, freq, dur, v = 1) {
    // warm lo-fi keys pluck
    const g = this.env(when, 0.26 * v, 0.008, dur, 0.001);
    for (const det of [-4, 3]) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      o.detune.value = det;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2100, when);
      lp.frequency.exponentialRampToValueAtTime(750, when + dur);
      o.connect(lp); lp.connect(g);
      o.start(when); o.stop(when + dur + 0.05);
    }
    const send = this.ctx.createGain();
    send.gain.value = 0.22;
    g.connect(send); send.connect(this.delay);
  },
  crackleStart() {
    // looped vinyl crackle bed for the lo-fi tracks
    if (!this.ctx) return null;
    if (!this.crackleBuf) {
      const len = this.ctx.sampleRate * 3;
      this.crackleBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.crackleBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.012;
      for (let p = 0; p < 70; p++) {
        const at = Math.floor(Math.random() * (len - 200));
        const amp = 0.08 + Math.random() * 0.3;
        for (let k = 0; k < 120; k++) d[at + k] += (Math.random() * 2 - 1) * amp * Math.exp(-k / 18);
      }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.crackleBuf;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 4200;
    const g = this.ctx.createGain();
    g.gain.value = 0.5;
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start();
    return src;
  },
  crackleStop(src) {
    if (src) { try { src.stop(); } catch (e) {} }
  },
  tick(when, accent = false) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = accent ? 1320 : 880;
    o.connect(this.env(when, 0.3, 0.002, 0.07));
    o.start(when); o.stop(when + 0.12);
  },
  hitsound() {
    if (!this.running() || !this.on) return;
    const w = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1500;
    o.connect(this.env(w, 0.08, 0.001, 0.04));
    o.start(w); o.stop(w + 0.08);
  },
  duck(dur = 0.25) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0.0001, t + dur);
    this.master.gain.setValueAtTime(this.on ? 0.55 : 0.0001, t + dur + 0.3);
  },
  applyMute() {
    if (this.ctx) this.master.gain.value = this.on ? 0.55 : 0.0001;
  },
};

// ============================================================ composer
const F = semi => 110 * Math.pow(2, semi / 12); // A2 base

const PROGS = [
  [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]],   // Am F C G
  [[0, 3, 7], [5, 8, 12], [8, 12, 15], [10, 14, 17]],   // Am Dm F G
  [[0, 3, 7], [3, 7, 10], [8, 12, 15], [7, 10, 14]],    // Am C F Em
  [[0, 3, 7], [10, 14, 17], [8, 12, 15], [3, 7, 10]],   // Am G F C
];

const PENTA = [0, 3, 5, 7, 10];
const pentaSemi = idx => PENTA[((idx % 5) + 5) % 5] + 12 * Math.floor(idx / 5);

const MEL_TEMPLATES = [
  [0, 4, 7, 12, 16, 20, 23, 28],
  [0, 3, 6, 12, 14, 16, 22, 24, 28, 30],
  [0, 6, 8, 14, 16, 18, 24, 26],
  [0, 2, 4, 8, 12, 16, 18, 20, 24, 28],
  [0, 4, 6, 10, 16, 20, 22, 26, 30],
];

function composeTrack(cfg) {
  const rnd = mulberry32(hashStr(cfg.seed));
  const bpm = cfg.bpm;
  const beat = 60 / bpm;
  const step = beat / 4;
  const LEAD_IN = 1.4;
  const style = cfg.style; // 'drive' | 'chill' | 'intense'

  const sections = [
    { name: 'intro', bars: 4 },
    { name: 'verse', bars: 8 },
    { name: 'chorus', bars: 8 },
    { name: 'verse', bars: 8 },
    { name: 'chorus', bars: 8 },
    { name: 'outro', bars: 4 },
  ];

  const prog = PROGS[Math.floor(rnd() * PROGS.length)];
  const events = [];      // audio events {t, fn, ...}
  const cands = [];       // beatmap candidates {t, kind, pitch, si}
  const sectionMarks = [];

  const ev = (t, fn, o = {}) => events.push({ t: LEAD_IN + t, fn, ...o });
  const cd = (t, kind, pitch, si) => cands.push({ t: LEAD_IN + t, kind, pitch, si });

  // melody phrase generator (2 bars = 32 steps)
  let melIdx = 4 + Math.floor(rnd() * 4);
  function phrase(barT, chordA, chordB, density, vol) {
    const tpl = MEL_TEMPLATES[Math.floor(rnd() * MEL_TEMPLATES.length)];
    const steps = tpl.filter(() => rnd() < density);
    for (let i = 0; i < steps.length; i++) {
      const si = steps[i];
      const chord = si < 16 ? chordA : chordB;
      melIdx += [-2, -1, -1, 1, 1, 2][Math.floor(rnd() * 6)];
      melIdx = clamp(melIdx, 2, 12);
      let semi = pentaSemi(melIdx);
      if (si % 8 === 0) { // snap strong beats toward chord tones
        let best = semi, bd = 99;
        for (const cSemi of chord) {
          for (const oct of [0, 12]) {
            const d = Math.abs(cSemi + oct - semi);
            if (d < bd) { bd = d; best = cSemi + oct; }
          }
        }
        semi = best;
      }
      const t = barT + si * step;
      const nextSi = steps[i + 1] !== undefined ? steps[i + 1] : si + 6;
      const dur = Math.max(step * 1.6, Math.min((nextSi - si) * step * 0.92, step * 5));
      ev(t, 'lead', { freq: F(semi + 24), dur, v: vol });
      cd(t, 'mel', semi, si);
    }
  }

  let bar = 0;
  for (const sec of sections) {
    sectionMarks.push({ t: LEAD_IN + bar * 16 * step, name: sec.name });
    for (let b = 0; b < sec.bars; b++, bar++) {
      const barT = bar * 16 * step;
      const chord = prog[bar % 4];
      const inIntro = sec.name === 'intro';
      const inVerse = sec.name === 'verse';
      const inChorus = sec.name === 'chorus';
      const inOutro = sec.name === 'outro';

      // pads everywhere
      ev(barT, 'pad', { freqs: chord.map(s => F(s + 12)), dur: 16 * step, v: inChorus ? 1.15 : 1 });

      // kick
      const kickSteps = inIntro ? (b < 2 ? [0, 8] : [0, 4, 8, 12])
        : inOutro ? [0, 8]
        : [0, 4, 8, 12];
      for (const s of kickSteps) {
        ev(barT + s * step, 'kick', { v: inOutro ? 0.7 : 1 });
        if (!inIntro && !inOutro) cd(barT + s * step, 'kick', null, s);
      }

      // snare on 2 & 4
      if (inVerse || inChorus) {
        for (const s of [4, 12]) {
          ev(barT + s * step, 'snare', { v: inChorus ? 1 : 0.7 });
          cd(barT + s * step, 'snare', null, s);
        }
      }

      // hats
      if (inVerse || inChorus) {
        const hatSteps = inChorus || style === 'intense'
          ? [0, 2, 4, 6, 8, 10, 12, 14]
          : [2, 6, 10, 14];
        for (const s of hatSteps) {
          const open = inChorus && s === 14 && b % 2 === 1;
          ev(barT + s * step, 'hat', { open, v: 1 });
          if (inChorus) cd(barT + s * step, 'tick', null, s);
        }
      }

      // bass 8ths
      if (!inIntro || b >= 2) {
        for (let s = 0; s < 16; s += 2) {
          const oct = (s === 6 || s === 14) && rnd() < 0.6 ? 12 : 0;
          ev(barT + s * step, 'bass', { freq: F(chord[0] - 12 + oct), dur: step * 1.7, v: inOutro ? 0.6 : 1 });
        }
      }

      // arp 16ths in chorus (and intense verses)
      if (inChorus || (style === 'intense' && inVerse)) {
        for (let s = 0; s < 16; s++) {
          ev(barT + s * step, 'arp', { freq: F(chord[s % 3] + 24), v: inChorus ? 1 : 0.7 });
        }
      }

      // melody: phrases start every 2 bars in verse/chorus
      if ((inVerse || inChorus) && bar % 2 === 0) {
        const chordB = prog[(bar + 1) % 4];
        const density = inChorus
          ? (style === 'chill' ? 0.75 : 0.95)
          : (style === 'chill' ? 0.5 : style === 'intense' ? 0.85 : 0.65);
        phrase(barT, chord, chordB, density, inChorus ? 1 : 0.8);
      }
      // sparse echo melody in outro
      if (inOutro && b === 0) phrase(barT, chord, prog[(bar + 1) % 4], 0.4, 0.6);
    }
  }

  events.sort((a, b) => a.t - b.t);
  cands.sort((a, b) => a.t - b.t);
  const duration = LEAD_IN + bar * 16 * step;
  return { bpm, beat, step, leadIn: LEAD_IN, duration, events, cands, sectionMarks };
}

// ============================================================ beatmap
const DIFFS = {
  easy:   { minGap: 0.36, approach: 1.7,  chords: false, ticks: false },
  normal: { minGap: 0.20, approach: 1.35, chords: false, ticks: false },
  hard:   { minGap: 0.115, approach: 1.05, chords: true,  ticks: true },
};

function makeBeatmap(track, diff, seedStr) {
  const D = DIFFS[diff];
  const rnd = mulberry32(hashStr(seedStr + ':' + diff));
  const PRIO = { mel: 3, snare: 2, kick: 1, tick: 0 };

  // group candidates by quantized time
  const groups = [];
  let cur = null;
  for (const c of track.cands) {
    if (c.kind === 'tick' && !D.ticks) continue;
    if (!cur || Math.abs(c.t - cur.t) > 0.001) {
      cur = { t: c.t, list: [c] };
      groups.push(cur);
    } else cur.list.push(c);
  }

  const notes = [];
  let lastT = -10, prevLane = Math.floor(rnd() * 4), prevLane2 = -1, prevPitch = null;
  let kickSide = 0, snareSide = 0;

  const pickLane = (c) => {
    let lane;
    if (c.kind === 'mel') {
      if (prevPitch === null || c.pitch === prevPitch) lane = prevLane;
      else if (c.pitch > prevPitch) lane = Math.min(prevLane + (c.pitch - prevPitch > 4 ? 2 : 1), 3);
      else lane = Math.max(prevLane - (prevPitch - c.pitch > 4 ? 2 : 1), 0);
      prevPitch = c.pitch;
    } else if (c.kind === 'kick') {
      lane = kickSide === 0 ? 0 : 3; kickSide ^= 1;
    } else if (c.kind === 'snare') {
      lane = snareSide === 0 ? 1 : 2; snareSide ^= 1;
    } else {
      lane = (prevLane + 2) % 4;
    }
    // avoid triples on the same lane
    if (lane === prevLane && lane === prevLane2) lane = lane === 3 ? 2 : lane + 1;
    prevLane2 = prevLane; prevLane = lane;
    return lane;
  };

  for (const g of groups) {
    if (g.t - lastT < D.minGap - 0.001) continue;
    g.list.sort((a, b) => PRIO[b.kind] - PRIO[a.kind]);
    const main = g.list[0];
    const lane = pickLane(main);
    notes.push({ t: g.t, lane, state: 0, dt: 0 });
    // chords on accents in hard
    if (D.chords && g.list.length > 1 && main.si % 4 === 0 && rnd() < 0.55) {
      let lane2 = (lane + 2) % 4;
      if (lane2 === lane) lane2 = (lane + 1) % 4;
      notes.push({ t: g.t, lane: lane2, state: 0, dt: 0 });
    }
    lastT = g.t;
  }

  notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  return notes;
}

// ============================================================ arranged songs (public-domain compositions, original hip-hop arrangements)
// All melodies transcribed from PD scores: Beethoven (1810), Grieg (1875), Joplin (1902).
// Semitones are absolute offsets from A2 (110 Hz).

const DRUM_KITS = {
  boombap: {
    light: { kick: [0, 10], snare: [], hat: [0, 4, 8, 12], ohat: [] },
    full:  { kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], ohat: [] },
    max:   { kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 11, 12, 14], ohat: [14] },
  },
  trap: {
    light: { kick: [0], snare: [], hat: [0, 2, 4, 6, 8, 10, 12, 14], ohat: [] },
    full:  { kick: [0, 6, 10], snare: [8], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ohat: [] },
    max:   { kick: [0, 6, 10, 13], snare: [8], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ohat: [4] },
  },
  oldschool: {
    light: { kick: [0, 10], snare: [], hat: [0, 4, 8, 12], ohat: [] },
    full:  { kick: [0, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], ohat: [] },
    max:   { kick: [0, 6, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 9, 10, 12, 14], ohat: [12] },
  },
  hyper: {
    light: { kick: [0, 8], snare: [], hat: [2, 6, 10, 14], ohat: [] },
    full:  { kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], ohat: [14] },
    max:   { kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ohat: [6, 14] },
  },
  y2k: {
    light: { kick: [0, 10], snare: [], hat: [0, 4, 8, 12], ohat: [] },
    full:  { kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 3, 4, 6, 8, 10, 11, 12, 14], ohat: [] },
    max:   { kick: [0, 7, 10, 13], snare: [4, 12], hat: [0, 2, 3, 4, 6, 8, 10, 11, 12, 14, 15], ohat: [12] },
  },
  house: {
    light: { kick: [0, 4, 8, 12], snare: [], hat: [2, 6, 10, 14], ohat: [] },
    full:  { kick: [0, 4, 8, 12], snare: [4, 12], hat: [], ohat: [2, 6, 10, 14] },
    max:   { kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], ohat: [2, 6, 10, 14] },
  },
};

// Für Elise — main theme, A section (8 bars, 16th-step grid)
const MEL_FE_A = [
  [0, 31], [2, 30], [4, 31], [6, 30], [8, 31], [10, 26], [12, 29], [14, 27],
  [16, 24, 4], [24, 15], [26, 19], [28, 24],
  [32, 26, 4], [40, 19], [42, 23], [44, 26],
  [48, 27, 4], [56, 19], [58, 31], [60, 30],
  [64, 31], [66, 30], [68, 31], [70, 30], [72, 31], [74, 26], [76, 29], [78, 27],
  [80, 24, 4], [88, 15], [90, 19], [92, 24],
  [96, 26, 4], [104, 29], [106, 27], [108, 26],
  [112, 24, 8],
];
const MEL_FE_BR = [
  [0, 0, 2], [4, 3, 2], [8, 7, 2], [12, 12, 2],
  [16, 12, 2], [20, 7, 2], [24, 3, 2], [28, 0, 2],
  [32, -5, 2], [36, -1, 2], [40, 2, 2], [44, 7, 2],
  [48, 7, 2], [52, 2, 2], [56, -1, 2], [60, -5, 2],
];
const FE_ROOTS_A = [-12, -12, -17, -12, -12, -12, -17, -12];
const FE_STABS_A = [[12, 15, 19], [12, 15, 19], [11, 14, 19], [12, 15, 19], [12, 15, 19], [12, 15, 19], [11, 14, 19], [12, 15, 19]];

// In the Hall of the Mountain King — theme (transposed to A minor), 8 bars
const MEL_MK_A = [
  [0, 0], [2, 2], [4, 3], [6, 5], [8, 7], [10, 3], [12, 7, 4],
  [16, 0], [18, 2], [20, 3], [22, 5], [24, 7], [26, 3], [28, 7, 4],
  [32, 6], [34, 2], [36, 6, 4],
  [48, 5], [50, 1], [52, 5, 4],
  [64, 0], [66, 2], [68, 3], [70, 5], [72, 7], [74, 3], [76, 7, 4],
  [80, 0], [82, 2], [84, 3], [86, 5], [88, 7], [90, 3], [92, 7, 4],
  [96, 12], [98, 10], [100, 7], [102, 3], [104, 7], [106, 10],
  [112, 12, 6],
];
const MEL_MK_HALF = MEL_MK_A.slice(0, 14); // first two phrases only (for the break)
const MK_ROOTS_A = [-12, -12, -6, -7, -12, -12, -12, -12];

// The Entertainer — opening strain (8 bars)
const MEL_ENT_A = [
  [0, 17], [1, 18], [2, 19], [3, 27, 2], [5, 19], [6, 27, 2], [8, 19], [9, 27, 4],
  [16, 17], [17, 18], [18, 19], [19, 27, 2], [21, 19], [22, 27, 2], [24, 19], [25, 27, 4],
  [32, 27], [33, 29], [34, 30], [35, 31], [36, 27], [37, 29], [38, 31, 2], [40, 26], [42, 29], [44, 27, 4],
  [64, 17], [65, 18], [66, 19], [67, 27, 2], [69, 19], [70, 27, 2], [72, 19], [73, 27, 4],
  [80, 17], [81, 18], [82, 19], [83, 27, 2], [85, 19], [86, 27, 2], [88, 19], [89, 27, 4],
  [96, 27], [97, 29], [98, 30], [99, 31], [100, 27], [101, 29], [102, 31, 2], [104, 26], [106, 29], [108, 27, 4],
  [112, 31], [114, 29], [116, 27], [118, 22], [120, 27, 6],
];
const MEL_ENT_BR = [
  [0, 15, 2], [4, 19, 2], [8, 22, 2], [12, 24, 2],
  [16, 22, 2], [20, 19, 2], [24, 15, 2],
  [32, 14, 2], [36, 17, 2], [40, 22, 2], [44, 26, 2],
  [48, 24, 4], [56, 22, 2], [60, 19, 2],
];
const ENT_ROOTS_A = [-9, -9, -14, -14, -9, -9, -14, -9];
const ENT_STABS_A = [[15, 19, 22], [15, 19, 22], [10, 14, 17], [10, 14, 17], [15, 19, 22], [15, 19, 22], [10, 14, 17], [15, 19, 22]];

// HYPERGLOW — original hyperpop hook in E major (150 BPM)
const MEL_HG_A = [
  [0, 19, 2], [4, 23, 2], [8, 26, 3], [12, 23, 2],
  [16, 21, 2], [20, 19, 2], [24, 21, 4],
  [32, 19, 2], [36, 23, 2], [40, 26, 3], [44, 28, 2],
  [48, 26, 2], [52, 23, 2], [56, 26, 4],
  [64, 19, 2], [68, 23, 2], [72, 26, 3], [76, 23, 2],
  [80, 21, 2], [84, 19, 2], [88, 16, 4],
  [96, 14, 2], [100, 16, 2], [104, 19, 3], [108, 21, 2], [112, 23, 2], [116, 26, 2], [120, 28, 4],
];
const MEL_HG_B = [
  [0, 31], [2, 28], [4, 26], [6, 28], [8, 31, 2], [12, 33, 2],
  [16, 31], [18, 28], [20, 26], [22, 23], [24, 26, 4],
  [32, 31], [34, 28], [36, 26], [38, 28], [40, 31, 2], [44, 35, 2],
  [48, 33], [50, 31], [52, 28], [54, 31], [56, 33, 4],
  [64, 31], [66, 28], [68, 26], [70, 28], [72, 31, 2], [76, 33, 2],
  [80, 31], [82, 28], [84, 26], [86, 23], [88, 26, 4],
  [96, 28], [98, 26], [100, 28], [102, 31, 2], [106, 33, 2], [110, 35, 2],
  [112, 31, 6],
];
const MEL_HG_BR = [
  [0, 23, 4], [8, 26, 4], [16, 28, 4], [24, 26, 4],
  [32, 23, 4], [40, 21, 4], [48, 19, 6],
];
const ROOTS_HG = [-5, -10, -8, -12];
const STABS_HG = [[19, 23, 26], [14, 18, 21], [16, 19, 23], [12, 16, 19]];

// VENOM — original dark Y2K pop in D minor (143 BPM)
const MEL_VN_A = [
  [0, 17, 1], [2, 18, 1], [4, 17, 1], [6, 13, 2], [10, 12, 3],
  [16, 17, 1], [18, 18, 1], [20, 17, 1], [22, 20, 2], [26, 17, 3],
  [32, 22, 1], [34, 20, 1], [36, 22, 1], [38, 25, 2], [42, 24, 3],
  [48, 22, 1], [50, 20, 1], [52, 19, 1], [54, 20, 2], [58, 17, 3],
  [64, 17, 1], [66, 18, 1], [68, 17, 1], [70, 13, 2], [74, 12, 3],
  [80, 17, 1], [82, 18, 1], [84, 17, 1], [86, 20, 2], [90, 17, 3],
  [96, 22, 1], [98, 20, 1], [100, 22, 1], [102, 25, 2], [106, 24, 3],
  [112, 13, 1], [114, 15, 1], [116, 17, 1], [118, 18, 1], [120, 17, 4],
];
const MEL_VN_B = [
  [0, 29, 2], [4, 27, 2], [8, 25, 2], [12, 27, 2], [16, 29, 2], [20, 28, 2], [24, 29, 4],
  [32, 25, 2], [36, 27, 2], [40, 29, 2], [44, 32, 2], [48, 29, 2], [52, 27, 2], [56, 25, 4],
  [64, 29, 2], [68, 27, 2], [72, 25, 2], [76, 27, 2], [80, 29, 2], [84, 28, 2], [88, 29, 4],
  [96, 25, 2], [100, 27, 2], [104, 29, 2], [108, 28, 2], [112, 29, 6],
];
const MEL_VN_BR = [
  [0, 12, 3], [8, 13, 3], [16, 15, 3], [24, 17, 3],
  [32, 18, 2], [36, 17, 2], [40, 15, 2], [44, 13, 2], [48, 12, 8],
];
const ROOTS_VN = [-7, -11, -9, -12];
const STABS_VN = [[17, 20, 24], [13, 17, 20], [15, 19, 22], [12, 16, 19]];

// NIGHTSWIM — original melodic-bassline club hook in A minor (138 BPM)
const MEL_NS_A = [
  [0, 0, 3], [6, 7, 2], [10, 5, 2], [14, 3, 2],
  [16, 0, 3], [22, 7, 2], [26, 10, 2], [30, 12, 2],
  [32, 12, 3], [38, 10, 2], [42, 7, 2], [46, 5, 2],
  [48, 3, 3], [54, 5, 2], [58, 7, 4],
  [64, 0, 3], [70, 7, 2], [74, 5, 2], [78, 3, 2],
  [80, 0, 3], [86, 7, 2], [90, 10, 2], [94, 12, 2],
  [96, 15, 3], [102, 12, 2], [106, 10, 2], [110, 7, 2],
  [112, 5, 3], [118, 7, 2], [122, 3, 4],
];
const MEL_NS_BR = [
  [0, 12, 4], [8, 10, 4], [16, 7, 4], [24, 5, 4],
  [32, 3, 4], [40, 5, 4], [48, 7, 8],
];
const STABS_NS = [[12, 15, 19], [8, 12, 15], [15, 19, 22], [10, 14, 17]];

const SONGS = {
  furelise: {
    bpm: 90, style: 'boombap', swing: 0.16, melVoice: 'keys', crackle: true,
    sections: [
      { name: 'intro', bars: 2, drums: 'light', roots: [-12] },
      { name: 'verse', bars: 8, drums: 'full', mel: MEL_FE_A, roots: FE_ROOTS_A, stabs: FE_STABS_A },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_FE_A, roots: FE_ROOTS_A, stabs: FE_STABS_A },
      { name: 'bridge', bars: 4, drums: 'light', mel: MEL_FE_BR, roots: [-12, -12, -17, -17] },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_FE_A, roots: FE_ROOTS_A, stabs: FE_STABS_A },
      { name: 'outro', bars: 2, drums: 'light', roots: [-12] },
    ],
  },
  mountainking: {
    bpm: 140, style: 'trap', swing: 0, melVoice: 'lead', crackle: false,
    sections: [
      { name: 'intro', bars: 4, drums: 'light', roots: [-12], stabs: [[0, 3, 7]] },
      { name: 'verse', bars: 8, drums: 'full', mel: MEL_MK_A, roots: MK_ROOTS_A, stabs: [[0, 3, 7]] },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_MK_A, transpose: 12, roots: MK_ROOTS_A, stabs: [[0, 3, 7]] },
      { name: 'bridge', bars: 2, drums: 'light', mel: MEL_MK_HALF, roots: [-12] },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_MK_A, transpose: 12, roots: MK_ROOTS_A, stabs: [[0, 3, 7]] },
      { name: 'outro', bars: 2, drums: 'light', roots: [-12] },
    ],
  },
  entertainer: {
    bpm: 92, style: 'oldschool', swing: 0.12, melVoice: 'keys', crackle: true,
    sections: [
      { name: 'intro', bars: 2, drums: 'light', roots: [-9] },
      { name: 'verse', bars: 8, drums: 'full', mel: MEL_ENT_A, roots: ENT_ROOTS_A, stabs: ENT_STABS_A },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_ENT_A, roots: ENT_ROOTS_A, stabs: ENT_STABS_A },
      { name: 'bridge', bars: 4, drums: 'light', mel: MEL_ENT_BR, roots: [-9, -14, -9, -14] },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_ENT_A, roots: ENT_ROOTS_A, stabs: ENT_STABS_A },
      { name: 'outro', bars: 2, drums: 'light', roots: [-9] },
    ],
  },
  hyperglow: {
    bpm: 150, style: 'hyper', swing: 0, melVoice: 'lead', crackle: false,
    sections: [
      { name: 'intro', bars: 2, drums: 'light', roots: ROOTS_HG, stabs: STABS_HG },
      { name: 'verse', bars: 8, drums: 'full', mel: MEL_HG_A, roots: ROOTS_HG, stabs: STABS_HG },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_HG_B, roots: ROOTS_HG, stabs: STABS_HG },
      { name: 'bridge', bars: 4, drums: 'light', mel: MEL_HG_BR, roots: [-5, -10, -8, -12] },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_HG_B, roots: ROOTS_HG, stabs: STABS_HG },
      { name: 'outro', bars: 2, drums: 'light', roots: ROOTS_HG },
    ],
  },
  venom: {
    bpm: 143, style: 'y2k', swing: 0.06, melVoice: 'keys', crackle: false,
    sections: [
      { name: 'intro', bars: 2, drums: 'light', roots: [-7] },
      { name: 'verse', bars: 8, drums: 'full', mel: MEL_VN_A, roots: ROOTS_VN, stabs: STABS_VN },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_VN_B, voice: 'lead', roots: ROOTS_VN, stabs: STABS_VN },
      { name: 'bridge', bars: 4, drums: 'light', mel: MEL_VN_BR, roots: [-7] },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_VN_B, voice: 'lead', roots: ROOTS_VN, stabs: STABS_VN },
      { name: 'outro', bars: 2, drums: 'light', roots: [-7] },
    ],
  },
  nightswim: {
    bpm: 138, style: 'house', swing: 0, melVoice: 'lead', crackle: false,
    sections: [
      { name: 'intro', bars: 2, drums: 'light', roots: [-12] },
      { name: 'verse', bars: 8, drums: 'full', mel: MEL_NS_A },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_NS_A, stabs: STABS_NS },
      { name: 'bridge', bars: 4, drums: 'light', mel: MEL_NS_BR, roots: [-12] },
      { name: 'chorus', bars: 8, drums: 'max', mel: MEL_NS_A, stabs: STABS_NS },
      { name: 'outro', bars: 2, drums: 'light', roots: [-12] },
    ],
  },
};

function expandSong(cfg) {
  const def = SONGS[cfg.song];
  const beat = 60 / def.bpm;
  const step = beat / 4;
  const LEAD_IN = 1.4;
  const swing = def.swing || 0;
  const events = [], cands = [], sectionMarks = [];
  let bar = 0;
  const tOf = gs => LEAD_IN + (gs + (Math.round(gs) % 2 === 1 ? swing : 0)) * step;

  for (const sec of def.sections) {
    sectionMarks.push({ t: tOf(bar * 16), name: sec.name });
    const base = bar * 16;
    const tr = sec.transpose || 0;
    if (sec.mel) {
      const voice = sec.voice || def.melVoice;
      for (const m of sec.mel) {
        const s = m[0], semi = m[1] + tr, durSteps = m[2] || 2;
        const t = tOf(base + s);
        const dur = Math.max(step * 1.6, durSteps * step * 0.95);
        events.push({ t, fn: voice, freq: F(semi), dur, v: voice === 'lead' ? 1.1 : 1 });
        cands.push({ t, kind: 'mel', pitch: semi, si: s % 16 });
      }
    }
    for (let b = 0; b < sec.bars; b++) {
      const bs = base + b * 16;
      const root = sec.roots ? sec.roots[b % sec.roots.length] : null;
      const P = DRUM_KITS[def.style][sec.drums];
      const full = sec.drums !== 'light';
      if (P) {
        for (const s of P.kick) {
          events.push({ t: tOf(bs + s), fn: 'kick', v: 1 });
          if (root !== null) events.push({ t: tOf(bs + s), fn: 'sub', freq: F(root), dur: step * 3.5, v: 1 });
          if (full) cands.push({ t: tOf(bs + s), kind: 'kick', pitch: null, si: s });
        }
        for (const s of P.snare) {
          events.push({ t: tOf(bs + s), fn: 'snare', v: 1 });
          if (full) cands.push({ t: tOf(bs + s), kind: 'snare', pitch: null, si: s });
        }
        for (const s of P.hat) {
          events.push({ t: tOf(bs + s), fn: 'hat', open: false, v: 1 });
          if (sec.drums === 'max') cands.push({ t: tOf(bs + s), kind: 'tick', pitch: null, si: s });
        }
        for (const s of P.ohat) events.push({ t: tOf(bs + s), fn: 'hat', open: true, v: 1 });
      }
      if (sec.stabs) {
        const ch = sec.stabs[b % sec.stabs.length];
        if (def.style === 'trap' || def.style === 'house') {
          events.push({ t: tOf(bs), fn: 'pad', freqs: ch.map(s => F(s)), dur: 16 * step, v: 0.85 });
        } else {
          for (const s of [0, 10]) {
            for (const cs of ch) events.push({ t: tOf(bs + s), fn: 'keys', freq: F(cs), dur: step * 2.2, v: 0.34 });
          }
        }
      }
    }
    bar += sec.bars;
  }

  events.sort((a, b) => a.t - b.t);
  cands.sort((a, b) => a.t - b.t);
  return {
    bpm: def.bpm, beat, step, leadIn: LEAD_IN,
    duration: LEAD_IN + bar * 16 * step,
    events, cands, sectionMarks, crackle: !!def.crackle,
  };
}

function buildTrack(cfg) {
  return cfg.song ? expandSong(cfg) : composeTrack(cfg);
}

// ============================================================ tracks
const TRACKS = [
  { id: 'furelise', name: 'FÜR ELISE', bpm: 90, seed: 'pf-furelise-v1', song: 'furelise', tag: 'BOOM BAP · 1810', color: '#ffd166' },
  { id: 'mountainking', name: 'MOUNTAIN KING', bpm: 140, seed: 'pf-mountainking-v1', song: 'mountainking', tag: 'TRAP · 1875', color: '#ff4da6' },
  { id: 'entertainer', name: 'THE ENTERTAINER', bpm: 92, seed: 'pf-entertainer-v1', song: 'entertainer', tag: 'OLD SCHOOL · 1902', color: '#4df3ff' },
  { id: 'hyperglow', name: 'HYPERGLOW', bpm: 150, seed: 'pf-hyperglow-v1', song: 'hyperglow', tag: 'HYPERPOP', color: '#ff4da6' },
  { id: 'venom', name: 'VENOM', bpm: 143, seed: 'pf-venom-v1', song: 'venom', tag: 'Y2K POP', color: '#b44dff' },
  { id: 'nightswim', name: 'NIGHTSWIM', bpm: 138, seed: 'pf-nightswim-v1', song: 'nightswim', tag: 'SPED UP CLUB', color: '#4df3ff' },
  { id: 'neon', name: 'NEON RUNNER', bpm: 122, seed: 'pf-neon-runner-v1', style: 'drive', tag: 'SYNTHWAVE', color: '#b44dff' },
  { id: 'midnight', name: 'MIDNIGHT DRIVE', bpm: 100, seed: 'pf-midnight-drive-v1', style: 'chill', tag: 'SYNTHWAVE', color: '#4df3ff' },
  { id: 'overdrive', name: 'OVERDRIVE', bpm: 146, seed: 'pf-overdrive-v1', style: 'intense', tag: 'SYNTHWAVE', color: '#ff4da6' },
];

function dailyTrack() {
  const date = todayStr();
  const h = hashStr('pf-daily-' + date);
  return {
    id: 'daily-' + date,
    name: 'DAILY DROP',
    bpm: 104 + (h % 38),
    seed: 'pf-daily-' + date,
    style: ['drive', 'chill', 'intense'][h % 3],
    color: '#ffd166',
    daily: true,
    date,
  };
}

// ============================================================ judgment
const WIN_P = 0.045, WIN_G = 0.092, WIN_GD = 0.135, MISS_AFTER = 0.16;
const JUDGE_INFO = [
  { text: 'PERFECT', color: '#aef6ff', pts: 300, accW: 1 },
  { text: 'GREAT', color: '#ffd166', pts: 200, accW: 0.66 },
  { text: 'GOOD', color: '#b44dff', pts: 80, accW: 0.33 },
  { text: 'MISS', color: '#ff5a5a', pts: 0, accW: 0 },
];

// ============================================================ state
const S = {
  mode: 'menu',                // menu | playing | paused | results | calib
  trackCfg: null, diff: 'normal',
  track: null, notes: [],
  songTime: 0, songStart: 0, animTime: 0,
  audioMode: false, testMode: false,
  schedIdx: 0, lowIdx: 0,
  counts: [0, 0, 0, 0],
  combo: 0, maxCombo: 0, score: 0, accNum: 0, accDen: 0,
  offset: parseFloat(localStorage.getItem('pf_offset') || '0'),
  shownScore: -1, shownAcc: -1,
  selTrack: 0,
};

let laneFlash = [-9, -9, -9, -9];
let laneHold = [false, false, false, false];
let explosions = [];   // {lane, t0, judge}
let judgePop = null;   // {ji, t0, hint}
let comboPopT = -9;

// calibration state
const CAL = { active: false, taps: [], beatDur: 0.5, startCtx: 0, need: 8 };

// ============================================================ DOM
const $ = id => document.getElementById(id);
const el = {
  hud: $('hud'), score: $('score'), acc: $('acc'), progressFill: $('progressFill'),
  menu: $('menu'), results: $('results'), pause: $('pause'), calib: $('calib'),
  trackGrid: $('trackGrid'), playBtn: $('playBtn'), bestLine: $('bestLine'),
  resTrack: $('resTrack'), grade: $('grade'), resAcc: $('resAcc'), newBest: $('newBest'),
  nPerfect: $('nPerfect'), nGreat: $('nGreat'), nGood: $('nGood'), nMiss: $('nMiss'),
  resScore: $('resScore'), resCombo: $('resCombo'),
  retryBtn: $('retryBtn'), shareBtn: $('shareBtn'), menuBtn: $('menuBtn'),
  pauseBtn: $('pauseBtn'), resumeBtn: $('resumeBtn'), quitBtn: $('quitBtn'),
  muteBtn: $('muteBtn'), calibBtn: $('calibBtn'), offsetMs: $('offsetMs'),
  calibStart: $('calibStart'), calibCancel: $('calibCancel'),
  calibCount: $('calibCount'), calibResult: $('calibResult'),
  toast: $('toast'),
};

let toastT = null;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.toast.classList.remove('show'), 2000);
}

function allTracks() { return [...TRACKS, dailyTrack()]; }

function bestKey(trackCfg, diff) { return `pf_best_${trackCfg.id}_${diff}`; }
function getBest(trackCfg, diff) {
  try { return JSON.parse(localStorage.getItem(bestKey(trackCfg, diff)) || 'null'); } catch (e) { return null; }
}

function buildMenu() {
  const tracks = allTracks();
  el.trackGrid.innerHTML = '';
  tracks.forEach((tr, i) => {
    const card = document.createElement('button');
    card.className = 'track' + (i === S.selTrack ? ' sel' : '');
    card.style.setProperty('--c', tr.color);
    const rnd = mulberry32(hashStr(tr.seed + ':bars'));
    let bars = '';
    for (let k = 0; k < 12; k++) bars += `<i style="height:${Math.round(20 + rnd() * 80)}%"></i>`;
    const best = getBest(tr, S.diff);
    card.innerHTML =
      `<div class="t-name">${tr.name}</div>` +
      `<div class="t-meta">${tr.bpm} BPM${tr.tag ? ' · ' + tr.tag : ''}${tr.daily ? ' · ' + tr.date.slice(5) : ''}</div>` +
      (best ? `<div class="t-best">${best.grade}</div>` : '') +
      `<div class="t-bars">${bars}</div>`;
    card.addEventListener('click', () => { S.selTrack = i; buildMenu(); });
    el.trackGrid.appendChild(card);
  });
  const tr = tracks[S.selTrack];
  const best = getBest(tr, S.diff);
  el.bestLine.innerHTML = best
    ? `BEST <b>${best.grade}</b> · ${(best.acc * 100).toFixed(1)}% · ${best.score.toLocaleString('en-US')}`
    : 'no clear yet — drop in';
  el.offsetMs.textContent = Math.round(S.offset * 1000);
}

// ============================================================ flow
function startGame() {
  const trackCfg = allTracks()[S.selTrack];
  S.trackCfg = trackCfg;
  S.track = buildTrack(trackCfg);
  S.notes = makeBeatmap(S.track, S.diff, trackCfg.seed);
  if (S.crackleSrc) { AC.crackleStop(S.crackleSrc); S.crackleSrc = null; }
  S.counts = [0, 0, 0, 0];
  S.combo = 0; S.maxCombo = 0; S.score = 0;
  S.accNum = 0; S.accDen = 0;
  S.schedIdx = 0; S.lowIdx = 0;
  S.shownScore = -1; S.shownAcc = -1;
  explosions = []; judgePop = null; comboPopT = -9;
  laneFlash = [-9, -9, -9, -9];

  S.mode = 'playing';
  el.menu.classList.add('hidden');
  el.results.classList.add('hidden');
  el.pause.classList.add('hidden');
  el.hud.classList.remove('hidden');
  el.muteBtn.classList.remove('hidden');

  if (S.testMode) {
    S.audioMode = false;
    S.songTime = 0;
    return;
  }
  const ok = AC.init();
  if (ok) {
    AC.applyMute();
    AC.resume().then(() => {
      S.audioMode = AC.running();
      if (S.audioMode) {
        S.songStart = AC.ctx.currentTime + 0.12;
        if (S.track.crackle && !S.crackleSrc) S.crackleSrc = AC.crackleStart();
      }
    });
    S.audioMode = AC.running();
    S.songStart = AC.ctx ? AC.ctx.currentTime + 0.12 : 0;
    if (S.audioMode && S.track.crackle && !S.crackleSrc) S.crackleSrc = AC.crackleStart();
  } else {
    S.audioMode = false;
  }
  S.songTime = -0.12;
}

function schedule() {
  if (!S.audioMode || !AC.running()) return;
  const lookahead = 0.3;
  const ev = S.track.events;
  while (S.schedIdx < ev.length && ev[S.schedIdx].t < S.songTime + lookahead) {
    const e = ev[S.schedIdx++];
    const when = S.songStart + e.t;
    if (when < AC.ctx.currentTime - 0.05) continue;
    switch (e.fn) {
      case 'kick': AC.kick(when, e.v); break;
      case 'snare': AC.snare(when, e.v); break;
      case 'hat': AC.hat(when, e.open, e.v); break;
      case 'bass': AC.bass(when, e.freq, e.dur, e.v); break;
      case 'sub': AC.sub(when, e.freq, e.dur, e.v); break;
      case 'keys': AC.keys(when, e.freq, e.dur, e.v); break;
      case 'lead': AC.lead(when, e.freq, e.dur, e.v); break;
      case 'arp': AC.arp(when, e.freq, e.v); break;
      case 'pad': AC.pad(when, e.freqs, e.dur, e.v); break;
    }
  }
}

function judge(note, dt) {
  const a = Math.abs(dt);
  const ji = a <= WIN_P ? 0 : a <= WIN_G ? 1 : 2;
  note.state = 1 + ji;
  note.dt = dt;
  S.counts[ji]++;
  S.combo++;
  S.maxCombo = Math.max(S.maxCombo, S.combo);
  const mult = 1 + Math.min(S.combo, 100) * 0.004;
  S.score += Math.round(JUDGE_INFO[ji].pts * mult);
  S.accNum += JUDGE_INFO[ji].accW;
  S.accDen += 1;
  judgePop = { ji, t0: S.animTime, hint: ji > 0 ? (dt < 0 ? 'early' : 'late') : '' };
  if (S.combo >= 5) comboPopT = S.animTime;
  explosions.push({ lane: note.lane, t0: S.animTime, judge: ji });
  if (ji <= 1) AC.hitsound();
}

function miss(note) {
  note.state = 4;
  S.counts[3]++;
  S.combo = 0;
  S.accDen += 1;
  judgePop = { ji: 3, t0: S.animTime, hint: '' };
}

function handleLane(lane) {
  if (S.mode !== 'playing') return;
  laneFlash[lane] = S.animTime;
  const t = S.songTime - S.offset;
  let best = null, bestA = 1e9;
  for (let i = S.lowIdx; i < S.notes.length; i++) {
    const n = S.notes[i];
    if (n.t - t > WIN_GD) break;
    if (n.state !== 0 || n.lane !== lane) continue;
    const a = Math.abs(n.t - t);
    if (a < bestA) { bestA = a; best = n; }
  }
  if (best && bestA <= WIN_GD) judge(best, t - best.t);
}

function finishSong() {
  S.mode = 'results';
  if (S.crackleSrc) { AC.crackleStop(S.crackleSrc); S.crackleSrc = null; }
  const acc = S.accDen ? S.accNum / S.accDen : 0;
  const grade = S.counts[3] === 0 && acc >= 0.97 ? 'SS'
    : acc >= 0.95 ? 'S' : acc >= 0.9 ? 'A' : acc >= 0.8 ? 'B' : acc >= 0.7 ? 'C' : 'D';
  el.resTrack.textContent = `${S.trackCfg.name} · ${S.diff.toUpperCase()}`;
  el.grade.textContent = grade;
  el.resAcc.textContent = (acc * 100).toFixed(1) + '%';
  el.nPerfect.textContent = S.counts[0];
  el.nGreat.textContent = S.counts[1];
  el.nGood.textContent = S.counts[2];
  el.nMiss.textContent = S.counts[3];
  el.resScore.textContent = S.score.toLocaleString('en-US');
  el.resCombo.textContent = S.maxCombo + (S.counts[3] === 0 && S.accDen > 0 ? ' FC' : '');
  const prev = getBest(S.trackCfg, S.diff);
  const isBest = !prev || S.score > prev.score;
  if (isBest && S.accDen > 0) {
    localStorage.setItem(bestKey(S.trackCfg, S.diff), JSON.stringify({ score: S.score, acc, grade, combo: S.maxCombo }));
  }
  el.newBest.classList.toggle('hidden', !isBest || S.accDen === 0);
  el.hud.classList.add('hidden');
  el.results.classList.remove('hidden');
  S.lastGrade = grade;
  S.lastAcc = acc;
}

function pauseGame() {
  if (S.mode !== 'playing') return;
  S.mode = 'paused';
  if (S.audioMode && AC.ctx) AC.ctx.suspend();
  el.pause.classList.remove('hidden');
}

function resumeGame() {
  if (S.mode !== 'paused') return;
  S.mode = 'playing';
  if (S.audioMode && AC.ctx) AC.ctx.resume();
  el.pause.classList.add('hidden');
}

function quitToMenu() {
  S.mode = 'menu';
  if (S.crackleSrc) { AC.crackleStop(S.crackleSrc); S.crackleSrc = null; }
  if (AC.ctx) { AC.ctx.resume(); AC.duck(); }
  el.pause.classList.add('hidden');
  el.results.classList.add('hidden');
  el.hud.classList.add('hidden');
  el.menu.classList.remove('hidden');
  buildMenu();
}

function share() {
  const fc = S.counts[3] === 0 ? ' · FC' : '';
  const text = `PULSEFALL · ${S.trackCfg.name} [${S.diff.toUpperCase()}]\n` +
    `${S.lastGrade} · ${(S.lastAcc * 100).toFixed(1)}% · ${S.maxCombo}x combo${fc}\n\n` +
    `The music is born the moment you press play:\n${location.origin}`;
  if (navigator.share) navigator.share({ text }).catch(() => {});
  else navigator.clipboard.writeText(text).then(() => toast('Copied — go start a rivalry'));
}

// ============================================================ calibration
function startCalib() {
  if (!AC.init()) { toast('Audio unavailable'); return; }
  AC.applyMute();
  AC.resume().then(() => {
    CAL.active = true;
    CAL.taps = [];
    CAL.beatDur = 0.5;
    CAL.startCtx = AC.ctx.currentTime + 0.4;
    for (let i = 0; i < 24; i++) AC.tick(CAL.startCtx + i * CAL.beatDur, i % 4 === 0);
    el.calibCount.textContent = `0 / ${CAL.need}`;
    el.calibResult.textContent = '';
    el.calibStart.textContent = 'RESTART';
  });
}

function calibTap() {
  if (!CAL.active || !AC.ctx) return;
  const t = AC.ctx.currentTime - CAL.startCtx;
  if (t < -0.3) return;
  let dev = ((t % CAL.beatDur) + CAL.beatDur) % CAL.beatDur;
  if (dev > CAL.beatDur / 2) dev -= CAL.beatDur;
  CAL.taps.push(dev);
  el.calibCount.textContent = `${CAL.taps.length} / ${CAL.need}`;
  if (CAL.taps.length >= CAL.need) {
    CAL.active = false;
    const off = clamp(median(CAL.taps), -0.25, 0.25);
    S.offset = off;
    localStorage.setItem('pf_offset', String(off));
    el.calibResult.textContent = `Offset locked: ${off >= 0 ? '+' : ''}${Math.round(off * 1000)}ms`;
    el.offsetMs.textContent = Math.round(off * 1000);
    el.calibStart.textContent = 'AGAIN';
  }
}

// ============================================================ update
function update(dtReal) {
  S.animTime += dtReal;

  if (S.mode === 'playing') {
    if (S.testMode) {
      S.songTime += dtReal;
    } else if (S.audioMode && AC.running()) {
      S.songTime = AC.ctx.currentTime - S.songStart;
      schedule();
    } else {
      S.songTime += dtReal;
    }

    // miss sweep
    const t = S.songTime - S.offset;
    for (let i = S.lowIdx; i < S.notes.length; i++) {
      const n = S.notes[i];
      if (n.t - t > MISS_AFTER) break;
      if (n.state === 0 && t - n.t > MISS_AFTER) miss(n);
    }
    while (S.lowIdx < S.notes.length && S.notes[S.lowIdx].state !== 0) S.lowIdx++;

    if (S.songTime > S.track.duration + 1.2) finishSong();

    // HUD
    if (S.score !== S.shownScore) {
      S.shownScore = S.score;
      el.score.textContent = S.score.toLocaleString('en-US');
    }
    const acc = S.accDen ? S.accNum / S.accDen : 1;
    const accR = Math.round(acc * 1000);
    if (accR !== S.shownAcc) {
      S.shownAcc = accR;
      el.acc.textContent = (accR / 10).toFixed(1) + '%';
    }
    el.progressFill.style.width = clamp(S.songTime / S.track.duration * 100, 0, 100) + '%';
  }

  // prune effects
  if (explosions.length > 40) explosions.splice(0, explosions.length - 40);
}

// ============================================================ render
function render() {
  const t = S.mode === 'playing' || S.mode === 'paused' ? S.songTime : S.animTime * 0.5;
  const beat = S.track ? S.track.beat : 0.5;
  const leadIn = S.track ? S.track.leadIn : 0;
  const beatPhase = (((t - leadIn) / beat) % 1 + 1) % 1;
  const pulse = S.mode === 'playing' ? Math.pow(1 - beatPhase, 2.5) : 0.25;

  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#150a30');
  sky.addColorStop(0.36, '#1d0c3d');
  sky.addColorStop(0.42, '#0c0720');
  sky.addColorStop(1, '#080414');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // stars
  ctx.fillStyle = '#cfd6ff';
  for (const s of stars) {
    ctx.globalAlpha = 0.25 + 0.3 * Math.sin(S.animTime * 1.1 + s.p);
    ctx.fillRect(s.x, s.y, s.r, s.r);
  }
  ctx.globalAlpha = 1;

  // synthwave sun
  const sunR = Math.min(W, H) * 0.17;
  const sunG = ctx.createLinearGradient(0, horizonY - sunR, 0, horizonY + sunR * 0.2);
  sunG.addColorStop(0, 'rgba(255,209,102,0.95)');
  sunG.addColorStop(0.55, 'rgba(255,77,166,0.85)');
  sunG.addColorStop(1, 'rgba(180,77,255,0.6)');
  ctx.save();
  ctx.beginPath();
  ctx.arc(W / 2, horizonY, sunR * (1 + pulse * 0.03), 0, TAU);
  ctx.clip();
  ctx.fillStyle = sunG;
  ctx.fillRect(W / 2 - sunR, horizonY - sunR, sunR * 2, sunR * 1.2);
  ctx.fillStyle = '#0c0720';
  for (let i = 0; i < 5; i++) {
    const y = horizonY - sunR * 0.45 + i * sunR * 0.22;
    ctx.fillRect(W / 2 - sunR, y, sunR * 2, 2 + i * 1.5);
  }
  ctx.restore();

  // horizon glow
  const hg = ctx.createLinearGradient(0, horizonY - 40, 0, horizonY + 60);
  hg.addColorStop(0, 'rgba(255,77,166,0)');
  hg.addColorStop(0.5, `rgba(255,77,166,${0.14 + pulse * 0.1})`);
  hg.addColorStop(1, 'rgba(255,77,166,0)');
  ctx.fillStyle = hg;
  ctx.fillRect(0, horizonY - 40, W, 100);

  // perspective grid
  ctx.strokeStyle = `rgba(180,77,255,${0.16 + pulse * 0.18})`;
  ctx.lineWidth = 1;
  const vpx = W / 2;
  for (let i = -8; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(vpx, horizonY);
    ctx.lineTo(vpx + i * W * 0.16, H + 40);
    ctx.stroke();
  }
  const scroll = S.mode === 'playing' ? beatPhase : (S.animTime * 0.5) % 1;
  for (let k = 0; k < 11; k++) {
    const z = ((k + scroll) / 11);
    const y = horizonY + (H - horizonY) * z * z;
    ctx.globalAlpha = z * (0.5 + pulse * 0.3);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (S.mode === 'playing' || S.mode === 'paused') renderPlayfield();
}

function renderPlayfield() {
  const D = DIFFS[S.diff];
  const t = S.songTime;
  const noteH = Math.max(16, laneW * 0.21);

  // playfield panel
  ctx.fillStyle = 'rgba(7,3,18,0.66)';
  ctx.fillRect(playX, 0, playW, H);
  for (let l = 0; l <= 4; l++) {
    ctx.strokeStyle = l === 0 || l === 4 ? 'rgba(240,236,255,0.22)' : 'rgba(240,236,255,0.07)';
    ctx.lineWidth = l === 0 || l === 4 ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(playX + l * laneW, 0);
    ctx.lineTo(playX + l * laneW, H);
    ctx.stroke();
  }

  // lane press glow
  for (let l = 0; l < 4; l++) {
    const age = S.animTime - laneFlash[l];
    if (age < 0.22) {
      const a = (1 - age / 0.22) * 0.16;
      const lg = ctx.createLinearGradient(0, hitY, 0, hitY - H * 0.5);
      lg.addColorStop(0, `rgba(${LANE_RGB[l]},${a})`);
      lg.addColorStop(1, `rgba(${LANE_RGB[l]},0)`);
      ctx.fillStyle = lg;
      ctx.fillRect(playX + l * laneW, hitY - H * 0.5, laneW, H * 0.5);
    }
  }

  // hit line
  ctx.strokeStyle = 'rgba(240,236,255,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playX - 8, hitY);
  ctx.lineTo(playX + playW + 8, hitY);
  ctx.stroke();

  // receptors
  const KEYS = ['D', 'F', 'J', 'K'];
  for (let l = 0; l < 4; l++) {
    const cx = playX + l * laneW + laneW / 2;
    const w = laneW * 0.84, h = noteH;
    const pressed = laneHold[l];
    const age = S.animTime - laneFlash[l];
    const flash = Math.max(0, 1 - age / 0.18);
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${LANE_RGB[l]},${0.55 + flash * 0.45})`;
    ctx.fillStyle = pressed || flash > 0.4 ? `rgba(${LANE_RGB[l]},${0.22 + flash * 0.3})` : `rgba(${LANE_RGB[l]},0.05)`;
    roundRect(ctx, cx - w / 2, hitY - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = `rgba(240,236,255,${0.4 + flash * 0.5})`;
    ctx.font = `700 ${Math.round(laneW * 0.18)}px Rajdhani, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(KEYS[l], cx, hitY + h / 2 + laneW * 0.22);
  }

  // notes
  const approach = D.approach;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = S.lowIdx; i < S.notes.length; i++) {
    const n = S.notes[i];
    const dt = n.t - t;
    if (dt > approach) break;
    if (n.state !== 0) continue;
    const y = hitY - (dt / approach) * (hitY + 60);
    if (y < -40) continue;
    const spr = noteSprites[n.lane];
    const cx = playX + n.lane * laneW + laneW / 2;
    ctx.drawImage(spr.c, cx - spr.w / 2, y - spr.h / 2);
  }

  // explosions
  for (const ex of explosions) {
    const age = S.animTime - ex.t0;
    if (age > 0.32) continue;
    const p = age / 0.32;
    const cx = playX + ex.lane * laneW + laneW / 2;
    ctx.globalAlpha = (1 - p) * 0.9;
    ctx.strokeStyle = `rgba(${LANE_RGB[ex.lane]},0.9)`;
    ctx.lineWidth = 3 * (1 - p);
    ctx.beginPath();
    ctx.arc(cx, hitY, 14 + p * laneW * 0.7, 0, TAU);
    ctx.stroke();
    if (ex.judge === 0) {
      ctx.globalAlpha = (1 - p) * 0.7;
      ctx.beginPath();
      ctx.arc(cx, hitY, 8 + p * laneW * 1.05, 0, TAU);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // judgment popup
  if (judgePop) {
    const age = S.animTime - judgePop.t0;
    if (age < 0.5) {
      const info = JUDGE_INFO[judgePop.ji];
      const scale = 1 + 0.45 * Math.exp(-9 * age);
      const alpha = age < 0.32 ? 1 : 1 - (age - 0.32) / 0.18;
      ctx.save();
      ctx.translate(W / 2, H * 0.42);
      ctx.scale(scale, scale);
      ctx.globalAlpha = alpha;
      ctx.font = `700 ${Math.round(Math.min(40, laneW * 0.38))}px Rajdhani, sans-serif`;
      ctx.textAlign = 'center';
      ctx.shadowColor = info.color;
      ctx.shadowBlur = 16;
      ctx.fillStyle = info.color;
      ctx.fillText(info.text, 0, 0);
      ctx.shadowBlur = 0;
      if (judgePop.hint) {
        ctx.font = `600 13px Rajdhani, sans-serif`;
        ctx.fillStyle = 'rgba(240,236,255,0.5)';
        ctx.fillText(judgePop.hint, 0, 20);
      }
      ctx.restore();
    }
  }

  // combo
  if (S.combo >= 5) {
    const age = S.animTime - comboPopT;
    const scale = 1 + 0.25 * Math.exp(-10 * age);
    ctx.save();
    ctx.translate(W / 2, H * 0.33);
    ctx.scale(scale, scale);
    ctx.font = `700 ${Math.round(Math.min(56, laneW * 0.52))}px Rajdhani, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(240,236,255,0.92)';
    ctx.shadowColor = 'rgba(77,243,255,0.7)';
    ctx.shadowBlur = 18;
    ctx.fillText(String(S.combo), 0, 0);
    ctx.shadowBlur = 0;
    ctx.font = `600 12px Rajdhani, sans-serif`;
    ctx.fillStyle = 'rgba(138,130,184,0.9)';
    ctx.fillText('C O M B O', 0, 18);
    ctx.restore();
  }
}

// ============================================================ main loop
let last = performance.now();
function frame(now) {
  const dtReal = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  update(dtReal);
  render();
  requestAnimationFrame(frame);
}

// ============================================================ input
const KEYMAP = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3, ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3 };

window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (S.mode === 'calib' || !el.calib.classList.contains('hidden')) { calibTap(); return; }
  const lane = KEYMAP[e.code];
  if (lane !== undefined) {
    laneHold[lane] = true;
    handleLane(lane);
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape') {
    if (S.mode === 'playing') pauseGame();
    else if (S.mode === 'paused') resumeGame();
  }
  if (e.code === 'Space' || e.code === 'Enter') {
    if (S.mode === 'menu') { startGame(); e.preventDefault(); }
    else if (S.mode === 'results') { startGame(); e.preventDefault(); }
    else if (S.mode === 'paused') resumeGame();
  }
  if (e.code === 'KeyR' && S.mode === 'results') startGame();
});

window.addEventListener('keyup', e => {
  const lane = KEYMAP[e.code];
  if (lane !== undefined) laneHold[lane] = false;
});

const activePointers = new Map();
canvas.addEventListener('pointerdown', e => {
  if (!el.calib.classList.contains('hidden')) { calibTap(); return; }
  if (S.mode !== 'playing') return;
  const x = e.clientX;
  if (x < playX || x > playX + playW) return;
  const lane = clamp(Math.floor((x - playX) / laneW), 0, 3);
  activePointers.set(e.pointerId, lane);
  laneHold[lane] = true;
  handleLane(lane);
  e.preventDefault();
});

window.addEventListener('pointerup', e => {
  const lane = activePointers.get(e.pointerId);
  if (lane !== undefined) { laneHold[lane] = false; activePointers.delete(e.pointerId); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && S.mode === 'playing' && !S.testMode) pauseGame();
});

window.addEventListener('resize', resize);
window.addEventListener('contextmenu', e => { if (e.target === canvas) e.preventDefault(); });

// buttons
el.playBtn.addEventListener('click', () => startGame());
el.retryBtn.addEventListener('click', () => startGame());
el.menuBtn.addEventListener('click', quitToMenu);
el.shareBtn.addEventListener('click', share);
el.pauseBtn.addEventListener('click', pauseGame);
el.resumeBtn.addEventListener('click', resumeGame);
el.quitBtn.addEventListener('click', quitToMenu);

document.querySelectorAll('.diff').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.diff').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    S.diff = b.dataset.diff;
    buildMenu();
  });
});

el.calibBtn.addEventListener('click', () => {
  el.menu.classList.add('hidden');
  el.calib.classList.remove('hidden');
  el.calibCount.textContent = '—';
  el.calibResult.textContent = S.offset !== 0 ? `Current: ${S.offset >= 0 ? '+' : ''}${Math.round(S.offset * 1000)}ms` : '';
});
el.calibStart.addEventListener('click', e => { e.stopPropagation(); startCalib(); });
el.calibCancel.addEventListener('click', e => {
  e.stopPropagation();
  CAL.active = false;
  if (AC.ctx) AC.duck();
  el.calib.classList.add('hidden');
  el.menu.classList.remove('hidden');
  buildMenu();
});
el.calib.addEventListener('pointerdown', e => {
  if (e.target.tagName !== 'BUTTON') calibTap();
});

el.muteBtn.addEventListener('click', () => {
  AC.on = !AC.on;
  localStorage.setItem('pf_mute', AC.on ? '0' : '1');
  el.muteBtn.classList.toggle('off', !AC.on);
  AC.applyMute();
});

// ============================================================ test handle
window.__PF = {
  get s() {
    return {
      mode: S.mode, songTime: Math.round(S.songTime * 1000) / 1000,
      diff: S.diff, track: S.trackCfg ? S.trackCfg.id : null,
      total: S.notes.length, counts: [...S.counts],
      combo: S.combo, maxCombo: S.maxCombo, score: S.score,
      acc: S.accDen ? Math.round(S.accNum / S.accDen * 1000) / 1000 : 1,
      duration: S.track ? Math.round(S.track.duration * 10) / 10 : 0,
    };
  },
  enableTest() { S.testMode = true; },
  selectTrack(i) { S.selTrack = i; buildMenu(); },
  selectDiff(d) { S.diff = d; },
  start() { startGame(); },
  step(dt) {
    const chunk = 1 / 60;
    let rem = dt;
    while (rem > 0) { const d = Math.min(chunk, rem); update(d); rem -= d; }
    render();
    return this.s;
  },
  nextNote() {
    for (let i = S.lowIdx; i < S.notes.length; i++) {
      if (S.notes[i].state === 0) return { t: S.notes[i].t, lane: S.notes[i].lane, i };
    }
    return null;
  },
  seek(t) { S.songTime = t; },
  hit(lane) { handleLane(lane); },
  compose(i, diff) {
    const cfg = allTracks()[i];
    const tr = buildTrack(cfg);
    const bm = makeBeatmap(tr, diff || S.diff, cfg.seed);
    return { events: tr.events.length, notes: bm.length, duration: Math.round(tr.duration * 10) / 10, bpm: tr.bpm };
  },
};

// ============================================================ boot
el.muteBtn.classList.toggle('off', !AC.on);
el.muteBtn.classList.remove('hidden');
resize();
buildMenu();
requestAnimationFrame(frame);

})();
