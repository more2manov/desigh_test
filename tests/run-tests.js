/* Тесты без зависимостей: node tests/run-tests.js */
'use strict';
var load = require('./load-ic').load;
var env = load(), IC = env.IC, lib = env.lib;

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

var FORMATS = [{ w: 1000, h: 1000 }, { w: 1200, h: 630 }, { w: 1080, h: 1920 }];
var SEEDS = [1, 2, 3, 42, 777];
var SETS = [
  { name: '1 объект', main: ['wallet'], bg: [] },
  { name: '2 объекта + фон', main: ['lamp', 'book'], bg: ['phone'] },
  { name: '3 объекта + фон', main: ['lamp', 'headphones', 'phone'], bg: ['wallet', 'puzzle'] },
  { name: '4 объекта', main: ['coin', 'folder', 'pen', 'flowers'], bg: [] }
];
var IDS = lib.objects.map(function (o) { return o.id; });

/** Прогон fn по всем форматам, размерам, зонам заголовка, наборам и seed. */
function eachCase(fn) {
  FORMATS.forEach(function (f) {
    [null, 'left', 'top'].forEach(function (zone) {
      ['L', 'S'].forEach(function (size) {
        SETS.forEach(function (set) {
          SEEDS.forEach(function (seed) {
            var label = f.w + 'x' + f.h + ' ' + (zone || 'no-title') + ' ' + size + ' ' + set.name + ' seed=' + seed;
            var res = IC.layout.compose(lib, {
              main: set.main.map(function (id) { return { id: id }; }),
              bg: set.bg.map(function (id) { return { id: id }; }),
              format: f, size: size, titleZone: zone, seed: seed
            });
            try { fn(res, label, { zone: zone, f: f }); } catch (e) { throw new Error(label + ': ' + e.message); }
          });
        });
      });
    });
  });
}

console.log('Компоновка');
test('у всех объектов один масштаб', function () {
  eachCase(function (r) {
    assert(typeof r.scene.scale === 'number' && r.scene.scale > 0, 'scale не задан');
    r.scene.items.forEach(function (it) {
      assert(it.scale === undefined, 'у объекта свой scale');
      var t = IC.scene.itemTransform(lib, r.scene, it);
      assert(t.indexOf('scale(' + r.scene.scale + ')') !== -1, 'transform не использует общий scale');
    });
  });
});

test('все объекты из библиотеки', function () {
  eachCase(function (r) {
    assert(r.scene.items.length > 0, 'пустая сцена');
    r.scene.items.forEach(function (it) {
      assert(IDS.indexOf(it.objectId) !== -1, 'нет в библиотеке: ' + it.objectId);
      assert(IC.scene.variant(lib, r.scene.size, it.objectId, it.kind).svg, 'нет варианта');
    });
  });
});

test('главный объект виден >= 95%, остальные главные >= 75%, фон 35-65% на холсте', function () {
  eachCase(function (r) {
    r.metrics.items.forEach(function (m) {
      if (m.kind === 'bg') assert(m.visibility >= 0.35 - 1e-9 && m.visibility <= 0.65 + 1e-9, 'фон ' + m.objectId + ' виден ' + m.visibility.toFixed(2));
      else if (m.uid === r.primaryUid) assert(m.visibility >= 0.95, 'главный ' + m.objectId + ' виден ' + m.visibility.toFixed(2));
      else assert(m.visibility >= 0.75, m.objectId + ' виден ' + m.visibility.toFixed(2));
    });
    assert(same(r.metrics, IC.layout.metrics(lib, r.scene)), 'метрики не воспроизводятся');
  });
});

test('слои: ниже нижний край -> выше слой; фон под главными', function () {
  eachCase(function (r) {
    var seenMain = false, lastBottom = {};
    r.metrics.items.forEach(function (m) {
      if (m.kind === 'main') seenMain = true; else assert(!seenMain, 'фон выше главного');
      if (lastBottom[m.kind] !== undefined) assert(m.box[3] >= lastBottom[m.kind] - 0.02, 'нарушен порядок слоёв');
      lastBottom[m.kind] = m.box[3];
    });
  });
});

test('ни один объект не заходит в зону заголовка (left и top)', function () {
  eachCase(function (r, label, c) {
    if (!c.zone) return;
    var z = IC.layout.zones(c.f.w, c.f.h, c.zone).title;
    r.metrics.items.forEach(function (m) {
      var ix = Math.min(m.box[2], z[2]) - Math.max(m.box[0], z[0]);
      var iy = Math.min(m.box[3], z[3]) - Math.max(m.box[1], z[1]);
      assert(!(ix > 0.01 && iy > 0.01), m.objectId + ' в зоне заголовка');
    });
  });
});

