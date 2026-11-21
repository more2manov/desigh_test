/* Палитры и перекраска.
 * В библиотеке цвета объектов записаны ролями (fill="@bg1", "@obj2" ...).
 * Перекраска = подстановка цвета роли из выбранной схемы. Геометрия не трогается.
 */
(function (IC) {
  'use strict';

  var ROLES = ['bg1', 'bg2', 'bg3', 'ink', 'obj1', 'obj2', 'obj3', 'paper'];
  var OBJ_ROLES = ['obj1', 'obj2', 'obj3'];
  var HEX = /^#[0-9a-f]{6}$/i;

  function normHex(v) {
    if (!v) return null;
    v = String(v).trim();
    if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v;
    if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    return HEX.test(v) ? v.toUpperCase() : null;
  }

  /** Цвета ролей для конкретного объекта: colorShift циклически сдвигает цвета объекта (obj1..obj3)
   *  внутри той же схемы — так объект «меняет цвета», не нарушая цветовую схему. */
  function colorsFor(scheme, colorShift) {
    var c = Object.assign({}, scheme.colors);
    var k = ((colorShift || 0) % 3 + 3) % 3;
    if (k) {
      OBJ_ROLES.forEach(function (r, i) { c[r] = scheme.colors[OBJ_ROLES[(i + k) % 3]]; });
    }
    return c;
  }

  function paint(markup, colors) {
    return markup.replace(/@(bg1|bg2|bg3|ink|obj1|obj2|obj3|paper)/g, function (_, r) { return colors[r]; });
  }

  /** Разбор пользовательской палитры.
   *  Принимает: JSON схемы ({name, colors:{bg1..paper}}), JSON {bg:[4], obj:[4]},
   *  или просто 6–8 hex-цветов через пробел/запятую/перенос: сначала цвета фона, потом цвета объектов
   *  (как в макете: 3 фона + тёмный, 3 цвета объектов + белый; тёмный и белый можно не указывать). */
  function parseUserPalette(text, name) {
    var data = null;
    try { data = JSON.parse(text); } catch (e) { /* не JSON — разберём как список */ }
    var colors = {};
    if (data && typeof data === 'object') {
      if (data.schemes && data.schemes.length) data = data.schemes[0];
      if (data.colors) {
        ROLES.forEach(function (r) { colors[r] = normHex(data.colors[r]); });
        name = data.name || name;
      } else if (data.bg && data.obj) {
        fill(data.bg.map(normHex), data.obj.map(normHex));
        name = data.name || name;
      }
    } else {
      var list = (String(text).match(/#?[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) || []).map(normHex).filter(Boolean);
      if (list.length === 8) fill(list.slice(0, 4), list.slice(4, 8));
      else if (list.length === 6) fill(list.slice(0, 3), list.slice(3, 6));
      else throw new Error('Нужно 6 или 8 цветов: 3 (или 4) цвета фона, затем 3 (или 4) цвета объектов. Найдено: ' + list.length);
    }
    function fill(bg, obj) {
      colors.bg1 = bg[0]; colors.bg2 = bg[1]; colors.bg3 = bg[2]; colors.ink = bg[3] || '#181817';
      colors.obj1 = obj[0]; colors.obj2 = obj[1]; colors.obj3 = obj[2]; colors.paper = obj[3] || '#FFFFFF';
    }
    var missing = ROLES.filter(function (r) { return !colors[r]; });
    if (missing.length) throw new Error('Не хватает цветов для ролей: ' + missing.join(', '));
    return { id: 'custom-' + Date.now().toString(36), name: name || 'Своя палитра', colors: colors, custom: true };
  }

  function toText(scheme) {
    var c = scheme.colors;
    return [c.bg1, c.bg2, c.bg3, c.ink].join(' ') + '\n' + [c.obj1, c.obj2, c.obj3, c.paper].join(' ');
  }

  IC.palette = { ROLES: ROLES, OBJ_ROLES: OBJ_ROLES, colorsFor: colorsFor, paint: paint, parseUserPalette: parseUserPalette, normHex: normHex, toText: toText };
})(window.IC = window.IC || {});
