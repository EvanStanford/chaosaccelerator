// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0): see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// The movie player (chaosplayback.html). Three things, in order:
//
//  1. READ the movie out of the address: the scene, how its map is drawn,
//     and the keyframes (share-url.js). Nothing else is needed, which is
//     what makes a movie's link something that can be sent to anyone: opened
//     cold, it renders and plays the same movie.
//
//  2. RENDER every frame before showing any of them. The camera's position
//     at each frame comes from movie-path.js. The PICTURE comes from the app
//     itself, loaded in a frame and asked for one finished still at a time
//     (FractalGrid.renderStill), so a movie is drawn by exactly the code
//     that draws the map: the same precision ladder at a deep zoom, the same
//     draws sized to what the GPU will allow, the same antialiasing. A second
//     renderer here would be thousands of lines, and would be a different
//     picture by the first deep zoom.
//
//  3. PLAY what was rendered, looping, from memory. Frames are kept as JPEG
//     blobs rather than bitmaps, a minute of full-resolution movie is tens
//     of gigabytes unpacked, and tens of megabytes packed, and unpacked a
//     little ahead of the playhead as it goes.
(function () {
  "use strict";

  var FPS = MoviePath.FPS;
  var JPEG_QUALITY = 0.92;
  // Unpacked frames held at once, as a budget in bytes: enough for half a
  // second ahead at any sensible size, without a 5-megapixel movie holding
  // gigabytes.
  var DECODED_BUDGET_BYTES = 384 * 1024 * 1024;
  var SPEEDS = [0.25, 0.5, 1, 2, 4];

  function $(id) { return document.getElementById(id); }
  var stage = $("stage"), engine = $("engine"), screen = $("screen");
  var renderPanel = $("render-panel"), renderStatus = $("render-status"), renderBar = $("render-bar"), renderDetail = $("render-detail");
  var progressEl = renderPanel.querySelector(".progress");
  var messageBox = $("player-message"), messageText = $("player-message-text");
  var btnPlayPause = $("play-pause"), scrubber = $("scrubber"), timeReadout = $("time-readout");
  var btnSpeed = $("speed"), btnLoop = $("loop"), btnRestart = $("restart");
  var movieFacts = $("movie-facts"), btnDownload = $("download");
  var renderActions = $("render-actions"), btnEndEarly = $("end-early");
  var endEarlyConfirm = $("end-early-confirm"), btnEndEarlyYes = $("end-early-yes"), btnEndEarlyNo = $("end-early-no");
  var screenCtx = screen.getContext("2d");

  function fail(message) {
    renderPanel.hidden = true;
    messageText.textContent = message;
    messageBox.hidden = false;
  }

  // ---- 1. The movie, out of the address ----

  var link;
  try {
    link = ShareUrl.decode(location.hash);
  } catch (err) {
    fail("This link's scene couldn't be read: " + err.message);
    return;
  }
  if (!link || link.page !== ShareUrl.PAGE_MOVIE || !link.scene || !link.view.movie.keyframes.length) {
    fail("There's no movie in this address. Movies are made on the map, in the Movie card.");
    return;
  }
  var movie = link.view.movie;
  var quality = MoviePath.QUALITIES[Math.min(movie.quality, MoviePath.QUALITIES.length - 1)];

  // The way back. The map gets the keyframes back too, in its own link, so
  // the Movie card comes up holding the movie this was rendered from, ready
  // to be changed and rendered again, on the first keyframe's view.
  var first = movie.keyframes[0];
  $("back-to-map").href = "chaos.html#" + ShareUrl.encode({
    page: ShareUrl.PAGE_MAP,
    scene: link.scene,
    view: { center: first.center, zoom: first.zoom, display: link.view.display, lowSaturation: link.view.lowSaturation, precision: link.view.precision, movie: movie },
  });
  // A different movie pasted over this one's address: the simple, certain way
  // to get from one to the other is to start over.
  window.addEventListener("hashchange", function () { location.reload(); });

  // ---- The screen ----
  //
  // One canvas, the size of the stage in device pixels. Whatever is being
  // shown, a frame just rendered, or the movie playing, is drawn to fit
  // inside it whole, so a movie keeps its shape in a window that has changed
  // since it was rendered.
  var shown = null; // the last thing drawn, for redrawing after a resize

  function fitScreen() {
    var rect = stage.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    if (screen.width !== w || screen.height !== h) {
      screen.width = w;
      screen.height = h;
    }
    if (shown) show(shown);
  }
  function show(image) {
    shown = image;
    var scale = Math.min(screen.width / image.width, screen.height / image.height);
    var w = image.width * scale, h = image.height * scale;
    screenCtx.fillStyle = "#000";
    screenCtx.fillRect(0, 0, screen.width, screen.height);
    screenCtx.imageSmoothingEnabled = true;
    screenCtx.imageSmoothingQuality = "high";
    screenCtx.drawImage(image, (screen.width - w) / 2, (screen.height - h) / 2, w, h);
  }
  new ResizeObserver(fitScreen).observe(stage);
  fitScreen();

  // ---- 2. Rendering ----

  var frames = [];        // [{ center, scale, step }]: see MoviePath.frames
  var blobPromises = [];  // one per frame; the same promise twice where two frames are the same picture
  var blobs = [];         // what they resolve to
  var frameWidth = 0, frameHeight = 0;
  // Each finished frame is copied here out of the renderer's canvas, in the
  // one task it can be (see renderStill), and packed from here.
  var copy = document.createElement("canvas");
  var copyCtx = copy.getContext("2d");
  var recentFrameMs = [];
  // What has been packed so far, for estimating what the whole movie will
  // come to. Counted per frame of the MOVIE, so a picture shared by several
  // identical frames is counted as often as it plays: an estimate of the
  // movie, which is what a reader expects, a little over what is held.
  var packedBytes = 0, packedFrames = 0;
  function formatBytes(bytes) {
    var units = ["B", "KB", "MB", "GB"], u = 0;
    while (bytes >= 1024 && u < units.length - 1) { bytes /= 1024; u++; }
    return (u === 0 || bytes >= 100 ? Math.round(bytes) : bytes.toFixed(1)) + " " + units[u];
  }
  var renderStartedAt = 0, frameStartedAt = 0;
  // How many frames, from the first, are finished pictures: what End Early
  // keeps. Counted where progress is reported, since that is called once
  // per finished frame, whether drawn or shared with the one before.
  var renderedCount = 0;
  // Set by End Early: the frame in flight is abandoned rather than waited
  // for (its renderer goes with the engine, see finishRender), and its
  // callback, should it land first, must do nothing.
  var endedEarly = false;

  // The app's own watermark (see #watermark in app-shell.css), drawn INTO
  // every frame rather than laid over the player, so it is still there in a
  // downloaded file. Sized against the frame, not in fixed pixels: the same
  // 12px that reads well on a full-resolution frame would fill a quarter of
  // a 1/8-resolution one's width.
  function stampWatermark() {
    var size = Math.max(7, Math.round(copy.height * 0.022));
    var inset = Math.round(size);
    copyCtx.save();
    copyCtx.font = size + "px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
    copyCtx.textAlign = "right";
    copyCtx.textBaseline = "alphabetic";
    copyCtx.shadowColor = "rgba(0, 0, 0, 0.8)";
    copyCtx.shadowBlur = Math.max(2, size / 4);
    copyCtx.shadowOffsetY = Math.max(1, size / 12);
    copyCtx.fillStyle = "#fff";
    copyCtx.fillText("chaosaccelerator.com", copy.width - inset, copy.height - inset);
    copyCtx.restore();
  }

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    if (seconds < 90) return seconds + " s";
    if (seconds < 5400) return Math.round(seconds / 60) + " min";
    return (seconds / 3600).toFixed(1) + " h";
  }

  function reportProgress(done) {
    renderedCount = done;
    btnEndEarly.disabled = done < 1;
    var fraction = frames.length ? done / frames.length : 0;
    renderStatus.textContent = "Rendering frame " + Math.min(done + 1, frames.length).toLocaleString() + " of " + frames.length.toLocaleString();
    renderBar.style.width = (fraction * 100).toFixed(1) + "%";
    progressEl.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    var detail = quality.label + "  \u00b7  " + frameWidth + " \u00d7 " + frameHeight;
    if (recentFrameMs.length >= 3) {
      var mean = recentFrameMs.reduce(function (a, b) { return a + b; }, 0) / recentFrameMs.length;
      detail += "  \u00b7  about " + formatDuration(mean * (frames.length - done) / 1000) + " left";
    }
    if (packedFrames > 0) detail += "  \u00b7  about " + formatBytes(packedBytes / packedFrames * frames.length) + " in all";
    renderDetail.textContent = detail + "  \u00b7  pauses while this tab is in the background";
  }

  // Everything that decides what a frame looks like. Two frames with the
  // same key are the same picture (a camera holding still while nothing in
  // the simulation moves either), and are rendered once.
  function frameKey(f) {
    return [f.center.x, f.center.xLo, f.center.y, f.center.yLo, f.scale, f.step].join(" ");
  }

  // Every frame in `frames` has its picture on the way: wait for the
  // packing, then play. Also the end End Early jumps to, with `frames` cut
  // down to the finished ones.
  function finishRender() {
    renderStatus.textContent = "Finishing\u2026";
    Promise.all(blobPromises).then(function (all) {
      if (all.some(function (blob) { return !blob; })) {
        fail("This browser couldn't store a frame that size. Try a lower resolution in the Movie card.");
        return;
      }
      blobs = all;
      // The renderer has done its work (or, ended early, is abandoned
      // mid-frame); its GPU memory is wanted back.
      engine.remove();
      beginPlayback();
    });
  }

  // End Early, confirmed: the movie is the frames finished so far. Nothing
  // asks the renderer to stop; the frame it is on simply never gets
  // collected, and the engine is removed once the finished frames are
  // packed.
  function endEarly() {
    if (endedEarly || renderedCount < 1) return;
    endedEarly = true;
    frames = frames.slice(0, renderedCount);
    blobPromises = blobPromises.slice(0, renderedCount);
    renderActions.hidden = true;
    endEarlyConfirm.hidden = true;
    finishRender();
  }
  btnEndEarly.addEventListener("click", function () {
    renderActions.hidden = true;
    endEarlyConfirm.hidden = false;
    btnEndEarlyNo.focus();
  });
  btnEndEarlyNo.addEventListener("click", function () {
    endEarlyConfirm.hidden = true;
    renderActions.hidden = false;
    btnEndEarly.focus();
  });
  btnEndEarlyYes.addEventListener("click", endEarly);

  function renderFrame(grid, i) {
    if (endedEarly) return;
    if (i >= frames.length) {
      finishRender();
      return;
    }
    if (i > 0 && frameKey(frames[i]) === frameKey(frames[i - 1])) {
      blobPromises[i] = blobPromises[i - 1];
      reportProgress(i + 1);
      renderFrame(grid, i + 1);
      return;
    }
    frameStartedAt = performance.now();
    var spec = frames[i];
    grid.renderStill({ center: spec.center, scale: spec.scale, step: spec.step, antialias: quality.antialias }, function (canvas) {
      // Called from inside the renderer's own frame: anything thrown here
      // would be thrown THERE, and end its render loop for good.
      if (endedEarly) return; // this frame was given up on
      try {
        if (copy.width !== canvas.width || copy.height !== canvas.height) {
          copy.width = frameWidth = canvas.width;
          copy.height = frameHeight = canvas.height;
        }
        copyCtx.drawImage(canvas, 0, 0);
        stampWatermark();
        // toBlob packs a snapshot taken now, so `copy` is free for the next
        // frame straight away.
        blobPromises[i] = new Promise(function (resolve) { copy.toBlob(resolve, "image/jpeg", JPEG_QUALITY); });
        blobPromises[i].then(function (blob) {
          if (!blob) return;
          packedBytes += blob.size;
          packedFrames += 1;
        });
        show(copy);
        recentFrameMs.push(performance.now() - frameStartedAt);
        if (recentFrameMs.length > 12) recentFrameMs.shift();
        reportProgress(i + 1);
        renderFrame(grid, i + 1);
      } catch (err) {
        fail("Rendering stopped: " + (err.message || err));
      }
    });
  }

  function beginRender(grid) {
    var defaultScale = grid.defaultScale();
    log10DefaultScale = Math.log10(defaultScale);
    var lastStep = link.scene.simulationSteps;
    frames = MoviePath.frames(movie.keyframes.map(function (k) {
      return { center: k.center, scale: defaultScale / k.zoom, step: Math.min(k.step, lastStep), seconds: k.seconds };
    }), movie.loop);
    blobPromises = new Array(frames.length);
    renderStartedAt = performance.now();
    movieFacts.textContent = frames.length.toLocaleString() + " frames  \u00b7  " + (frames.length / FPS).toFixed(1) + " s";
    reportProgress(0);
    renderFrame(grid, 0);
  }

  function startEngine() {
    renderPanel.hidden = false;
    var rect = stage.getBoundingClientRect();
    // Sized ONCE, in pixels: a renderer that followed the window would
    // restart its picture on every resize, and hand back frames of different
    // sizes either side of one.
    engine.style.width = Math.max(16, Math.round(rect.width / quality.divisor)) + "px";
    engine.style.height = Math.max(16, Math.round(rect.height / quality.divisor)) + "px";
    engine.addEventListener("load", function () {
      // A map link starts the map as the page loads (see openAddress in
      // transition.js), so by now it either has or it isn't going to.
      var grid = null;
      try {
        grid = engine.contentWindow && engine.contentWindow.FractalGrid;
      } catch (err) {
        // Opened straight off the disk, where a browser treats every file as
        // an origin of its own and one page may not reach into another.
        fail("The movie player has to be opened from a web server (http://\u2026), not as a file.");
        return;
      }
      if (!grid || !grid.isStarted()) {
        fail("The scene in this link couldn't be opened on the map.");
        return;
      }
      beginRender(grid);
    });
    // The app, opened on this movie's map: drawn the way the movie is to be
    // drawn, and otherwise at its defaults.
    engine.src = "chaos.html#" + ShareUrl.encode({
      page: ShareUrl.PAGE_MAP,
      scene: link.scene,
      view: { display: link.view.display, lowSaturation: link.view.lowSaturation, precision: link.view.precision },
    });
  }

  // ---- The sound ----
  //
  // A Shepard tone that follows the zoom: three orders of magnitude in is one
  // octave up, three out is one down, so a movie that dives forever climbs
  // forever without ever getting anywhere. Six partials an octave apart,
  // each faded by a window over log-frequency centred on 220 Hz (an A, so
  // the partials all land on A's at every thousandfold zoom): full volume
  // within an octave of the centre, falling away by a cosine to silence two
  // octaves further out, fuller and more organ-like than Shepard's own
  // Gaussian, with nothing shrill at the top. As the pitch climbs, a partial
  // fading out at the top is replaced by one fading in at the bottom, and
  // since a partial's volume depends only on its absolute frequency the join
  // is seamless. Each partial is one plain sine: two a few cents apart, for
  // warmth, beat against each other at a few hertz, which is worse. Everything
  // moves through smoothing so nothing clicks.
  var OCTAVES_PER_DECADE = 1 / 3;
  var TONE_CENTER_HZ = 220;
  var TONE_FLAT = 1;           // octaves either side of the centre at full volume
  var TONE_HALF_WIDTH = 3;     // octaves; silent from here out, and partials live in [-3, 3)
  var TONE_LEVEL = 0.12;       // six sines, about four of them at full volume at once
  var TONE_FADE_S = 0.12;      // time constant of the fade in and out

  function ShepardTone(ctx, destination) {
    var master = ctx.createGain();
    master.gain.value = 0;
    master.connect(destination);
    var partials = [];
    for (var k = -TONE_HALF_WIDTH; k < TONE_HALF_WIDTH; k++) {
      var gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(master);
      var osc = ctx.createOscillator();
      osc.type = "sine";
      osc.connect(gain);
      osc.start();
      partials.push({ k: k, gain: gain, osc: osc, x: null });
    }
    // Where partial k sits in the window for a tone at `octaves`: it climbs
    // continuously with the tone, and wraps from the top of the window to
    // the bottom, both silent, rather than every partial jumping an octave
    // whenever the tone crosses a whole number, which was audible however
    // smoothly it was done.
    function place(octaves, k) {
      var width = 2 * TONE_HALF_WIDTH, x = (octaves + k + TONE_HALF_WIDTH) % width;
      if (x < 0) x += width;
      return x - TONE_HALF_WIDTH;
    }
    // The window over log-frequency: flat in the middle, cosine edges, and
    // exactly zero at the window's edge so the partial that wraps round does
    // so in silence.
    function bell(x) {
      var a = Math.abs(x);
      if (a <= TONE_FLAT) return 1;
      if (a >= TONE_HALF_WIDTH) return 0;
      return 0.5 * (1 + Math.cos(Math.PI * (a - TONE_FLAT) / (TONE_HALF_WIDTH - TONE_FLAT)));
    }
    return {
      // `octaves` is the tone's position: any real number, only its fraction
      // is audible.
      setPitch: function (octaves) {
        var now = ctx.currentTime;
        partials.forEach(function (p) {
          var x = place(octaves, p.k);
          var hz = TONE_CENTER_HZ * Math.pow(2, x);
          // Small moves are smoothed so nothing zippers; a wrap round the
          // window (or the movie looping or being seeked) is taken at once:
          // an oscillator changes pitch without a break in its wave, so an
          // instant change makes no click where a smoothed one would chirp.
          // Volume is always smoothed: an instant change there IS a click.
          var jump = p.x === null || Math.abs(x - p.x) > 0.5;
          if (jump) p.osc.frequency.setValueAtTime(hz, now);
          else p.osc.frequency.setTargetAtTime(hz, now, 0.02);
          p.gain.gain.setTargetAtTime(bell(x), now, 0.02);
          p.x = x;
        });
      },
      // 1 is on, 0 is off; either way it gets there smoothly.
      setLevel: function (level) {
        master.gain.setTargetAtTime(TONE_LEVEL * level, ctx.currentTime, TONE_FADE_S);
      },
      stop: function () {
        partials.forEach(function (p) { p.osc.stop(); });
        master.disconnect();
      },
    };
  }

  // Frame i's place on the tone, from the zoom it was rendered at.
  var log10DefaultScale = 0;
  function pitchOf(i) {
    return (log10DefaultScale - Math.log10(frames[i].scale)) * OCTAVES_PER_DECADE;
  }

  // The live sound: off until asked for, and the AudioContext made only then,
  // in the click, browsers don't let a page start sound on its own.
  var btnSound = $("sound");
  var soundOn = false, audioCtx = null, liveTone = null;
  function updateSound() {
    if (liveTone) liveTone.setLevel(soundOn && playing ? 1 : 0);
  }
  function setSoundOn(next) {
    soundOn = next;
    if (soundOn && !audioCtx && typeof AudioContext === "function") {
      audioCtx = new AudioContext();
      liveTone = new ShepardTone(audioCtx, audioCtx.destination);
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    btnSound.setAttribute("aria-pressed", soundOn ? "true" : "false");
    btnSound.title = soundOn ? "Sound on" : "Sound off";
    btnSound.setAttribute("aria-label", btnSound.title);
    updateSound();
  }

  // ---- 3. Playback ----

  var position = 0;       // in frames, fractional while playing
  var playing = false, looping = true, speedIndex = SPEEDS.indexOf(1);
  var lastTickAt = 0, shownIndex = -1, scrubbing = false;
  var decoded = {};       // frame index -> ImageBitmap, or true while it is being unpacked
  var maxDecoded = 24;

  // At more than two frames of movie per frame of screen there is no point
  // unpacking the ones that would never be shown.
  function stride() { return Math.max(1, Math.round(SPEEDS[speedIndex] * FPS / 60)); }
  function indexAt(p) {
    var i = Math.floor(p / stride()) * stride();
    return Math.min(frames.length - 1, Math.max(0, i));
  }

  function unpack(i) {
    if (decoded[i]) return;
    decoded[i] = true;
    createImageBitmap(blobs[i]).then(function (bitmap) {
      if (decoded[i] !== true) { bitmap.close(); return; } // dropped while it was unpacking
      decoded[i] = bitmap;
    }, function () { delete decoded[i]; });
  }
  // The frame under the playhead and the ones coming up, unpacked; everything
  // else let go.
  function keepAhead() {
    var wanted = {}, step = stride(), i = indexAt(position);
    for (var n = 0; n < maxDecoded; n++) {
      wanted[i] = true;
      i += step;
      if (i >= frames.length) {
        if (!looping) break;
        i = 0;
      }
    }
    Object.keys(decoded).forEach(function (key) {
      if (wanted[key]) return;
      if (decoded[key] !== true && decoded[key] !== shown) decoded[key].close();
      if (decoded[key] !== shown) delete decoded[key];
    });
    Object.keys(wanted).forEach(function (key) { unpack(Number(key)); });
  }

  function formatClock(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    return Math.floor(seconds / 60) + ":" + ("0" + (seconds % 60)).slice(-2);
  }

  function setPlaying(next) {
    playing = next;
    lastTickAt = 0;
    btnPlayPause.innerHTML = playing ? "&#10074;&#10074;" : "&#9654;";
    btnPlayPause.title = playing ? "Pause" : "Play";
    btnPlayPause.setAttribute("aria-label", btnPlayPause.title);
    updateSound();
  }

  function tick(now) {
    if (playing && lastTickAt) {
      var next = position + Math.min(0.1, (now - lastTickAt) / 1000) * FPS * SPEEDS[speedIndex];
      if (next >= frames.length) {
        if (looping) next = next % frames.length;
        else { next = frames.length - 1; setPlaying(false); }
      }
      // Never ahead of the unpacker: a playhead that ran on regardless would
      // skip whatever wasn't ready, and a movie that stutters forward reads
      // worse than one that waits a frame.
      if (decoded[indexAt(next)] && decoded[indexAt(next)] !== true) position = next;
    }
    lastTickAt = now;
    keepAhead();
    var index = indexAt(position), bitmap = decoded[index];
    if (index !== shownIndex && bitmap && bitmap !== true) {
      show(bitmap);
      shownIndex = index;
    }
    if (liveTone) liveTone.setPitch(pitchOf(index));
    if (!scrubbing) scrubber.value = String(Math.floor(position));
    timeReadout.textContent = formatClock(position / FPS) + " / " + formatClock(frames.length / FPS);
    requestAnimationFrame(tick);
  }

  function seek(frame) {
    position = Math.min(frames.length - 1, Math.max(0, frame));
    lastTickAt = 0;
  }

  function beginPlayback() {
    renderPanel.hidden = true;
    maxDecoded = Math.min(90, Math.max(8, Math.floor(DECODED_BUDGET_BYTES / (frameWidth * frameHeight * 4))));
    movieFacts.textContent = frames.length.toLocaleString() + " frames  \u00b7  " + (frames.length / FPS).toFixed(1) + " s  \u00b7  " +
      frameWidth + " \u00d7 " + frameHeight + "  \u00b7  " +
      formatBytes(blobs.reduce(function (sum, blob) { return sum + blob.size; }, 0)) + "  \u00b7  rendered in " + formatDuration((performance.now() - renderStartedAt) / 1000) +
      (endedEarly ? "  \u00b7  ended early" : "");
    scrubber.max = String(frames.length - 1);
    [btnPlayPause, scrubber, btnSpeed, btnLoop, btnRestart, btnSound].forEach(function (control) { control.disabled = false; });

    btnPlayPause.addEventListener("click", function () {
      // Play, at the end of a movie that doesn't loop, means play it again.
      if (!playing && !looping && position >= frames.length - 1) seek(0);
      setPlaying(!playing);
    });
    scrubber.addEventListener("input", function () { scrubbing = true; seek(Number(scrubber.value)); });
    scrubber.addEventListener("change", function () { scrubbing = false; });
    btnSpeed.addEventListener("click", function () {
      speedIndex = (speedIndex + 1) % SPEEDS.length;
      btnSpeed.textContent = SPEEDS[speedIndex] + "x";
    });
    btnLoop.addEventListener("click", function () {
      looping = !looping;
      btnLoop.setAttribute("aria-pressed", looping ? "true" : "false");
    });
    btnRestart.addEventListener("click", function () { seek(0); });
    btnSound.addEventListener("click", function () { setSoundOn(!soundOn); });
    window.addEventListener("keydown", function (event) {
      if (event.target === scrubber) return; // it has arrow keys of its own
      if (event.key === " ") { event.preventDefault(); btnPlayPause.click(); }
      else if (event.key === "m") btnSound.click();
      else if (event.key === "ArrowRight") { setPlaying(false); seek(Math.floor(position) + 1); }
      else if (event.key === "ArrowLeft") { setPlaying(false); seek(Math.floor(position) - 1); }
      else if (event.key === "Home") seek(0);
    });

    btnDownload.hidden = false;
    btnDownload.addEventListener("click", downloadMovie);

    setPlaying(true);
    requestAnimationFrame(tick);
  }

  // ---- Saving it as a file ----
  //
  // The frames are replayed once, off screen, into a canvas the browser's own
  // MediaRecorder is filming, so this takes as long as the movie runs, and
  // produces whatever video format this browser records (WebM in Chrome and
  // Firefox, MP4 in Safari). That is the price of having no encoder of our
  // own: a real one would mean shipping a muxer library. Every frame is held
  // for exactly one frame's time, paced against the clock rather than by
  // counting timeouts, so the file runs at the movie's own speed.
  //
  // With the sound on, the file gets the tone too: a second Shepard tone,
  // played into the recording alone and not the speakers, following the
  // frames as they are filmed. With it off the file has no audio track.
  var DOWNLOAD_LABEL = "Download";
  function downloadMovie() {
    if (btnDownload.disabled) return;
    if (typeof MediaRecorder !== "function" || !HTMLCanvasElement.prototype.captureStream) {
      btnDownload.textContent = "Not supported in this browser";
      btnDownload.disabled = true;
      return;
    }
    var film = document.createElement("canvas");
    film.width = frameWidth;
    film.height = frameHeight;
    var filmCtx = film.getContext("2d");
    var withSound = soundOn && !!audioCtx;
    var types = withSound
      ? ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      : ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    var type = types.filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0];
    var recorder, filmTone = null;
    try {
      var stream = film.captureStream(FPS);
      if (withSound) {
        var sink = audioCtx.createMediaStreamDestination();
        filmTone = new ShepardTone(audioCtx, sink);
        stream.addTrack(sink.stream.getAudioTracks()[0]);
      }
      // Generous on purpose: this picture is mostly fine noise, which a
      // default bitrate turns to mush.
      recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: Math.min(60e6, Math.max(8e6, frameWidth * frameHeight * 12)), audioBitsPerSecond: 128000 });
    } catch (err) {
      if (filmTone) filmTone.stop();
      btnDownload.textContent = "Not supported in this browser";
      btnDownload.disabled = true;
      return;
    }
    var chunks = [];
    recorder.ondataavailable = function (event) { if (event.data && event.data.size) chunks.push(event.data); };
    recorder.onstop = function () {
      if (filmTone) filmTone.stop();
      var file = new Blob(chunks, { type: recorder.mimeType || type });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = "chaosaccelerator-movie." + (/mp4/.test(file.type) ? "mp4" : "webm");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      btnDownload.textContent = DOWNLOAD_LABEL;
      btnDownload.disabled = false;
    };
    btnDownload.disabled = true;
    var startedAt = 0;
    // "1m29s", or "29s" inside the first minute.
    function formatRecorded(seconds) {
      seconds = Math.floor(seconds);
      var m = Math.floor(seconds / 60), s = seconds % 60;
      return m ? m + "m" + (s < 10 ? "0" : "") + s + "s" : s + "s";
    }
    var movieLength = formatRecorded(blobs.length / FPS);
    function film1(i) {
      if (i >= blobs.length) {
        // One more frame's time, or the last frame is cut short, and with
        // sound, long enough for the tone to fade out rather than stop dead.
        if (filmTone) filmTone.setLevel(0);
        setTimeout(function () { recorder.stop(); }, filmTone ? Math.max(1000 / FPS, 1000 * TONE_FADE_S * 4) : 1000 / FPS);
        return;
      }
      createImageBitmap(blobs[i]).then(function (bitmap) {
        var due = startedAt + i * 1000 / FPS;
        setTimeout(function () {
          filmCtx.drawImage(bitmap, 0, 0);
          bitmap.close();
          if (filmTone) filmTone.setPitch(pitchOf(i));
          btnDownload.textContent = "Recording in real time " + formatRecorded((i + 1) / FPS) + " out of " + movieLength;
          film1(i + 1);
        }, Math.max(0, due - performance.now()));
      }, function () { recorder.stop(); });
    }
    // The first frame is on the canvas before filming starts, so the file
    // doesn't open on a blank.
    createImageBitmap(blobs[0]).then(function (bitmap) {
      filmCtx.drawImage(bitmap, 0, 0);
      bitmap.close();
      if (filmTone) { filmTone.setPitch(pitchOf(0)); filmTone.setLevel(1); }
      recorder.start();
      startedAt = performance.now();
      film1(1);
    });
  }

  startEngine();
})();