test('главные объекты не наложены сильнее допустимого', function () {
  eachCase(function (r) { assert(r.metrics.maxOverlap <= 0.5, 'наложение ' + r.metrics.maxOverlap.toFixed(2)); });
});

test('тот же seed -> идентичный результат, разные seed -> разные', function () {
  var opts = { main: [{ id: 'lamp' }, { id: 'headphones' }, { id: 'phone' }], bg: [{ id: 'puzzle' }], format: { w: 1200, h: 630 }, titleZone: 'left' };
  var a = IC.layout.compose(lib, Object.assign({ seed: 5 }, opts)), b = IC.layout.compose(lib, Object.assign({ seed: 5 }, opts));
  assert(same(a, b), 'один seed дал разное');
  var c = IC.layout.compose(lib, Object.assign({ seed: 6 }, opts));
  assert(!same(a.scene, c.scene), 'разные seed дали одно и то же');
  FORMATS.forEach(function (f) {
    [['wallet'], ['lamp', 'book', 'coin']].forEach(function (ids) {
      var vs = IC.layout.variants(lib, { main: ids.map(function (id) { return { id: id }; }), format: f, seed: 1 });
      assert(vs.length === 6, 'вариантов не 6');
      var keys = {};
      vs.forEach(function (v) { keys[JSON.stringify(v.scene.items.map(function (i) { return [i.x, i.y]; }))] = 1; });
      assert(Object.keys(keys).length === 6, 'варианты повторяются');
    });
  });
});

test('одна раскладка укладывается в ~200 мс', function () {
  var t = Date.now(), N = 10;
  for (var i = 0; i < N; i++) IC.layout.compose(lib, { main: [{ id: 'lamp' }, { id: 'headphones' }, { id: 'phone' }], bg: [{ id: 'puzzle' }, { id: 'wallet' }], format: { w: 1080, h: 1350 }, seed: i });
  var avg = (Date.now() - t) / N;
  assert(avg < 200, 'в среднем ' + avg.toFixed(0) + ' мс');
});

console.log('Подбор по смыслу');
function ids(list) { return list.map(function (x) { return x.id; }); }
test('«финансовая грамотность» -> кошелёк или монета', function () {
  var a = IC.semantic.analyze('финансовая грамотность', lib);
  var p = IC.semantic.pickForComposition(a.ranked, lib);
  assert(p.main.indexOf('wallet') !== -1 || p.main.indexOf('coin') !== -1, 'получили ' + p.main);
  assert(a.ranked[0].id === 'wallet' || a.ranked[0].id === 'coin', 'первый ' + a.ranked[0].id);
});
test('«идея для стартапа» -> лампа', function () {
  var p = IC.semantic.pickForComposition(IC.semantic.analyze('идея для стартапа', lib).ranked, lib);
  assert(p.main[0] === 'lamp', 'получили ' + p.main);
});
test('«лампа, наушники и телефон» -> ровно эти три', function () {
  var r = IC.semantic.parseList('лампа, наушники и телефон', lib);
  assert(r.unknown.length === 0, 'неизвестные: ' + r.unknown);
  assert(same(ids(r.items).sort(), ['headphones', 'lamp', 'phone']), 'получили ' + ids(r.items));
});

console.log('Рендер');
test('в SVG нет <image>, у каждого объекта свой <g id>, пути совпадают с библиотекой', function () {
  var checked = 0;
  eachCase(function (r) {
    var svg = IC.scene.render(lib, r.scene, { export: true });
    assert(!/<image/i.test(svg) && !/data:image/i.test(svg), 'есть растр');
    var body = svg.slice(svg.indexOf('<g id="objects">'));
    var starts = [], seen = {};
    r.scene.items.forEach(function (it) {
      var id = IC.scene.layerId(r.scene, it);
      assert(!seen[id], 'повтор id ' + id); seen[id] = 1;
      var pos = body.indexOf('<g id="' + id + '"');
      assert(pos !== -1, 'нет <g id="' + id + '">');
      starts.push(pos);
    });
    r.scene.items.forEach(function (it, i) {
      var seg = body.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : body.length);
      var got = (seg.match(/ d="[^"]*"/g) || []);
      var want = (IC.scene.variant(lib, r.scene.size, it.objectId, it.kind).svg.match(/ d="[^"]*"/g) || []);
      assert(want.length > 0 && same(got, want), 'пути ' + it.objectId + ' не совпадают с библиотекой');
      checked++;
    });
  });
  assert(checked > 100, 'проверено мало объектов');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
