/* Собирает 3 примера композиций в examples/*.svg (и *.png, если есть Chrome).
 * Запуск: node tools/render-examples.js */
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');
var env = require('../tests/load-ic').load(), IC = env.IC, lib = env.lib;
var OUT = path.join(__dirname, '..', 'examples');
var CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function ids(list) { return list.map(function (x) { return { id: x.id }; }); }

var EXAMPLES = [
  {
    file: 'finance-literacy', text: 'финансовая грамотность', mode: 'metaphor',
    format: IC.scene.FORMATS[0], size: 'L', schemeId: 'violet', decor: 'violet', titleZone: null, withBg: false, seed: 11
  },
  {
    file: 'startup-idea', text: 'идея для стартапа', mode: 'metaphor',
    format: IC.scene.FORMATS[1], size: 'L', schemeId: 'peach', decor: 'peach', titleZone: 'left', withBg: true, seed: 8
  },
  {
    file: 'lamp-headphones-phone', text: 'лампа наушники фоновый телефон', mode: 'list',
    format: IC.scene.FORMATS[2], size: 'L', schemeId: 'teal', decor: 'teal', titleZone: null, withBg: true, seed: 5
  }
];

// список «из каталога + запасные фоновые»
function pick(ex) {
  if (ex.mode === 'list') {
    var parsed = IC.semantic.parseList(ex.text, lib);
    var main = parsed.items.filter(function (i) { return i.kind === 'main'; });
    var bg = parsed.items.filter(function (i) { return i.kind === 'bg'; });
    if (ex.withBg && !bg.length) bg = ['puzzle', 'book'].map(function (id) { return { id: id }; });
    return { main: ids(main), bg: ids(bg) };
  }
  var p = IC.semantic.pickForComposition(IC.semantic.analyze(ex.text, lib).ranked, lib);
  return { main: p.main.map(function (id) { return { id: id }; }), bg: ex.withBg ? p.bg.map(function (id) { return { id: id }; }) : [] };
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
var haveChrome = fs.existsSync(CHROME);
if (!haveChrome) console.log('Chrome не найден — PNG пропущены');

EXAMPLES.forEach(function (ex) {
  var sel = pick(ex);
  var res = IC.layout.compose(lib, {
    main: sel.main, bg: sel.bg, format: ex.format, size: ex.size, schemeId: ex.schemeId,
    decor: ex.decor, titleZone: ex.titleZone, seed: ex.seed
  });
  var svg = IC.scene.render(lib, res.scene, { export: true });
  var svgPath = path.join(OUT, ex.file + '.svg');
  fs.writeFileSync(svgPath, svg);
  console.log(ex.file + '.svg  ' + ex.format.w + '×' + ex.format.h + '  main=' + sel.main.map(function (m) { return m.id; }) +
    ' bg=' + sel.bg.map(function (m) { return m.id; }) + '  scale=' + res.scene.scale);

  if (haveChrome) {
    var pngPath = path.join(OUT, ex.file + '.png');
    var url = 'file:///' + svgPath.replace(/\\/g, '/');
    var r = cp.spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--screenshot=' + pngPath, '--window-size=' + ex.format.w + ',' + ex.format.h, url], { timeout: 60000 });
    console.log(fs.existsSync(pngPath) ? '  -> ' + ex.file + '.png' : '  PNG не получился (' + (r.error || r.status) + ')');
  }
});
