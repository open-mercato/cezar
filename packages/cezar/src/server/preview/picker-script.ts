/**
 * The Design Mode picker — the script the design proxy injects into every HTML page it re-serves
 * (spec `.ai/specs/2026-10-09-design-mode.md`).
 *
 * It runs INSIDE the task's app, which is untrusted and is somebody else's page, so it is written
 * to leave no trace when idle: no listeners that swallow events, no styles, no nodes — until the
 * cockpit switches it on. It speaks to exactly one window (its parent) at exactly one origin (the
 * cockpit's, baked in when the proxy was opened) and listens to nothing else, so neither the app
 * nor a page that frames the proxy can drive it or read what it reports.
 *
 * A string rather than a function serialized with `toString()`: the dev runner (tsx/esbuild) may
 * rewrite function bodies with helpers that do not exist in the page. Plain ES5-flavoured source,
 * because it has to run in whatever the framed app's browser target is, unbundled.
 *
 * A picked element stays MARKED — a lime frame with its number — for as long as the cockpit says
 * it is part of the note being written (`set-marks`). The cockpit owns the list and the numbers;
 * this script only owns the element references, which is why a mark does not survive a reload of
 * the page: the node it pointed at is gone, and guessing a replacement would mark the wrong thing.
 *
 * The caps below are what keep one pick small enough to ride a message: every picked element
 * lives in ONE draft entry on the cockpit side, and an agent needs the element, not the page.
 */
export const PICKER_PATH = '/__cezar_design__/picker.js';

export const PICK_HTML_MAX = 1500;
export const PICK_TEXT_MAX = 200;

export interface PickerConfig {
  /** The cockpit's origin — the only window this script posts to or obeys. */
  parentOrigin: string;
  /** The app's real origin, so a reported address names the dev server and not the proxy. */
  upstreamOrigin: string;
}

export function pickerScript(config: PickerConfig): string {
  // `<` cannot end a script here (this is served as a .js file, not inlined), but escaping it
  // costs nothing and keeps the config inert if that ever changes.
  const json = JSON.stringify({ ...config, htmlMax: PICK_HTML_MAX, textMax: PICK_TEXT_MAX }).replace(/</g, '\\u003c');
  return PICKER_SOURCE.replace('__CEZAR_DESIGN_CONFIG__', () => json);
}

