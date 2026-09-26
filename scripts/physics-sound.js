// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Sound effects: a bounce clave tick and a sticky-edge palm-muted pluck, synthesized with Web Audio
// oscillators so every voice can be pitched exactly. Shared by physics-ui.js and fractal-grid.js.
(function (global) {
  "use strict";

  var ctx = null;
  var masterGain = null;
  var MASTER_GAIN_CEILING = 0.8;
  // User volume 0-1, the one source of truth for mute button and slider (muted = 0). Starts muted.
  var volume = 0;
  var lastAudibleVolume = 1;
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
    // A limiter: a big Inspect (Grid) can stack over a hundred voices, which would clip without it.
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
    // Anything but running: iOS also has "interrupted", which wants the same resume.
    if (c && c.state !== "running" && c.state !== "closed") {
      var resumed = c.resume();
      if (resumed && resumed.catch) resumed.catch(function () {});
    }
    return c;
  }

  // Unlocking: iOS Safari only starts a context inside a gesture's own handler, so every gesture pokes it (capture+passive).
  ["touchend", "pointerup", "click", "keydown"].forEach(function (type) {
    global.addEventListener(type, function () { resumedContext(); }, { capture: true, passive: true });
  });

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

  // n<=1: middle C; 2-7: CHORD_SEMITONES; more: n consecutive semitones centered on middle C.
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

  // ---- Building blocks: a source through a linear-attack/exponential-decay gain (0.001: the ramp can't hit 0)
  function envGain(c, now, attack, decay, peak) {
    var g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + attack);
    g.gain.exponentialRampToValueAtTime(0.001, now + attack + decay);
    return g;
  }
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

  // Clave: a short bright sine at 2.5x the note, plus an even briefer 6x ping for the click.
  function playBounce(freq) {
    var c = startVoice();
    if (!c) return;
    var now = c.currentTime;
    tone(c, now, "sine", freq * 2.5, 0.0005, 0.16, 0.45);
    tone(c, now, "sine", freq * 6, 0.0005, 0.03, 0.12);
  }

  // Palm-muted string: sawtooth through a 900 Hz lowpass over a few ms of noise for the pick.
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
