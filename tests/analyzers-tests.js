/* Тесты src/analyzers.js без сети: node tests/analyzers-tests.js */
'use strict';
var env = require('./load-ic').load(), IC = env.IC, lib = env.lib;
var A = IC.analyzers;

var passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function json(x) { return JSON.stringify(x); }
var queue = [];
function test(name, fn) {
  queue.push(Promise.resolve().then(fn).then(
    function () { passed++; console.log('  ok   ' + name); },
    function (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }));
}

var IDS = lib.objects.map(function (o) { return o.id; });
var KEY = 'sk-ant-SECRET-KEY-123';
var TEXT = 'знания и обучение';
var GOOD = json({ main: [IDS[0], IDS[1]], background: [IDS[2]], reason: 'потому что' });

function okFetch(text, calls) {
  return function (url, init) {
    if (calls) calls.push({ url: url, init: init });
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ content: [{ type: 'text', text: text }] }); } });
  };
}
function llm(extra) { return Object.assign({ mode: 'llm', claude: null, timeoutMs: 500 }, extra); }
function noSecret(r) { assert(json(r).indexOf(KEY) < 0, 'ключ попал в Result'); }
function assertFallback(r, part) {
  assert(r.source === 'local', 'source=' + r.source);
  assert(typeof r.fallback === 'string' && r.fallback.length > 0, 'нет fallback');
  if (part) assert(r.fallback.indexOf(part) >= 0, 'fallback: ' + r.fallback);
  assert(r.reason.indexOf('LLM недоступен') >= 0 || r.empty, 'нет пометки в reason');
  noSecret(r);
}

test('local: форма результата', function () {
  return A.analyze(TEXT, lib, { mode: 'local' }).then(function (r) {
    assert(r.source === 'local' && r.main.length >= 1, 'main пуст');
    assert(Array.isArray(r.bg) && typeof r.reason === 'string' && r.reason, 'reason');
    assert(r.matches && Array.isArray(r.unknown) && !r.fallback, 'matches/unknown/fallback');
    r.main.forEach(function (id) { assert(IDS.indexOf(id) >= 0, 'чужой id'); });
  });
});

test('local: пустой результат -> empty', function () {
  return A.analyze('zzzqqq', lib, { mode: 'local' }).then(function (r) {
    assert(r.empty === true && r.main.length === 0 && r.bg.length === 0, 'должен быть empty');
  });
});

test('claude.use: валидный JSON', function () {
  var got = {};
  var claude = { use: function (n) { got.n = n; return Promise.resolve(function (p, o) { got.p = p; got.o = o; return Promise.resolve({ text: GOOD }); }); } };
  return A.analyze(TEXT, lib, llm({ claude: claude })).then(function (r) {
    assert(got.n === 'sample' && got.o.modelTier === 'quick' && got.o.cache === true, 'вызов sample');
    assert(got.p.indexOf(json(TEXT)) >= 0, 'метафора не в промпте');
    assert(r.source === 'claude' && json(r.main) === json([IDS[0], IDS[1]]) && json(r.bg) === json([IDS[2]]), json(r));
    assert(r.reason === 'потому что' && !r.fallback, 'reason/fallback');
  });
});

test('fetch: заголовки, модель по умолчанию, ключ не в Result', function () {
  var calls = [];
  return A.analyze(TEXT, lib, llm({ apiKey: KEY, fetch: okFetch(GOOD, calls) })).then(function (r) {
    assert(r.source === 'api' && r.main.length === 2, json(r));
    assert(calls.length === 1 && calls[0].url === 'https://api.anthropic.com/v1/messages', 'url');
    var h = calls[0].init.headers, body = JSON.parse(calls[0].init.body);
    assert(calls[0].init.method === 'POST' && h['x-api-key'] === KEY, 'method/key');
    assert(h['anthropic-version'] === '2023-06-01' && h['content-type'] === 'application/json', 'headers');
    assert(h['anthropic-dangerous-direct-browser-access'] === 'true', 'browser-access header');
    assert(body.model === 'claude-haiku-5-5' && A.DEFAULT_MODEL === 'claude-haiku-5-5', 'модель ' + body.model);
    assert(body.max_tokens === 400 && body.messages[0].role === 'user', 'body');
    noSecret(r);
  });
});

