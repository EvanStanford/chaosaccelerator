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
  var quality = MoviePath.QUALITIES[Math.min(movie.quality, MoviePath.QUALITIES.length - 1)];

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
  var recentFrameMs = [];
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

  function frameKey(f) {
    return [f.center.x, f.center.xLo, f.center.y, f.center.yLo, f.scale, f.step].join(" ");
  }

  function finishRender() {
    renderStatus.textContent = "Finishing\u2026";
    Promise.all(blobPromises).then(function (all) {
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
      // Called from inside the renderer's own frame: anything thrown here would end its render loop.
      if (endedEarly) return; // this frame was given up on
      try {
        if (copy.width !== canvas.width || copy.height !== canvas.height) {
          copy.width = frameWidth = canvas.width;
          copy.height = frameHeight = canvas.height;
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
    // Sized ONCE: a renderer that followed the window would restart on every resize.
    engine.style.width = Math.max(16, Math.round(rect.width / quality.divisor)) + "px";
    engine.style.height = Math.max(16, Math.round(rect.height / quality.divisor)) + "px";
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
    return {
      setPitch: function (octaves) {
        var now = ctx.currentTime;
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
      setLevel: function (level) {
        master.gain.setTargetAtTime(TONE_LEVEL * level, ctx.currentTime, TONE_FADE_S);
      },
      stop: function () {
        partials.forEach(function (p) { p.osc.stop(); });
        master.disconnect();
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
    btnDownload.addEventListener("click", downloadMovie);

    setPlaying(true);
    requestAnimationFrame(tick);
  }

  // ---- Saving it as a file ---- the frames are replayed once, off screen, into a canvas
  // MediaRecorder is filming, so it takes as long as the movie and produces whatever this
  // browser records (WebM in Chrome/Firefox, MP4 in Safari). Paced against the clock, not by
  // counting timeouts. With sound on, a second tone plays into the recording alone.
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
      // Generous: fine noise turns to mush at a default bitrate.
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
    function formatRecorded(seconds) {
      seconds = Math.floor(seconds);
      var m = Math.floor(seconds / 60), s = seconds % 60;
      return m ? m + "m" + (s < 10 ? "0" : "") + s + "s" : s + "s";
    }
    var movieLength = formatRecorded(blobs.length / FPS);
    function film1(i) {
      if (i >= blobs.length) {
        // One more frame's time, or the last frame is cut short; with sound, long enough to fade.
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
    // First frame on the canvas before filming starts, so the file doesn't open on a blank.
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
