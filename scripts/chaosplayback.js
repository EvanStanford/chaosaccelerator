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
  var renderSpinner = $("render-spinner");
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
  if (!link || link.page !== ShareUrl.PAGE_MOVIE || !link.scene) {
    fail("There's no movie in this address. Movies are made on the map, in the Movie card.");
    return;
  }
  var movie = link.view.movie;
  var movieSize = movie.size, antialias = movie.antialias;
  // A movie of the map's Inspect tab plays its locked points once instead of flying through keyframes.
  var ofInspect = movie.subject === "inspect";
  if (ofInspect ? !link.view.inspect.length : !movie.keyframes.length) {
    fail(ofInspect ? "This link has no locked Inspect points to film." : "There's no movie in this address. Movies are made on the map, in the Movie card.");
    return;
  }

  // The way back, keyframes and Inspect points included, so the map comes up as it was left.
  var backView = ofInspect ? link.view : movie.keyframes[0];
  $("back-to-map").href = "chaos.html#" + ShareUrl.encode({
    page: ShareUrl.PAGE_MAP,
    scene: link.scene,
    view: {
      center: backView.center, zoom: backView.zoom, display: link.view.display, lowSaturation: link.view.lowSaturation, precision: link.view.precision,
      speed: link.view.speed, volume: link.view.volume, inspect: link.view.inspect,
      movie: { keyframes: movie.keyframes, size: movie.size, antialias: movie.antialias, loop: movie.loop },
    },
  });
  // A different movie pasted over the address: start over.
  window.addEventListener("hashchange", function () { location.reload(); });

  // ---- The screen ---- one canvas, stage-sized in device px; whatever is shown is drawn to fit inside it whole.
  var shown = null, shownFrame = 0; // the last thing drawn and its frame, for redrawing after a resize

  function fitScreen() {
    var rect = stage.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    if (screen.width !== w || screen.height !== h) {
      screen.width = w;
      screen.height = h;
    }
    if (shown) show(shown, shownFrame);
  }
  function show(image, frame) {
    shown = image;
    shownFrame = frame;
    var scale = Math.min(screen.width / image.width, screen.height / image.height);
    var w = image.width * scale, h = image.height * scale, x = (screen.width - w) / 2, y = (screen.height - h) / 2;
    screenCtx.fillStyle = "#000";
    screenCtx.fillRect(0, 0, screen.width, screen.height);
    screenCtx.imageSmoothingEnabled = true;
    screenCtx.imageSmoothingQuality = "high";
    screenCtx.drawImage(image, x, y, w, h);
    var at = inspection && inspectCorner.value !== "off" ? inspectionAt(frame) : null;
    if (at) drawInspection(screenCtx, inspectCanvas, image.width, image.height, x, y, scale, at);
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
  var WATERMARK = "chaosaccelerator.com";
  function watermarkFont(height) {
    var size = Math.max(7, Math.round(height * 0.022));
    return { size: size, inset: size, font: size + "px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" };
  }
  function stampWatermark() {
    var mark = watermarkFont(copy.height), size = mark.size, inset = mark.inset;
    copyCtx.save();
    copyCtx.font = mark.font;
    copyCtx.textAlign = "right";
    copyCtx.textBaseline = "alphabetic";
    copyCtx.shadowColor = "rgba(0, 0, 0, 0.8)";
    copyCtx.shadowBlur = Math.max(2, size / 4);
    copyCtx.shadowOffsetY = Math.max(1, size / 12);
    copyCtx.fillStyle = "#fff";
    copyCtx.fillText(WATERMARK, copy.width - inset, copy.height - inset);
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
    if (progressNote) detail += "  \u00b7  " + progressNote;
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
      closeJob();
      // The renderer stays for the Inspect overlay; a last still 16 px across lets its canvas go.
      if (!ofInspect) engineGrid.renderStill({ center: frames[0].center, scale: frames[0].scale, step: 0, antialias: false, width: 16, height: 16 }, function () {});
      if (videoFile || videoProblem) return beginPlayback();
      // Resumed with nothing left to render: the file's size from a saved frame.
      createImageBitmap(blobs[0]).then(function (bitmap) {
        frameWidth = bitmap.width;
        frameHeight = bitmap.height;
        bitmap.close();
        return openVideo(frameWidth, frameHeight, false);
      }).then(beginPlayback);
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
    saveFrame(i);
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
        show(copy, i);
        noteFrameTime(frameCosts[i], performance.now() - frameStartedAt);
        // The first frame rendered sets the file's size, so the encoder is chosen now; a resumed render
        // encodes nothing yet (its earlier frames exist only as JPEGs).
        if (!videoChosen) {
          videoChosen = true;
          openVideo(w, h, resumedFrom === 0).then(function () { frameDone(grid, i); });
        } else {
          frameDone(grid, i);
        }
      } catch (err) {
        fail("Rendering stopped: " + (err.message || err));
      }
    });
  }

  function beginRender(grid) {
    engineGrid = grid;
    if (ofInspect) return beginInspectRender(grid);
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
    movieFacts.textContent = frames.length.toLocaleString() + " frames  \u00b7  " + (frames.length / FPS).toFixed(1) + " s";
    openJob().then(function (from) {
      resumedFrom = from;
      renderStartedAt = performance.now();
      reportProgress(from);
      renderFrame(grid, from);
    });
  }

  // ---- Saved progress ---- (movie-store.js) every finished frame is saved, so a closed player can resume, two
  // frames back in case either was bad. This render goes unsaved while another tab renders or another movie is paused.
  var address = ShareUrl.cleanFragment(location.hash);
  var job = null; // the progress this page saves, or null
  var saving = Promise.resolve(), saveFailed = false;
  var resumedFrom = 0, priorMs = 0, progressNote = "", releaseLock = null, videoChosen = false;

  function openJob() {
    return Promise.all([MovieStore.load(), MovieStore.running()]).then(function (found) {
      var saved = found[0];
      if (found[1]) {
        progressNote = "progress isn't saved while another tab renders";
        return 0;
      }
      if (saved && saved.link === address) return resumeJob(saved);
      if (saved) {
        progressNote = "progress isn't saved while another render is paused";
        return 0;
      }
      var fresh = { link: address, total: frames.length, done: 0, ms: 0 };
      return MovieStore.begin(fresh).then(function () {
        job = fresh;
        return 0;
      });
    }).catch(function () {
      job = null;
      progressNote = "progress can't be saved in this browser";
      return 0;
    }).then(function (from) {
      if (job) releaseLock = MovieStore.hold();
      return from;
    });
  }

  // A saved frame that no longer matches its frame (the code changed since) ends the reuse there.
  function resumeJob(saved) {
    var upTo = Math.max(0, Math.min(saved.done, frames.length) - 2);
    return MovieStore.frames(upTo).then(function (stored) {
      var from = 0;
      while (from < upTo && stored[from] && stored[from].i === from && stored[from].key === frameKey(frames[from]) &&
        (stored[from].blob || from > 0)) {
        var blob = stored[from].blob;
        blobPromises[from] = blob ? Promise.resolve(blob) : blobPromises[from - 1];
        if (blob) {
          packedBytes += blob.size;
          packedFrames += 1;
        }
        from++;
      }
      job = saved;
      job.total = frames.length;
      job.done = from;
      priorMs = saved.ms || 0;
      if (from > 0) progressNote = "resumed at frame " + (from + 1).toLocaleString();
      return from;
    });
  }

  // After a failed save the job stays as last saved, and is still cleared when the render ends.
  function saveFrame(i) {
    if (!job || saveFailed) return;
    var repeat = i > 0 && blobPromises[i] === blobPromises[i - 1];
    saving = saving.then(function () { return blobPromises[i]; }).then(function (blob) {
      if (!job || saveFailed) return;
      job.done = i + 1;
      job.ms = priorMs + performance.now() - renderStartedAt;
      return MovieStore.saveFrame(i, frameKey(frames[i]), repeat ? null : blob, job);
    }).catch(function () {
      saveFailed = true;
      progressNote = "progress stopped being saved";
    });
  }

  // The render is over (all of it, or ended early): nothing left to resume.
  function closeJob() {
    if (!job) return;
    job = null;
    saving = saving.then(function () { return MovieStore.discard(); }).catch(function () {}).then(function () {
      if (releaseLock) releaseLock();
    });
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
    // Silent: the engine's own Inspect tab would play the points' bounces.
    var view = { display: link.view.display, lowSaturation: link.view.lowSaturation, volume: 0 };
    if (!ofInspect) {
      view.precision = link.view.precision;
      engine.src = "chaos.html#" + ShareUrl.encode({ page: ShareUrl.PAGE_MAP, scene: link.scene, view: view });
      return;
    }
    // Without the map's own copy, the engine rebuilds the points from the link, so it needs them and their view.
    loadInspectSnapshot().then(function () {
      if (!inspectSnapshot) {
        view.precision = link.view.precision;
        view.center = link.view.center;
        view.zoom = link.view.zoom;
        view.speed = link.view.speed;
        view.inspect = link.view.inspect;
      }
      engine.src = "chaos.html#" + ShareUrl.encode({ page: ShareUrl.PAGE_MAP, scene: link.scene, view: view });
    });
  }

  // ---- A movie of the Inspect tab ---- the map's saved trajectories if they are this link's, else the points rebuilt
  // from the link (FractalGrid.inspectTab); played once at the tab's speed, then held on the last frame as the tab does.
  var inspectSnapshot = null;
  function loadInspectSnapshot() {
    return MovieStore.loadInspect().then(function (saved) {
      if (saved && withoutLook(ShareUrl.cleanFragment(saved.link)) === withoutLook(address)) inspectSnapshot = saved;
    }).catch(function () {});
  }

  // The look (background, filled bodies, pace) is chosen here, so a snapshot is this link's whatever its look. A
  // new look goes in the address, and the page films again (hashchange reloads it).
  var backgroundField = $("background-field"), backgroundChoice = $("background-choice");
  var bodiesField = $("bodies-field"), bodiesChoice = $("bodies-choice");
  var paceField = $("pace-field"), paceChoice = $("pace-choice");
  function withoutLook(fragment) { return fragment.replace(/,(bkgd|fill|pace):[a-z0-9.]+/g, ""); }
  backgroundChoice.value = movie.background;
  bodiesChoice.value = movie.filled ? "filled" : "outlined";
  paceChoice.value = String(movie.pace);
  function changeLook() {
    var fragment = withoutLook(address);
    if (backgroundChoice.value !== "plain") fragment += ",bkgd:" + backgroundChoice.value;
    if (bodiesChoice.value === "filled") fragment += ",fill:t";
    if (paceChoice.value !== "1") fragment += ",pace:" + paceChoice.value.replace(/^0/, "");
    location.hash = fragment;
  }
  backgroundChoice.addEventListener("change", changeLook);
  bodiesChoice.addEventListener("change", changeLook);
  paceChoice.addEventListener("change", changeLook);

  function beginInspectRender(grid) {
    renderStatus.textContent = "Filming the Inspect tab\u2026";
    renderSpinner.hidden = false;
    progressEl.hidden = renderDetail.hidden = renderActions.hidden = true;
    var tab = grid.inspectTab(inspectSnapshot, { background: movie.background, filled: movie.filled });
    if (!tab) {
      // Still rebuilding the link's points.
      requestAnimationFrame(function () { beginInspectRender(grid); });
      return;
    }
    if (!tab.points) {
      fail("None of this link's Inspect points could be simulated.");
      return;
    }
    filmVoices = tab.voices;
    // The chosen size, cut to the scene's shape.
    var w = movieSize.width, h = movieSize.height;
    if (w / h > tab.aspect) w = h * tab.aspect;
    else h = w / tab.aspect;
    copy.width = frameWidth = Math.max(16, 4 * Math.floor(w / 4));
    copy.height = frameHeight = Math.max(16, 2 * Math.floor(h / 2));
    // Slowed, frames fall between simulation steps and the app places the bodies in between; at full pace each
    // frame is a step the simulation reached, as the tab shows it.
    var rate = tab.stepsPerSecond * movie.pace;
    var count = Math.ceil((tab.steps - 1) * FPS / rate) + 1 + Math.round(tab.endHoldSeconds * FPS);
    frames = [];
    for (var i = 0; i < count; i++) {
      var step = i * rate / FPS;
      frames.push({ step: Math.min(tab.steps - 1, movie.pace < 1 ? step : Math.floor(step)) });
    }
    blobPromises = new Array(frames.length);
    movieFacts.textContent = frames.length.toLocaleString() + " frames  \u00b7  " + (frames.length / FPS).toFixed(1) + " s";
    renderStartedAt = performance.now();
    openVideo(frameWidth, frameHeight, true).then(function () { filmInspectFrame(tab, 0); });
  }

  // The Inspect tab's sounds for the move from frame `from` to frame `to`, into `track` at `when`: a voice bounces
  // or stops at an edge once for the steps in between, as the tab sounds them.
  var filmVoices = [];
  function soundInspectStep(track, from, to, when) {
    var a = frames[from].step, b = frames[to].step;
    if (b <= a) return;
    filmVoices.forEach(function (voice) {
      if (voice.bounces.some(function (e) { return e > a && e <= b; })) track.bounce(voice.freq, when);
      if (voice.edgeStep !== null && voice.edgeStep > a && voice.edgeStep <= b) track.edge(voice.freq, when);
    });
  }

  // A few JPEGs in flight at most, and a pause for the page every few frames.
  function filmInspectFrame(tab, i) {
    if (i >= frames.length) {
      finishRender();
      return;
    }
    Promise.resolve(i >= 4 ? blobPromises[i - 4] : null).then(function () {
      if (i > 0 && frames[i].step === frames[i - 1].step) {
        blobPromises[i] = blobPromises[i - 1];
      } else {
        tab.draw(copyCtx, copy.width, copy.height, frames[i].step);
        stampWatermark();
        blobPromises[i] = new Promise(function (resolve) { copy.toBlob(resolve, "image/jpeg", JPEG_QUALITY); });
      }
      encodeFrame(i);
      renderedCount = i + 1;
      whenEncoderReady(function () {
        if ((i + 1) % 8) filmInspectFrame(tab, i + 1);
        else setTimeout(filmInspectFrame, 0, tab, i + 1);
      });
    });
  }

  // ---- Inspect point ---- the Inspect preview of the center of the most zoomed-in keyframe (the last, if
  // several tie), drawn into a corner of every frame at that frame's Map Evolution frame, and into a download.
  // A movie whose keyframes share one simulation frame plays the point's run once instead, then fades it out.
  var inspectField = $("inspect-field"), inspectCorner = $("inspect-corner"), inspectTitle = inspectField.title;
  var engineGrid = null;
  var inspection = null; // FractalGrid.inspection(), made the first time a corner is picked
  var inspectCanvas = document.createElement("canvas");

  function inspectKeyframe() {
    return movie.keyframes.reduce(function (best, k) { return k.zoom >= best.zoom ? k : best; });
  }

  inspectCorner.addEventListener("change", function () {
    if (inspectCorner.value === "off" || inspection) {
      if (shown) show(shown, shownFrame);
      return;
    }
    // Simulating can take seconds (building a high precision's program): painted as such before it blocks.
    inspectCorner.disabled = true;
    inspectField.firstElementChild.textContent = "Simulating";
    requestAnimationFrame(function () { setTimeout(simulateInspection); });
  });

  function simulateInspection() {
    var k = inspectKeyframe();
    try {
      var precision = engineGrid.stillPrecision({ center: k.center, scale: engineGrid.defaultScale() / k.zoom, width: movieSize.width, height: movieSize.height });
      inspection = engineGrid.inspection(k.center, precision.name);
    } catch (err) {
      inspection = null;
    }
    inspectCorner.disabled = false;
    inspectField.firstElementChild.textContent = "Inspect point";
    inspectField.title = inspection ? inspectTitle : "This point couldn't be simulated.";
    if (!inspection) inspectCorner.value = "off";
    if (shown) show(shown, shownFrame);
  }

  // The overlay at movie frame i, { step, alpha }, or null once it has faded out. The run plays at Inspect's 1x,
  // or 2x or 4x if the movie is too short for it; still too short at 4x, it is cut off at the end.
  var INSPECT_FADE_SECONDS = 0.5;
  function inspectionAt(i) {
    if (frames.some(function (f) { return f.step !== frames[0].step; })) return { step: frames[i].step, alpha: 1 };
    var rate = inspection.stepsPerSecond, lastSecond = (frames.length - 1) / FPS;
    if (inspection.steps / rate > lastSecond) rate *= 2;
    if (inspection.steps / rate > lastSecond) rate *= 2;
    var seconds = i / FPS, past = seconds - inspection.steps / rate;
    if (past >= INSPECT_FADE_SECONDS) return null;
    return { step: Math.min(inspection.steps, Math.round(seconds * rate)), alpha: past > 0 ? 1 - past / INSPECT_FADE_SECONDS : 1 };
  }

  // Into ctx, where a frame of width x height is drawn at (x, y) times `scale`: a corner of it, above the
  // watermark where they'd meet, as inspectionAt() says. The overlay is drawn in `scratch` first.
  function drawInspection(ctx, scratch, width, height, x, y, scale, at) {
    var w = width * scale, h = height * scale;
    var ih = Math.round(h * 0.3), iw = Math.round(ih * inspection.aspect);
    if (iw > w * 0.45) {
      iw = Math.round(w * 0.45);
      ih = Math.round(iw / inspection.aspect);
    }
    var margin = Math.round(h * 0.025), corner = inspectCorner.value;
    var ix = corner.indexOf("left") >= 0 ? x + margin : x + w - margin - iw;
    var iy = corner.indexOf("top") === 0 ? y + margin : y + h - margin - ih;
    var mark = watermarkFont(height);
    copyCtx.save();
    copyCtx.font = mark.font;
    var markLeft = x + (width - mark.inset - copyCtx.measureText(WATERMARK).width) * scale - margin;
    var markTop = y + (height - mark.inset - mark.size) * scale - margin;
    copyCtx.restore();
    if (ix + iw > markLeft && iy + ih > markTop) iy = markTop - ih;
    if (scratch.width !== iw || scratch.height !== ih) {
      scratch.width = iw;
      scratch.height = ih;
    }
    inspection.draw(scratch.getContext("2d"), iw, ih, at.step);
    ctx.save();
    ctx.globalAlpha = at.alpha;
    ctx.drawImage(scratch, ix, iy);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
    ctx.restore();
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
  var soundOn = false, audioCtx = null, liveTone = null, liveVoices = null;
  function updateSound() {
    if (liveTone) liveTone.setLevel(soundOn && playing ? 1 : 0);
  }
  function setSoundOn(next) {
    soundOn = next;
    if (soundOn && !audioCtx && typeof AudioContext === "function") {
      audioCtx = new AudioContext();
      // An Inspect movie sounds its points' bounces and edge stops; a keyframe movie, the zoom's tone.
      if (ofInspect) liveVoices = PhysicsSound.track(audioCtx, audioCtx.destination);
      else liveTone = new ShepardTone(audioCtx, audioCtx.destination);
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
      if (liveVoices && soundOn && playing && shownIndex >= 0 && index > shownIndex) soundInspectStep(liveVoices, shownIndex, index, audioCtx.currentTime);
      show(bitmap, index);
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
      formatBytes(blobs.reduce(function (sum, blob) { return sum + blob.size; }, 0)) + "  \u00b7  rendered in " + formatDuration((priorMs + performance.now() - renderStartedAt) / 1000) +
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
      else if (event.key === "m" && !btnSound.hidden) btnSound.click();
      else if (event.key === "ArrowRight") { setPlaying(false); seek(Math.floor(position) + 1); }
      else if (event.key === "ArrowLeft") { setPlaying(false); seek(Math.floor(position) - 1); }
      else if (event.key === "Home") seek(0);
    });

    // The Inspect point belongs to keyframe movies, the look to Inspect ones.
    inspectField.hidden = ofInspect;
    backgroundField.hidden = bodiesField.hidden = paceField.hidden = !ofInspect;
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

  var videoEncoder = null, videoFile = null; // videoFile: { mux, width, height, config }
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

  // live false: settle the file's size and codec only, for a file encoded later from the JPEGs.
  function openVideo(width, height, live) {
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
      videoFile = { mux: pick.mux, width: pick.config.width, height: pick.config.height, config: pick.config };
      if (!live) return;
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
    try {
      encodeCanvas(videoEncoder, source, i);
    } catch (err) {
      dropVideo(err);
    }
  }

  // `source` as frame i of the movie.
  function encodeCanvas(encoder, source, i) {
    var frame = new VideoFrame(source, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    try {
      encoder.encode(frame, { keyFrame: i % KEYFRAME_EVERY === 0 });
    } finally {
      frame.close();
    }
  }

  // The movie from the frames' JPEGs (the sharper copy), the Inspect overlay drawn on if asked: for a download
  // with the overlay, and for a resumed render, whose earlier frames were never encoded. The next few are
  // unpacked while one encodes; a repeated frame is redrawn from the last picture only for the overlay.
  function encodeFromJpegs(withOverlay, onProgress) {
    var chunks = [], meta = null;
    var encoder = new VideoEncoder({
      output: function (chunk, m) {
        if (!meta && m && m.decoderConfig) meta = m;
        chunks.push(chunk);
      },
      error: function () {}, // flush() rejects with it
    });
    encoder.configure(videoFile.config);
    var film = document.createElement("canvas"), scratch = document.createElement("canvas");
    film.width = videoFile.width;
    film.height = videoFile.height;
    var filmCtx = film.getContext("2d");
    filmCtx.imageSmoothingQuality = "high";
    var unpacking = {};
    function unpack(i) {
      if (i < blobs.length && !unpacking[i] && (i === 0 || blobs[i] !== blobs[i - 1])) unpacking[i] = createImageBitmap(blobs[i]);
    }
    return new Promise(function (resolve, reject) {
      var i = 0, held = null;
      function fail(err) {
        if (encoder.state !== "closed") encoder.close();
        if (held) held.close();
        reject(err);
      }
      function next() {
        if (i >= blobs.length) {
          if (held) held.close();
          held = null;
          encoder.flush().then(function () {
            encoder.close();
            resolve({ chunks: chunks, meta: meta });
          }, fail);
          return;
        }
        if (encoder.encodeQueueSize > 2) {
          setTimeout(next, 4);
          return;
        }
        for (var ahead = i; ahead < i + 4; ahead++) unpack(ahead);
        (unpacking[i] || Promise.resolve(null)).then(function (bitmap) {
          if (bitmap) {
            delete unpacking[i];
            if (held) held.close();
            held = bitmap;
          }
          if (bitmap || withOverlay) {
            filmCtx.drawImage(held, 0, 0, film.width, film.height);
            var at = withOverlay ? inspectionAt(i) : null;
            if (at) drawInspection(filmCtx, scratch, frameWidth, frameHeight, 0, 0, film.width / frameWidth, at);
          }
          encodeCanvas(encoder, film, i);
          i++;
          if (i % 15 === 0) onProgress(i / blobs.length);
          next();
        }).catch(fail);
      }
      next();
    });
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

  // Samples the encoder holds its output back by (AAC primes 2112), found by encoding a click and decoding it.
  function encoderDelay(config) {
    var click = new Float32Array(SOUND_RATE), at = SOUND_RATE / 2;
    for (var i = 0; i < 48; i++) click[at + i] = 0.8 * (1 - i / 48);
    var chunks = [], meta = null, decoded = [];
    var encoder = new AudioEncoder({
      output: function (chunk, m) {
        if (!meta && m && m.decoderConfig) meta = m;
        chunks.push(chunk);
      },
      error: function () {},
    });
    encoder.configure(config);
    var data = new AudioData({ format: "f32-planar", sampleRate: SOUND_RATE, numberOfChannels: 1, numberOfFrames: click.length, timestamp: 0, data: click });
    encoder.encode(data);
    data.close();
    return encoder.flush().then(function () {
      encoder.close();
      var decoder = new AudioDecoder({
        output: function (part) {
          var samples = new Float32Array(part.numberOfFrames);
          part.copyTo(samples, { planeIndex: 0 });
          decoded.push(samples);
          part.close();
        },
        error: function () {},
      });
      decoder.configure(meta.decoderConfig);
      chunks.forEach(function (chunk) { decoder.decode(chunk); });
      return decoder.flush().then(function () {
        decoder.close();
        for (var b = 0, n = 0; b < decoded.length; b++) {
          for (var j = 0; j < decoded[b].length; j++, n++) if (Math.abs(decoded[b][j]) > 0.4) return Math.max(0, n - at);
        }
        return 0;
      });
    }).catch(function () { return 0; });
  }

  // The movie's sound, rendered ahead and encoded early by the encoder's delay so it lands on the picture; null where
  // this browser can't.
  function soundTrack() {
    if (typeof AudioEncoder !== "function" || typeof OfflineAudioContext !== "function") return Promise.resolve(null);
    var tries = [["aac", "mp4a.40.2"], ["opus", "opus"]].map(function (c) {
      return { mux: c[0], config: { codec: c[1], sampleRate: SOUND_RATE, numberOfChannels: 1, bitrate: 128000 } };
    });
    var pick = null, delay = 0;
    return firstSupported(AudioEncoder, tries).then(function (found) {
      pick = found;
      return pick ? encoderDelay(pick.config) : 0;
    }).then(function (found) {
      if (!pick) return null;
      delay = found;
      var seconds = frames.length / FPS;
      var offline = new OfflineAudioContext(1, Math.ceil(seconds * SOUND_RATE) + delay, SOUND_RATE);
      if (ofInspect) {
        var voices = PhysicsSound.track(offline, offline.destination);
        for (var f = 1; f < frames.length; f++) soundInspectStep(voices, f - 1, f, f / FPS);
      } else {
        var tone = new ShepardTone(offline, offline.destination);
        tone.setLevel(1, 0);
        for (var i = 0; i < frames.length; i++) tone.setPitch(pitchOf(i), i / FPS);
        tone.setLevel(0, Math.max(0, seconds - 4 * TONE_FADE_S)); // silent by the end
      }
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
        var samples = buffer.getChannelData(0).subarray(delay);
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
    var withSound = soundOn, withOverlay = !!inspection && inspectCorner.value !== "off";
    btnDownload.disabled = true;
    inspectCorner.disabled = true;
    btnDownload.textContent = "Saving";
    var picture = withOverlay || resumedFrom > 0
      ? encodeFromJpegs(withOverlay, function (done) { btnDownload.textContent = "Saving " + Math.round(done * 100) + "%"; })
      : Promise.resolve({ chunks: videoChunks, meta: videoMeta });
    Promise.all([picture, withSound ? soundTrack() : Promise.resolve(null)]).then(function (done) {
      var video = done[0], sound = done[1];
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
      while (v < video.chunks.length || a < audio.length) {
        if (a < audio.length && (v >= video.chunks.length || audio[a].timestamp < video.chunks[v].timestamp)) {
          muxer.addAudioChunk(audio[a], a === 0 ? sound.meta : undefined);
          a++;
        } else {
          muxer.addVideoChunk(video.chunks[v], v === 0 ? video.meta : undefined);
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
    }).catch(function (err) {
      btnDownload.textContent = "Saving failed: " + ((err && err.message) || err);
    }).then(function () {
      btnDownload.disabled = false;
      inspectCorner.disabled = false;
    });
  }

  startEngine();
})();
