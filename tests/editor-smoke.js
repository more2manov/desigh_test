/* Дымовой тест src/editor.js без браузера: node tests/editor-smoke.js
 * DOM заглушён минимально — проверяются модель, история, операции и экспорт (не мышь). */
'use strict';
var vm = require('vm'), fs = require('fs'), path = require('path');
var env = require('./load-ic').load(), IC = env.IC, lib = env.lib;

function FakeEl(tag) { this.tagName = tag; this.attrs = {}; this.style = {}; this.children = []; this.listeners = {}; this.parentNode = null; }
FakeEl.prototype = {
  get firstChild() { return this.children[0] || null; },
  setAttribute: function (k, v) { this.attrs[k] = String(v); },
  getAttribute: function (k) { return k in this.attrs ? this.attrs[k] : null; },
  removeAttribute: function (k) { delete this.attrs[k]; },
  appendChild: function (c) { c.parentNode = this; this.children.push(c); return c; },
  removeChild: function (c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
  querySelector: function (s) { return s.indexOf('svg') === 0 ? this._svg || null : new FakeEl('g'); },
  addEventListener: function (n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); },
  removeEventListener: function () {},
  getScreenCTM: function () { return null; },
  set innerHTML(v) { this._svg = new FakeEl('svg'); this.html = v; },
  get innerHTML() { return this.html; }
};
var keyListeners = [];
var doc = {
  createElement: function (t) { return new FakeEl(t); },
  createElementNS: function (ns, t) { return new FakeEl(t); },
  addEventListener: function (n, f) { if (n === 'keydown') keyListeners.push(f); },
  removeEventListener: function () {},
  activeElement: null, body: {}
};
var container = new FakeEl('div'); container.ownerDocument = doc;

var ctx = vm.createContext({ window: { IC: IC }, console: console, Date: Date, Math: Math, Promise: Promise, JSON: JSON, document: doc });
vm.runInContext(fs.readFileSync(path.join(env.ROOT, 'src', 'editor.js'), 'utf8'), ctx, { filename: 'src/editor.js' });

var passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

var changes = [], sels = [];
var ed = IC.editor.create(container, lib, {
  getCustomSchemes: function () { return []; },
  onChange: function (s, r) { changes.push(r); }, onSelect: function (u) { sels.push(u); }
});
var ids = lib.objects.map(function (o) { return o.id; });
function key(k, extra) { var e = Object.assign({ key: k, code: '', target: { tagName: 'DIV' }, preventDefault: function () { this.pd = true; } }, extra); keyListeners.forEach(function (f) { f(e); }); return e; }

