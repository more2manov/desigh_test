/* Подбор объектов по смыслу.
 * Сценарий 1 (метафора/заголовок): слова запроса приводятся к основам и сравниваются
 *   с тегами объектов из каталога. Результат — объекты с весами и объяснением «почему».
 * Сценарий 2 (список объектов): «лампа, наушники и фоновый телефон» → точный список.
 * Работает офлайн; LLM-анализ (src/analyzers.js) — дополнительная надстройка с тем же выходом.
 */
(function (IC) {
  'use strict';

  var ENDINGS = ['ностями', 'ностью', 'ностей', 'иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими',
    'ией', 'иях', 'ость', 'ости', 'ия', 'ие', 'ий', 'ой', 'ей', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ов', 'ев',
    'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ую', 'юю', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й', 's'];
  var STOP = ['и', 'в', 'во', 'на', 'с', 'со', 'для', 'по', 'к', 'ко', 'от', 'из', 'за', 'о', 'об', 'про', 'как', 'что',
    'это', 'наш', 'ваш', 'мой', 'твой', 'все', 'всё', 'или', 'а', 'но', 'не', 'без', 'при', 'до', 'же', 'the', 'a', 'of', 'and', 'for', 'to', 'in'];
  var BG_MARKERS = ['фоновый', 'фоновая', 'фоновое', 'фоновые', 'фон', 'фоном', 'монохромный', 'монохромная', 'bg', 'background'];

  function stem(word) {
    var w = String(word).toLowerCase().replace(/ё/g, 'е');
    for (var i = 0; i < ENDINGS.length; i++) {
      var e = ENDINGS[i];
      if (w.length - e.length >= 3 && w.slice(-e.length) === e) return w.slice(0, -e.length);
    }
    return w;
  }

  function tokens(text) {
    return (String(text).toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]+/g) || [])
      .filter(function (t) { return STOP.indexOf(t) === -1 && t.length > 1; });
  }

  function same(a, b) {
    if (a === b) return true;
    var n = Math.min(a.length, b.length);
    return n >= 5 && a.slice(0, n) === b.slice(0, n);
  }

  var cache = null;
  function index(lib) {
    if (cache && cache.lib === lib) return cache.idx;
    var idx = lib.objects.map(function (o) {
      return {
        id: o.id, name: o.name,
        aliases: o.aliases.map(function (a) { return { word: a, s: stem(a) }; }),
        tags: o.tags.map(function (t) { return { word: t, s: stem(t) }; })
      };
    });
    cache = { lib: lib, idx: idx };
    return idx;
  }

  /** Сценарий 1. Возвращает {ranked:[{id,name,score,matches:[слово→тег]}], unknown:[слова без совпадений]} */
  function analyze(text, lib) {
    var idx = index(lib);
    var toks = tokens(text);
    var used = {};
    var ranked = idx.map(function (o) {
      var score = 0, matches = [];
      toks.forEach(function (t) {
        var s = stem(t), best = 0, why = null;
        o.aliases.forEach(function (a) { if (same(s, a.s) && best < 3) { best = 3; why = a.word; } });
        o.tags.forEach(function (g) { if (same(s, g.s) && best < 1) { best = 1; why = g.word; } });
        if (best) { score += best; matches.push(t + ' → ' + why); used[t] = 1; }
      });
      return { id: o.id, name: o.name, score: score, matches: matches };
    }).filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; });
    return { ranked: ranked, unknown: toks.filter(function (t) { return !used[t]; }) };
  }

  /** Сценарий 2. «лампа наушники, фоновый телефон» → [{id,kind,word}]. Разбор по словам: каждое слово-алиас — объект;
   *  маркер фона и число относятся к ближайшему следующему объекту; нераспознанные слова — в unknown. */
  function parseList(text, lib) {
    var idx = index(lib);
    var words = (String(text).toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]+/g) || [])
      .filter(function (t) { return STOP.indexOf(t) === -1; });
    var items = [], unknown = [], bg = false, count = 1;
    words.forEach(function (w) {
      if (BG_MARKERS.indexOf(w) !== -1) { bg = true; return; }
      if (/^[0-9]+$/.test(w)) { count = Math.min(6, Math.max(1, +w)); return; }
      if (w === 'шт' || w === 'x' || w === 'х' || w.length < 2) return;
      var st = stem(w), found = null;
      idx.forEach(function (o) { if (!found && o.aliases.some(function (al) { return same(st, al.s); })) found = o.id; });
      if (!found) { // запасной путь — только для слова, не совпавшего ни с одним алиасом: тег одного объекта
        var an = analyze(w, lib).ranked;
        if (an.length && (an.length === 1 || an[0].score > an[1].score)) found = an[0].id;
      }
      if (!found) { unknown.push(w); return; }
      for (var i = 0; i < count; i++) items.push({ id: found, kind: bg ? 'bg' : 'main', word: w });
      bg = false; count = 1;
    });
    return { items: items, unknown: unknown };
  }

  /** Из ранжированного списка — набор для композиции: 2–4 главных, следующие 1–2 — кандидаты в фон. */
  function pickForComposition(ranked, lib, opts) {
    opts = opts || {};
    var maxMain = opts.maxMain || 3;
    var ids = ranked.map(function (r) { return r.id; });
    var top = ranked.length ? ranked[0].score : 0;
    var main = ids.filter(function (id, i) { return i < maxMain && (i === 0 || ranked[i].score >= Math.max(1, top * 0.34)); });
    if (main.length < 2) { // мало прямых ассоциаций — добавляем «соседей» по общим тегам
      var rel = related(main[0], lib).filter(function (id) { return main.indexOf(id) === -1; });
      while (main.length < 2 && rel.length) main.push(rel.shift());
    }
    var rest = ids.filter(function (id) { return main.indexOf(id) === -1; });
    var bg = rest.slice(0, 2);
    if (!bg.length && main[0]) bg = related(main[0], lib).filter(function (id) { return main.indexOf(id) === -1; }).slice(0, 2);
    return { main: main, bg: bg };
  }

  /** Объекты с общими тегами (для дополнения сцены, когда запрос даёт один объект). */
  function related(id, lib) {
    var idx = index(lib), me = null;
    idx.forEach(function (o) { if (o.id === id) me = o; });
    if (!me) return lib.objects.map(function (o) { return o.id; });
    return idx.filter(function (o) { return o.id !== id; }).map(function (o) {
      var n = 0;
      o.tags.forEach(function (t) { me.tags.forEach(function (m) { if (same(t.s, m.s)) n++; }); });
      return { id: o.id, n: n };
    }).sort(function (a, b) { return b.n - a.n; }).map(function (x) { return x.id; });
  }

  IC.semantic = { stem: stem, tokens: tokens, analyze: analyze, parseList: parseList, pickForComposition: pickForComposition, related: related };
})(window.IC = window.IC || {});
