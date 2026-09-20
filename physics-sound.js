// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// ---- 8-bit-style sound effects: a bounce "piano" note and a sticky-
// edge "xylophone" blip ----
//
// Synthesized with plain Web Audio oscillators rather than sample files -
// authentic period 8-bit game audio WAS simple square/triangle waveforms
// straight off the sound chip, so generating it procedurally is the
// accurate approach, not an approximation of one. It also means every voice
// can be pitched exactly, which sampled audio would need real-time
// pitch-shifting to do cleanly across the wide chord ranges below.
//
// Shared between physics-ui.js and fractal-grid.js (both load this file) -
// unlike the rest of this project's page-specific UI code, this has no
// per-page behavior to diverge, so it isn't duplicated the way that code is.
(function (global) {
  "use strict";

  // Created lazily on the first actual sound, not at page load - browsers
  // refuse to run an AudioContext until a user gesture happens anyway, and
  // every caller of playBounce/playEdge already only ever fires from one
  // (hovering, dragging, clicking Play), so there's no separate "unlock"
  // step to wire up.
  var ctx = null;
  var masterGain = null;
  // The headroom the mixer itself is built around (see the compressor
  // below) - separate from the user-facing volume slider, which multiplies
  // against this rather than replacing it, so 100% on the slider is exactly
  // the loudness the mix was tuned at, not a new maximum.
  var MASTER_GAIN_CEILING = 0.8;
  // User-facing volume, 0-1 - the single source of truth both the mute
  // button and the settings slider read and write (see setVolume/isMuted
  // below); there is no separate "muted" flag; muted just means this is 0.
  // Defaults to full, matching the fixed loudness this mixer always played
  // at before a volume control existed at all.
  var volume = 1;
  // What to restore to on unmute (or on dragging the slider back up from
  // 0) - the last value volume held while still audible, so muting never
  // loses "how loud it was," only silences it. 1 here is only ever reached
  // if the whole session starts muted somehow; it's a floor of last
  // resort, not a value setVolume itself ever assigns to volume.
  var lastAudibleVolume = 1;
  // Callbacks registered via onVolumeChange, fired after every real change
  // - see setVolume. Each page's own JS registers exactly one, to keep its
  // own mute button AND its own settings slider (two separate DOM
  // locations, per page) in sync with whichever of the two - on either
  // page - actually changed it.
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
  // The mute button's own handler - toggles based on the CURRENT state
  // rather than tracking its own on/off flag, so it stays correct even
  // when the slider (not this button) was what last changed volume.
  function toggleMute() {
    setVolume(volume > 0 ? 0 : (lastAudibleVolume > 0 ? lastAudibleVolume : 1));
  }
  function onVolumeChange(cb) { volumeListeners.push(cb); }

  function ensureContext() {
    if (ctx) return ctx;
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return null; // no Web Audio support - sounds just silently don't play
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
      // Refused outside a gesture (see below) - which is reported as a
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
  // is ever played FROM the gesture - they come out of an animation frame,
  // moments later - and iOS Safari only lets a context start (or restart,
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
  // triad's G, not the same octave as C) - one entry per voice count 2-7,
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
  // list - see fractal-grid.js's own caller). n<=1 is just middle C alone;
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

  // One oscillator (plus an optional second, higher-pitched layer for body/
  // attack character) with a linear attack into an exponential decay - the
  // plain envelope shape any simple sound chip could produce, and all
  // that's needed for a percussive blip. exponentialRampToValueAtTime can't
  // target exactly 0 (it's a multiplicative curve), hence the 0.001 floor;
  // the oscillators are stopped shortly after regardless, so nothing lingers
  // audibly.
  function playVoice(freq, opts) {
    if (volume <= 0) return;
    var c = resumedContext();
    if (!c) return;
    var now = c.currentTime;
    var end = now + opts.attack + opts.decay + 0.02;
    function layer(f, peak, decay) {
      var osc = c.createOscillator();
      osc.type = opts.wave;
      osc.frequency.setValueAtTime(f, now);
      var gain = c.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(peak, now + opts.attack);
      gain.gain.exponentialRampToValueAtTime(0.001, now + opts.attack + decay);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(now);
      osc.stop(end);
    }
    layer(freq, opts.peak, opts.decay);
    if (opts.overtoneRatio) {
      layer(freq * opts.overtoneRatio, opts.peak * opts.overtoneGain, opts.decay * opts.overtoneDecayScale);
    }
  }

  // Piano-ish: a square wave (one of the two classic chip-tune timbres)
  // with an octave-up layer underneath for body, a softer attack and a
  // longer decay than the edge sound's blip - read as sustained rather
  // than percussive.
  function playBounce(freq) {
    playVoice(freq, {
      wave: "square", peak: 0.22,
      attack: 0.006, decay: 0.55,
      overtoneRatio: 2, overtoneGain: 0.35, overtoneDecayScale: 0.7,
    });
  }

  // Xylophone-ish: a bright triangle wave, snapped on almost instantly and
  // decaying quickly, plus a brief two-octave-up "tick" layer standing in
  // for the mallet's own attack transient.
  function playEdge(freq) {
    playVoice(freq, {
      wave: "triangle", peak: 0.35,
      attack: 0.002, decay: 0.22,
      overtoneRatio: 4, overtoneGain: 0.18, overtoneDecayScale: 0.15,
    });
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
