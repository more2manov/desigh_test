/* Загрузка src/*.js в vm-контекст с заглушкой window (как это делает браузер через <script src>). */
'use strict';
var vm = require('vm'), fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');

function load() {
  var ctx = vm.createContext({ window: {}, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, AbortController: AbortController });
  ['palette', 'scene', 'semantic', 'analyzers', 'layout'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f + '.js'), 'utf8'), ctx, { filename: 'src/' + f + '.js' });
  });
  ctx.window.IC_LIBRARY = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'library.json'), 'utf8'));
  return { IC: ctx.window.IC, lib: ctx.window.IC_LIBRARY, ROOT: ROOT };
}

module.exports = { load: load, ROOT: ROOT };
