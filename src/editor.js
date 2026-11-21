/* Холст редактора: рендер сцены, выделение, перетаскивание, поворот, клавиатура, история, экспорт.
 * Контракт — docs/INTERFACE.md. Объекты не меняются (только позиция/поворот/цвета ролей);
 * масштаб один на всю сцену (scene.scale) — масштаба отдельного объекта здесь нет.
 */
(function (IC) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var MAX_HISTORY = 100;      // шагов отмены
  var MERGE_MS = 1000;        // серия однотипных правок (стрелки, ввод угла) — один шаг истории
  var SLOP = 3;               // экранных px до начала перетаскивания
  var ACCENT = '#6c4dff';
  var MAX_CANVAS_SIDE = 16384;

  function normAngle(r) {
    r = ((r % 360) + 360) % 360;
    if (r > 180) r -= 360;
    return Math.round(r * 10) / 10;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function isTyping(t) {
    if (!t || !t.tagName) return false;
    var tag = String(t.tagName).toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
  }

  function create(container, lib, opts) {
    opts = opts || {};
    var doc = container.ownerDocument || document;
    var scene = opts.scene ? IC.scene.clone(opts.scene) : IC.scene.create(lib);
    var selected = null;
    var hist = [IC.scene.clone(scene)], pos = 0;
    var mergeKey = null, mergeTime = 0;
    var drag = null;
    var svg = null, overlay = null, selG = null;
    var destroyed = false;
    var ro = null;

    var wrap = doc.createElement('div');
    wrap.className = 'ic-editor';
    wrap.style.cssText = 'width:100%;height:100%;position:relative;touch-action:none;user-select:none;-webkit-user-select:none;';
    container.appendChild(wrap);

    /* ---------- утилиты ---------- */
    function custom() { return typeof opts.getCustomSchemes === 'function' ? (opts.getCustomSchemes() || []) : []; }
    function el(name, attrs) {
      var e = doc.createElementNS(NS, name);
      for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
      return e;
    }
    function find(uid) {
      if (!uid) return null;
      for (var i = 0; i < scene.items.length; i++) if (scene.items[i].uid === uid) return scene.items[i];
      return null;
    }
    function indexOfUid(uid) {
      for (var i = 0; i < scene.items.length; i++) if (scene.items[i].uid === uid) return i;
      return -1;
    }
    function groupOf(uid) { return svg ? svg.querySelector('[data-uid="' + uid + '"]') : null; }
    function emit(reason) { if (typeof opts.onChange === 'function') opts.onChange(IC.scene.clone(scene), reason); }
    /** Единиц холста в одном экранном px (для линий/ручек постоянного размера). */
    function unit() {
      var m = svg && svg.getScreenCTM ? svg.getScreenCTM() : null;
      return m && m.a > 0 ? 1 / m.a : (scene.format.w / 600);
    }
    function toSvg(e) {
      var m = svg && svg.getScreenCTM ? svg.getScreenCTM() : null;
      if (!m) return null;
      var p = svg.createSVGPoint();
      p.x = e.clientX; p.y = e.clientY;
      return p.matrixTransform(m.inverse());
    }
    function clampPos(it) {
      it.x = clamp(it.x, 0, scene.format.w);
      it.y = clamp(it.y, 0, scene.format.h);
    }

    /* ---------- история ---------- */
    function commit(reason, merge) {
      var now = Date.now();
      var snap = IC.scene.clone(scene);
      if (merge && mergeKey === merge && now - mergeTime < MERGE_MS && pos === hist.length - 1 && pos > 0) {
        hist[pos] = snap;
      } else {
        hist.length = pos + 1;
        hist.push(snap);
        if (hist.length > MAX_HISTORY + 1) hist.shift();
        pos = hist.length - 1;
      }
      mergeKey = merge || null;
      mergeTime = now;
    }

    /** Общий хвост любой правки: выделение, полный рендер, история, колбэки. */
    function finish(reason, newSel, o) {
      o = o || {};
      var before = selected;
      if (newSel !== undefined) selected = newSel;
      if (selected && !find(selected)) selected = null;
      render();
      if (o.history !== false) commit(reason, o.merge);
      if (selected !== before && typeof opts.onSelect === 'function') opts.onSelect(selected);
      emit(reason);
    }

    /* ---------- рендер и слой выделения ---------- */
    function render() {
      cancelDrag();
      wrap.innerHTML = IC.scene.render(lib, scene, { customSchemes: custom() });
      svg = wrap.querySelector('svg');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.style.cssText = 'display:block;width:100%;height:100%;max-width:100%;max-height:100%;overflow:visible;';
      var objs = svg.querySelector('#objects');
      if (objs) objs.style.cursor = 'move';
      overlay = el('g', { id: 'ic-overlay', 'pointer-events': 'none' });
      svg.appendChild(overlay);
      buildOverlay();
    }

    function placeSelection(it) {
      if (!selG || !it) return;
      selG.setAttribute('transform', 'translate(' + round2(it.x) + ' ' + round2(it.y) + ')' + (it.rotation ? ' rotate(' + it.rotation + ')' : ''));
    }

    function buildOverlay() {
      if (!overlay) return;
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      selG = null;
      var k = unit();
      var W = scene.format.w, H = scene.format.h;

      // направляющая зоны заголовка (только редактор, в экспорт не попадает)
      if (scene.titleZone && IC.layout && IC.layout.zones) {
        var z = IC.layout.zones(W, H, scene.titleZone).title;
        if (z) {
          overlay.appendChild(el('rect', {
            x: z[0], y: z[1], width: z[2] - z[0], height: z[3] - z[1],
            fill: 'rgba(108,77,255,0.05)', stroke: ACCENT, 'stroke-width': 1.5, 'stroke-dasharray': '6 4',
            'vector-effect': 'non-scaling-stroke'
          }));
          var label = el('text', { x: z[0] + 8 * k, y: z[1] + 18 * k, 'font-size': 12 * k, fill: ACCENT, 'font-family': 'sans-serif' });
          label.textContent = 'Заголовок';
          overlay.appendChild(label);
        }
      }

      // рамка выделения (повёрнута вместе с объектом) и ручка поворота
      var it = find(selected);
      if (!it) return;
      var s = IC.scene.itemSize(lib, scene, it);
      var off = 28 * k;
      selG = el('g', {});
      selG.appendChild(el('rect', {
        x: -s.w / 2, y: -s.h / 2, width: s.w, height: s.h, fill: 'none',
        stroke: ACCENT, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke'
      }));
      selG.appendChild(el('line', {
        x1: 0, y1: -s.h / 2, x2: 0, y2: -s.h / 2 - off,
        stroke: ACCENT, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke'
      }));
      var h = el('g', { 'data-ic-handle': 'rotate', 'pointer-events': 'all', cursor: 'grab' });
      h.appendChild(el('circle', { cx: 0, cy: -s.h / 2 - off, r: 14 * k, fill: 'transparent' }));
      h.appendChild(el('circle', {
        cx: 0, cy: -s.h / 2 - off, r: 6 * k, fill: '#fff', stroke: ACCENT, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke'
      }));
      var tt = el('title', {});
      tt.textContent = 'Повернуть (Shift — шаг 15°)';
      h.appendChild(tt);
      selG.appendChild(h);
      overlay.appendChild(selG);
      placeSelection(it);
    }

    /* ---------- мышь / указатель ---------- */
    function blurActive() {
      var a = doc.activeElement;
      if (a && a !== doc.body && isTyping(a) && a.blur) a.blur();
    }

    function onPointerDown(e) {
      if (destroyed || !svg || drag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      var t = e.target;
      if (!t || !t.closest) return;
      var p = toSvg(e);
      if (!p) return;
      var handle = selected ? t.closest('[data-ic-handle]') : null;
      var g = handle ? null : t.closest('[data-uid]');
      var it, mode;
      if (handle) {
        it = find(selected); mode = 'rotate';
      } else if (g) {
        select(g.getAttribute('data-uid'));
        it = find(selected); mode = 'move';
      } else {
        select(null);
        return;
      }
      if (!it) return;
      e.preventDefault();
      blurActive();
      drag = {
        mode: mode, uid: it.uid, pid: e.pointerId, sx: e.clientX, sy: e.clientY, start: p, moved: false,
        orig: { x: it.x, y: it.y, rot: it.rotation || 0 },
        a0: Math.atan2(p.y - it.y, p.x - it.x),
        g: mode === 'move' ? g : groupOf(it.uid)
      };
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
    }

    function applyLive(it) {
      if (drag && drag.g) drag.g.setAttribute('transform', IC.scene.itemTransform(lib, scene, it));
      placeSelection(it);
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pid) return;
      var it = find(drag.uid);
      if (!it) { drag = null; return; }
      var p = toSvg(e);
      if (!p) return;
      if (drag.mode === 'move') {
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < SLOP) return;
        drag.moved = true;
        it.x = drag.orig.x + (p.x - drag.start.x);
        it.y = drag.orig.y + (p.y - drag.start.y);
        clampPos(it);
      } else {
        var r = drag.orig.rot + (Math.atan2(p.y - it.y, p.x - it.x) - drag.a0) * 180 / Math.PI;
        r = e.shiftKey ? Math.round(r / 15) * 15 : r;
        r = normAngle(r);
        if (r !== drag.orig.rot) drag.moved = true;
        it.rotation = r;
      }
      if (drag.moved) applyLive(it);
    }

    function onPointerUp(e) {
      if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.pid)) return;
      var d = drag;
      drag = null;
      try { if (svg && e && e.pointerId !== undefined) svg.releasePointerCapture(e.pointerId); } catch (err) { /* уже отпущен */ }
      if (!d.moved) return;
      var it = find(d.uid);
      if (!it) return;
      it.x = round2(it.x); it.y = round2(it.y);
      finish(d.mode === 'rotate' ? 'rotate' : 'move');
    }

    function onPointerCancel(e) {
      if (!drag || e.pointerId !== drag.pid) return;
      cancelDrag();
    }

    /** Отмена перетаскивания: вернуть исходные значения (без истории). */
    function cancelDrag() {
      if (!drag) return;
      var d = drag;
      drag = null;
      var it = find(d.uid);
      if (it && d.moved) {
        it.x = d.orig.x; it.y = d.orig.y; it.rotation = d.orig.rot;
        if (d.g && svg) d.g.setAttribute('transform', IC.scene.itemTransform(lib, scene, it));
        placeSelection(it);
      }
    }

    /* ---------- клавиатура ---------- */
    function onKey(e) {
      if (destroyed || isTyping(e.target) || e.altKey) return;
      var c = e.code || '', key = e.key || '', lk = key.toLowerCase();
      var mod = e.ctrlKey || e.metaKey;
      if (mod) {
        if (c === 'KeyZ' || (!c && lk === 'z')) { e.preventDefault(); if (e.shiftKey) ed.redo(); else ed.undo(); return; }
        if (c === 'KeyY' || (!c && lk === 'y')) { e.preventDefault(); ed.redo(); return; }
        if ((c === 'KeyD' || (!c && lk === 'd')) && selected) { e.preventDefault(); ed.duplicate(); }
        return;
      }
      if (!selected) return;
      var step = e.shiftKey ? 10 : 1;
      switch (key) {
        case 'ArrowLeft': e.preventDefault(); ed.nudge(-step, 0); return;
        case 'ArrowRight': e.preventDefault(); ed.nudge(step, 0); return;
        case 'ArrowUp': e.preventDefault(); ed.nudge(0, -step); return;
        case 'ArrowDown': e.preventDefault(); ed.nudge(0, step); return;
        case 'Delete': case 'Backspace': e.preventDefault(); ed.remove(); return;
        case 'Escape': select(null); return;
      }
      if (c === 'BracketLeft' || key === '[') { e.preventDefault(); ed.lower(); }
      else if (c === 'BracketRight' || key === ']') { e.preventDefault(); ed.raise(); }
    }

    /* ---------- выделение ---------- */
    function select(uid) {
      uid = uid && find(uid) ? uid : null;
      if (uid === selected) return;
      selected = uid;
      buildOverlay();
      if (typeof opts.onSelect === 'function') opts.onSelect(selected);
    }

    /** Правка выделенного объекта с полным рендером и шагом истории. fn вернёт false — «ничего не изменилось». */
    function mutateSel(fn, reason, merge) {
      var it = find(selected);
      if (!it) return false;
      if (fn(it) === false) return false;
      finish(reason, undefined, { merge: merge });
      return true;
    }

    function occupied(x, y) {
      for (var i = 0; i < scene.items.length; i++) {
        if (Math.abs(scene.items[i].x - x) < 15 && Math.abs(scene.items[i].y - y) < 15) return true;
      }
      return false;
    }

    /* ---------- публичный интерфейс ---------- */
    var ed = {
      setScene: function (s, o) {
        scene = IC.scene.clone(s);
        if (!scene.items) scene.items = [];
        if (o && o.resetHistory) {
          hist = [IC.scene.clone(scene)]; pos = 0; mergeKey = null;
          finish('setScene', undefined, { history: false });
        } else {
          finish('setScene');
        }
      },
      getScene: function () { return IC.scene.clone(scene); },
      update: function (fn, reason) {
        var draft = IC.scene.clone(scene);
        var r = fn(draft);
        scene = (r && typeof r === 'object' && r.items) ? r : draft;
        finish(reason || 'update');
      },
      select: select,
      getSelected: function () { var it = find(selected); return it ? IC.scene.clone(it) : null; },

      duplicate: function () {
        var it = find(selected);
        if (!it) return;
        var c = IC.scene.clone(it);
        c.uid = IC.scene.uid();
        c.x += 30; c.y += 30;
        scene.items.splice(indexOfUid(it.uid) + 1, 0, c);
        finish('duplicate', c.uid);
      },
      remove: function () {
        var i = indexOfUid(selected);
        if (i < 0) return;
        scene.items.splice(i, 1);
        finish('remove', null);
      },
      raise: function () {
        var i = indexOfUid(selected);
        if (i < 0 || i >= scene.items.length - 1) return;
        var t = scene.items[i]; scene.items[i] = scene.items[i + 1]; scene.items[i + 1] = t;
        finish('raise');
      },
      lower: function () {
        var i = indexOfUid(selected);
        if (i <= 0) return;
        var t = scene.items[i]; scene.items[i] = scene.items[i - 1]; scene.items[i - 1] = t;
        finish('lower');
      },
      toFront: function () {
        var i = indexOfUid(selected);
        if (i < 0 || i === scene.items.length - 1) return;
        scene.items.push(scene.items.splice(i, 1)[0]);
        finish('toFront');
      },
      toBack: function () {
        var i = indexOfUid(selected);
        if (i <= 0) return;
        scene.items.unshift(scene.items.splice(i, 1)[0]);
        finish('toBack');
      },
      toggleKind: function () {
        mutateSel(function (it) {
          var next = it.kind === 'bg' ? 'main' : 'bg';
          var v = null;
          try { v = IC.scene.variant(lib, scene.size, it.objectId, next); } catch (err) { v = null; }
          if (!v) return false;
          it.kind = next;
        }, 'toggleKind');
      },
      shiftColors: function () {
        mutateSel(function (it) { it.colorShift = (((it.colorShift || 0) + 1) % 3 + 3) % 3; }, 'shiftColors');
      },
      setRotation: function (deg) {
        var n = Number(deg);
        if (!isFinite(n)) return;
        n = normAngle(n);
        mutateSel(function (it) {
          if ((it.rotation || 0) === n) return false;
          it.rotation = n;
        }, 'rotate', 'rotation:' + selected);
      },
      resetRotation: function () {
        mutateSel(function (it) {
          if (!(it.rotation || 0)) return false;
          it.rotation = 0;
        }, 'rotate');
      },
      /** Сдвиг в единицах холста; серия сдвигов — один шаг истории; полный рендер не нужен. */
      nudge: function (dx, dy) {
        var it = find(selected);
        if (!it || !isFinite(dx) || !isFinite(dy) || (!dx && !dy)) return;
        it.x += dx; it.y += dy;
        clampPos(it);
        var g = groupOf(it.uid);
        if (g) {
          g.setAttribute('transform', IC.scene.itemTransform(lib, scene, it));
          placeSelection(it);
          commit('nudge', 'nudge:' + it.uid);
          emit('nudge');
        } else {
          finish('nudge', undefined, { merge: 'nudge:' + it.uid });
        }
      },

      addObject: function (objectId, kind) {
        var o = IC.scene.getObject(lib, objectId);
        kind = kind === 'bg' ? 'bg' : 'main';
        if (!o || !o.variants[scene.size] || !o.variants[scene.size][kind]) return null;
        var W = scene.format.w, H = scene.format.h, x = W / 2, y = H / 2;
        for (var n = 1; n <= 8 && occupied(x, y); n++) { x = W / 2 + n * 30; y = H / 2 + n * 30; }
        var it = { uid: IC.scene.uid(), objectId: objectId, kind: kind, x: x, y: y, rotation: 0, colorShift: 0 };
        scene.items.push(it);
        finish('add', it.uid);
        return IC.scene.clone(it);
      },

      undo: function () {
        if (pos <= 0) return false;
        pos--; mergeKey = null;
        scene = IC.scene.clone(hist[pos]);
        finish('undo', undefined, { history: false });
        return true;
      },
      redo: function () {
        if (pos >= hist.length - 1) return false;
        pos++; mergeKey = null;
        scene = IC.scene.clone(hist[pos]);
        finish('redo', undefined, { history: false });
        return true;
      },
      canUndo: function () { return pos > 0; },
      canRedo: function () { return pos < hist.length - 1; },

      exportSVG: function () {
        return IC.scene.render(lib, scene, { export: true, customSchemes: custom() });
      },

      exportPNG: function (scaleFactor) {
        var f = Number(scaleFactor);
        if (!isFinite(f) || f <= 0) f = 1;
        var W = Math.round(scene.format.w * f), H = Math.round(scene.format.h * f);
        return new Promise(function (resolve, reject) {
          if (W < 1 || H < 1 || W > MAX_CANVAS_SIDE || H > MAX_CANVAS_SIDE) {
            reject(new Error('Недопустимый размер PNG: ' + W + '×' + H + ' px (допустимо до ' + MAX_CANVAS_SIDE + ' px по стороне).'));
            return;
          }
          var svgText;
          try { svgText = ed.exportSVG(); } catch (err) { reject(new Error('Не удалось собрать SVG для экспорта: ' + (err && err.message))); return; }
          var img = new Image();
          img.onload = function () {
            try {
              var cv = doc.createElement('canvas');
              cv.width = W; cv.height = H;
              var ctx = cv.getContext('2d');
              if (!ctx) { reject(new Error('Браузер не смог создать холст для PNG (возможно, слишком большой размер).')); return; }
              ctx.drawImage(img, 0, 0, W, H);
              cv.toBlob(function (blob) {
                if (blob) resolve(blob);
                else reject(new Error('Не удалось получить PNG: браузер вернул пустой результат (попробуйте меньший масштаб).'));
              }, 'image/png');
            } catch (err) {
              reject(new Error('Не удалось получить PNG: ' + (err && err.message ? err.message : 'ошибка холста') + '.'));
            }
          };
          img.onerror = function () { reject(new Error('Не удалось загрузить SVG как изображение для PNG.')); };
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        });
      },

      refresh: function () { render(); },
      destroy: function () {
        destroyed = true;
        drag = null;
        doc.removeEventListener('keydown', onKey);
        if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('resize', onResize);
        if (ro) ro.disconnect();
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        svg = overlay = selG = null;
      }
    };

    function onResize() { if (!destroyed && !drag) buildOverlay(); }

    wrap.addEventListener('pointerdown', onPointerDown);
    wrap.addEventListener('pointermove', onPointerMove);
    wrap.addEventListener('pointerup', onPointerUp);
    wrap.addEventListener('pointercancel', onPointerCancel);
    wrap.addEventListener('lostpointercapture', onPointerUp);
    doc.addEventListener('keydown', onKey);
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(wrap);
    } else if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', onResize);
    }

    render();
    return ed;
  }

  IC.editor = { create: create };
})(window.IC = window.IC || {});
