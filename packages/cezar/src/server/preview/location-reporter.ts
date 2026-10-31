/**
 * The Preview's location reporter: tells the cockpit where a framed page is after it moves on its
 * own — `pushState`, `replaceState`, a hash change — which fires no `load` and leaves a
 * cross-origin frame's address unreadable from outside. The Design Mode picker carries it; the
 * desktop shell injects its own copy into every frame (`FRAME_SCRIPT` in
 * `packages/desktop/src-tauri/src/lib.rs`), and the first to run claims `__cezarLocation`.
 *
 * It only REPORTS — `{ source: 'cezar-preview', type: 'location', url, how }` to its parent at one
 * origin — and obeys nothing. `how` is `load`, `push`, `replace` or `pop` (a traversal, or a hash
 * change that added no entry). Plain ES5-flavoured source, for the same reasons as the picker.
 */
export function locationReporterScript(parentOrigin: string): string {
  return LOCATION_REPORTER_SOURCE.replace('__CEZAR_PARENT_ORIGIN__', () => JSON.stringify(parentOrigin).replace(/</g, '\\u003c'));
}

const LOCATION_REPORTER_SOURCE = String.raw`(function (parentOrigin) {
  'use strict';
  if (window.parent === window || window.__cezarLocation) return;
  window.__cezarLocation = true;
  var last = null;
  var length = history.length;
  function report(how) {
    var url = location.href;
    if (url === last) return;
    last = url;
    length = history.length;
    try { window.parent.postMessage({ source: 'cezar-preview', type: 'location', url: url, how: how }, parentOrigin); } catch (e) { /* parent gone */ }
  }
  function wrap(name, how) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () {
      var result = original.apply(this, arguments);
      report(how);
      return result;
    };
  }
  wrap('pushState', 'push');
  wrap('replaceState', 'replace');
  function moved() { report(history.length > length ? 'push' : 'pop'); }
  window.addEventListener('popstate', moved);
  window.addEventListener('hashchange', moved);
  report('load');
})(__CEZAR_PARENT_ORIGIN__);
`;
