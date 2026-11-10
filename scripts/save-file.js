// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Saving a file: the browser's Save dialog where it has one (Chrome, Edge), opened in Downloads with the usual name;
// elsewhere a plain download. choose() has to run inside the click: the dialog needs it.
(function (global) {
  "use strict";

  function download(name) {
    return {
      save: function (blob) {
        var link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(link.href); }, 60000);
        return Promise.resolve();
      },
    };
  }

  // Resolves to { save(blob) -> Promise }, or null when the dialog was cancelled.
  function choose(name, type, description) {
    if (typeof global.showSaveFilePicker !== "function") return Promise.resolve(download(name));
    var accept = {};
    accept[type] = [name.slice(name.lastIndexOf("."))];
    return global.showSaveFilePicker({ suggestedName: name, startIn: "downloads", types: [{ description: description, accept: accept }] })
      .then(function (handle) {
        return {
          save: function (blob) {
            return handle.createWritable().then(function (file) {
              return file.write(blob).then(function () { return file.close(); });
            });
          },
        };
      }, function (err) {
        return err && err.name === "AbortError" ? null : download(name);
      });
  }

  global.SaveFile = { choose: choose };
})(typeof window !== "undefined" ? window : globalThis);
