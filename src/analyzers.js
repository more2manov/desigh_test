/* Анализаторы метафоры: локальный (словарь, src/semantic.js) и LLM (Claude в claude.ai или API по ключу).
 * Выход один и тот же: Result = {source, main, bg, reason, matches, unknown, fallback?, empty?}.
 * analyze() не бросает исключений: при любой проблеме с LLM тихо откатывается на словарь и пишет причину в fallback.
 * Ключ API нигде не логируется и не попадает в Result и сообщения об ошибках.
 */
(function (IC) {
  'use strict';

  var DEFAULT_MODEL = 'claude-haiku-5-5';
  var API_URL = 'https://api.anthropic.com/v1/messages';
  var NO_LLM = 'LLM не настроен: нет ключа API и страница открыта не в claude.ai';
  var LLM_NOTE = ' (LLM недоступен, использован словарь)';

  /** Ошибка с безопасным для показа текстом (без ключа и сырых сообщений). */
  function Fail(msg) { this.safe = msg; }

  function objectsOf(lib) { return (lib && lib.objects) || []; }

  function buildPrompt(text, lib) {
    var list = objectsOf(lib).map(function (o) {
      return o.id + ' — ' + o.name + ' — ' + (o.tags || []).join(', ');
    }).join('\n');
    return 'Задача: подобрать объекты из каталога для иллюстрации к метафоре или заголовку.\n' +
      'Метафора: ' + JSON.stringify(String(text)) + '\n\n' +
      'Каталог объектов (id — название — теги):\n' + list + '\n\n' +
      'Выбери 2–4 главных объекта, лучше всего передающих смысл, и 0–2 фоновых (второстепенных). ' +
      'Фоновые не должны повторять главные. Используй только id из каталога.\n' +
      'Верни ТОЛЬКО JSON без пояснений и без markdown: {"main":["id"],"background":["id"],"reason":"короткое объяснение по-русски"}';
  }

  /** Ответ LLM → {main,bg,reason} или null, если пригодных главных объектов нет. */
  function parseResponse(text, lib) {
    if (typeof text !== 'string') return null;
    var s = text.replace(/```(?:json)?/gi, ' ');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    var obj;
    try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    var valid = {};
    objectsOf(lib).forEach(function (o) { valid[o.id] = 1; });
    var seen = {};
    function clean(arr) {
      var out = [];
      (Array.isArray(arr) ? arr : []).forEach(function (id) {
        if (typeof id === 'string' && valid[id] === 1 && !seen[id]) { seen[id] = 1; out.push(id); }
      });
      return out;
    }
    var main = clean(obj.main).slice(0, 4);
    if (main.length < 1) return null;
    var bg = clean(obj.background !== undefined ? obj.background : obj.bg).slice(0, 2);
    return { main: main, bg: bg, reason: typeof obj.reason === 'string' ? obj.reason.trim() : '' };
  }

  function localAnalyze(text, lib) {
    var a = IC.semantic.analyze(text, lib);
    var res = { source: 'local', main: [], bg: [], reason: '', matches: {}, unknown: a.unknown || [] };
    if (!a.ranked.length) {
      res.empty = true;
      res.reason = 'Совпадений со словарём не найдено';
      return res;
    }
    var pick = IC.semantic.pickForComposition(a.ranked, lib);
    res.main = pick.main.slice();
    res.bg = pick.bg.slice();
    a.ranked.forEach(function (r) { res.matches[r.id] = r.matches.slice(); });
    var names = {};
    objectsOf(lib).forEach(function (o) { names[o.id] = o.name; });
    function nm(id) { return names[id] || id; }
    res.reason = 'Подобрано по словарю: ' + res.main.map(nm).join(', ') +
      (res.bg.length ? '; фон: ' + res.bg.map(nm).join(', ') : '');
    return res;
  }

  function withTimeout(promise, ms, msg) {
    var timer;
    var t = new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Fail(msg)); }, ms); });
    return Promise.race([promise, t]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; });
  }

  /** Через claude.ai: claude.use('sample'). Возвращает текст, null — если sample недоступен. */
  function viaClaude(claude, prompt, ms) {
    var run = (async function () {
      var sample = await claude.use('sample');
      if (typeof sample !== 'function') return null;
      var r = await sample(prompt, { modelTier: 'quick', cache: true });
      return (r && typeof r.text === 'string') ? r.text : (typeof r === 'string' ? r : '');
    })();
    return withTimeout(run, ms, 'таймаут').catch(function (e) {
      if (e instanceof Fail) throw new Fail('Claude недоступен: ' + e.safe);
      throw new Fail('Claude недоступен: ошибка запроса');
    });
  }

  function viaApi(fetchFn, apiKey, model, prompt, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var run = (async function () {
      var resp;
      try {
        resp = await fetchFn(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({ model: model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
          signal: ctl ? ctl.signal : undefined
        });
      } catch (e) { throw new Fail('LLM недоступен: ошибка сети'); }
      if (!resp || !resp.ok) {
        var st = resp && resp.status;
        throw new Fail(st === 401 || st === 403 ? 'LLM: ключ API отклонён (HTTP ' + st + ')' : 'LLM недоступен: ошибка HTTP' + (st ? ' ' + st : ''));
      }
      var json;
      try { json = await resp.json(); } catch (e) { throw new Fail('LLM вернул непонятный ответ'); }
      var parts = (json && Array.isArray(json.content) ? json.content : []);
      return parts.filter(function (p) { return p && p.type === 'text'; }).map(function (p) { return p.text; }).join('');
    })();
    return withTimeout(run, ms, 'LLM недоступен: таймаут').catch(function (e) {
      if (ctl) { try { ctl.abort(); } catch (_) { /* ignore */ } }
      if (e instanceof Fail) throw e;
      throw new Fail('LLM недоступен: ошибка запроса');
    });
  }

  function fallbackLocal(text, lib, why) {
    var res = localAnalyze(text, lib);
    res.fallback = why;
    if (!res.empty) res.reason += LLM_NOTE;
    return res;
  }

  function fromParsed(p, text, lib, source) {
    var res = { source: source, main: p.main, bg: p.bg, reason: p.reason || 'Подобрано LLM', matches: {}, unknown: [] };
    try {
      var loc = IC.semantic.analyze(text, lib);
      p.main.concat(p.bg).forEach(function (id) {
        loc.ranked.forEach(function (r) { if (r.id === id) res.matches[id] = r.matches.slice(); });
      });
    } catch (e) { /* matches — только справочная информация */ }
    return res;
  }

  /** Главная функция. Возвращает Promise<Result>, никогда не reject. */
  function analyze(text, lib, opts) {
    opts = opts || {};
    return (async function () {
      try {
        if (opts.mode !== 'llm') return localAnalyze(text, lib);
        var ms = opts.timeoutMs > 0 ? opts.timeoutMs : 10000;
        var claude = opts.claude !== undefined ? opts.claude : (typeof globalThis !== 'undefined' ? globalThis.claude : undefined);
        var apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
        var model = opts.model || DEFAULT_MODEL;
        var prompt = buildPrompt(text, lib);
        var raw = null, source = null;
        try {
          if (claude && typeof claude.use === 'function') {
            raw = await viaClaude(claude, prompt, ms);
            if (raw !== null) source = 'claude';
          }
          if (raw === null && apiKey) {
            var fetchFn = opts.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
            if (typeof fetchFn !== 'function') throw new Fail('LLM недоступен: fetch не поддерживается');
            raw = await viaApi(fetchFn, apiKey, model, prompt, ms);
            source = 'api';
          }
        } catch (e) {
          return fallbackLocal(text, lib, e instanceof Fail ? e.safe : 'LLM недоступен: ошибка запроса');
        }
        if (raw === null) return fallbackLocal(text, lib, NO_LLM);
        var parsed = parseResponse(raw, lib);
        if (!parsed) return fallbackLocal(text, lib, 'LLM вернул непонятный ответ');
        return fromParsed(parsed, text, lib, source);
      } catch (e) {
        try { return fallbackLocal(text, lib, 'Ошибка анализа'); }
        catch (e2) { return { source: 'local', main: [], bg: [], reason: 'Ошибка анализа', matches: {}, unknown: [], empty: true }; }
      }
    })();
  }

  IC.analyzers = { DEFAULT_MODEL: DEFAULT_MODEL, analyze: analyze, buildPrompt: buildPrompt, parseResponse: parseResponse };
})(window.IC = window.IC || {});
