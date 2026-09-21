// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// The movie player (chaosplayback.html). Three things, in order:
//
//  1. READ the movie out of the address - the scene, how its map is drawn,
//     and the keyframes (share-url.js). Nothing else is needed, which is
//     what makes a movie's link something that can be sent to anyone: opened
//     cold, it renders and plays the same movie.
//
//  2. RENDER every frame before showing any of them. The camera's position
//     at each frame comes from movie-path.js. The PICTURE comes from the app
//     itself, loaded in a frame and asked for one finished still at a time
//     (FractalGrid.renderStill) - so a movie is drawn by exactly the code
//     that draws the map: the same precision ladder at a deep zoom, the same
//     draws sized to what the GPU will allow, the same antialiasing. A second
//     renderer here would be thousands of lines, and would be a different
//     picture by the first deep zoom.
//
//  3. PLAY what was rendered, looping, from memory. Frames are kept as JPEG
//     blobs rather than bitmaps - a minute of full-resolution movie is tens
//     of gigabytes unpacked, and tens of megabytes packed - and unpacked a
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

  // The ways back. The map gets the keyframes back too, in its own link, so
  // the Movie card comes up holding the movie this was rendered from - ready
  // to be changed and rendered again - on the first keyframe's view.
  var first = movie.keyframes[0];
  $("back-to-scene").href = "chaos.html#" + ShareUrl.encode({ page: ShareUrl.PAGE_BUILDER, scene: link.scene });
  $("back-to-map").href = "chaos.html#" + ShareUrl.encode({
    page: ShareUrl.PAGE_MAP,
    scene: link.scene,
    view: { center: first.center, zoom: first.zoom, display: link.view.display, precision: link.view.precision, movie: movie },
  });
  // A different movie pasted over this one's address: the simple, certain way
  // to get from one to the other is to start over.
  window.addEventListener("hashchange", function () { location.reload(); });

  // ---- The screen ----
  //
  // One canvas, the size of the stage in device pixels. Whatever is being
  // shown - a frame just rendered, or the movie playing - is drawn to fit
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

  var frames = [];        // [{ center, scale, step }] - see MoviePath.frames
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
  // identical frames is counted as often as it plays - an estimate of the
  // movie, which is what a reader expects, a little over what is held.
  var packedBytes = 0, packedFrames = 0;
  function formatBytes(bytes) {
    var units = ["B", "KB", "MB", "GB"], u = 0;
    while (bytes >= 1024 && u < units.length - 1) { bytes /= 1024; u++; }
    return (u === 0 || bytes >= 100 ? Math.round(bytes) : bytes.toFixed(1)) + " " + units[u];
  }
  var renderStartedAt = 0, frameStartedAt = 0;

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

  function renderFrame(grid, i) {
    if (i >= frames.length) {
      Promise.all(blobPromises).then(function (all) {
        if (all.some(function (blob) { return !blob; })) {
          fail("This browser couldn't store a frame that size. Try a lower resolution in the Movie card.");
          return;
        }
        blobs = all;
        // The renderer has done its work; its GPU memory is wanted back.
        engine.remove();
        beginPlayback();
      });
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
    // The app, opened on this movie's map - drawn the way the movie is to be
    // drawn, and otherwise at its defaults.
    engine.src = "chaos.html#" + ShareUrl.encode({
      page: ShareUrl.PAGE_MAP,
      scene: link.scene,
      view: { display: link.view.display, precision: link.view.precision },
    });
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
      formatBytes(blobs.reduce(function (sum, blob) { return sum + blob.size; }, 0)) + "  \u00b7  rendered in " + formatDuration((performance.now() - renderStartedAt) / 1000);
    scrubber.max = String(frames.length - 1);
    [btnPlayPause, scrubber, btnSpeed, btnLoop, btnRestart].forEach(function (control) { control.disabled = false; });

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
    window.addEventListener("keydown", function (event) {
      if (event.target === scrubber) return; // it has arrow keys of its own
      if (event.key === " ") { event.preventDefault(); btnPlayPause.click(); }
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
  // MediaRecorder is filming - so this takes as long as the movie runs, and
  // produces whatever video format this browser records (WebM in Chrome and
  // Firefox, MP4 in Safari). That is the price of having no encoder of our
  // own: a real one would mean shipping a muxer library. Every frame is held
  // for exactly one frame's time, paced against the clock rather than by
  // counting timeouts, so the file runs at the movie's own speed.
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
    var type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].filter(function (t) {
      return MediaRecorder.isTypeSupported(t);
    })[0];
    var recorder;
    try {
      // Generous on purpose: this picture is mostly fine noise, which a
      // default bitrate turns to mush.
      recorder = new MediaRecorder(film.captureStream(FPS), { mimeType: type, videoBitsPerSecond: Math.min(60e6, Math.max(8e6, frameWidth * frameHeight * 12)) });
    } catch (err) {
      btnDownload.textContent = "Not supported in this browser";
      btnDownload.disabled = true;
      return;
    }
    var chunks = [];
    recorder.ondataavailable = function (event) { if (event.data && event.data.size) chunks.push(event.data); };
    recorder.onstop = function () {
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
    function film1(i) {
      if (i >= blobs.length) {
        // One more frame's time, or the last frame is cut short.
        setTimeout(function () { recorder.stop(); }, 1000 / FPS);
        return;
      }
      createImageBitmap(blobs[i]).then(function (bitmap) {
        var due = startedAt + i * 1000 / FPS;
        setTimeout(function () {
          filmCtx.drawImage(bitmap, 0, 0);
          bitmap.close();
          btnDownload.textContent = "Recording " + Math.round(100 * (i + 1) / blobs.length) + "%";
          film1(i + 1);
        }, Math.max(0, due - performance.now()));
      }, function () { recorder.stop(); });
    }
    // The first frame is on the canvas before filming starts, so the file
    // doesn't open on a blank.
    createImageBitmap(blobs[0]).then(function (bitmap) {
      filmCtx.drawImage(bitmap, 0, 0);
      bitmap.close();
      recorder.start();
      startedAt = performance.now();
      film1(1);
    });
  }

  startEngine();
})();
