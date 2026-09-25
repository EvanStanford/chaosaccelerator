// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0): see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// ---- Sound effects: a bounce "clave" tick and a sticky-edge "palm-muted
// string" pluck ----
//
// Synthesized with plain Web Audio oscillators rather than sample files, so
// every voice can be pitched exactly, which sampled audio would need
// real-time pitch-shifting to do cleanly across the wide chord ranges
// below. Both were picked from a set of twenty auditioned candidates.
//
// Shared between physics-ui.js and fractal-grid.js (both load this file),
// unlike the rest of this project's page-specific UI code, this has no
// per-page behavior to diverge, so it isn't duplicated the way that code is.
(function (global) {
  "use strict";

  // Created lazily on the first actual sound, not at page load: browsers
  // refuse to run an AudioContext until a user gesture happens anyway, and
  // every caller of playBounce/playEdge already only ever fires from one
  // (hovering, dragging, clicking Play), so there's no separate "unlock"
  // step to wire up.
  var ctx = null;
  var masterGain = null;
  // The headroom the mixer itself is built around (see the compressor
  // below): separate from the user-facing volume slider, which multiplies
  // against this rather than replacing it, so 100% on the slider is exactly
  // the loudness the mix was tuned at, not a new maximum.
  var MASTER_GAIN_CEILING = 0.8;
  // User-facing volume, 0-1: the single source of truth both the mute
  // button and the settings slider read and write (see setVolume/isMuted
  // below); there is no separate "muted" flag; muted just means this is 0.
  // Starts MUTED on every page: sound is opt-in, so nothing plays until
  // the mute button (or a settings slider) is used. Each page's own
  // updateVolumeUI reads this at load, so the icons show muted from the
  // first frame rather than after the first change.
  var volume = 0;
  // What to restore to on unmute (or on dragging the slider back up from
  // 0): the last value volume held while still audible, so muting never
  // loses "how loud it was," only silences it. Since every session starts
  // muted, this 1 is what the first unmute lands on: full, the loudness
  // the mix below was tuned at.
  var lastAudibleVolume = 1;
  // Callbacks registered via onVolumeChange, fired after every real change
  // - see setVolume. Each page's own JS registers exactly one, to keep its
  // own mute button AND its own settings slider (two separate DOM
  // locations, per page) in sync with whichever of the two, on either
  // page, actually changed it.
  var volumeListeners = [];

  function applyGain() {
    if (masterGain) masterGain.gain.value = volume * MASTER_GAIN_CEILING;
  }

  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    if (volume > 0) lastAudibleVolume = volume;
    applyGain();
    volumeListeners.forEach(function (cb) { cb(volume); });
  }
  function getVolume() { return volume; }
  function isMuted() { return volume <= 0; }
  // The mute button's own handler: toggles based on the CURRENT state
  // rather than tracking its own on/off flag, so it stays correct even
  // when the slider (not this button) was what last changed volume.
  function toggleMute() {
    setVolume(volume > 0 ? 0 : (lastAudibleVolume > 0 ? lastAudibleVolume : 1));
  }
  function onVolumeChange(cb) { volumeListeners.push(cb); }

  function ensureContext() {
    if (ctx) return ctx;
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return null; // no Web Audio support: sounds just silently don't play
    ctx = new Ctor();
    masterGain = ctx.createGain();
    applyGain();
    // A limiter, not an effect: a big Inspect (Grid) can have well over a
    // hundred voices bouncing within a few frames of each other, and
    // without something taming the sum, that many full-amplitude blips
    // stacking would clip into harsh distortion rather than just sounding
    // appropriately busy.
    var compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 12;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);
    return ctx;
  }

  function resumedContext() {
    var c = ensureContext();
    // Anything but "running": iOS has a third state, "interrupted" (a call,
    // the tab sent to the background), that wants the same resume.
    if (c && c.state !== "running" && c.state !== "closed") {
      var resumed = c.resume();
      // Refused outside a gesture (see below), which is reported as a
      // rejected promise, and an unhandled one is an error in the console for
      // every sound that didn't play.
      if (resumed && resumed.catch) resumed.catch(function () {});
    }
    return c;
  }

  // ---- Unlocking, where "after a gesture" isn't enough ----
  //
  // The comment at the top of this file holds on a desktop: every sound is
  // downstream of something the user did, and Chrome and Firefox let a
  // context start any time after the page's first interaction. But no sound
  // is ever played FROM the gesture, they come out of an animation frame,
  // moments later, and iOS Safari only lets a context start (or restart,
  // after an interruption) from inside the gesture's own event handler. Left
  // to the lazy path alone, a phone never makes a sound at all.
  //
  // So every gesture anywhere on the page also pokes the context. Capture
  // phase and passive: it must run even where a handler further down stops
  // the event (the grid's own touch handlers call preventDefault), and it
  // never needs to stop anything itself. The release half of the gesture
  // (touchend/pointerup/click), since that is the half iOS counts.
  ["touchend", "pointerup", "click", "keydown"].forEach(function (type) {
    global.addEventListener(type, function () { resumedContext(); }, { capture: true, passive: true });
  });

  // ---- Chords, centered on middle C (MIDI 60) ----
  //
  // Semitone offsets from middle C, listed low to high exactly as the
  // named notes ascend (so e.g. the 9th's D lands an octave above the
  // triad's G, not the same octave as C): one entry per voice count 2-7,
  // matching the chords given for this feature exactly.
  var CHORD_SEMITONES = {
    2: [0, 7],           // Power chord (dyad): C - G
    3: [0, 4, 7],         // Major triad: C - E - G
    4: [0, 4, 7, 10],      // Dominant 7th: C - E - G - Bb
    5: [0, 4, 7, 11, 14],    // Major 9th: C - E - G - B - D
    6: [0, 4, 7, 11, 14, 18],  // Major 11th (as Maj9#11): C - E - G - B - D - F#
    7: [0, 4, 7, 11, 14, 17, 21], // Major 13th: C - E - G - B - D - F - A
  };

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // The frequency each of `n` simultaneous voices should play at, in the
  // order those voices are listed (a hovered scene, then each Inspect
  // point/line/grid point, in the same order they appear in the Inspect
  // list: see fractal-grid.js's own caller). n<=1 is just middle C alone;
  // 2-7 use CHORD_SEMITONES; above that there's no named chord left to
  // reach for, so it falls back to a plain run of n consecutive chromatic
  // semitones centered on middle C - floor((n-1)/2) below it, then the rest
  // at and above, so e.g. 21 voices is 10 below, middle C itself, and 10
  // above.
  function chordFrequencies(n) {
    var semitones;
    if (n <= 1) {
      semitones = [0];
    } else if (CHORD_SEMITONES[n]) {
      semitones = CHORD_SEMITONES[n];
    } else {
      var below = Math.floor((n - 1) / 2);
      semitones = [];
      for (var i = 0; i < n; i++) semitones.push(i - below);
    }
    return semitones.map(function (s) { return midiToFreq(60 + s); });
  }

  // ---- Building blocks ----
  //
  // Every layer is a source through its own gain envelope, a linear attack
  // into an exponential decay: the plain shape any simple sound chip could
  // produce, and all a percussive blip needs. exponentialRampToValueAtTime
  // can't target exactly 0 (it's a multiplicative curve), hence the 0.001
  // floor; the sources are stopped shortly after regardless, so nothing
  // lingers audibly.
  function envGain(c, now, attack, decay, peak) {
    var g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + attack);
    g.gain.exponentialRampToValueAtTime(0.001, now + attack + decay);
    return g;
  }
  // One oscillator through its envelope into the master mixer, optionally
  // by way of a filter node.
  function tone(c, now, type, freq, attack, decay, peak, via) {
    var osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    var g = envGain(c, now, attack, decay, peak);
    if (via) { osc.connect(via); via.connect(g); } else osc.connect(g);
    g.connect(masterGain);
    osc.start(now);
    osc.stop(now + attack + decay + 0.02);
  }
  // A burst of white noise through a lowpass and its envelope: the "knock"
  // of something being struck. One second of noise is generated once and
  // shared; every burst only ever plays its first few milliseconds.
  var noiseBuffer = null;
  function noise(c, now, attack, decay, peak, lowpassHz) {
    if (!noiseBuffer) {
      noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
      var d = noiseBuffer.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    var src = c.createBufferSource();
    src.buffer = noiseBuffer;
    var f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = lowpassHz;
    var g = envGain(c, now, attack, decay, peak);
    src.connect(f); f.connect(g); g.connect(masterGain);
    src.start(now);
    src.stop(now + attack + decay + 0.02);
  }
  function startVoice() {
    if (volume <= 0) return null;
    return resumedContext();
  }

  // Clave-ish: a very short, bright sine pitched well above the voice's
  // note (2.5x, so middle C lands around 650 Hz) snapped on in half a
  // millisecond, with an even briefer 6x ping for the click of the strike.
  function playBounce(freq) {
    var c = startVoice();
    if (!c) return;
    var now = c.currentTime;
    tone(c, now, "sine", freq * 2.5, 0.0005, 0.16, 0.45);
    tone(c, now, "sine", freq * 6, 0.0005, 0.03, 0.12);
  }

  // Palm-muted string: a sawtooth through a fixed 900 Hz lowpass, dull and
  // stringy, over a few milliseconds of filtered noise for the pick.
  function playEdge(freq) {
    var c = startVoice();
    if (!c) return;
    var now = c.currentTime;
    var lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    tone(c, now, "sawtooth", freq, 0.002, 0.18, 0.5, lp);
    noise(c, now, 0.001, 0.008, 0.2, 4000);
  }

  global.PhysicsSound = {
    chordFrequencies: chordFrequencies,
    playBounce: playBounce,
    playEdge: playEdge,
    setVolume: setVolume,
    getVolume: getVolume,
    isMuted: isMuted,
    toggleMute: toggleMute,
    onVolumeChange: onVolumeChange,
  };
})(window);
