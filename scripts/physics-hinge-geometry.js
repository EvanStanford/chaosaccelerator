// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Pure scene math (no DOM): hinge-preserving edits, wrapping starting positions into the frame, wrap
// detection in a logged trajectory, the off-screen pointer. Shared by editor, grid preview and tests.
(function (global) {
  "use strict";

  function findWorldHinge(scene, bodyIndex) {
    for (var i = 0; i < scene.hinges.length; i++) {
      if (scene.hinges[i].bodyA === null && scene.hinges[i].bodyB === bodyIndex) return scene.hinges[i];
    }
    return null;
  }

  // The incoming hinge pinning bodyIndex to the world or a parent body; at most one per body.
  function findOwnHinge(scene, bodyIndex) {
    for (var i = 0; i < scene.hinges.length; i++) {
      if (scene.hinges[i].bodyB === bodyIndex) return scene.hinges[i];
    }
    return null;
  }

  // World position of a hinge's A side: localAnchorA itself is the fixed pin when bodyA is null.
  function hingeWorldPointA(scene, hinge) {
    if (hinge.bodyA === null) return hinge.localAnchorA;
    var parent = scene.bodies[hinge.bodyA];
    var r = global.PhysicsEngine.rotateVec(hinge.localAnchorA, parent.angle);
    return { x: parent.x + r.x, y: parent.y + r.y };
  }

  function shapeSize(body) {
    if (body.type === "circle") return body.radius;
    if (body.type === "funnel" || body.type === "splitter") return body.size;
    return body.length;
  }

  // Circles and funnels scale uniformly; a line only along its local X (it has no thickness).
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

  // Spring anchors keep their place on a resized body by the same rule; no recenter or cascade needed.
  function rescaleSpringAnchorsOnBody(scene, bodyIndex, ratio) {
    var body = scene.bodies[bodyIndex];
    global.PhysicsEngine.sceneSprings(scene).forEach(function (s) {
      if (s.bodyA === bodyIndex) s.localAnchorA = scaleAnchorForResize(body, s.localAnchorA, ratio);
      if (s.bodyB === bodyIndex) s.localAnchorB = scaleAnchorForResize(body, s.localAnchorB, ratio);
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

  // A world hinge's pin is not derived from any body: shift it too, or Play snaps the body back.
  function translateBodyPreservingHinges(scene, bodyIndex, dx, dy) {
    if (dx === 0 && dy === 0) return;
    var worldHinge = findWorldHinge(scene, bodyIndex);
    if (worldHinge) {
      worldHinge.localAnchorA = { x: worldHinge.localAnchorA.x + dx, y: worldHinge.localAnchorA.y + dy };
    }
    translateBodyAndDescendants(scene, bodyIndex, dx, dy, {});
  }

  // Runs `mutate` on bodyIndex; if hinged (world or parent), keeps that pin fixed and drags descendants along.
  function applyBodyEditPreservingHinge(scene, bodyIndex, isResize, mutate) {
    var ownHinge = findOwnHinge(scene, bodyIndex);
    var body = scene.bodies[bodyIndex];
    var oldSize = isResize ? shapeSize(body) : null;
    function rescaleSprings() {
      if (!isResize) return;
      var springRatio = oldSize > 1e-9 ? shapeSize(body) / oldSize : 1;
      if (isFinite(springRatio) && springRatio !== 1) rescaleSpringAnchorsOnBody(scene, bodyIndex, springRatio);
    }
    if (!ownHinge) { mutate(); rescaleSprings(); return; }

    var oldAngle = body.angle;
    var oldX = body.x, oldY = body.y;

    var children = scene.hinges
      .filter(function (h) { return h.bodyA === bodyIndex; })
      .map(function (h) { return { hinge: h, oldLocal: { x: h.localAnchorA.x, y: h.localAnchorA.y } }; });

    var pivot = hingeWorldPointA(scene, ownHinge);

    mutate();
    rescaleSprings();

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

  // ---- Wrapping a STARTING position into the frame: may be many frame widths out, so a true wrap-to-range ----
  function wrapIntoRange(v, span) {
    return ((v % span) + span) % span; // JS's % can return negative; this can't
  }

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

  // Center delta to land in [0, frameWidth) x [0, frameHeight). A moving body wraps once its
  // CENTER crosses an edge; an anchored body only once its whole shape is past one. {0,0} = leave.
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

  // Hinged TO another body: never wrapped on its own (its root's cascade carries it) or the joint tears.
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

  // Wraps only root bodies; each root's cascade fixes its subtree in one pass. bySpringGroup settles
  // sprung bodies as the engine wraps them (tethered: not at all; else as one, by its leader).
  function normalizeAllBodiesIntoFrame(scene, bySpringGroup) {
    if (!scene.frameWidth || !scene.frameHeight) return;
    var groups = bySpringGroup ? global.PhysicsEngine.springGroups(scene) : null;
    for (var i = 0; i < scene.bodies.length; i++) {
      if (isHingeChild(scene, i)) continue;
      var group = groups ? groups.groupOf[i] : null;
      if (!group) { normalizeBodyIntoFrame(scene, i); continue; }
      if (group.tethered || group.leader !== i) continue;
      var delta = frameWrapDelta(scene.bodies[i], scene.frameWidth, scene.frameHeight);
      if (delta.dx !== 0 || delta.dy !== 0) global.PhysicsEngine.translateSpringGroup(scene, group, delta.dx, delta.dy);
    }
  }

  // Bodies whose edge crossing can trigger Sticky Edges' early stop: the roots PhysicsEngine.step
  // wraps. Hinge children and spring followers only follow a wrap, so watching them double-counts.
  function wrapWatchedBodyIndices(scene) {
    var result = [];
    var groups = global.PhysicsEngine.springGroups(scene);
    for (var i = 0; i < scene.bodies.length; i++) {
      if (scene.bodies[i].isAnchored) continue;
      if (isHingeChild(scene, i)) continue;
      var group = groups ? groups.groupOf[i] : null;
      if (group && (group.tethered || group.leader !== i)) continue;
      result.push(i);
    }
    return result;
  }

  // ---- "Stop on wrap": last good step before a watched body wraps ----
  // Scans a logged trajectory (per-step {x, y, angle} rows per body) for the first step where a
  // watched body jumps by over half the frame (per-step motion is tiny, so that is always a wrap).
  // Returns null, or { step, tFrac, tTarget, bodyIndex, x, y, angle }: step is the 1-indexed
  // stepCount to stop at, tFrac in [0, dt] is when within it the crossing happened, tTarget =
  // tFrac - dt, and x/y/angle are bodyIndex's state ONE STEP BEFORE the continuous crossing instant
  // (extrapolated by finite difference: a discrete logged sample would jump as the start sweeps
  // past a step boundary). bodyIndex is targetBodyIndex, or the crossing body when that is null.
  function findWrapStopStep(traj, watchedBodyIndices, targetBodyIndex, frameWidth, frameHeight, initialBodies, dt) {
    if (!frameWidth || !frameHeight) return null;
    // Start from the AUTHORED state, not traj[0], or a wrap on the very first step is invisible.
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
        // Undo the step's wrap correction (exactly +-span) so finite difference gives a real velocity.
        var axis = Math.abs(dx) > frameWidth / 2 ? "x" : "y";
        var span = axis === "x" ? frameWidth : frameHeight;
        var rawDelta = axis === "x" ? dx : dy;
        var prewrap = rawDelta < 0 ? cur[axis] + span : cur[axis] - span;
        var vAxis = (prewrap - p1[axis]) / dt;
        var boundary = prewrap > span ? span : 0;
        var tFrac = (boundary - p1[axis]) / vAxis;
        tFrac = Math.max(0, Math.min(dt, tFrac)); // guard float roundoff
        if (best === null || tFrac < best.tFrac) best = { tFrac: tFrac, crossingBodyIndex: idx };
      }
      if (best !== null) {
        var tTarget = best.tFrac - dt; // in [-dt, 0): one whole step before the crossing
        var effectiveTargetIndex = targetBodyIndex !== null ? targetBodyIndex : best.crossingBodyIndex;
        var result = { step: i, tFrac: best.tFrac, tTarget: tTarget, bodyIndex: effectiveTargetIndex };
        var tp1 = prev[effectiveTargetIndex], tp0 = prevPrev[effectiveTargetIndex];
        if (tp0 === undefined) {
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

  // ---- Off-screen pointer: an arrow toward a body outside the frame ----
  // Tip where the line from frame center to the body crosses the edge; length grows with the distance
  // beyond it, zero at the edge (fades on re-entry), saturating toward maxLength. null when inside.
  function offscreenPointer(x, y, frameWidth, frameHeight, maxLength) {
    if (!frameWidth || !frameHeight) return null;
    if (x >= 0 && x <= frameWidth && y >= 0 && y <= frameHeight) return null;

    var cx = frameWidth / 2, cy = frameHeight / 2;
    var dx = x - cx, dy = y - cy;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return null; // dead center can't be outside, but don't divide by it

    var t = Infinity;
    if (dx !== 0) t = Math.min(t, (frameWidth / 2) / Math.abs(dx));
    if (dy !== 0) t = Math.min(t, (frameHeight / 2) / Math.abs(dy));

    var ux = dx / len, uy = dy / len;
    var edgeX = cx + dx * t, edgeY = cy + dy * t;
    var beyond = Math.hypot(x - edgeX, y - edgeY);
    var reference = Math.min(frameWidth, frameHeight) / 2;
    var length = maxLength * (beyond / (beyond + reference));
    return { tipX: edgeX, tipY: edgeY, dirX: ux, dirY: uy, length: length, distance: beyond };
  }

  global.PhysicsHingeGeometry = {
    offscreenPointer: offscreenPointer,
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