const PICKER_SOURCE = String.raw`(function () {
  'use strict';
  if (window.__cezarDesign) return;
  window.__cezarDesign = true;
  // Only as a framed page: opened in a tab of its own there is no cockpit to report to.
  if (window.parent === window) return;

  var cfg = __CEZAR_DESIGN_CONFIG__;
  var active = false;
  var box = null;
  var tag = null;
  var hovered = null;
  // key -> { el, node } for every element picked in THIS document. "node" is the mark's own
  // overlay, present only while the cockpit lists the key in set-marks. (No backticks in here:
  // this whole script is one template literal.)
  var picked = {};
  // Keys are unique per DOCUMENT, not per session: after a reload the cockpit may still hold a
  // pick from the page that was here before, and its key must not match a new one.
  var docId = Math.random().toString(36).slice(2, 8);
  var nextKey = 1;
  var markTimer = null;

  function post(message) {
    message.source = 'cezar-design';
    try { window.parent.postMessage(message, cfg.parentOrigin); } catch (e) { /* parent gone */ }
  }

  function pageUrl() {
    return cfg.upstreamOrigin + location.pathname + location.search + location.hash;
  }

  function cut(text, max) {
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function ownNode(node) {
    return node === box || node === tag || (node && node.getAttribute && node.getAttribute('data-cezar-design') === 'mark');
  }

  // ---- marks -------------------------------------------------------------------------------

  function keyOf(el) {
    for (var key in picked) if (picked[key].el === el) return key;
    return null;
  }

  function placeMark(entry) {
    if (!entry.node) return;
    if (!entry.el.isConnected) { entry.node.style.display = 'none'; return; }
    var rect = entry.el.getBoundingClientRect();
    entry.node.style.display = 'block';
    entry.node.style.left = rect.left + 'px';
    entry.node.style.top = rect.top + 'px';
    entry.node.style.width = rect.width + 'px';
    entry.node.style.height = rect.height + 'px';
  }

  var lastRects = '';

  // Where every marked element is right now, in this document's viewport. The cockpit anchors
  // the note popup to one of them, so it is told whenever they move — and only then.
  function placeMarks() {
    var rects = [];
    for (var key in picked) {
      var entry = picked[key];
      placeMark(entry);
      if (!entry.node || !entry.el.isConnected) continue;
      var rect = entry.el.getBoundingClientRect();
      rects.push({ key: key, x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) });
    }
    var serialized = JSON.stringify(rects);
    if (serialized === lastRects) return;
    lastRects = serialized;
    post({ type: 'rects', rects: rects, viewport: { width: window.innerWidth, height: window.innerHeight } });
  }

  // A picked element's frame: the hover frame, kept and turned lime. Drawn the moment the
  // element is clicked — not when the cockpit confirms — so the click visibly lands.
  function ensureMark(entry) {
    if (entry.node) return;
    entry.node = document.createElement('div');
    entry.node.setAttribute('data-cezar-design', 'mark');
    entry.node.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;box-sizing:border-box;' +
      'border:2px solid #a3e635;background:rgba(163,230,53,.14);border-radius:2px;';
    document.documentElement.appendChild(entry.node);
  }

  function dropMark(key) {
    var entry = picked[key];
    if (!entry) return;
    if (entry.node && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
    delete picked[key];
  }

  // Layout moves under a mark for reasons no event reports (hot reload, a late image, an
  // animation), so while any mark is showing it is re-placed on a slow tick as well.
  function syncMarkTimer() {
    var any = false;
    for (var key in picked) { any = true; break; }
    if (any && !markTimer) markTimer = setInterval(placeMarks, 400);
    if (!any && markTimer) { clearInterval(markTimer); markTimer = null; }
  }

  // The cockpit's word on which picks are still selected. It is the authority: a pick it did not
  // keep, or one it has since sent or removed, loses its frame here.
  function setMarks(marks) {
    var wanted = {};
    for (var i = 0; i < marks.length; i++) {
      if (marks[i] && typeof marks[i].key === 'string') wanted[marks[i].key] = String(marks[i].n);
    }
    for (var key in picked) {
      if (key in wanted) ensureMark(picked[key]);
      else dropMark(key);
    }
    placeMarks();
    syncMarkTimer();
    // The hover frame may be sitting on an element that just stopped (or started) being selected.
    if (hovered) highlight(hovered);
  }

  // ---- describing an element ---------------------------------------------------------------

  function segment(el) {
    var name = el.tagName.toLowerCase();
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return name + '#' + el.id;
    var classes = [];
    for (var i = 0; i < el.classList.length && classes.length < 2; i++) {
      if (/^[A-Za-z_][\w-]*$/.test(el.classList[i])) classes.push(el.classList[i]);
    }
    var out = name + (classes.length ? '.' + classes.join('.') : '');
    var parent = el.parentElement;
    if (parent) {
      var same = 0, index = 0;
      for (var j = 0; j < parent.children.length; j++) {
        if (parent.children[j].tagName === el.tagName) {
          same++;
          if (parent.children[j] === el) index = same;
        }
      }
      if (same > 1) out += ':nth-of-type(' + index + ')';
    }
    return out;
  }

  function selectorOf(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 5) {
      var part = segment(node);
      parts.unshift(part);
      if (part.indexOf('#') !== -1) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  var STYLE_PROPS = [
    'display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight',
    'line-height', 'text-align', 'padding', 'margin', 'border', 'border-radius', 'gap',
    'flex-direction', 'justify-content', 'align-items', 'box-shadow', 'opacity', 'overflow', 'z-index'
  ];
  // Values that say nothing: an agent does not need to hear that an element is not transparent.
  var BORING = {
    'none': 1, 'normal': 1, 'auto': 1, 'static': 1, '0px': 1, 'visible': 1, '1': 1, 'start': 1,
    'rgba(0, 0, 0, 0)': 1, 'row': 1, 'stretch': 1, 'flex-start': 1
  };

  function stylesOf(el) {
    var out = {};
    var computed;
    try { computed = window.getComputedStyle(el); } catch (e) { return out; }
    for (var i = 0; i < STYLE_PROPS.length; i++) {
      var value = computed.getPropertyValue(STYLE_PROPS[i]);
      if (!value) continue;
      value = value.trim();
      if (BORING[value] || /^0px none /.test(value)) continue;
      out[STYLE_PROPS[i]] = cut(value, 160);
    }
    return out;
  }

  function fnName(type) {
    if (!type) return '';
    if (typeof type === 'function') return type.displayName || type.name || '';
    if (typeof type === 'object') return type.displayName || fnName(type.render) || fnName(type.type);
    return '';
  }

  // Development builds of React and Vue hang their component tree off the DOM node. Reading it
  // is best-effort by nature: a production build simply answers nothing, and that is fine.
  function componentsOf(el) {
    var names = [];
    var source = '';
    try {
      var key = null;
      for (var k in el) {
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) { key = k; break; }
      }
      var fiber = key ? el[key] : null;
      var guard = 0;
      while (fiber && guard++ < 200 && names.length < 6) {
        var name = fnName(fiber.type);
        if (name && name.length > 1 && names.indexOf(name) === -1) names.push(name);
        if (!source && fiber._debugSource && fiber._debugSource.fileName) {
          source = fiber._debugSource.fileName + ':' + fiber._debugSource.lineNumber;
        }
        fiber = fiber.return;
      }
      if (!names.length) {
        var node = el;
        var instance = null;
        while (node && !instance) { instance = node.__vueParentComponent || null; node = node.parentElement; }
        guard = 0;
        while (instance && guard++ < 50 && names.length < 6) {
          var type = instance.type || {};
          var vueName = type.__name || type.name || '';
          if (vueName && names.indexOf(vueName) === -1) names.push(vueName);
          if (!source && type.__file) source = type.__file;
          instance = instance.parent;
        }
      }
    } catch (e) { /* a framework's internals changed shape — say nothing rather than guess */ }
    return { names: names, source: cut(String(source), 300) };
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var components = componentsOf(el);
    return {
      url: cut(pageUrl(), 2000),
      selector: cut(selectorOf(el), 400),
      tag: el.tagName.toLowerCase(),
      text: cut((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), cfg.textMax),
      html: cut(el.outerHTML || '', cfg.htmlMax),
      styles: stylesOf(el),
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      components: components.names,
      source: components.source
    };
  }

  // ---- the overlay -------------------------------------------------------------------------

  function ensureUi() {
    if (box) return;
    box = document.createElement('div');
    box.setAttribute('data-cezar-design', 'box');
    box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;' +
      'border:2px solid #4f8cff;background:rgba(79,140,255,.14);border-radius:2px;display:none;';
    tag = document.createElement('div');
    tag.setAttribute('data-cezar-design', 'tag');
    tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;' +
      'font:500 11px/1.4 ui-sans-serif,system-ui,sans-serif;color:#fff;background:#2563eb;' +
      'padding:2px 6px;border-radius:3px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tag);
  }

  function highlight(el) {
    hovered = el;
    if (!box || !tag) return;
    // A selected element already wears its lime frame; the blue hover frame over it would hide
    // exactly the change the click was supposed to show.
    if (!el || keyOf(el)) { box.style.display = 'none'; tag.style.display = 'none'; return; }
    var rect = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    tag.textContent = segment(el) + '  ' + Math.round(rect.width) + '×' + Math.round(rect.height);
    tag.style.display = 'block';
    var top = rect.top - 22;
    tag.style.top = (top < 2 ? Math.min(rect.bottom + 4, window.innerHeight - 22) : top) + 'px';
    tag.style.left = Math.max(2, Math.min(rect.left, window.innerWidth - 80)) + 'px';
  }

  function targetOf(event) {
    var el = event.target;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || ownNode(el) || el === document.documentElement) return null;
    return el;
  }

  function onMove(event) {
    var el = targetOf(event);
    if (el !== hovered) highlight(el);
  }

  // Everything a click is made of is swallowed while picking: the app must not navigate, submit
  // or open a menu because the user pointed at something to talk about it.
  function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  function onClick(event) {
    swallow(event);
    var el = targetOf(event);
    if (!el) return;
    // Clicking a selected element again deselects it: the lime frame goes, the hover frame is back.
    var existing = keyOf(el);
    if (existing) {
      dropMark(existing);
      placeMarks();
      syncMarkTimer();
      highlight(el);
      post({ type: 'unpicked', key: existing });
      return;
    }
    var key = docId + '-' + nextKey++;
    // Described BEFORE the frame is drawn, so the element's own markup and styles are what is
    // reported — and the frame is drawn before the cockpit answers, so the click lands at once.
    var element = describe(el);
    element.mark = key;
    picked[key] = { el: el, node: null };
    ensureMark(picked[key]);
    placeMarks();
    syncMarkTimer();
    highlight(el);
    post({ type: 'picked', element: element });
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    swallow(event);
    setActive(false);
    post({ type: 'cancel' });
  }

  function onScroll() {
    if (hovered) highlight(hovered);
    placeMarks();
  }

  var SWALLOWED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'submit'];

  function setActive(next) {
    if (next === active) return;
    active = next;
    var method = active ? 'addEventListener' : 'removeEventListener';
    document[method]('mousemove', onMove, true);
    document[method]('click', onClick, true);
    document[method]('keydown', onKey, true);
    for (var i = 0; i < SWALLOWED.length; i++) document[method](SWALLOWED[i], swallow, true);
    if (active) {
      ensureUi();
      document.documentElement.style.setProperty('cursor', 'crosshair', 'important');
    } else {
      highlight(null);
      document.documentElement.style.removeProperty('cursor');
    }
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== cfg.parentOrigin || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== 'cezar-design-host') return;
    if (data.type === 'set-active') setActive(!!data.active);
    else if (data.type === 'set-marks' && Array.isArray(data.marks)) setMarks(data.marks.slice(0, 50));
  });

  // Marks outlive the picker being switched off, so they follow the page on their own listeners.
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  post({ type: 'ready', url: pageUrl() });
})();
`;