test('fetch: своя модель', function () {
  var calls = [];
  return A.analyze(TEXT, lib, llm({ apiKey: KEY, model: 'm-x', fetch: okFetch(GOOD, calls) })).then(function () {
    assert(JSON.parse(calls[0].init.body).model === 'm-x', 'model');
  });
});

test('чужие id: часть валидных -> только валидные', function () {
  var t = json({ main: ['nope', IDS[0], IDS[0], IDS[1]], background: [IDS[1], 'zzz', IDS[3]], reason: 'r' });
  return A.analyze(TEXT, lib, llm({ apiKey: KEY, fetch: okFetch(t) })).then(function (r) {
    assert(r.source === 'api' && json(r.main) === json([IDS[0], IDS[1]]) && json(r.bg) === json([IDS[3]]), json(r));
  });
});

test('чужие id: все чужие -> откат', function () {
  var t = json({ main: ['nope', 'zzz'], background: [], reason: 'r' });
  return A.analyze(TEXT, lib, llm({ apiKey: KEY, fetch: okFetch(t) })).then(function (r) { assertFallback(r); });
});

test('мусор не-JSON -> откат', function () {
  return A.analyze(TEXT, lib, llm({ apiKey: KEY, fetch: okFetch('Извините, не могу помочь') })).then(function (r) { assertFallback(r); });
});

test('fetch reject (сеть) -> откат', function () {
  var f = function () { return Promise.reject(new Error('boom ' + KEY)); };
  return A.analyze(TEXT, lib, llm({ apiKey: KEY, fetch: f })).then(function (r) { assertFallback(r, 'ошибка сети'); });
});

test('HTTP 401 -> откат', function () {
  var f = function () { return Promise.resolve({ ok: false, status: 401, json: function () { return Promise.resolve({}); } }); };
  return A.analyze(TEXT, lib, llm({ apiKey: KEY, fetch: f })).then(function (r) { assertFallback(r, '401'); });
});

test('таймаут fetch -> откат', function () {
  var t0 = Date.now();
  return A.analyze(TEXT, lib, llm({ apiKey: KEY, timeoutMs: 50, fetch: function () { return new Promise(function () {}); } })).then(function (r) {
    assertFallback(r, 'таймаут');
    assert(Date.now() - t0 < 400, 'слишком долго');
  });
});

test('claude.use зависает -> откат по таймауту', function () {
  var claude = { use: function () { return new Promise(function () {}); } };
  return A.analyze(TEXT, lib, llm({ claude: claude, timeoutMs: 50 })).then(function (r) { assertFallback(r, 'Claude недоступен: таймаут'); });
});

test('claude.use -> null, ключа нет -> local с fallback', function () {
  var claude = { use: function () { return Promise.resolve(null); } };
  return A.analyze(TEXT, lib, llm({ claude: claude })).then(function (r) {
    assertFallback(r, 'LLM не настроен');
    assert(r.main.length >= 1, 'local main');
  });
});

test('claude.use -> null, есть ключ -> api', function () {
  var claude = { use: function () { return Promise.resolve(null); } };
  return A.analyze(TEXT, lib, llm({ claude: claude, apiKey: KEY, fetch: okFetch(GOOD) })).then(function (r) {
    assert(r.source === 'api', r.source);
  });
});

test('JSON в ```json обёртке принят', function () {
  var t = 'Вот ответ:\n```json\n' + GOOD + '\n```';
  return A.analyze(TEXT, lib, llm({ apiKey: KEY, fetch: okFetch(t) })).then(function (r) {
    assert(r.source === 'api' && r.main.length === 2, json(r));
  });
});

test('parseResponse: main обрезается до 4, bg до 2', function () {
  var p = A.parseResponse(json({ main: IDS.slice(0, 6), background: IDS.slice(6, 10), reason: '' }), lib);
  assert(p.main.length === 4 && p.bg.length === 2, json(p));
  assert(A.parseResponse('not json', lib) === null && A.parseResponse(null, lib) === null, 'null');
});

test('buildPrompt: все id и метафора в кавычках', function () {
  var p = A.buildPrompt('сказ "про" ключ', lib);
  IDS.forEach(function (id) { assert(p.indexOf(id + ' — ') >= 0, 'нет ' + id); });
  assert(p.indexOf(json('сказ "про" ключ')) >= 0, 'метафора не экранирована');
});

Promise.all(queue).then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
