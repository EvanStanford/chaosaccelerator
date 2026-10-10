// CPAL-1.0 License. See chaosaccelerator.com/license.html

// A movie render's progress in IndexedDB, so a closed player can carry on: one job (the movie's address, its
// frame count, frames done, time spent) and every finished frame's JPEG. A running render holds a lock. The
// Inspect tab's last snapshot for a movie of it is kept too, in a database of its own.
(function (global) {
  "use strict";

  var DB = "chaosaccelerator-movie-render", JOBS = "job", FRAMES = "frames", JOB = "current";
  var INSPECT_DB = "chaosaccelerator-inspect-movie", INSPECT = "inspect";
  var LOCK = "chaosaccelerator-movie-render";
  var opening = {};

  function open(name, stores) {
    if (!opening[name]) {
      opening[name] = new Promise(function (resolve, reject) {
        var request = global.indexedDB.open(name, 1);
        request.onupgradeneeded = function () {
          stores.forEach(function (store) { request.result.createObjectStore(store); });
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    }
    return opening[name];
  }

  // work(store, ...) issues the requests and may return a function reading their results once committed.
  function transact(name, stores, mode, work) {
    return open(name, stores).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(stores, mode);
        var read = work.apply(null, stores.map(function (store) { return tx.objectStore(store); }));
        tx.oncomplete = function () { resolve(read ? read() : undefined); };
        tx.onerror = tx.onabort = function () { reject(tx.error); };
      });
    });
  }
  function jobTransact(mode, work) { return transact(DB, [JOBS, FRAMES], mode, work); }
  function inspectTransact(mode, work) { return transact(INSPECT_DB, [INSPECT], mode, work); }

  global.MovieStore = {
    // { link, total, done, ms }, or null.
    load: function () {
      return jobTransact("readonly", function (jobs) {
        var request = jobs.get(JOB);
        return function () { return request.result || null; };
      });
    },
    begin: function (job) {
      return jobTransact("readwrite", function (jobs, frames) {
        frames.clear();
        jobs.put(job, JOB);
      });
    },
    // blob null: the same picture as the frame before.
    saveFrame: function (i, key, blob, job) {
      return jobTransact("readwrite", function (jobs, frames) {
        frames.put({ i: i, key: key, blob: blob }, i);
        jobs.put(job, JOB);
      });
    },
    // Frames 0 to count - 1, in order: [{ i, key, blob }].
    frames: function (count) {
      if (count < 1) return Promise.resolve([]);
      return jobTransact("readonly", function (jobs, frames) {
        var request = frames.getAll(global.IDBKeyRange.bound(0, count - 1));
        return function () { return request.result; };
      });
    },
    discard: function () {
      return jobTransact("readwrite", function (jobs, frames) {
        jobs.clear();
        frames.clear();
      });
    },
    // Held until release() is called or the page goes; true from running() meanwhile, in any tab.
    hold: function () {
      if (!global.navigator.locks) return function () {};
      var release = null, released = false;
      global.navigator.locks.request(LOCK, function () {
        return new Promise(function (resolve) {
          release = resolve;
          if (released) resolve();
        });
      });
      return function () {
        released = true;
        if (release) release();
      };
    },
    running: function () {
      if (!global.navigator.locks) return Promise.resolve(false);
      return global.navigator.locks.query().then(function (state) {
        return state.held.some(function (lock) { return lock.name === LOCK; });
      });
    },
    // { link, ... } or null.
    saveInspect: function (snapshot) {
      return inspectTransact("readwrite", function (store) { store.put(snapshot, JOB); });
    },
    loadInspect: function () {
      return inspectTransact("readonly", function (store) {
        var request = store.get(JOB);
        return function () { return request.result || null; };
      });
    },
  };
})(window);
