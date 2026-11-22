/* Модель композиции и её рендер в SVG.
 *
 * scene = {
 *   format: {id, name, w, h},        // размер холста в px
 *   size: 'L' | 'S',                  // набор детализации из библиотеки
 *   schemeId: 'violet' | ... ,        // активная цветовая схема
 *   decor: 'violet'|'peach'|'teal'|'none',
 *   scale: number,                    // ОДИН масштаб для всех объектов — пропорции между ними не меняются
 *   titleZone: null | 'left' | 'top', // место под заголовок (только направляющая в редакторе)
 *   items: [{uid, objectId, kind:'main'|'bg', x, y, rotation, colorShift}]  // x,y — центр объекта; порядок = порядок слоёв
 * }
 */
(function (IC) {
  'use strict';

  var FORMATS = [
    { id: 'square', name: 'Квадрат 1000×1000', w: 1000, h: 1000 },
    { id: 'og', name: 'Обложка 1200×630', w: 1200, h: 630 },
    { id: 'post', name: 'Пост 1080×1350', w: 1080, h: 1350 },
    { id: 'banner', name: 'Баннер 1920×1080', w: 1920, h: 1080 },
    { id: 'story', name: 'Сторис 1080×1920', w: 1080, h: 1920 }
  ];

  var uidCounter = 0;
  function uid() { uidCounter += 1; return 'i' + Date.now().toString(36) + uidCounter; }

  function getObject(lib, id) {
    for (var i = 0; i < lib.objects.length; i++) if (lib.objects[i].id === id) return lib.objects[i];
    return null;
  }

  function variant(lib, size, objectId, kind) {
    var o = getObject(lib, objectId);
    if (!o) throw new Error('Нет объекта в библиотеке: ' + objectId);
    return o.variants[size][kind];
  }

  function allSchemes(lib, custom) {
    return lib.palettes.schemes.concat(custom || []);
  }

  function getScheme(lib, id, custom) {
    var list = allSchemes(lib, custom);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }

  /** Размер объекта на холсте. */
  function itemSize(lib, scene, item) {
    var v = variant(lib, scene.size, item.objectId, item.kind);
    return { w: v.w * scene.scale, h: v.h * scene.scale, nw: v.w, nh: v.h };
  }

  /** Габариты (с учётом поворота) — для выделения и раскладки. */
  function itemBounds(lib, scene, item) {
    var s = itemSize(lib, scene, item);
    var a = (item.rotation || 0) * Math.PI / 180;
    var cw = Math.abs(s.w * Math.cos(a)) + Math.abs(s.h * Math.sin(a));
    var ch = Math.abs(s.w * Math.sin(a)) + Math.abs(s.h * Math.cos(a));
    return { x: item.x - cw / 2, y: item.y - ch / 2, w: cw, h: ch };
  }

  function itemTransform(lib, scene, item) {
    var v = variant(lib, scene.size, item.objectId, item.kind);
    var r = item.rotation || 0;
    return 'translate(' + fx(item.x) + ' ' + fx(item.y) + ')' +
      (r ? ' rotate(' + fx(r) + ')' : '') +
      ' scale(' + fx(scene.scale, 5) + ') translate(' + fx(-v.w / 2) + ' ' + fx(-v.h / 2) + ')';
  }

  function fx(n, d) { var p = Math.pow(10, d === undefined ? 2 : d); return String(Math.round(n * p) / p); }

  function layerId(scene, item) {
    var n = 0;
    for (var i = 0; i < scene.items.length; i++) {
      if (scene.items[i].objectId === item.objectId) n++;
      if (scene.items[i] === item) break;
    }
    return item.objectId + (item.kind === 'bg' ? '-bg' : '') + '-' + n;
  }

  function renderItem(lib, scene, item, scheme) {
    var v = variant(lib, scene.size, item.objectId, item.kind);
    var colors = IC.palette.colorsFor(scheme, item.colorShift);
    return '<g id="' + layerId(scene, item) + '" data-uid="' + item.uid + '" data-object="' + item.objectId +
      '" data-kind="' + item.kind + '" transform="' + itemTransform(lib, scene, item) + '">' +
      IC.palette.paint(v.svg, colors) + '</g>';
  }

  function decorMarkup(lib, scene, scheme) {
    if (!scene.decor || scene.decor === 'none') return '';
    var d = null;
    lib.decors.forEach(function (x) { if (x.id === scene.decor) d = x; });
    if (!d) return '';
    var v = d.variants[scene.size];
    var W = scene.format.w, H = scene.format.h;
    var c = Math.max(W / v.w, H / v.h);           // фон «cover», прижат к правому нижнему углу (там «пол»)
    var tx = W - v.w * c, ty = H - v.h * c;
    // декор хранится ролями (@bg2, @bg3 ...) — подставляем цвета активной схемы
    var markup = IC.palette.paint(v.svg, scheme.colors);
    return '<g id="background-decor" transform="translate(' + fx(tx) + ' ' + fx(ty) + ') scale(' + fx(c, 5) + ')">' + markup + '</g>';
  }

  /** Полный SVG композиции. opts.export — чистый файл для скачивания (без служебных атрибутов). */
  function render(lib, scene, opts) {
    opts = opts || {};
    var scheme = getScheme(lib, scene.schemeId, opts.customSchemes);
    var W = scene.format.w, H = scene.format.h;
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" fill="none">');
    parts.push('<defs><clipPath id="canvas-clip"><rect width="' + W + '" height="' + H + '"/></clipPath></defs>');
    parts.push('<g id="composition" clip-path="url(#canvas-clip)">');
    parts.push('<rect id="background" width="' + W + '" height="' + H + '" fill="' + scheme.colors.bg1 + '"/>');
    parts.push(decorMarkup(lib, scene, scheme));
    parts.push('<g id="objects">');
    scene.items.forEach(function (it) { parts.push(renderItem(lib, scene, it, scheme)); });
    parts.push('</g></g></svg>');
    var out = parts.join('');
    if (opts.export) out = out.replace(/ data-(uid|object|kind)="[^"]*"/g, '');
    return out;
  }

  function create(lib, opts) {
    opts = opts || {};
    return {
      format: opts.format || FORMATS[0],
      size: opts.size || 'L',
      schemeId: opts.schemeId || lib.palettes.schemes[0].id,
      decor: opts.decor === undefined ? 'violet' : opts.decor,
      scale: opts.scale || 0.5,
      titleZone: opts.titleZone || null,
      items: []
    };
  }

  function clone(scene) { return JSON.parse(JSON.stringify(scene)); }

  /** Площадь объектов сцены в наборе size (нативные размеры, без scale). */
  function nativeArea(lib, scene, size) {
    var sum = 0;
    for (var i = 0; i < scene.items.length; i++) {
      var it = scene.items[i];
      var v = variant(lib, size, it.objectId, it.kind);
      sum += v.w * v.h;
    }
    return sum;
  }

  /** Коэффициент визуального размера: visual = scale * factor; для L равен 1.
   *  Считается по реальным размерам объектов сцены (S не ровно вдвое меньше L), для пустой сцены - по base. */
  function sizeFactor(lib, scene, size) {
    size = size || scene.size;
    var aL = nativeArea(lib, scene, 'L');
    if (!scene.items.length || !aL) return lib.sizes[size].base / lib.sizes.L.base;
    return Math.sqrt(nativeArea(lib, scene, size) / aL);
  }

  /** Смена набора S<->L: объекты меняются на соответствующую детализацию, визуальный размер сохраняется. */
  function switchSize(lib, scene, size) {
    if (scene.size === size) return scene;
    scene.scale = scene.scale * sizeFactor(lib, scene, scene.size) / sizeFactor(lib, scene, size);
    scene.size = size;
    return scene;
  }

  IC.scene = {
    FORMATS: FORMATS, uid: uid, getObject: getObject, variant: variant, getScheme: getScheme, allSchemes: allSchemes,
    itemSize: itemSize, itemBounds: itemBounds, itemTransform: itemTransform, renderItem: renderItem,
    render: render, create: create, clone: clone, switchSize: switchSize, sizeFactor: sizeFactor, layerId: layerId
  };
})(window.IC = window.IC || {});