test('addObject добавляет и выделяет', function () {
  var it = ed.addObject(ids[0], 'main');
  assert(it && ed.getScene().items.length === 1 && ed.getSelected().uid === it.uid && sels[sels.length - 1] === it.uid);
  assert(it.x === 500 && it.y === 500);
});
test('второй объект смещается', function () {
  var it = ed.addObject(ids[1], 'main');
  assert(it.x === 530 && it.y === 530, it.x + ',' + it.y);
});
test('addObject с неизвестным id → null', function () { assert(ed.addObject('nope', 'main') === null); });
test('duplicate: +30/+30, над оригиналом, новый uid', function () {
  ed.select(ed.getScene().items[0].uid);
  var orig = ed.getSelected(); ed.duplicate();
  var s = ed.getScene(), c = ed.getSelected();
  assert(c.uid !== orig.uid && c.x === orig.x + 30 && c.y === orig.y + 30 && s.items[1].uid === c.uid && s.items.length === 3);
});
test('слои: raise/lower/toFront/toBack', function () {
  var u = ed.getSelected().uid;
  ed.toFront(); assert(ed.getScene().items[2].uid === u);
  ed.toBack(); assert(ed.getScene().items[0].uid === u);
  ed.raise(); assert(ed.getScene().items[1].uid === u);
  ed.lower(); assert(ed.getScene().items[0].uid === u);
});
test('toggleKind, shiftColors, setRotation, resetRotation', function () {
  var k = ed.getSelected().kind; ed.toggleKind(); assert(ed.getSelected().kind !== k);
  ed.shiftColors(); assert(ed.getSelected().colorShift === 1);
  ed.setRotation(190); assert(ed.getSelected().rotation === -170, String(ed.getSelected().rotation));
  ed.resetRotation(); assert(ed.getSelected().rotation === 0);
});
test('undo/redo возвращают сцену', function () {
  var before = JSON.stringify(ed.getScene());
  ed.nudge(5, 0); ed.nudge(5, 0);
  assert(ed.canUndo());
  ed.undo(); assert(JSON.stringify(ed.getScene()) === before, 'серия nudge — один шаг истории');
  assert(ed.canRedo()); ed.redo(); assert(ed.getSelected().x === 10 + (JSON.parse(before).items[0].x));
});
test('клавиши: стрелки, [ ], Ctrl+Z/Y, Ctrl+D, Delete', function () {
  var x0 = ed.getSelected().x; key('ArrowRight', { shiftKey: true }); assert(ed.getSelected().x === x0 + 10, 'arrow');
  var n = ed.getScene().items.length; var e = key('d', { ctrlKey: true, code: 'KeyD' }); assert(e.pd, 'pd'); assert(ed.getScene().items.length === n + 1, 'dup '+n+' '+ed.getScene().items.length);
  key('z', { ctrlKey: true, code: 'KeyZ' }); assert(ed.getScene().items.length === n);
  key('z', { ctrlKey: true, shiftKey: true, code: 'KeyZ' }); assert(ed.getScene().items.length === n + 1);
  ed.select(ed.getScene().items[0].uid); key('Delete'); assert(ed.getScene().items.length === n && ed.getSelected() === null);
});
test('ввод в input игнорируется', function () {
  ed.select(ed.getScene().items[0].uid); var n = ed.getScene().items.length;
  key('Delete', { target: { tagName: 'INPUT' } }); assert(ed.getScene().items.length === n);
});
test('update и setScene', function () {
  ed.update(function (s) { s.scale = 0.3; s.titleZone = 'left'; }, 'scale');
  assert(ed.getScene().scale === 0.3 && changes[changes.length - 1] === 'scale');
  var s = ed.getScene(); s.items = []; ed.setScene(s, { resetHistory: true });
  assert(!ed.canUndo() && ed.getSelected() === null && sels[sels.length - 1] === null);
});
test('история ограничена 100 шагами', function () {
  ed.addObject(ids[0], 'main');
  for (var i = 0; i < 150; i++) ed.update(function (s) { s.scale = 0.2 + i / 1000; });
  var n = 0; while (ed.undo()) n++; assert(n === 100, 'шагов: ' + n);
});
test('exportSVG чистый: без data-uid/служебных слоёв, у каждого объекта <g id>', function () {
  ed.select(null); ed.setScene(ed.getScene(), { resetHistory: true });
  var s = ed.getScene(); ed.addObject(ids[0], 'main'); ed.addObject(ids[1], 'bg');
  var svg = ed.exportSVG();
  assert(svg.indexOf('data-uid') < 0 && svg.indexOf('ic-overlay') < 0 && svg.indexOf('<image') < 0);
  assert((svg.match(/<g id="[^"]+" transform=/g) || []).length >= 2);
});
test('exportPNG без браузера отклоняется понятной ошибкой', function () {
  var p = ed.exportPNG(1e9);
  return p.then(function () { throw new Error('должно отклониться'); }, function (e) { assert(/Недопустимый размер/.test(e.message)); });
});

test('смена зоны заголовка: раскладка варианта применяется одним шагом, объекты вне зоны, undo возвращает сцену', function () {
  var f = { w: 1200, h: 630 };
  var base = { main: [{ id: 'lamp' }, { id: 'headphones' }, { id: 'phone' }], bg: [], format: f, size: 'L', seed: 11, titleZone: null };
  ed.setScene(IC.layout.variants(lib, base, 6)[0].scene, { resetHistory: true });
  ['left', 'top', null].forEach(function (zone) {
    var before = JSON.stringify(ed.getScene());
    var o = Object.assign({}, base, { titleZone: zone });
    var v = IC.layout.variants(lib, o, 6)[0];
    ed.update(function (s) { var nv = IC.scene.clone(v.scene); s.items = nv.items; s.scale = nv.scale; s.titleZone = nv.titleZone; }, 'titleZone');
    assert(ed.getScene().titleZone === zone);
    if (zone) {
      var z = IC.layout.zones(f.w, f.h, zone).title;
      IC.layout.compose(lib, Object.assign({}, o, { seed: v.seed })).metrics.items.forEach(function (m) {
        var ix = Math.min(m.box[2], z[2]) - Math.max(m.box[0], z[0]), iy = Math.min(m.box[3], z[3]) - Math.max(m.box[1], z[1]);
        assert(!(ix > 0.01 && iy > 0.01), m.objectId + ' в зоне ' + zone);
      });
    }
    ed.undo();
    assert(JSON.stringify(ed.getScene()) === before, 'undo не вернул сцену');
    ed.redo();
  });
});

setTimeout(function () { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); }, 50);
