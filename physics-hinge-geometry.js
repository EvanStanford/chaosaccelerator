// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Keeping a hinge point fixed under a resize/rotate/move edit - pure scene
// math, no DOM. Originally lived inside physics-ui.js (the interactive
// editor), extracted so it can be reused anywhere a scene needs editing
// without dragging in a whole page's worth of UI: the fractal grid's
// hover-preview needs the exact same math to compute an offset scene's
// initial state in plain JS (see physics-grid-codegen.js's
// computeOffsetSceneNumeric), and the regression suite can now test this
// directly instead of through a hidden iframe of #editor-view.
//
// A world hinge's localAnchorA IS the fixed background pin (bodyA is null,
// so it's never expressed relative to anything that could move) - the
// point that must not move is always just that constant. localAnchorB is
// the pinned point *on the body*, in the body's own local frame.
//
// Resizing (radius/length) rescales every hinge anchor ON the resized body
// proportionally first - so an anchor sitting exactly at an endpoint stays
// exactly at the (new) endpoint - then recenters the body so its world
// hinge still lands on that fixed pin. Rotating just recenters (anchors
// are already rotation-invariant in local coordinates).
//
// Any body hinged TO the edited one has its own attachment point on that
// body checked before/after, and is translated by whatever that point
// moved - which is exactly how a hinge "drags along" what's attached to
// it. Because that's a pure translation, it composes trivially for further
// descendants (every point on a body moves identically under a
// translation), so the same offset just cascades outward.
(function (global) {
  "use strict";

  function findWorldHinge(scene, bodyIndex) {
    for (var i = 0; i < scene.hinges.length; i++) {
      if (scene.hinges[i].bodyA === null && scene.hinges[i].bodyB === bodyIndex) return scene.hinges[i];
    }
    return null;
  }

  // The hinge that pins bodyIndex to *something else* - the world, or
  // another body - i.e. the incoming hinge where bodyIndex is the "B" side.
  // A body is only ever expected to have one such hinge (same assumption
  // findWorldHinge already made; a hinge graph is a forest, not a DAG with
  // multiple parents per node).
  function findOwnHinge(scene, bodyIndex) {
    for (var i = 0; i < scene.hinges.length; i++) {
      if (scene.hinges[i].bodyB === bodyIndex) return scene.hinges[i];
    }
    return null;
  }

  // The current world position of a hinge's "A" side - a constant when
  // bodyA is null (the world pin never moves on its own), or derived from
  // the parent body's current position/angle otherwise.
  function hingeWorldPointA(scene, hinge) {
    if (hinge.bodyA === null) return hinge.localAnchorA;
    var parent = scene.bodies[hinge.bodyA];
    var r = global.PhysicsEngine.rotateVec(hinge.localAnchorA, parent.angle);
    return { x: parent.x + r.x, y: parent.y + r.y };
  }

  function shapeSize(body) {
    if (body.type === "circle") return body.radius;
    if (body.type === "funnel") return body.size;
    return body.length;
  }

  // Circles and funnels scale uniformly (no preferred axis - a funnel's
  // whole trapezoid grows from its one `size` parameter); a line only
  // scales along its own local X axis - there's no adjustable "thickness"
  // to scale.
  function scaleAnchorForResize(body, anchor, ratio) {
    return body.type === "line"
      ? { x: anchor.x * ratio, y: anchor.y }
      : { x: anchor.x * ratio, y: anchor.y * ratio };
  }

  function rescaleAllAnchorsOnBody(scene, bodyIndex, ratio) {
    var body = scene.bodies[bodyIndex];
    scene.hinges.forEach(function (h) {
      if (h.bodyA === bodyIndex) h.localAnchorA = scaleAnchorForResize(body, h.localAnchorA, ratio);
      if (h.bodyB === bodyIndex) h.localAnchorB = scaleAnchorForResize(body, h.localAnchorB, ratio);
    });
  }

  function translateBodyAndDescendants(scene, bodyIndex, dx, dy, visited) {
    if (visited[bodyIndex]) return; // guard against a hinge cycle
    visited[bodyIndex] = true;
    var body = scene.bodies[bodyIndex];
    body.x += dx;
    body.y += dy;
    scene.hinges.forEach(function (h) {
      if (h.bodyA === bodyIndex) translateBodyAndDescendants(scene, h.bodyB, dx, dy, visited);
    });
  }

  // A direct move (drag, or a Center X/Y edit) translates the body itself,
  // which translateBodyAndDescendants already cascades correctly to
  // anything hinged to it. The one thing that cascade can't reach is a
  // world hinge ON the moved body itself: its localAnchorA is a fixed
  // background point, not derived from any body's position, so nothing
  // updates it automatically. Left alone, the pin stays where it was and
  // Play immediately snaps the body back onto it - translate the pin by
  // the same delta so the move actually sticks.
  function translateBodyPreservingHinges(scene, bodyIndex, dx, dy) {
    if (dx === 0 && dy === 0) return;
    var worldHinge = findWorldHinge(scene, bodyIndex);
    if (worldHinge) {
      worldHinge.localAnchorA = { x: worldHinge.localAnchorA.x + dx, y: worldHinge.localAnchorA.y + dy };
    }
    translateBodyAndDescendants(scene, bodyIndex, dx, dy, {});
  }

  // Runs `mutate` (which changes body.radius/length/angle) on scene.bodies[bodyIndex].
  // If that body is hinged to the background OR to another body, keeps the
  // pin fixed and drags along anything hinged to it; otherwise this is just
  // `mutate()`. The parent case matters even though `mutate` never touches
  // the parent itself: the parent's attachment point is exactly where this
  // body must still land after the edit, whether that point is a constant
  // (world) or derived from the parent's own position/angle.
  function applyBodyEditPreservingHinge(scene, bodyIndex, isResize, mutate) {
    var ownHinge = findOwnHinge(scene, bodyIndex);
    if (!ownHinge) { mutate(); return; }

    var body = scene.bodies[bodyIndex];
    var oldAngle = body.angle;
    var oldX = body.x, oldY = body.y;
    var oldSize = isResize ? shapeSize(body) : null;

    // Snapshot every child attachment point (in this body's OLD local
    // frame) before anything changes, so we can tell exactly how far each
    // one moves once the edit and any rescale are applied.
    var children = scene.hinges
      .filter(function (h) { return h.bodyA === bodyIndex; })
      .map(function (h) { return { hinge: h, oldLocal: { x: h.localAnchorA.x, y: h.localAnchorA.y } }; });

    // The parent's attachment point never moves as a result of `mutate()`
    // (which only ever changes scene.bodies[bodyIndex]), so it's safe to
    // read before or after - computed here, before, to mirror the order
    // children's old attachment points are captured in.
    var pivot = hingeWorldPointA(scene, ownHinge);

    mutate();

    if (isResize) {
      var ratio = oldSize > 1e-9 ? shapeSize(body) / oldSize : 1;
      if (isFinite(ratio) && ratio !== 1) rescaleAllAnchorsOnBody(scene, bodyIndex, ratio);
    }

    var rB = global.PhysicsEngine.rotateVec(ownHinge.localAnchorB, body.angle);
    body.x = pivot.x - rB.x;
    body.y = pivot.y - rB.y;

    var visited = {};
    visited[bodyIndex] = true;
    children.forEach(function (entry) {
      var oldR = global.PhysicsEngine.rotateVec(entry.oldLocal, oldAngle);
      var oldWorld = { x: oldX + oldR.x, y: oldY + oldR.y };
      var newR = global.PhysicsEngine.rotateVec(entry.hinge.localAnchorA, body.angle); // already rescaled above, if applicable
      var newWorld = { x: body.x + newR.x, y: body.y + newR.y };
      translateBodyAndDescendants(scene, entry.hinge.bodyB, newWorld.x - oldWorld.x, newWorld.y - oldWorld.y, visited);
    });
  }

  // ---- Keeping a body's STARTING position inside a locked frame ----
  //
  // A per-step wrap (see PhysicsEngine.step) only ever needs to correct a
  // small overshoot - a body can't move more than MAX_SPEED*dt in one step,
  // always far less than a reasonable frame size - so a single subtract-or-
  // add-one-frame-width is enough there. A STARTING position has no such
  // bound: the physics editor lets you type or paste an arbitrary
  // coordinate, and the fractal grid can offset a linked property by a
  // worldX/worldY that's thousands of units out once you've zoomed out far
  // enough - either can land many frame-widths away in one go, so this
  // needs a real wrap-to-range, not a single correction.
  function wrapIntoRange(v, span) {
    return ((v % span) + span) % span; // JS's % can return negative; this can't
  }

  // The axis-aligned half-extent of a body's own shape, used only to decide
  // whether an ANCHORED body's edit is worth doing at all (see
  // frameWrapDelta) - a circle is the same in both axes; a rotated line's
  // bounding box depends on its angle.
  function frameHalfExtent(body) {
    if (body.type === "circle") return { x: body.radius, y: body.radius };
    if (body.type === "funnel") {
      var verts = global.PhysicsEngine.getFunnelVertices(body);
      var maxX = 0, maxY = 0;
      for (var k in verts) {
        maxX = Math.max(maxX, Math.abs(verts[k].x - body.x));
        maxY = Math.max(maxY, Math.abs(verts[k].y - body.y));
      }
      return { x: maxX, y: maxY };
    }
    var half = body.length / 2;
    return { x: Math.abs(Math.cos(body.angle)) * half, y: Math.abs(Math.sin(body.angle)) * half };
  }

  // How far this body's center needs to move to land back in
  // [0, frameWidth) x [0, frameHeight) under the project's two wrap rules:
  // a moving (non-static) body wraps as soon as its CENTER crosses an edge
  // (matching the per-step rule exactly, just generalized to any distance
  // past it); a body anchored in place only wraps if its own shape would be
  // ENTIRELY past one edge - nudging an anchored body that's merely
  // sticking out past an edge would move something the user deliberately
  // placed there. {dx:0, dy:0} means "leave it alone."
  function frameWrapDelta(body, frameWidth, frameHeight) {
    if (!body.isAnchored) {
      return { dx: wrapIntoRange(body.x, frameWidth) - body.x, dy: wrapIntoRange(body.y, frameHeight) - body.y };
    }
    var half = frameHalfExtent(body);
    var dx = 0, dy = 0;
    if (body.x - half.x > frameWidth || body.x + half.x < 0) dx = wrapIntoRange(body.x, frameWidth) - body.x;
    if (body.y - half.y > frameHeight || body.y + half.y < 0) dy = wrapIntoRange(body.y, frameHeight) - body.y;
    return { dx: dx, dy: dy };
  }

  // True for a body hinged TO another body (not the world) - its position
  // is a rigid consequence of that parent (free to rotate about the joint,
  // but not to independently translate), so it must never be wrapped on
  // its own: normalizeAllBodiesIntoFrame below only ever wraps a body
  // itself, then lets translateBodyPreservingHinges's own cascade carry
  // that correction to every descendant, exactly like a manual drag would.
  // Wrapping a hinge child directly - plausible-looking, since a rigid
  // "arm" can genuinely put a child way outside the frame - would move it
  // without moving what it's pinned to, tearing the joint immediately.
  function isHingeChild(scene, bodyIndex) {
    for (var i = 0; i < scene.hinges.length; i++) {
      if (scene.hinges[i].bodyB === bodyIndex && scene.hinges[i].bodyA !== null) return true;
    }
    return false;
  }

  function normalizeBodyIntoFrame(scene, bodyIndex) {
    var delta = frameWrapDelta(scene.bodies[bodyIndex], scene.frameWidth, scene.frameHeight);
    if (delta.dx !== 0 || delta.dy !== 0) translateBodyPreservingHinges(scene, bodyIndex, delta.dx, delta.dy);
  }

  // Only ever wraps root bodies (unhinged, or hinged straight to the world)
  // - never a hinge child (see isHingeChild) - so every hinge chain is
  // fully correct after exactly one pass: roots don't depend on each other,
  // and each root's own correction already cascades to its entire subtree
  // in one call.
  function normalizeAllBodiesIntoFrame(scene) {
    if (!scene.frameWidth || !scene.frameHeight) return;
    for (var i = 0; i < scene.bodies.length; i++) {
      if (isHingeChild(scene, i)) continue;
      normalizeBodyIntoFrame(scene, i);
    }
  }

  // Bodies whose crossing a frame edge can trigger Sticky Edges' early
  // stop - the exact same set PhysicsEngine.step's own end-of-step wrap
  // cascade calls "roots": non-static (a static body never moves, so it
  // can never wrap) and not a hinge child (its position is a rigid
  // consequence of its parent, not independently choosable, so it never
  // independently wraps - only ever corrected as a cascade side effect of
  // its own root's wrap; watching it separately here would just be
  // re-detecting the same crossing its root already reports).
  function wrapWatchedBodyIndices(scene) {
    var result = [];
    for (var i = 0; i < scene.bodies.length; i++) {
      if (scene.bodies[i].isAnchored) continue;
      if (isHingeChild(scene, i)) continue;
      result.push(i);
    }
    return result;
  }

  // ---- "Stop on wrap": finding the last good step before a body wraps ----
  //
  // Given a logged trajectory (an array of per-step {x, y, angle} rows for
  // each body - physics-ui.js's playback array, or a GLSL hover-replay's),
  // finds the first step at which ANY of watchedBodyIndices' positions shows
  // the signature of a frame wrap ("any object reaches the frame edge," not
  // just one specific Output body - a scene can stop early because of a
  // body that was never the one being colored by), so playback can stop
  // there instead of continuing through the teleport. A wrap wouldn't be
  // exactly ±frameWidth/height as observed here - PhysicsEngine.step's wrap
  // corrects that step's POST-motion position, so the delta between two
  // consecutive LOGGED (post-step) frames is frameWidth/height minus that
  // step's own small normal motion - but per-step motion is always tiny
  // (bounded by the engine's speed cap) next to any usable frame size, so
  // any observed delta anywhere near half the frame size can only be a
  // wrap. Only ever checked against watchedBodyIndices (see
  // wrapWatchedBodyIndices) - a hinge child's own position moves in lockstep
  // with its root's wrap already, so it would just be re-detecting the same
  // crossing a step later or earlier depending on cascade order, not a
  // genuinely separate event.
  //
  // Returns null (nothing in watchedBodyIndices ever wraps within this
  // run), or { step, tFrac, tTarget, bodyIndex, x, y, angle }: step is the
  // 1-indexed stepCount to stop playback at (an effectiveMaxSteps), tFrac
  // (in [0, dt]) is how far into that step the crossing actually happened -
  // the "Scene lifespan" output type's own value is step - 1 + tFrac/dt,
  // a genuinely continuous step count rather than a jumping integer - and
  // tTarget = tFrac - dt. x/y/angle are bodyIndex's own position/angle, NOT
  // simply trajectory[step-1] - they're extrapolated to one whole
  // step-duration *before* the exact continuous instant the crossing
  // happens, using that body's own velocity (reconstructed by finite
  // difference). bodyIndex is targetBodyIndex when it's given (not null);
  // when it's null (Scene Lifespan has no target body of its own to
  // extrapolate for), it's whichever watched body actually triggered this
  // crossing instead - a caller still needs SOME body's continuous,
  // pre-wrap position to draw on the frozen final frame, and always falling
  // back to nobody's (leaving every body's raw discretely-wrapped
  // trajectory row on screen instead) is exactly what produced a real bug:
  // a body that crosses on its very first logged step had no earlier
  // pre-wrap sample to show at all, so the raw row was already
  // post-teleport - visibly "jumping to the opposite edge and freezing
  // there" the instant Scene Lifespan was selected, even though the exact
  // same scene rendered correctly with the body's own x/y as Output.
  //
  // Why not just trajectory[step-1] (this function's old behavior): that
  // value is only ever a discrete LOGGED sample, and WHICH sample counts as
  // "the one before the wrap" is an integer that jumps by 1 exactly when
  // starting conditions sweep past a step boundary - producing a real,
  // large, spurious discontinuity (confirmed empirically: a lone free-
  // falling circle, no collisions at all, shows a clean ~16px jump every
  // ~16px of starting-position sweep, matching one step's fall distance at
  // speed) even though nothing about the underlying motion is actually
  // discontinuous in this simple case. Solving for the exact sub-step
  // crossing time and interpolating from there removes that artifact,
  // mirroring the fix already applied to collision detection (see
  // PhysicsGPU's collideCircleCircle) - same idea, applied to the frame-
  // wrap boundary instead of a circle's radius.
  //
  // Evaluating "at the exact crossing instant" would trivially always equal
  // the boundary itself for whichever property is doing the wrapping (by
  // definition - that instant IS when it equals the boundary), collapsing
  // to a constant for exactly the common case of Output being the wrapping
  // property. "One step before that instant" keeps the current feature's
  // actual intent (a snapshot of where things were, right before they
  // would've wrapped) while still being a continuous function of the
  // starting conditions - the reference TIME is now a smooth real number,
  // not a jumping integer step index.
  function findWrapStopStep(traj, watchedBodyIndices, targetBodyIndex, frameWidth, frameHeight, initialBodies, dt) {
    if (!frameWidth || !frameHeight) return null;
    // prev[idx] is the frame immediately before the crossing (what this
    // function used to return outright, for the single watched body it
    // used to take); prevPrev[idx] is one frame further back still - its
    // own velocity (prev-prevPrev)/dt is what "one step before the
    // crossing" needs to extrapolate from, for whichever body turns out to
    // be targetBodyIndex. Starts from the AUTHORED pre-simulation state,
    // not traj[0] itself - a wrap on the very first physics step would
    // otherwise be invisible, since traj only ever logs post-step states.
    // targetBodyIndex is tracked the same way even when it isn't itself
    // being watched (e.g. Output is body 2 but body 0 is the one that
    // crosses first) - every tracked body advances in lockstep below.
    var tracked = watchedBodyIndices.slice();
    if (targetBodyIndex !== null && tracked.indexOf(targetBodyIndex) === -1) tracked.push(targetBodyIndex);
    var prev = {}, prevPrev = {};
    tracked.forEach(function (idx) {
      var b = initialBodies[idx];
      prev[idx] = { x: b.x, y: b.y, angle: b.angle };
    });
    for (var i = 0; i < traj.length; i++) {
      var best = null;
      for (var k = 0; k < watchedBodyIndices.length; k++) {
        var idx = watchedBodyIndices[k];
        var cur = traj[i][idx];
        var p1 = prev[idx];
        var dx = cur.x - p1.x, dy = cur.y - p1.y;
        if (Math.abs(dx) <= frameWidth / 2 && Math.abs(dy) <= frameHeight / 2) continue;
        // Which axis actually crossed, and its position this step WITHOUT
        // the wrap correction PhysicsEngine.step already applied - undoing
        // that (always exactly ±span, see wrapCoord) is what makes a real,
        // physical velocity recoverable by finite difference between two
        // logged (pre-wrap) positions.
        var axis = Math.abs(dx) > frameWidth / 2 ? "x" : "y";
        var span = axis === "x" ? frameWidth : frameHeight;
        var rawDelta = axis === "x" ? dx : dy;
        var prewrap = rawDelta < 0 ? cur[axis] + span : cur[axis] - span;
        var vAxis = (prewrap - p1[axis]) / dt;
        var boundary = prewrap > span ? span : 0;
        var tFrac = (boundary - p1[axis]) / vAxis;
        tFrac = Math.max(0, Math.min(dt, tFrac)); // guard float roundoff
        // Earliest continuous crossing wins when more than one body's
        // discrete step both register a crossing on the same logged step.
        if (best === null || tFrac < best.tFrac) best = { tFrac: tFrac, crossingBodyIndex: idx };
      }
      if (best !== null) {
        var tTarget = best.tFrac - dt; // in [-dt, 0): one whole step before the crossing
        // No target body (Scene Lifespan) still needs SOME body's
        // continuous position for a caller to draw - the one that actually
        // crossed is the only sensible choice (see this function's own
        // comment above on why leaving this unset was a real bug).
        var effectiveTargetIndex = targetBodyIndex !== null ? targetBodyIndex : best.crossingBodyIndex;
        var result = { step: i, tFrac: best.tFrac, tTarget: tTarget, bodyIndex: effectiveTargetIndex };
        var tp1 = prev[effectiveTargetIndex], tp0 = prevPrev[effectiveTargetIndex];
        if (tp0 === undefined) {
          // Crossed on the very first step - nothing precedes tp1 to take
          // a "one step earlier" velocity from, so fall back to tp1
          // itself (matches the old behavior, only in this rare edge
          // case).
          result.x = tp1.x; result.y = tp1.y; result.angle = tp1.angle;
        } else {
          var vx = (tp1.x - tp0.x) / dt, vy = (tp1.y - tp0.y) / dt, va = (tp1.angle - tp0.angle) / dt;
          result.x = tp1.x + vx * tTarget;
          result.y = tp1.y + vy * tTarget;
          result.angle = tp1.angle + va * tTarget;
        }
        return result;
      }
      for (var k2 = 0; k2 < tracked.length; k2++) {
        var idx2 = tracked[k2];
        prevPrev[idx2] = prev[idx2];
        prev[idx2] = traj[i][idx2];
      }
    }
    return null; // never wraps within this run
  }

  // ---- Off-screen pointer geometry ----
  //
  // Where to put an arrow pointing at a body that has left the frame, and how
  // long to draw it. Lives here, in the module both pages already share for
  // frame geometry, so the editor's playback and the fractal grid's replay
  // panel point at things the same way instead of each inventing a rule.
  //
  // The tip sits where the straight line from the frame's centre to the body
  // crosses the frame's edge, so the arrow is always on the edge nearest the
  // direction you'd look. Its LENGTH grows with how far past that crossing
  // the body actually is, and - the property that makes it feel right -
  // reaches exactly zero as the body arrives at the edge, so the arrow
  // shrinks away rather than popping out of existence when the body comes
  // back on screen.
  //
  // That growth saturates rather than being proportional: under Infinite
  // Space a body can be tens of thousands of pixels out, and a proportional
  // arrow would be longer than the canvas almost immediately. At a distance
  // of one reference length the arrow is half its maximum, and it approaches
  // the maximum from there without ever exceeding it.
  //
  // Returns null when the body is inside the frame - nothing to point at.
  function offscreenPointer(x, y, frameWidth, frameHeight, maxLength) {
    if (!frameWidth || !frameHeight) return null;
    if (x >= 0 && x <= frameWidth && y >= 0 && y <= frameHeight) return null;

    var cx = frameWidth / 2, cy = frameHeight / 2;
    var dx = x - cx, dy = y - cy;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return null; // dead centre can't be outside, but don't divide by it

    // The centre is the middle of the rectangle, so the crossing is simply
    // whichever axis runs out of half-extent first along this direction.
    var t = Infinity;
    if (dx !== 0) t = Math.min(t, (frameWidth / 2) / Math.abs(dx));
    if (dy !== 0) t = Math.min(t, (frameHeight / 2) / Math.abs(dy));

    var ux = dx / len, uy = dy / len;
    var edgeX = cx + dx * t, edgeY = cy + dy * t;
    var beyond = Math.hypot(x - edgeX, y - edgeY);
    // Half the max at one reference length out; zero when the body is at the
    // edge, which is what makes it fade out smoothly on re-entry.
    var reference = Math.min(frameWidth, frameHeight) / 2;
    var length = maxLength * (beyond / (beyond + reference));
    return { tipX: edgeX, tipY: edgeY, dirX: ux, dirY: uy, length: length, distance: beyond };
  }

  global.PhysicsHingeGeometry = {
    offscreenPointer: offscreenPointer,
    // findWorldHinge, translateBodyAndDescendants, and normalizeBodyIntoFrame
    // are used internally (by findOwnHinge, translateBodyPreservingHinges/
    // applyBodyEditPreservingHinge, and normalizeAllBodiesIntoFrame
    // respectively) but never called from outside this file, so they're not
    // exported.
    findOwnHinge: findOwnHinge,
    hingeWorldPointA: hingeWorldPointA,
    translateBodyPreservingHinges: translateBodyPreservingHinges,
    applyBodyEditPreservingHinge: applyBodyEditPreservingHinge,
    frameHalfExtent: frameHalfExtent,
    wrapIntoRange: wrapIntoRange,
    frameWrapDelta: frameWrapDelta,
    isHingeChild: isHingeChild,
    normalizeAllBodiesIntoFrame: normalizeAllBodiesIntoFrame,
    wrapWatchedBodyIndices: wrapWatchedBodyIndices,
    findWrapStopStep: findWrapStopStep,
  };
})(window);
