/* Автокомпоновка: из списка объектов делает сцену в формате src/scene.js.
 *
 * Правила (не нарушаются никогда):
 *  - геометрия объектов не трогается: функция только выбирает x, y и ОДИН общий scale;
 *  - у всех объектов (главных и фоновых) один и тот же scale, без индивидуальных масштабов;
 *  - фоновые объекты берутся из варианта 'bg' (только цвета фона) и лежат под главными.
 *
 * Алгоритм: общий масштаб по заполнению области -> ~500 случайных раскладок + доводка (hill climbing)
 *  -> слои по нижнему краю (ниже край -> выше слой) -> фоновые объекты по краям и углам.
 *
 * Метрики (IC.layout.metrics) считаются по «ядру» объекта: bbox, ужатый на 12% по каждой оси.
 * Видимость главного объекта = доля точек ядра внутри холста и не закрытых ядрами верхних объектов.
 * Для фонового объекта «видимость» = доля его bbox, попавшая на холст.
 */
(function (IC) {
  'use strict';

  var SHRINK = 0.12;          // ужатие bbox для расчёта наложений/видимости
  var TOLERANCE = 0.15;       // допустимое наложение (доля площади меньшего ядра)
  var GRID = 10;              // точек на сторону при расчёте видимости
  var TITLE_LEFT = 0.42;      // зона заголовка слева: x < 0.42 * W
  var TITLE_TOP = 0.35;       // зона заголовка сверху: y < 0.35 * H
  var OVERHANG = 0.2;         // сколько неглавный объект может выйти за край холста (доля размера)
  var OVERHANG_PRIMARY = 0.03;
  var SAMPLES = 500;
  var REFINE_STARTS = 4;
  var REFINE_STEPS = 90;

  /* ---------- утилиты ---------- */

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function round2(n) { return Math.round(n * 100) / 100; }
  function area(b) { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }
  function inter(a, b) {
    return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
      Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  }
  function core(b) {
    var dx = (b[2] - b[0]) * SHRINK / 2, dy = (b[3] - b[1]) * SHRINK / 2;
    return [b[0] + dx, b[1] + dy, b[2] - dx, b[3] - dy];
  }
  function boxOf(x, y, w, h) { return [x - w / 2, y - h / 2, x + w / 2, y + h / 2]; }

  /** Прямоугольники: доступная область и зона заголовка. */
  function zones(W, H, titleZone) {
    if (titleZone === 'left') return { area: [W * TITLE_LEFT, 0, W, H], title: [0, 0, W * TITLE_LEFT, H] };
    if (titleZone === 'top') return { area: [0, H * TITLE_TOP, W, H], title: [0, 0, W, H * TITLE_TOP] };
    return { area: [0, 0, W, H], title: null };
  }

  function resolveFormat(f) {
    if (!f) return IC.scene.FORMATS[0];
    if (typeof f === 'string') {
      var found = IC.scene.FORMATS.filter(function (x) { return x.id === f; })[0];
      if (found) return found;
    }
    if (f.w && f.h) return { id: f.id || 'custom', name: f.name || (f.w + '×' + f.h), w: f.w, h: f.h };
    return IC.scene.FORMATS[0];
  }

  /* ---------- метрики ---------- */

  /** Видимость каждого объекта. boxes — полные bbox, order — индексы от нижнего слоя к верхнему,
   *  covers[i] — true, если объект i закрывает нижние (главные). Возвращает массив долей 0..1. */
  function visibility(boxes, order, covers, W, H) {
    var rank = [], res = [], i, j, k;
    order.forEach(function (idx, r) { rank[idx] = r; });
    var cores = boxes.map(core);
    for (i = 0; i < boxes.length; i++) {
      var c = cores[i], hit = 0, tot = 0;
      var above = [];
      for (j = 0; j < boxes.length; j++) if (rank[j] > rank[i] && covers[j]) above.push(cores[j]);
      for (var gx = 0; gx < GRID; gx++) {
        var px = c[0] + (c[2] - c[0]) * (gx + 0.5) / GRID;
        for (var gy = 0; gy < GRID; gy++) {
          var py = c[1] + (c[3] - c[1]) * (gy + 0.5) / GRID;
          tot++;
          if (px < 0 || py < 0 || px > W || py > H) continue;
          var hidden = false;
          for (k = 0; k < above.length; k++) {
            var a = above[k];
            if (px > a[0] && px < a[2] && py > a[1] && py < a[3]) { hidden = true; break; }
          }
          if (!hidden) hit++;
        }
      }
      res.push(hit / tot);
    }
    return res;
  }

  function canvasFraction(b, W, H) { return inter(b, [0, 0, W, H]) / area(b); }

  /** Метрики готовой сцены. Возвращает {items:[{uid,objectId,kind,box,visibility}], maxOverlap}.
   *  visibility: главные — с учётом холста и перекрытия верхними главными; фоновые — доля bbox на холсте. */
  function metrics(lib, scene) {
    var W = scene.format.w, H = scene.format.h;
    var boxes = scene.items.map(function (it) {
      var b = IC.scene.itemBounds(lib, scene, it);
      return [b.x, b.y, b.x + b.w, b.y + b.h];
    });
    var order = scene.items.map(function (_, i) { return i; });         // порядок слоёв = порядок в items
    var covers = scene.items.map(function (it) { return it.kind === 'main'; });
    var vis = visibility(boxes, order, covers, W, H);
    var maxOverlap = 0;
    var items = scene.items.map(function (it, i) {
      if (it.kind === 'main') {
        for (var j = i + 1; j < scene.items.length; j++) {
          if (scene.items[j].kind !== 'main') continue;
          var ca = core(boxes[i]), cb = core(boxes[j]);
          maxOverlap = Math.max(maxOverlap, inter(ca, cb) / Math.min(area(ca), area(cb)));
        }
      }
      return {
        uid: it.uid, objectId: it.objectId, kind: it.kind, box: boxes[i],
        visibility: it.kind === 'bg' ? canvasFraction(boxes[i], W, H) : vis[i]
      };
    });
    return { items: items, maxOverlap: maxOverlap };
  }

  /* ---------- главные объекты ---------- */

  function fillFor(n) { return n <= 1 ? 0.45 : n === 2 ? 0.5 : 0.58; }

  /** Общий масштаб: Σ(w·h)·s² ≈ fill·area, самый крупный объект ≤ 0.9 области по любой оси. */
  function commonScale(dims, areaRect) {
    var aw = areaRect[2] - areaRect[0], ah = areaRect[3] - areaRect[1];
    var sum = 0, maxW = 0, maxH = 0;
    dims.forEach(function (d) { sum += d.w * d.h; maxW = Math.max(maxW, d.w); maxH = Math.max(maxH, d.h); });
    var s = Math.sqrt(fillFor(dims.length) * aw * ah / sum);
    s = Math.min(s, 0.9 * aw / maxW, 0.9 * ah / maxH);
    return Math.round(s * 100000) / 100000;
  }

  /** Допустимые диапазоны центров: внутри области, выход за край холста — но не за границу зоны заголовка. */
  function ranges(dims, c) {
    return dims.map(function (d, i) {
      var ov = i === 0 ? OVERHANG_PRIMARY : OVERHANG;
      function lim(lo, hi, size, canvasLo, canvasHi) {
        var a = lo - (lo <= canvasLo ? ov * size : 0) + size / 2;
        var b = hi + (hi >= canvasHi ? ov * size : 0) - size / 2;
        return a > b ? [(a + b) / 2, (a + b) / 2] : [a, b];
      }
      return { x: lim(c.area[0], c.area[2], d.w, 0, c.W), y: lim(c.area[1], c.area[3], d.h, 0, c.H) };
    });
  }

  /** Штраф раскладки (меньше — лучше). P — центры в порядке dims. */
  function cost(P, dims, c) {
    var n = dims.length, boxes = [], order = [], i, j;
    for (i = 0; i < n; i++) { boxes.push(boxOf(P[i].x, P[i].y, dims[i].w, dims[i].h)); order.push(i); }
    order.sort(function (a, b) { return (boxes[a][3] - boxes[b][3]) || (a - b); });
    var vis = visibility(boxes, order, dims.map(function () { return true; }), c.W, c.H);
    var total = 0;
    for (i = 0; i < n; i++) {
      var need = i === 0 ? 0.95 : 0.75;
      total += Math.max(0, need - vis[i]) * (i === 0 ? 60 : 25) + (1 - vis[i]) * 1.5;
      total += (1 - canvasFraction(boxes[i], c.W, c.H)) * 6;   // лучше целиком на холсте, чем обрезанным
    }
    var cores = boxes.map(core);
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      var r = inter(cores[i], cores[j]) / Math.min(area(cores[i]), area(cores[j]));
      total += Math.max(0, r - TOLERANCE) * 12 + r * 1.5;
    }
    // баланс: центр масс (по площади) около целевой точки области
    var aw = c.area[2] - c.area[0], ah = c.area[3] - c.area[1];
    var mx = 0, my = 0, m = 0;
    for (i = 0; i < n; i++) { var a = dims[i].w * dims[i].h; mx += P[i].x * a; my += P[i].y * a; m += a; }
    var dist = Math.hypot((mx / m - c.target.x) / aw, (my / m - c.target.y) / ah);
    total += Math.max(0, dist - 0.04) * 10;
    // разнесённость: объекты занимают область, а не жмутся в один угол
    if (n > 1) {
      var u = [Infinity, Infinity, -Infinity, -Infinity];
      boxes.forEach(function (b) { u = [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])]; });
      total += Math.max(0, 0.7 - (u[2] - u[0]) / aw) * 3 + Math.max(0, 0.7 - (u[3] - u[1]) / ah) * 3;
    }
    return total;
  }

  function clampTo(v, r) { return Math.min(r[1], Math.max(r[0], v)); }

  function searchMain(rnd, dims, c) {
    var rg = ranges(dims, c), n = dims.length, pool = [], s, i;
    function randomLayout() {
      return dims.map(function (_, k) {
        return { x: rg[k].x[0] + rnd() * (rg[k].x[1] - rg[k].x[0]), y: rg[k].y[0] + rnd() * (rg[k].y[1] - rg[k].y[0]) };
      });
    }
    for (s = 0; s < SAMPLES; s++) {
      var P = randomLayout();
      pool.push({ P: P, c: cost(P, dims, c) });
    }
    pool.sort(function (a, b) { return a.c - b.c; });
    var aw = c.area[2] - c.area[0], ah = c.area[3] - c.area[1];
    var best = pool[0];
    for (var st = 0; st < REFINE_STARTS; st++) {
      var cur = { P: pool[st].P.map(function (p) { return { x: p.x, y: p.y }; }), c: pool[st].c };
      for (i = 0; i < REFINE_STEPS; i++) {
        var k = Math.floor(rnd() * n), q = cur.P.map(function (p) { return { x: p.x, y: p.y }; });
        if (n > 1 && rnd() < 0.15) {                       // обмен позициями двух объектов
          var k2 = (k + 1 + Math.floor(rnd() * (n - 1))) % n;
          var tx = q[k].x, ty = q[k].y;
          q[k].x = clampTo(q[k2].x, rg[k].x); q[k].y = clampTo(q[k2].y, rg[k].y);
          q[k2].x = clampTo(tx, rg[k2].x); q[k2].y = clampTo(ty, rg[k2].y);
        } else {
          var step = 0.15 * (1 - i / REFINE_STEPS) + 0.01;
          q[k].x = clampTo(q[k].x + (rnd() - 0.5) * 2 * step * aw, rg[k].x);
          q[k].y = clampTo(q[k].y + (rnd() - 0.5) * 2 * step * ah, rg[k].y);
        }
        var qc = cost(q, dims, c);
        if (qc < cur.c) cur = { P: q, c: qc };
      }
      if (cur.c < best.c) best = cur;
    }
    return best;
  }

  /* ---------- фоновые объекты ---------- */

  function placeBackground(rnd, bgDims, mainBoxes, c) {
    var W = c.W, H = c.H, placed = [], out = [];
    var mcx = 0, mcy = 0;
    mainBoxes.forEach(function (b) { mcx += (b[0] + b[2]) / 2; mcy += (b[1] + b[3]) / 2; });
    mcx = mainBoxes.length ? mcx / mainBoxes.length : W / 2; mcy = mainBoxes.length ? mcy / mainBoxes.length : H / 2;
    var mainCores = mainBoxes.map(core);

    bgDims.forEach(function (d) {
      var best = null;
      for (var t = 0; t < 400; t++) {
        var lo = t < 250 ? 0.35 : 0.2, hi = t < 250 ? 0.65 : 0.8;
        var x, y, mode = rnd();
        var f1 = 0.4 + rnd() * 0.3, fx = 0.6 + rnd() * 0.2, fy = 0.6 + rnd() * 0.2;
        if (mode < 0.5) {                                   // угол
          x = rnd() < 0.5 ? fx * d.w - d.w / 2 : W - fx * d.w + d.w / 2;
          y = rnd() < 0.5 ? fy * d.h - d.h / 2 : H - fy * d.h + d.h / 2;
        } else {                                            // край
          var side = Math.floor(rnd() * 4);
          x = c.area[0] + d.w / 2 + rnd() * Math.max(0, c.area[2] - c.area[0] - d.w);
          y = c.area[1] + d.h / 2 + rnd() * Math.max(0, c.area[3] - c.area[1] - d.h);
          if (side === 0) x = f1 * d.w - d.w / 2;
          else if (side === 1) x = W - f1 * d.w + d.w / 2;
          else if (side === 2) y = f1 * d.h - d.h / 2;
          else y = H - f1 * d.h + d.h / 2;
        }
        var b = boxOf(x, y, d.w, d.h);
        if (c.title && inter(b, c.title) > 0) continue;
        var vf = canvasFraction(b, W, H);
        if (vf < lo || vf > hi) continue;
        var cb = core(b), vis = inter(cb, [0, 0, W, H]), pen = 0, i;
        for (i = 0; i < mainCores.length; i++) pen += inter(cb, mainCores[i]) / Math.max(1, vis);
        for (i = 0; i < placed.length; i++) pen += 3 * inter(cb, placed[i]) / Math.max(1, vis);
        var far = Math.hypot((x - mcx) / W, (y - mcy) / H);
        var score = pen * 2 - far + rnd() * 0.15;
        if (!best || score < best.score) best = { x: x, y: y, box: b, score: score };
        if (t >= 250 && best) break;
      }
      if (best) { placed.push(core(best.box)); out.push({ x: best.x, y: best.y, box: best.box }); }
      else out.push(null);
    });
    return out;
  }

  /* ---------- сборка ---------- */

  /** Одна раскладка. opts: {main:[{id}], bg:[{id}], format, size:'L'|'S', titleZone:null|'left'|'top', seed,
   *  schemeId, decor}. Возвращает {seed, scene, score, metrics}. */
  function compose(lib, opts) {
    opts = opts || {};
    var seed = opts.seed === undefined ? 1 : opts.seed;
    var rnd = mulberry32(seed);
    var format = resolveFormat(opts.format), W = format.w, H = format.h;
    var size = opts.size || 'L', zone = opts.titleZone || null;
    var mains = opts.main || [], bgs = opts.bg || [];
    var z = zones(W, H, zone);

    var mainDims = mains.map(function (o) { var v = IC.scene.variant(lib, size, o.id, 'main'); return { w: v.w, h: v.h }; });
    var bgDims = bgs.map(function (o) { var v = IC.scene.variant(lib, size, o.id, 'bg'); return { w: v.w, h: v.h }; });
    var scale = commonScale(mainDims.length ? mainDims : bgDims, z.area);

    var scene = IC.scene.create(lib, {
      format: format, size: size, schemeId: opts.schemeId, decor: opts.decor, titleZone: zone, scale: scale
    });
    var mdims = mainDims.map(function (d) { return { w: d.w * scale, h: d.h * scale }; });
    var bdims = bgDims.map(function (d) { return { w: d.w * scale, h: d.h * scale }; });

    // «стиль» варианта: слегка смещённая целевая точка центра масс — разные seed дают разные композиции
    var aw = z.area[2] - z.area[0], ah = z.area[3] - z.area[1];
    var ctx = {
      W: W, H: H, area: z.area, title: z.title,
      target: { x: z.area[0] + aw * (0.5 + (rnd() - 0.5) * 0.24), y: z.area[1] + ah * (0.5 + (rnd() - 0.5) * 0.24) }
    };

    var best = mdims.length ? searchMain(rnd, mdims, ctx) : { P: [], c: 0 };
    var mainBoxes = best.P.map(function (p, i) { return boxOf(p.x, p.y, mdims[i].w, mdims[i].h); });
    var bgPlaced = placeBackground(rnd, bdims, mainBoxes, ctx);

    var n = 0;
    function item(objectId, kind, x, y, bottom) {
      return { uid: 's' + seed.toString(36) + '-' + (n++), objectId: objectId, kind: kind, x: round2(x), y: round2(y), rotation: 0, colorShift: 0, _b: bottom };
    }
    var bgItems = [], mainItems = [];
    bgPlaced.forEach(function (p, i) { if (p) bgItems.push(item(bgs[i].id, 'bg', p.x, p.y, p.box[3])); });
    var primaryUid = null;
    best.P.forEach(function (p, i) {
      var it = item(mains[i].id, 'main', p.x, p.y, p.y + mdims[i].h / 2);
      if (i === 0) primaryUid = it.uid;
      mainItems.push(it);
    });
    // изометрия: чем ниже нижний край, тем выше слой (primary — первый в списке — при равенстве выше)
    function byBottom(a, b) { return a._b - b._b; }
    scene.items = bgItems.sort(byBottom).concat(mainItems.sort(byBottom));
    scene.items.forEach(function (it) { delete it._b; });

    return { seed: seed, scene: scene, score: best.c, primaryUid: mainItems.length ? primaryUid : null, metrics: metrics(lib, scene) };
  }

  /** n раскладок (по умолчанию 6) с разными seed — для полосы вариантов. */
  function variants(lib, opts, count) {
    var base = (opts && opts.seed) || 1, out = [];
    for (var i = 0; i < (count || 6); i++) {
      out.push(compose(lib, Object.assign({}, opts, { seed: base + i * 7919 })));
    }
    return out;
  }

  IC.layout = {
    compose: compose, variants: variants, metrics: metrics, commonScale: commonScale, zones: zones,
    rng: mulberry32, TITLE_LEFT: TITLE_LEFT, TITLE_TOP: TITLE_TOP, SHRINK: SHRINK, TOLERANCE: TOLERANCE
  };
})(window.IC = window.IC || {});
