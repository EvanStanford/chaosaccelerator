// CPAL-1.0 License. See chaosaccelerator.com/license.html

// The movie player (chaosplayback.html): 1. READ the movie out of the address
// (share-url.js); 2. RENDER every frame first, via the app itself loaded in an iframe
// (FractalGrid.renderStill), so a movie is drawn by exactly the code that draws the map;
// 3. PLAY from memory, frames kept as JPEG blobs and unpacked a little ahead of the playhead.
(function () {
  "use strict";

  var FPS = MoviePath.FPS;
  var JPEG_QUALITY = 0.92;
  // Unpacked-frame budget: half a second ahead at any sensible size, without gigabytes.
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
  var movieSize = movie.size, antialias = movie.antialias;

  // The way back, keyframes included, so the Movie card comes up holding this movie.
  var first = movie.keyframes[0];
  $("back-to-map").href = "chaos.html#" + ShareUrl.encode({
    page: ShareUrl.PAGE_MAP,
    scene: link.scene,
    view: { center: first.center, zoom: first.zoom, display: link.view.display, lowSaturation: link.view.lowSaturation, precision: link.view.precision, movie: movie },
  });
  // A different movie pasted over the address: start over.
  window.addEventListener("hashchange", function () { location.reload(); });

  // ---- The screen ---- one canvas, stage-sized in device px; whatever is shown is drawn to fit inside it whole.
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
  var copy = document.createElement("canvas");
  var copyCtx = copy.getContext("2d");
  // Packed so far, for the size estimate: counted per frame of the MOVIE, shared pictures included.
  var packedBytes = 0, packedFrames = 0;
  function formatBytes(bytes) {
    var units = ["B", "KB", "MB", "GB"], u = 0;
    while (bytes >= 1024 && u < units.length - 1) { bytes /= 1024; u++; }
    return (u === 0 || bytes >= 100 ? Math.round(bytes) : bytes.toFixed(1)) + " " + units[u];
  }
  var renderStartedAt = 0, frameStartedAt = 0;
  var renderedCount = 0;
  // Set by End Early: the frame in flight is abandoned, and its callback must do nothing.
  var endedEarly = false;

  // The app's watermark, drawn INTO every frame so it survives download. Sized against the frame, not fixed px.
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

  // ---- Time left ---- the renderer draws once a display refresh, so a frame takes its work plus half a refresh
  // on average, and at least one. Work is steps times a cost per step at the frame's precision: measured once frames
  // render at it, and until then the last measured cost scaled by the precisions' slowdowns over float32 (10x, 40x, 70x).
  var refreshMs = 1000 / 60;
  var frameCosts = [];  // per frame { precision, slowdown, steps }; null where it repeats the frame before, which is free
  var stepCosts = {};   // precision -> { slowdown, ms: recent ms per step }; the first frame at each may build its program, so is left out
  var lastMeasured = null, measuredFrames = 0;

  function measureRefresh() {
    var stamps = [];
    requestAnimationFrame(function sample(t) {
      stamps.push(t);
      if (stamps.length < 12) { requestAnimationFrame(sample); return; }
      var gaps = stamps.slice(1).map(function (at, k) { return at - stamps[k]; }).sort(function (a, b) { return a - b; });
      refreshMs = gaps[gaps.length >> 1];
    });
  }

  function noteFrameTime(cost, ms) {
    var known = stepCosts[cost.precision];
    if (!known) {
      stepCosts[cost.precision] = { slowdown: cost.slowdown, ms: [] };
      return;
    }
    known.ms.push(Math.max(0, ms - refreshMs / 2) / cost.steps);
    if (known.ms.length > 12) known.ms.shift();
    lastMeasured = known;
    measuredFrames += 1;
  }

  // null until a few frames have been measured.
  function msLeft(from) {
    if (measuredFrames < 3) return null;
    function mean(list) { return list.reduce(function (a, b) { return a + b; }, 0) / list.length; }
    var perStep = {};
    Object.keys(stepCosts).forEach(function (precision) {
      if (stepCosts[precision].ms.length) perStep[precision] = mean(stepCosts[precision].ms);
    });
    var perSlowdown = mean(lastMeasured.ms) / lastMeasured.slowdown;
    var total = 0;
    for (var i = from; i < frames.length; i++) {
      var cost = frameCosts[i];
      if (!cost) continue;
      var rate = perStep[cost.precision] !== undefined ? perStep[cost.precision] : perSlowdown * cost.slowdown;
      total += Math.max(refreshMs, refreshMs / 2 + rate * cost.steps);
    }
    return total;
  }

  function reportProgress(done) {
    renderedCount = done;
    btnEndEarly.disabled = done < 1;
    var fraction = frames.length ? done / frames.length : 0;
    renderStatus.textContent = "Rendering frame " + Math.min(done + 1, frames.length).toLocaleString() + " of " + frames.length.toLocaleString();
    renderBar.style.width = (fraction * 100).toFixed(1) + "%";
    progressEl.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    var detail = movieSize.width + " \u00d7 " + movieSize.height + (antialias ? " with antialiasing" : "");
    var left = msLeft(done);
    if (left !== null) detail += "  \u00b7  about " + formatDuration(left / 1000) + " left";
    if (packedFrames > 0) detail += "  \u00b7  about " + formatBytes(packedBytes / packedFrames * frames.length) + " in all";
    renderDetail.textContent = detail + "  \u00b7  pauses while this tab is in the background";
  }

  function frameKey(f) {
    return [f.center.x, f.center.xLo, f.center.y, f.center.yLo, f.scale, f.step].join(" ");
  }

  function finishRender() {
    renderStatus.textContent = "Finishing\u2026";
    Promise.all([Promise.all(blobPromises), finishVideo()]).then(function (done) {
      var all = done[0];
      if (all.some(function (blob) { return !blob; })) {
        fail("This browser couldn't store a frame that size. Try a lower resolution in the Movie card.");
        return;
      }
      blobs = all;
      engine.remove();
      beginPlayback();
    });
  }

  // End Early, confirmed: the movie is the frames finished so far. The renderer is not
  // asked to stop; its frame is simply never collected.
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

  // Frame i is in `copy`: into the video file, then on to the next.
  function frameDone(grid, i) {
    encodeFrame(i);
    reportProgress(i + 1);
    whenEncoderReady(function () { renderFrame(grid, i + 1); });
  }

  function renderFrame(grid, i) {
    if (endedEarly) return;
    if (i >= frames.length) {
      finishRender();
      return;
    }
    if (i > 0 && frameKey(frames[i]) === frameKey(frames[i - 1])) {
      blobPromises[i] = blobPromises[i - 1];
      frameDone(grid, i);
      return;
    }
    frameStartedAt = performance.now();
    var spec = frames[i];
    grid.renderStill({ center: spec.center, scale: spec.scale, step: spec.step, antialias: antialias,
      width: movieSize.width, height: movieSize.height }, function (canvas) {
      // Called from inside the renderer's own frame: anything thrown here would end its render loop.
      if (endedEarly) return; // this frame was given up on
      try {
        // Video encoders need even sizes, and Chrome garbles a canvas frame whose width isn't a multiple of 4.
        var w = canvas.width - canvas.width % 4, h = canvas.height - canvas.height % 2;
        if (copy.width !== w || copy.height !== h) {
          copy.width = frameWidth = w;
          copy.height = frameHeight = h;
        }
        copyCtx.drawImage(canvas, 0, 0);
        stampWatermark();
        blobPromises[i] = new Promise(function (resolve) { copy.toBlob(resolve, "image/jpeg", JPEG_QUALITY); });
        blobPromises[i].then(function (blob) {
          if (!blob) return;
          packedBytes += blob.size;
          packedFrames += 1;
        });
        show(copy);
        noteFrameTime(frameCosts[i], performance.now() - frameStartedAt);
        // The first frame sets the file's size, so the encoder is chosen now.
        if (i === 0) openVideo(w, h).then(function () { frameDone(grid, 0); });
        else frameDone(grid, i);
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
    frameCosts = frames.map(function (f, i) {
      if (i > 0 && frameKey(f) === frameKey(frames[i - 1])) return null;
      var precision = grid.stillPrecision({ center: f.center, scale: f.scale, width: movieSize.width, height: movieSize.height });
      return { precision: precision.name, slowdown: precision.slowdown, steps: Math.max(1, f.step) };
    });
    blobPromises = new Array(frames.length);
    renderStartedAt = performance.now();
    movieFacts.textContent = frames.length.toLocaleString() + " frames  \u00b7  " + (frames.length / FPS).toFixed(1) + " s";
    reportProgress(0);
    renderFrame(grid, 0);
  }

  function startEngine() {
    renderPanel.hidden = false;
    measureRefresh();
    engine.addEventListener("load", function () {
      // A map link starts the map on load (openAddress in transition.js), so by now it has or won't.
      var grid = null;
      try {
        grid = engine.contentWindow && engine.contentWindow.FractalGrid;
      } catch (err) {
        // Opened off the disk: every file is its own origin.
        fail("The movie player has to be opened from a web server (http://\u2026), not as a file.");
        return;
      }
      if (!grid || !grid.isStarted()) {
        fail("The scene in this link couldn't be opened on the map.");
        return;
      }
      beginRender(grid);
    });
    engine.src = "chaos.html#" + ShareUrl.encode({
      page: ShareUrl.PAGE_MAP,
      scene: link.scene,
      view: { display: link.view.display, lowSaturation: link.view.lowSaturation, precision: link.view.precision },
    });
  }

  // ---- The sound ---- a Shepard tone following the zoom: three orders of magnitude
  // is one octave. Six sine partials an octave apart, each faded by a window over
  // log-frequency centred on 220 Hz (flat within an octave, cosine to silence two further
  // out); a partial's volume depends only on its absolute frequency, so the wrap is seamless.
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
    // Partial k's place in the window: climbs continuously and wraps top to bottom, both silent.
    function place(octaves, k) {
      var width = 2 * TONE_HALF_WIDTH, x = (octaves + k + TONE_HALF_WIDTH) % width;
      if (x < 0) x += width;
      return x - TONE_HALF_WIDTH;
    }
    // Flat in the middle, cosine edges, exactly zero at the edge so the wrap is silent.
    function bell(x) {
      var a = Math.abs(x);
      if (a <= TONE_FLAT) return 1;
      if (a >= TONE_HALF_WIDTH) return 0;
      return 0.5 * (1 + Math.cos(Math.PI * (a - TONE_FLAT) / (TONE_HALF_WIDTH - TONE_FLAT)));
    }
    // `at`: when, in ctx's time; now if left out. A saved file's tone is scheduled ahead.
    return {
      setPitch: function (octaves, at) {
        var now = at === undefined ? ctx.currentTime : at;
        partials.forEach(function (p) {
          var x = place(octaves, p.k);
          var hz = TONE_CENTER_HZ * Math.pow(2, x);
        // Small moves are smoothed; a wrap (or a seek) jumps at once: an instant pitch
        // change makes no click, a smoothed one would chirp. Volume is always smoothed.
          var jump = p.x === null || Math.abs(x - p.x) > 0.5;
          if (jump) p.osc.frequency.setValueAtTime(hz, now);
          else p.osc.frequency.setTargetAtTime(hz, now, 0.02);
          p.gain.gain.setTargetAtTime(bell(x), now, 0.02);
          p.x = x;
        });
      },
      setLevel: function (level, at) {
        master.gain.setTargetAtTime(TONE_LEVEL * level, at === undefined ? ctx.currentTime : at, TONE_FADE_S);
      },
    };
  }

  var log10DefaultScale = 0;
  function pitchOf(i) {
    return (log10DefaultScale - Math.log10(frames[i].scale)) * OCTAVES_PER_DECADE;
  }

  // Off until asked, and the AudioContext made only in the click: a page can't start sound on its own.
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

  // Past two movie frames per screen frame, skip unpacking the ones never shown.
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
      // Never ahead of the unpacker: waiting a frame reads better than stuttering forward.
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
    if (videoProblem) {
      btnDownload.textContent = videoProblem;
      btnDownload.disabled = true;
    }
    btnDownload.addEventListener("click", downloadMovie);

    setPlaying(true);
    requestAnimationFrame(tick);
  }

  // ---- Saving it as a file ---- every frame is encoded (WebCodecs) as soon as it is rendered,
  // straight from the picture on screen; Download puts the chunks in an MP4 (mp4-muxer.js), with the tone if sound is on.
  var DOWNLOAD_LABEL = "Download";
  var KEYFRAME_EVERY = FPS; // so players can seek
  // H.264 plays everywhere, so it is tried at every size before VP9 or AV1. High profile, levels 4.0 to 5.2.
  var VIDEO_CODECS = [
    ["avc", ["avc1.640028", "avc1.64002a", "avc1.640032", "avc1.640033", "avc1.640034"]],
    ["vp9", ["vp09.00.51.08"]],
    ["av1", ["av01.0.13M.08"]],
  ];
  // A frame no encoder takes whole is shrunk into these in turn (long side, short side).
  var FILE_BOXES = [[4096, 2304], [3840, 2160], [1920, 1080]];
  var SOUND_RATE = 48000;

  var videoEncoder = null, videoFile = null; // videoFile: { mux, width, height }
  var videoChunks = [], videoMeta = null;
  var videoProblem = null; // why there is no file to save
  var shrunk = null, shrunkCtx = null;

  // The first of `tries` ({ config }) that `Codec` accepts, or null.
  function firstSupported(Codec, tries, i) {
    i = i || 0;
    if (i >= tries.length) return Promise.resolve(null);
    return Codec.isConfigSupported(tries[i].config).then(function (answer) {
      return answer.supported ? tries[i] : firstSupported(Codec, tries, i + 1);
    }, function () { return firstSupported(Codec, tries, i + 1); });
  }

  function openVideo(width, height) {
    if (typeof VideoEncoder !== "function") {
      videoProblem = "Saving isn't supported in this browser";
      return Promise.resolve();
    }
    var sizes = [[width, height]];
    FILE_BOXES.forEach(function (box) {
      var s = Math.min(box[0] / Math.max(width, height), box[1] / Math.min(width, height));
      if (s < 1) sizes.push([4 * Math.floor(width * s / 4), 2 * Math.floor(height * s / 2)]);
    });
    var tries = [];
    VIDEO_CODECS.forEach(function (family) {
      sizes.forEach(function (size) {
        family[1].forEach(function (codec) {
          tries.push({ mux: family[0], config: {
            codec: codec, width: size[0], height: size[1], framerate: FPS,
            // Generous: fine noise turns to mush at a default bitrate.
            bitrate: Math.min(60e6, Math.max(8e6, size[0] * size[1] * 12)),
          } });
        });
      });
    });
    return firstSupported(VideoEncoder, tries).then(function (pick) {
      if (!pick) {
        videoProblem = "Saving isn't supported in this browser";
        return;
      }
      videoFile = { mux: pick.mux, width: pick.config.width, height: pick.config.height };
      videoEncoder = new VideoEncoder({
        output: function (chunk, meta) {
          if (!videoMeta && meta && meta.decoderConfig) videoMeta = meta;
          videoChunks.push(chunk);
        },
        error: dropVideo,
      });
      videoEncoder.configure(pick.config);
    }).catch(dropVideo);
  }

  function dropVideo(err) {
    if (videoProblem) return;
    videoProblem = "Saving failed: " + ((err && err.message) || err);
    videoChunks = [];
    if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
    videoEncoder = null;
  }

  // Frame i, from `copy`, shrunk first if the file is smaller.
  function encodeFrame(i) {
    if (!videoEncoder) return;
    var source = copy;
    if (copy.width !== videoFile.width || copy.height !== videoFile.height) {
      if (!shrunk) {
        shrunk = document.createElement("canvas");
        shrunk.width = videoFile.width;
        shrunk.height = videoFile.height;
        shrunkCtx = shrunk.getContext("2d");
        shrunkCtx.imageSmoothingQuality = "high";
      }
      shrunkCtx.drawImage(copy, 0, 0, shrunk.width, shrunk.height);
      source = shrunk;
    }
    var frame = null;
    try {
      frame = new VideoFrame(source, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      videoEncoder.encode(frame, { keyFrame: i % KEYFRAME_EVERY === 0 });
    } catch (err) {
      dropVideo(err);
    }
    if (frame) frame.close();
  }

  // Holds the next render while the encoder is behind: each frame waiting on it is a whole picture in memory.
  function whenEncoderReady(then) {
    if (videoEncoder && videoEncoder.encodeQueueSize > 2) setTimeout(whenEncoderReady, 10, then);
    else then();
  }

  function finishVideo() {
    if (!videoEncoder) return Promise.resolve();
    return videoEncoder.flush().then(function () {
      videoEncoder.close();
      videoEncoder = null;
    }).catch(dropVideo);
  }

  // The tone the player plays, rendered ahead and encoded; null where this browser can't.
  function soundTrack() {
    if (typeof AudioEncoder !== "function" || typeof OfflineAudioContext !== "function") return Promise.resolve(null);
    var tries = [["aac", "mp4a.40.2"], ["opus", "opus"]].map(function (c) {
      return { mux: c[0], config: { codec: c[1], sampleRate: SOUND_RATE, numberOfChannels: 1, bitrate: 128000 } };
    });
    return firstSupported(AudioEncoder, tries).then(function (pick) {
      if (!pick) return null;
      var seconds = frames.length / FPS;
      var offline = new OfflineAudioContext(1, Math.ceil(seconds * SOUND_RATE), SOUND_RATE);
      var tone = new ShepardTone(offline, offline.destination);
      tone.setLevel(1, 0);
      for (var i = 0; i < frames.length; i++) tone.setPitch(pitchOf(i), i / FPS);
      tone.setLevel(0, Math.max(0, seconds - 4 * TONE_FADE_S)); // silent by the end
      return offline.startRendering().then(function (buffer) {
        var chunks = [], meta = null;
        var encoder = new AudioEncoder({
          output: function (chunk, m) {
            if (!meta && m && m.decoderConfig) meta = m;
            chunks.push(chunk);
          },
          error: function () {}, // flush() rejects with it
        });
        encoder.configure(pick.config);
        var samples = buffer.getChannelData(0);
        for (var at = 0; at < samples.length; at += SOUND_RATE) {
          var part = samples.subarray(at, at + SOUND_RATE);
          var data = new AudioData({ format: "f32-planar", sampleRate: SOUND_RATE, numberOfChannels: 1,
            numberOfFrames: part.length, timestamp: Math.round(at * 1e6 / SOUND_RATE), data: part });
          encoder.encode(data);
          data.close();
        }
        return encoder.flush().then(function () {
          encoder.close();
          return { mux: pick.mux, chunks: chunks, meta: meta };
        });
      });
    });
  }

  function downloadMovie() {
    if (btnDownload.disabled) return;
    var withSound = soundOn;
    btnDownload.disabled = true;
    btnDownload.textContent = "Saving";
    (withSound ? soundTrack() : Promise.resolve(null)).then(function (sound) {
      // The file in pieces as written; the one write back over earlier bytes is the mdat's size.
      var parts = [], size = 0;
      var target = new Mp4Muxer.StreamTarget({
        onData: function (data, position) {
          if (position === size) {
            parts.push(data);
            size += data.byteLength;
            return;
          }
          var start = 0;
          parts.forEach(function (part) {
            var from = Math.max(position, start), to = Math.min(position + data.byteLength, start + part.byteLength);
            if (from < to) part.set(data.subarray(from - position, to - position), from - start);
            start += part.byteLength;
          });
        },
      });
      var muxer = new Mp4Muxer.Muxer({
        target: target,
        video: { codec: videoFile.mux, width: videoFile.width, height: videoFile.height, frameRate: FPS },
        audio: sound ? { codec: sound.mux, numberOfChannels: 1, sampleRate: SOUND_RATE } : undefined,
        fastStart: false,
        firstTimestampBehavior: "offset",
      });
      // In time order, so the two tracks interleave.
      var audio = sound ? sound.chunks : [], v = 0, a = 0;
      while (v < videoChunks.length || a < audio.length) {
        if (a < audio.length && (v >= videoChunks.length || audio[a].timestamp < videoChunks[v].timestamp)) {
          muxer.addAudioChunk(audio[a], a === 0 ? sound.meta : undefined);
          a++;
        } else {
          muxer.addVideoChunk(videoChunks[v], v === 0 ? videoMeta : undefined);
          v++;
        }
      }
      muxer.finalize();
      var save = document.createElement("a");
      save.href = URL.createObjectURL(new Blob(parts, { type: "video/mp4" }));
      save.download = "chaosaccelerator-movie.mp4";
      document.body.appendChild(save);
      save.click();
      save.remove();
      setTimeout(function () { URL.revokeObjectURL(save.href); }, 60000);
      btnDownload.textContent = withSound && !sound ? "Saved without sound: not supported in this browser" : DOWNLOAD_LABEL;
      btnDownload.disabled = false;
    }).catch(function (err) {
      btnDownload.textContent = "Saving failed: " + ((err && err.message) || err);
      btnDownload.disabled = false;
    });
  }

  startEngine();
})();
