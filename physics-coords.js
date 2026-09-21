// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// The one place the project's two coordinate systems meet.
//
// ENGINE SPACE is what every other file means by x/y, and none of this
// changes it: canvas pixels with the origin in the frame's TOP-LEFT corner
// and +y pointing DOWN, wrapping over [0, frameWidth) x [0, frameHeight)
// (see PhysicsEngine.step's frame wrap). The engine, the GPU compiler, the
// grid's shader codegen and every regression test still run on exactly that.
//
// AUTHORED SPACE is what a person reads and writes: the origin at the CENTER
// of the frame and +y pointing UP - the way a plot is drawn rather than the
// way a canvas is indexed. It is the space every scene JSON is written in
// (Export, Import, the sample files, the editor's own auto-save), and the
// space the editor and the fractal grid report positions in. Two things
// follow from the origin being the center rather than a corner, and both
// are the point of it: a scene is described relative to the middle of the
// frame, so opening it in a differently-sized window keeps it framed instead
// of pushing it off the bottom-right; and a fractal grid driven by a body's
// x/y lands its wrap tiling around the origin instead of off to one side.
//
// The map, for a frame fw x fh:
//
//   engine.x = authored.x + fw/2        authored.x = engine.x - fw/2
//   engine.y = fh/2 - authored.y        authored.y = fh/2 - engine.y
//
// The y half is a reflection, so it also reverses every quantity whose sign
// depends on which way is up or which way is round. angle, angular velocity
// (w) and vy all negate; vx and every size (radius/length/size) are
// untouched. Reflecting the angle is what makes a positive rotation read
// counter-clockwise on screen, which is what "+y is up" has to mean for it
// to be worth doing.
//
// A body's LOCAL frame reflects along with it, and needs no half-frame
// added: flipping y and negating the angle are the same operation on a local
// offset, since flipY(R(a) v) === R(-a) flipY(v). So a hinge's local anchor
// only ever has its own y negated. A hinge to the WORLD (bodyA === null) is
// the exception - its localAnchorA is a world point, not a local one (see
// PhysicsEngine.hingeBodyA's WORLD_BODY), so it takes the full position map.
// A spring's two anchors follow exactly the same two rules.
(function (global) {
  "use strict";

  // Same precision serializeScene rounds to; re-applied after a conversion
  // so a round trip through authored space doesn't leave 408 sitting in the
  // file as 407.99999999999994.
  function round(n) {
    return Math.round(n * 10000) / 10000;
  }

  // Half the frame, i.e. where the authored origin sits in engine space.
  // A scene with no locked frame (nothing in the editor has one until the
  // canvas has a size) degenerates to a plain y-flip about 0, which is
  // still self-inverse - the only requirement is that both directions use
  // the same frame.
  function halfFrame(frame) {
    return {
      x: (Number(frame.frameWidth) || 0) / 2,
      y: (Number(frame.frameHeight) || 0) / 2,
    };
  }

  function toAuthoredX(x, frame) { return x - halfFrame(frame).x; }
  function toAuthoredY(y, frame) { return halfFrame(frame).y - y; }
  function toEngineX(x, frame) { return x + halfFrame(frame).x; }
  function toEngineY(y, frame) { return halfFrame(frame).y - y; }
  // Both spaces measure rotation from the same axis; only its direction
  // differs, so this is its own inverse and serves both ways.
  function flipAngle(a) { return -a; }

  // The two directions differ only in how a position maps, so both are this
  // one walk over the scene with a different pair of position functions -
  // there is no second copy of the "which fields flip" list to drift out of
  // sync with the first.
  function convert(json, frame, mapX, mapY) {
    var out = {};
    Object.keys(json).forEach(function (k) { out[k] = json[k]; });

    out.bodies = (json.bodies || []).map(function (b) {
      var body = {};
      Object.keys(b).forEach(function (k) { body[k] = b[k]; });
      body.x = round(mapX(Number(b.x) || 0, frame));
      body.y = round(mapY(Number(b.y) || 0, frame));
      if (b.angle !== undefined) body.angle = round(flipAngle(Number(b.angle) || 0));
      if (b.vy !== undefined) body.vy = round(-(Number(b.vy) || 0));
      if (b.w !== undefined) body.w = round(flipAngle(Number(b.w) || 0));
      return body;
    });

    // A hinge and a spring are the same shape where it matters here - two
    // anchors, with end A a WORLD point when bodyA is null - so one walk
    // serves both. Everything else on the link (a spring's stiffness and rest
    // length) is a magnitude, and rides along untouched.
    function convertLink(h) {
      var link = {};
      Object.keys(h).forEach(function (k) { link[k] = h[k]; });
      var worldAnchored = h.bodyA === null || h.bodyA === undefined;
      var ax = Number(h.localAnchorA && h.localAnchorA.x) || 0;
      var ay = Number(h.localAnchorA && h.localAnchorA.y) || 0;
      link.localAnchorA = worldAnchored
        ? { x: round(mapX(ax, frame)), y: round(mapY(ay, frame)) }
        : { x: round(ax), y: round(-ay) };
      link.localAnchorB = {
        x: round(Number(h.localAnchorB && h.localAnchorB.x) || 0),
        y: round(-(Number(h.localAnchorB && h.localAnchorB.y) || 0)),
      };
      return link;
    }
    out.hinges = (json.hinges || []).map(convertLink);
    // Left off entirely when the scene has none, so a scene from before
    // springs existed converts to exactly what it always did.
    if (json.springs) out.springs = json.springs.map(convertLink);

    return out;
  }

  // Engine-space scene JSON (what serializeScene produces) -> the authored
  // JSON that gets exported, auto-saved, or written into a sample file.
  // Measured from the scene's own locked frame: it is being described
  // relative to the frame it was actually built in.
  function toAuthoredJSON(json) {
    return convert(json, json, toAuthoredX, toAuthoredY);
  }

  // The way back. `frame` is deliberately NOT defaulted to the JSON's own
  // frameWidth/frameHeight: a scene arriving in authored space should land
  // centered in whatever frame is receiving it (the editor's live canvas),
  // which is the whole reason for describing it from the center. Callers
  // pass the frame they are loading INTO.
  function toEngineJSON(json, frame) {
    return convert(json, frame, toEngineX, toEngineY);
  }

  global.PhysicsCoords = {
    toAuthoredJSON: toAuthoredJSON,
    toEngineJSON: toEngineJSON,
    toAuthoredX: toAuthoredX,
    toAuthoredY: toAuthoredY,
    flipAngle: flipAngle,
  };
})(window);
