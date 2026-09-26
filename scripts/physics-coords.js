// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Engine space (top-left origin, +y down) vs authored space (scene JSON, editor readouts: frame-center
// origin, +y up). Frame fw x fh: engine.x = authored.x + fw/2, engine.y = fh/2 - authored.y (self-inverse).
// The y reflection also negates angle, w and vy; local anchors only flip y, world pins take the full map.
(function (global) {
  "use strict";

  function round(n) {
    return Math.round(n * 10000) / 10000;
  }

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
  function flipAngle(a) { return -a; }

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
    if (json.springs) out.springs = json.springs.map(convertLink);

    return out;
  }

  function toAuthoredJSON(json) {
    return convert(json, json, toAuthoredX, toAuthoredY);
  }

  // `frame` is the frame being loaded INTO, not the JSON's own: an authored scene lands centered in it.
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
