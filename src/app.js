/* Интерфейс конструктора иллюстраций: сборка, варианты, свойства, библиотека, палитры, экспорт.
 * Работает поверх IC.editor (контракт: docs/INTERFACE.md). Все сообщения — через IC.app.notify, без alert/confirm/prompt. */
(function (IC) {
  'use strict';

  var lib = window.IC_LIBRARY;
  var FORMATS = IC.scene.FORMATS;
  var STORE_KEY = 'ic.customSchemes';
  var KEY_STORE = 'ic.apiKey';
  var AN_STORE = 'ic.analysis';
  var FALLBACK_MODEL = 'claude-haiku-5-5';
  var VARIANT_COUNT = 6;
  var SEED_STEP = VARIANT_COUNT * 7919 + 101;
  var ROLES = IC.palette.ROLES;
  var DECORS = ['violet', 'peach', 'teal', 'none'];

  var EXAMPLES = {
    metaphor: ['финансовая грамотность', 'идея для стартапа', 'обучение и знания', 'онлайн-работа', 'креатив и вдохновение'],
    list: ['лампа, наушники и телефон', 'книга, ручка, фоновые цветы', 'кошелёк, монета и папка', '3 пазла']
  };

  var state = {
    mode: 'metaphor',
    texts: { metaphor: 'финансовая грамотность', list: 'лампа, наушники и телефон' },
    formatId: 'square',
    size: 'L',
    schemeId: 'violet',
    decor: 'violet',
    withBg: false,
    zone: null,
    libKind: 'main',
    seed: 11,
    variants: [],
    active: -1,
    last: null,
    custom: [],
    analysis: { mode: 'local', model: '' } // ключ API сюда не кладётся: он живёт только в поле ввода
  };
  var reqId = 0;
  var ed = null;
  var fmtKey = '';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function errText(e) { return (e && e.message) ? e.message : String(e || 'неизвестная ошибка'); }
  function objName(id) { var o = IC.scene.getObject(lib, id); return o ? o.name : id; }
  function raf(fn) { return (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(fn); }

  /* ---------- сообщения ---------- */

  function notify(text, type, action) {
    var box = $('toasts');
    var t = el('div', 'toast toast--' + (type || 'info'));
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    t.appendChild(el('span', 'toast__text', text));
    var close = function () { if (t.parentNode) t.parentNode.removeChild(t); };
    if (action && action.fn) {
      var b = el('button', 'toast__btn', action.label);
      b.type = 'button';
      b.addEventListener('click', function () { close(); action.fn(); });
      t.appendChild(b);
    }
    var x = el('button', 'toast__close', '×');
    x.type = 'button'; x.setAttribute('aria-label', 'Закрыть сообщение');
    x.addEventListener('click', close);
    t.appendChild(x);
    box.appendChild(t);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(close, type === 'error' || action ? 10000 : 4500);
  }

  /* ---------- свои палитры ---------- */

  function validScheme(s) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.colors || typeof s.colors !== 'object') return false;
    return ROLES.every(function (r) { return IC.palette.normHex(s.colors[r]); });
  }
  function cleanScheme(s) {
    var colors = {};
    ROLES.forEach(function (r) { colors[r] = IC.palette.normHex(s.colors[r]); });
    return { id: String(s.id), name: String(s.name || 'Своя палитра').slice(0, 40), colors: colors, custom: true };
  }
  function loadCustom() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(validScheme).map(cleanScheme) : [];
    } catch (e) { return []; }
  }
  function saveCustom() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.custom)); }
    catch (e) { notify('Свои палитры не удалось сохранить в браузере: они пропадут после закрытия страницы.', 'warn'); }
  }
  function allSchemes() { return IC.scene.allSchemes(lib, state.custom); }
  function hasScheme(id) { return allSchemes().some(function (s) { return s.id === id; }); }

  /* ---------- переключатели ---------- */

  function setSeg(box, attr, value) {
    var btns = box.querySelectorAll('button');
    Array.prototype.forEach.call(btns, function (b) {
      var on = String(b.getAttribute('data-' + attr)) === String(value === null ? '' : value);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
  }
  function initSeg(box, attr, onPick) {
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !box.contains(b)) return;
      onPick(b.getAttribute('data-' + attr));
    });
    box.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var btns = Array.prototype.slice.call(box.querySelectorAll('button'));
      var i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      var step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
      var nb = btns[(i + step + btns.length) % btns.length];
      nb.focus(); nb.click();
    });
  }

  /* ---------- холст ---------- */

  function fitCanvas() {
    if (!ed) return;
    var s = ed.getScene();
    var wrap = $('canvas-wrap');
    var cs = window.getComputedStyle(wrap);
    var pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    var avail = Math.max(200, wrap.clientWidth - pad - 2);
    var maxH = 100000;
    if ((window.innerWidth || 1200) >= 1000) {
      // высота холста: окно минус шапка, заголовки и полоса вариантов (замер реальной вёрстки)
      var col = document.querySelector('.col--center');
      var cr = col.getBoundingClientRect();
      var overhead = cr.height - $('canvas').getBoundingClientRect().height + cr.top + (window.pageYOffset || 0) + 12;
      maxH = Math.max(240, (window.innerHeight || 800) - overhead);
    }
    var w = Math.min(avail, maxH * s.format.w / s.format.h);
    $('canvas').style.width = Math.round(w) + 'px';
  }

  function updateUndo() {
    if (!ed) return;
    $('btn-undo').disabled = !ed.canUndo();
    $('btn-redo').disabled = !ed.canRedo();
  }

  /* ---------- сборка: подбор объектов ---------- */

  var SPLIT = /[,;\n]+|\s+и\s+|\s+\+\s+/i;

  function relatedExtra(mainIds, usedIds, n) {
    if (!mainIds.length) return [];
    return IC.semantic.related(mainIds[0], lib).filter(function (id) { return usedIds.indexOf(id) === -1; }).slice(0, n);
  }

  function scrubKey(str) {
    str = String(str === undefined || str === null ? '' : str);
    var k = $('an-key') ? $('an-key').value.trim() : '';
    return k.length > 3 ? str.split(k).join('***') : str;
  }
  function currentModel() {
    var m = $('an-model').value.trim();
    return m || (IC.analyzers && IC.analyzers.DEFAULT_MODEL) || FALLBACK_MODEL;
  }

  function entriesFromIds(main, bg, matchesOf) {
    var entries = [];
    main.forEach(function (id) { entries.push({ id: id, kind: 'main', matches: matchesOf(id) }); });
    bg.forEach(function (id) { entries.push({ id: id, kind: 'bg', matches: matchesOf(id) }); });
    return entries;
  }

  /** Метафора через словарь (синхронно, без сети): {main,bg,entries,unknown} или {empty:true,unknown}. */
  function selectMetaphorDict(text) {
    var a = IC.semantic.analyze(text, lib);
    if (!a.ranked.length) return { empty: true, unknown: a.unknown, source: 'local' };
    var p = IC.semantic.pickForComposition(a.ranked, lib);
    var byId = {};
    a.ranked.forEach(function (r) { byId[r.id] = r; });
    var bgIds = state.withBg ? p.bg : [];
    return {
      main: p.main.map(function (id) { return { id: id }; }),
      bg: bgIds.map(function (id) { return { id: id }; }),
      entries: entriesFromIds(p.main, bgIds, function (id) { return byId[id] ? byId[id].matches : []; }),
      unknown: a.unknown, source: 'local'
    };
  }

  /** Метафора через IC.analyzers (словарь или LLM). Никогда не отклоняется. */
  async function selectMetaphorAsync(text, mode) {
    var model = currentModel();
    var r;
    try {
      r = await IC.analyzers.analyze(text, lib, { mode: mode, apiKey: $('an-key').value.trim(), model: model });
    } catch (e) {
      r = { source: 'local', fallback: scrubKey(errText(e)), main: [], bg: [], empty: true, unknown: [], matches: {} };
    }
    r = r || {};
    var info = { source: r.source || 'local', model: model, reason: scrubKey(r.reason || ''), fallback: r.fallback ? scrubKey(r.fallback) : '' };
    var mainIds = Array.isArray(r.main) ? r.main : [];
    var bgIds = state.withBg && Array.isArray(r.bg) ? r.bg : [];
    var unknown = Array.isArray(r.unknown) ? r.unknown : [];
    if (r.empty || !mainIds.length) return Object.assign({ empty: true, unknown: unknown }, info);
    var matches = r.matches || {};
    return Object.assign({
      main: mainIds.map(function (id) { return { id: id }; }),
      bg: bgIds.map(function (id) { return { id: id }; }),
      entries: entriesFromIds(mainIds, bgIds, function (id) { return Array.isArray(matches[id]) ? matches[id] : []; }),
      unknown: unknown
    }, info);
  }

  /** Подбор объектов (синхронно): {main,bg,entries,unknown} или {empty:true,unknown}. Метафора — через словарь. */
  function selectObjects(text) {
    if (state.mode === 'metaphor') return selectMetaphorDict(text);
    var entries = [], unknown = [], main = [], bg = [];
    var parts = String(text).split(SPLIT).map(function (s) { return s.trim(); }).filter(Boolean);
    parts.forEach(function (part) {
      var r = IC.semantic.parseList(part, lib);
      if (!r.items.length) { unknown.push(part); return; }
      var first = r.items[0];
      entries.push({ id: first.id, kind: first.kind, count: r.items.length, word: part });
      r.items.forEach(function (it) { (it.kind === 'bg' ? bg : main).push({ id: it.id }); });
    });
    if (!main.length && !bg.length) return { empty: true, unknown: unknown };
    if (state.withBg && !bg.length) {
      var used = main.map(function (m) { return m.id; });
      relatedExtra(used, used, 2).forEach(function (id) {
        bg.push({ id: id }); entries.push({ id: id, kind: 'bg', count: 1, extra: true });
      });
    }
    return { main: main, bg: bg, entries: entries, unknown: unknown };
  }

  /* ---------- подсказка и объяснение ---------- */

  function insertIntoText(str) {
    var ta = $('build-text');
    var cur = ta.value.replace(/[\s,;]+$/, '');
    ta.value = cur ? cur + ', ' + str : str;
    state.texts[state.mode] = ta.value;
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* не критично */ }
  }

  function renderHint(box) {
    var hint = el('div', 'hint');
    hint.id = 'explain-hint';
    hint.appendChild(el('p', 'title', 'Примеры запросов — нажмите, чтобы подставить'));
    var ex = el('div', 'chips chips--hint');
    ex.id = 'explain-examples';
    EXAMPLES[state.mode].forEach(function (t) {
      var c = el('button', 'chip chip--ex', t);
      c.type = 'button';
      c.addEventListener('click', function () {
        var ta = $('build-text');
        ta.value = t; state.texts[state.mode] = t; ta.focus();
      });
      ex.appendChild(c);
    });
    hint.appendChild(ex);
    hint.appendChild(el('p', 'title', 'Доступные объекты — нажмите, чтобы добавить в поле'));
    var ob = el('div', 'chips chips--hint');
    ob.id = 'explain-objects';
    lib.objects.forEach(function (o) {
      var c = el('button', 'chip chip--obj', o.name.toLowerCase());
      c.type = 'button';
      c.setAttribute('data-object-id', o.id);
      c.title = 'Добавить «' + o.name.toLowerCase() + '» в поле ввода';
      c.addEventListener('click', function () { insertIntoText(o.name.toLowerCase()); });
      ob.appendChild(c);
    });
    hint.appendChild(ob);
    box.appendChild(hint);
  }

  function sourceLine(res) {
    if (state.mode !== 'metaphor' || !res.source) return null;
    var text, warn = false;
    if (res.fallback) { text = res.fallback + ' — использован словарь'; warn = true; }
    else if (res.source === 'claude') text = 'Источник: Claude (claude.ai)';
    else if (res.source === 'api') text = 'Источник: Anthropic API (' + (res.model || currentModel()) + ')';
    else text = 'Источник: словарь';
    return el('p', 'source' + (warn ? ' is-warn' : ''), text);
  }

  function renderExplain(res) {
    var box = $('explain');
    box.textContent = '';
    if (!res) return;
    if (res.empty) {
      var msg;
      if (res.noText) msg = state.mode === 'metaphor' ? 'Поле пустое: введите тему или метафору.' : 'Поле пустое: перечислите объекты через запятую.';
      else msg = state.mode === 'metaphor'
        ? 'Ничего не найдено: ни одно слово не связано с объектами библиотеки. Попробуйте другие слова или вкладку «По объектам».'
        : 'Ничего не найдено: не удалось распознать ни один объект. Перечислите объекты через запятую.';
      box.appendChild(el('p', 'error', msg));
      if (res.reason && res.source && res.source !== 'local') box.appendChild(el('p', 'note', res.reason));
      if (res.unknown && res.unknown.length) {
        box.appendChild(el('p', 'note', 'Не распознано: ' + res.unknown.join(', ') + '.'));
      }
      var sl0 = sourceLine(res);
      if (sl0) box.appendChild(sl0);
      renderHint(box);
      return;
    }
    box.appendChild(el('p', 'title', 'Как подобраны объекты'));
    if (res.reason && res.source && res.source !== 'local') box.appendChild(el('p', 'why', res.reason));
    var ul = el('ul');
    res.entries.forEach(function (en) {
      var li = el('li');
      var head = el('div');
      if (en.word) head.appendChild(document.createTextNode('«' + en.word + '» → '));
      head.appendChild(el('strong', null, objName(en.id)));
      head.appendChild(el('span', 'tag', en.kind === 'bg' ? 'фоновый' : 'главный'));
      if (en.count > 1) head.appendChild(el('span', 'tag', '×' + en.count));
      li.appendChild(head);
      var why = '';
      if (en.matches && en.matches.length) why = en.matches.join('; ');
      else if (en.extra || state.mode === 'metaphor') why = 'добавлен как близкий по смыслу';
      if (why) li.appendChild(el('span', 'why', why));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    if (res.unknown && res.unknown.length) {
      box.appendChild(el('p', 'note', 'Не распознаны: ' + res.unknown.join(', ') + ' — эти слова подбор не учитывал.'));
    }
    var sl = sourceLine(res);
    if (sl) box.appendChild(sl);
  }

  function layoutOpts(sel) {
    var f = FORMATS.filter(function (x) { return x.id === state.formatId; })[0] || FORMATS[0];
    return {
      main: sel.main, bg: sel.bg, format: f, size: state.size, schemeId: state.schemeId,
      decor: state.decor, titleZone: state.zone, seed: state.seed
    };
  }

  function computeVariants() {
    state.variants = IC.layout.variants(lib, layoutOpts(state.last), VARIANT_COUNT);
    state.active = -1;
    renderStrip();
  }

  function sceneFromVariant(v) {
    var sc = IC.scene.clone(v.scene);
    sc.schemeId = state.schemeId;
    sc.decor = state.decor;
    return sc;
  }

  function setBusy(on) {
    var b = $('btn-build');
    b.disabled = on;
    b.textContent = on ? 'Анализ…' : 'Собрать';
    b.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function applyBuild(res, initial) {
    renderExplain(res);
    if (res.empty) { notify('Ничего не найдено — подробности под кнопкой «Собрать».', 'warn'); return; }
    state.last = { main: res.main, bg: res.bg };
    state.seed = initial ? 11 : Math.floor(Math.random() * 900000) + 1;
    try {
      computeVariants();
      var sc = sceneFromVariant(state.variants[0]);
      ed.setScene(sc, initial ? { resetHistory: true } : undefined);
      state.active = 0;
      renderStrip();
      syncFromScene(ed.getScene());
      ed.select(null);
    } catch (e) {
      notify('Не удалось собрать композицию: ' + errText(e), 'error');
    }
  }

  function doBuild(initial) {
    var text = $('build-text').value.trim();
    state.texts[state.mode] = $('build-text').value;
    var my = ++reqId;
    setBusy(false);
    if (!text) {
      renderExplain({ empty: true, noText: true, unknown: [] });
      notify('Введите тему или список объектов.', 'warn');
      return;
    }
    // стартовая композиция и вкладка «По объектам» — только синхронный словарь, без сети
    if (initial || state.mode !== 'metaphor' || !IC.analyzers || typeof IC.analyzers.analyze !== 'function') {
      applyBuild(selectObjects(text), initial);
      return;
    }
    setBusy(true);
    selectMetaphorAsync(text, state.analysis.mode).then(function (res) {
      if (my !== reqId) return; // устаревший запрос
      setBusy(false);
      applyBuild(res, false);
    }, function (e) {
      if (my !== reqId) return;
      setBusy(false);
      notify('Не удалось выполнить анализ: ' + scrubKey(errText(e)), 'error');
    });
  }

  function moreVariants() {
    if (!state.last) { notify('Сначала нажмите «Собрать».', 'info'); return; }
    state.seed += SEED_STEP;
    try { computeVariants(); }
    catch (e) { notify('Не удалось собрать варианты: ' + errText(e), 'error'); }
  }

  /* ---------- полоса вариантов ---------- */

  function previewMarkup(scene, n) {
    var sc = Object.assign({}, scene, { schemeId: state.schemeId, decor: state.decor });
    var svg = IC.scene.render(lib, sc, { customSchemes: state.custom });
    return svg.replace(/canvas-clip/g, 'pv' + n + '-clip');
  }

  function renderStrip() {
    var strip = $('strip');
    strip.textContent = '';
    $('strip-empty').hidden = state.variants.length > 0;
    state.variants.forEach(function (v, i) {
      var b = el('button', 'variant');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-label', 'Вариант ' + (i + 1));
      b.setAttribute('aria-selected', i === state.active ? 'true' : 'false');
      b.title = 'Вариант ' + (i + 1);
      b.innerHTML = previewMarkup(v.scene, i);
      b.addEventListener('click', function () {
        state.active = i;
        try { ed.setScene(sceneFromVariant(v)); ed.select(null); syncFromScene(ed.getScene()); }
        catch (e) { notify('Не удалось применить вариант: ' + errText(e), 'error'); }
        Array.prototype.forEach.call(strip.children, function (c, k) { c.setAttribute('aria-selected', k === i ? 'true' : 'false'); });
      });
      strip.appendChild(b);
    });
    fitCanvas();
  }

  /* ---------- схемы ---------- */

  function renderSchemeList(box, withDelete) {
    box.textContent = '';
    allSchemes().forEach(function (s) {
      var row = el('div', 'scheme');
      var b = el('button', 'scheme__btn');
      b.type = 'button';
      b.setAttribute('aria-pressed', s.id === state.schemeId ? 'true' : 'false');
      b.setAttribute('aria-label', 'Схема: ' + s.name);
      b.title = s.name;
      var dots = el('span', 'scheme__dots');
      ['bg1', 'bg2', 'bg3', 'obj1', 'obj2', 'obj3'].forEach(function (r) {
        var i = el('i'); i.style.background = s.colors[r]; dots.appendChild(i);
      });
      b.appendChild(dots);
      b.appendChild(el('span', 'scheme__name', s.name));
      b.addEventListener('click', function () { setScheme(s.id); });
      row.appendChild(b);
      if (withDelete && s.custom) {
        var d = el('button', 'scheme__del', '×');
        d.type = 'button';
        d.setAttribute('aria-label', 'Удалить палитру «' + s.name + '»');
        d.title = 'Удалить палитру';
        d.addEventListener('click', function () { deleteScheme(s.id); });
        row.appendChild(d);
      }
      box.appendChild(row);
    });
  }

  function renderSchemes() {
    renderSchemeList($('schemes'), true);
  }

  /** Состояние схемы изменилось (из любого источника) — перерисовать зависящие части интерфейса. */
  function applySchemeState(id) {
    state.schemeId = id;
    renderSchemes();
    renderLib();
    renderStrip();
  }

  function setScheme(id) {
    if (!hasScheme(id)) return;
    applySchemeState(id);
    ed.update(function (s) { s.schemeId = id; }, 'scheme');
  }

  function deleteScheme(id) {
    var s = allSchemes().filter(function (x) { return x.id === id; })[0];
    if (!s || !s.custom) return;
    state.custom = state.custom.filter(function (x) { return x.id !== id; });
    saveCustom();
    if (state.schemeId === id) {
      state.schemeId = lib.palettes.schemes[0].id;
      ed.update(function (sc) { sc.schemeId = state.schemeId; }, 'scheme');
    } else {
      ed.refresh();
    }
    applySchemeState(state.schemeId);
    notify('Палитра «' + s.name + '» удалена.', 'info');
  }

  function showPalMsg(text, ok) {
    var m = $('pal-msg');
    m.hidden = !text;
    m.textContent = text || '';
    m.className = 'form-msg ' + (ok ? 'is-ok' : 'is-error');
  }

  function addPalette(text) {
    var s;
    try { s = IC.palette.parseUserPalette(text, $('pal-name').value.trim() || undefined); }
    catch (e) { showPalMsg('Не удалось разобрать палитру: ' + errText(e), false); return; }
    if (!validScheme(s)) { showPalMsg('Палитра содержит некорректные цвета.', false); return; }
    s = cleanScheme(s);
    state.custom.push(s);
    saveCustom();
    showPalMsg('Палитра «' + s.name + '» добавлена и применена.', true);
    $('pal-name').value = '';
    setScheme(s.id);
  }

  /* ---------- библиотека ---------- */

  function renderLib() {
    var box = $('lib');
    box.textContent = '';
    var scheme = IC.scene.getScheme(lib, state.schemeId, state.custom);
    var colors = IC.palette.colorsFor(scheme, 0);
    lib.objects.forEach(function (o) {
      var v = o.variants.L[state.libKind];
      var b = el('button', 'lib-item');
      b.type = 'button';
      b.setAttribute('aria-label', 'Добавить на холст: ' + o.name + (state.libKind === 'bg' ? ' (фоновый)' : ' (главный)'));
      b.title = o.name;
      b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + v.w + ' ' + v.h + '" fill="none" aria-hidden="true">' +
        IC.palette.paint(v.svg, colors) + '</svg>';
      b.appendChild(el('span', null, o.name));
      b.addEventListener('click', function () {
        try { ed.addObject(o.id, state.libKind); } catch (e) { notify('Не удалось добавить объект: ' + errText(e), 'error'); }
      });
      box.appendChild(b);
    });
  }

  /* ---------- панель выбранного объекта ---------- */

  function updateProps() {
    if (!ed) return;
    var it = ed.getSelected();
    $('props-empty').hidden = !!it;
    $('props-body').hidden = !it;
    if (!it) return;
    $('props-name').textContent = objName(it.objectId) + ' · ' + (it.kind === 'bg' ? 'фоновый' : 'главный');
    var rot = Math.round(it.rotation || 0);
    if (document.activeElement !== $('rot-range')) $('rot-range').value = rot;
    if (document.activeElement !== $('rot-num')) $('rot-num').value = rot;
  }

  function bindProp(id, method) {
    $(id).addEventListener('click', function () { ed[method](); updateProps(); updateUndo(); });
  }

  /* ---------- синхронизация интерфейса со сценой ---------- */

  function sizePct(scene) {
    return Math.round(scene.scale * IC.scene.sizeFactor(lib, scene) * 100);
  }

  function syncFromScene(scene) {
    var f = FORMATS.filter(function (x) { return x.id === scene.format.id; })[0] ||
      FORMATS.filter(function (x) { return x.w === scene.format.w && x.h === scene.format.h; })[0];
    if (f) { state.formatId = f.id; $('sel-format').value = f.id; }
    state.size = scene.size; setSeg($('seg-size'), 'size', scene.size);
    state.decor = scene.decor || 'none'; setSeg($('seg-decor'), 'decor', state.decor);
    state.zone = scene.titleZone || null; setSeg($('seg-zone'), 'zone', state.zone);
    if (scene.schemeId !== state.schemeId && hasScheme(scene.schemeId)) applySchemeState(scene.schemeId);
    var pct = sizePct(scene);
    $('scale-out').textContent = pct + '%';
    if (document.activeElement !== $('scale-range')) $('scale-range').value = Math.min(300, Math.max(20, pct));
    var key = scene.format.w + 'x' + scene.format.h;
    if (key !== fmtKey) { fmtKey = key; fitCanvas(); }
  }

  function onChange(scene) {
    if (!ed) return;
    syncFromScene(scene);
    updateUndo();
    updateProps();
  }

  /* ---------- экспорт ---------- */

  function fileBase() { return 'illustration-' + state.formatId; }

  async function saveFile(filename, data, mime) {
    if (window.claude && typeof window.claude.use === 'function') {
      try {
        var downloads = await window.claude.use('downloads');
        await downloads.save({ filename: filename, data: data });
        notify('Файл сохранён: ' + filename, 'success');
        return true;
      } catch (e) {
        notify('Не удалось сохранить файл: ' + errText(e) + '. Скопируйте SVG в буфер обмена и вставьте в редактор.', 'error',
          { label: 'Копировать SVG', fn: copySVG });
        return false;
      }
    }
    try {
      var blob = (data instanceof Blob) ? data : new Blob([data], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
      notify('Файл «' + filename + '» отправлен в загрузки.', 'success');
      return true;
    } catch (e) {
      notify('Не удалось скачать файл: ' + errText(e) + '. Можно скопировать SVG в буфер обмена.', 'error',
        { label: 'Копировать SVG', fn: copySVG });
      return false;
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  async function copySVG() {
    var svg;
    try { svg = ed.exportSVG(); } catch (e) { notify('Не удалось подготовить SVG: ' + errText(e), 'error'); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(svg);
        notify('SVG скопирован в буфер обмена.', 'success');
        return;
      }
    } catch (e) { /* пробуем запасной способ */ }
    if (fallbackCopy(svg)) notify('SVG скопирован в буфер обмена.', 'success');
    else notify('Не удалось скопировать SVG: браузер запретил доступ к буферу обмена. Скачайте файл кнопкой «Скачать SVG».', 'error');
  }

  async function downloadSVG() {
    var svg;
    try { svg = ed.exportSVG(); } catch (e) { notify('Не удалось подготовить SVG: ' + errText(e), 'error'); return; }
    await saveFile(fileBase() + '.svg', svg, 'image/svg+xml');
  }

  async function downloadPNG() {
    var blob;
    try { blob = await ed.exportPNG(2); }
    catch (e) {
      notify('Не удалось получить PNG: ' + errText(e) + '. SVG можно скопировать или скачать.', 'error', { label: 'Копировать SVG', fn: copySVG });
      return;
    }
    await saveFile(fileBase() + '.png', blob, 'image/png');
  }

  function saveProject() {
    var data = JSON.stringify({
      app: 'illustration-composer', version: 1, scene: ed.getScene(), customSchemes: state.custom
    }, null, 2);
    return saveFile('illustration-project.json', data, 'application/json');
  }

  /** Проверка и нормализация сцены из файла проекта. Возвращает {scene} или {error}. */
  function validateScene(sc) {
    if (!sc || typeof sc !== 'object') return { error: 'нет поля scene' };
    if (!sc.format || !isFinite(sc.format.w) || !isFinite(sc.format.h) || sc.format.w < 100 || sc.format.h < 100 || sc.format.w > 10000 || sc.format.h > 10000) {
      return { error: 'некорректный формат холста' };
    }
    if (sc.size !== 'L' && sc.size !== 'S') return { error: 'размер должен быть S или L' };
    if (typeof sc.schemeId !== 'string') return { error: 'не указана цветовая схема' };
    if (!isFinite(sc.scale) || sc.scale <= 0 || sc.scale > 20) return { error: 'некорректный масштаб' };
    if (!Array.isArray(sc.items)) return { error: 'нет списка объектов' };
    var items = [];
    for (var i = 0; i < sc.items.length; i++) {
      var it = sc.items[i];
      if (!it || !IC.scene.getObject(lib, it.objectId)) return { error: 'объект №' + (i + 1) + ' не найден в библиотеке' };
      if (it.kind !== 'main' && it.kind !== 'bg') return { error: 'у объекта №' + (i + 1) + ' неизвестный тип' };
      if (!isFinite(it.x) || !isFinite(it.y)) return { error: 'у объекта №' + (i + 1) + ' нет координат' };
      items.push({
        uid: typeof it.uid === 'string' && it.uid ? it.uid : IC.scene.uid(),
        objectId: it.objectId, kind: it.kind, x: +it.x, y: +it.y,
        rotation: isFinite(it.rotation) ? +it.rotation : 0,
        colorShift: isFinite(it.colorShift) ? Math.round(it.colorShift) : 0
      });
    }
    var std = FORMATS.filter(function (x) { return x.id === sc.format.id && x.w === sc.format.w && x.h === sc.format.h; })[0];
    return {
      scene: {
        format: std ? Object.assign({}, std) : { id: 'custom', name: 'Свой ' + sc.format.w + '×' + sc.format.h, w: +sc.format.w, h: +sc.format.h },
        size: sc.size, schemeId: sc.schemeId,
        decor: DECORS.indexOf(sc.decor) !== -1 ? sc.decor : 'none',
        scale: +sc.scale,
        titleZone: sc.titleZone === 'left' || sc.titleZone === 'top' ? sc.titleZone : null,
        items: items
      }
    };
  }

  function openProject(file) {
    var fr = new FileReader();
    fr.onerror = function () { notify('Не удалось прочитать файл проекта.', 'error'); };
    fr.onload = function () {
      var data;
      try { data = JSON.parse(String(fr.result)); }
      catch (e) { notify('Файл проекта повреждён: это не JSON.', 'error'); return; }
      if (!data || data.app !== 'illustration-composer') { notify('Это не проект конструктора иллюстраций.', 'error'); return; }
      if (data.version !== 1) { notify('Неподдерживаемая версия проекта: ' + data.version + '.', 'error'); return; }
      var added = Array.isArray(data.customSchemes) ? data.customSchemes.filter(validScheme).map(cleanScheme) : [];
      var res = validateScene(data.scene);
      if (res.error) { notify('Проект не открыт: ' + res.error + '.', 'error'); return; }
      var backup = state.custom.slice();
      added.forEach(function (s) {
        state.custom = state.custom.filter(function (x) { return x.id !== s.id; });
        state.custom.push(s);
      });
      if (!hasScheme(res.scene.schemeId)) {
        notify('Схема проекта не найдена — использована «' + lib.palettes.schemes[0].name + '».', 'warn');
        res.scene.schemeId = lib.palettes.schemes[0].id;
      }
      try {
        saveCustom();
        ed.setScene(res.scene, { resetHistory: true });
      } catch (e) {
        state.custom = backup;
        notify('Проект не открыт: ' + errText(e), 'error');
        return;
      }
      reqId++; setBusy(false);
      state.variants = []; state.active = -1; state.last = null;
      renderStrip();
      applySchemeState(res.scene.schemeId);
      ed.refresh();
      ed.select(null);
      syncFromScene(ed.getScene());
      updateUndo();
      notify('Проект открыт: объектов — ' + res.scene.items.length + '.', 'success');
    };
    fr.readAsText(file);
  }

  /* ---------- привязка событий ---------- */

  function setMode(mode, focusTab) {
    if (mode !== state.mode) state.texts[state.mode] = $('build-text').value;
    state.mode = mode;
    reqId++; setBusy(false);
    $('analysis-block').hidden = mode !== 'metaphor';
    ['metaphor', 'list'].forEach(function (m) {
      var t = $('tab-' + m), on = m === mode;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    $('tabpanel-build').setAttribute('aria-labelledby', 'tab-' + mode);
    $('text-label').textContent = mode === 'metaphor' ? 'Тема или метафора' : 'Список объектов';
    var ta = $('build-text');
    ta.value = state.texts[mode];
    ta.placeholder = mode === 'metaphor'
      ? 'Например: финансовая грамотность'
      : 'Например: лампа, наушники и телефон. Слово «фоновый» делает объект фоновым.';
    var box = $('examples');
    box.textContent = '';
    EXAMPLES[mode].forEach(function (t) {
      var c = el('button', 'chip', t);
      c.type = 'button';
      c.title = 'Подставить пример';
      c.addEventListener('click', function () { ta.value = t; ta.focus(); });
      box.appendChild(c);
    });
    $('explain').textContent = '';
    if (focusTab) $('tab-' + mode).focus();
  }

  /* ---------- блок «Анализ метафоры» ---------- */

  function saveAnalysis() {
    try { localStorage.setItem(AN_STORE, JSON.stringify({ mode: state.analysis.mode, model: state.analysis.model })); } catch (e) { /* без хранилища */ }
  }
  function storeKey() {
    try {
      if ($('an-remember').checked && $('an-key').value) localStorage.setItem(KEY_STORE, $('an-key').value);
      else localStorage.removeItem(KEY_STORE);
    } catch (e) { /* без хранилища */ }
  }
  function showAnalysisMode() {
    setSeg($('an-mode'), 'amode', state.analysis.mode);
    $('an-llm').hidden = state.analysis.mode !== 'llm';
  }
  function initAnalysis() {
    try {
      var raw = localStorage.getItem(AN_STORE);
      var a = raw ? JSON.parse(raw) : null;
      if (a && (a.mode === 'local' || a.mode === 'llm')) state.analysis.mode = a.mode;
      if (a && typeof a.model === 'string') state.analysis.model = a.model.slice(0, 80);
      var k = localStorage.getItem(KEY_STORE);
      if (k) { $('an-key').value = k; $('an-remember').checked = true; }
    } catch (e) { /* без хранилища */ }
    $('an-model').value = state.analysis.model;
    $('an-model').placeholder = (IC.analyzers && IC.analyzers.DEFAULT_MODEL) || FALLBACK_MODEL;
    showAnalysisMode();
    initSeg($('an-mode'), 'amode', function (v) {
      state.analysis.mode = v === 'llm' ? 'llm' : 'local';
      showAnalysisMode(); saveAnalysis();
    });
    $('an-model').addEventListener('input', function () { state.analysis.model = $('an-model').value.trim(); saveAnalysis(); });
    $('an-key').addEventListener('input', function () { if ($('an-remember').checked) storeKey(); });
    $('an-remember').addEventListener('change', storeKey);
  }

  function afterGeometryChange() {
    if (state.last) { try { computeVariants(); } catch (e) { /* полоса останется прежней */ } }
  }

  function bindUI() {
    // вкладки
    $('tab-metaphor').addEventListener('click', function () { setMode('metaphor'); });
    $('tab-list').addEventListener('click', function () { setMode('list'); });
    document.querySelector('.tabs').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setMode(state.mode === 'metaphor' ? 'list' : 'metaphor', true);
      }
    });
    $('build-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doBuild(false); }
    });
    $('btn-build').addEventListener('click', function () { doBuild(false); });
    $('btn-more').addEventListener('click', moreVariants);

    // формат
    var sel = $('sel-format');
    FORMATS.forEach(function (f) {
      var o = document.createElement('option'); o.value = f.id; o.textContent = f.name; sel.appendChild(o);
    });
    sel.value = state.formatId;
    sel.addEventListener('change', function () {
      var f = FORMATS.filter(function (x) { return x.id === sel.value; })[0];
      if (!f) return;
      state.formatId = f.id;
      ed.update(function (s) {
        var rx = f.w / s.format.w, ry = f.h / s.format.h;
        s.items.forEach(function (it) { it.x = Math.round(it.x * rx * 100) / 100; it.y = Math.round(it.y * ry * 100) / 100; });
        s.scale = s.scale * Math.min(rx, ry);
        s.format = Object.assign({}, f);
      }, 'format');
      afterGeometryChange();
    });

    initSeg($('seg-size'), 'size', function (v) {
      state.size = v; setSeg($('seg-size'), 'size', v);
      ed.update(function (s) { IC.scene.switchSize(lib, s, v); }, 'size');
      afterGeometryChange();
    });
    initSeg($('seg-decor'), 'decor', function (v) {
      state.decor = v; setSeg($('seg-decor'), 'decor', v);
      ed.update(function (s) { s.decor = v; }, 'decor');
      renderStrip();
    });
    initSeg($('seg-zone'), 'zone', function (v) {
      state.zone = v || null; setSeg($('seg-zone'), 'zone', v);
      ed.update(function (s) { s.titleZone = v || null; }, 'titleZone');
      afterGeometryChange();
    });
    $('chk-bg').addEventListener('change', function () { state.withBg = $('chk-bg').checked; });

    // холст
    $('btn-undo').addEventListener('click', function () { ed.undo(); updateUndo(); updateProps(); });
    $('btn-redo').addEventListener('click', function () { ed.redo(); updateUndo(); updateProps(); });
    window.addEventListener('resize', fitCanvas);

    // свойства
    bindProp('p-dup', 'duplicate'); bindProp('p-del', 'remove');
    bindProp('p-raise', 'raise'); bindProp('p-lower', 'lower');
    bindProp('p-front', 'toFront'); bindProp('p-back', 'toBack');
    bindProp('p-kind', 'toggleKind'); bindProp('p-shift', 'shiftColors');
    bindProp('p-rot-reset', 'resetRotation');

    var rotPending = null;
    function applyRotation(deg) {
      rotPending = deg;
      raf(function () {
        if (rotPending === null) return;
        var v = rotPending; rotPending = null;
        ed.setRotation(v); updateProps();
      });
    }
    $('rot-range').addEventListener('input', function () {
      $('rot-num').value = $('rot-range').value; applyRotation(+$('rot-range').value);
    });
    $('rot-num').addEventListener('input', function () {
      var raw = $('rot-num').value;
      if (raw === '' || raw === '-' || !isFinite(+raw)) return;
      var v = Math.max(-180, Math.min(180, +raw));
      $('rot-range').value = v; applyRotation(v);
    });
    $('rot-num').addEventListener('change', function () {
      var v = +$('rot-num').value;
      if (!isFinite(v)) v = 0;
      v = Math.max(-180, Math.min(180, v));
      $('rot-num').value = v; $('rot-range').value = v; applyRotation(v);
    });

    // масштаб сцены
    var scalePending = null;
    $('scale-range').addEventListener('input', function () {
      var pct = +$('scale-range').value;
      $('scale-out').textContent = pct + '%';
      scalePending = pct;
      raf(function () {
        if (scalePending === null) return;
        var p = scalePending; scalePending = null;
        ed.update(function (s) { s.scale = p / 100 / IC.scene.sizeFactor(lib, s); }, 'scale');
      });
    });

    // библиотека
    initSeg($('seg-libkind'), 'kind', function (v) {
      state.libKind = v; setSeg($('seg-libkind'), 'kind', v); renderLib();
    });

    // палитры
    $('pal-add').addEventListener('click', function () {
      var t = $('pal-text').value.trim();
      if (!t) { showPalMsg('Вставьте 6 или 8 цветов в формате hex или загрузите JSON-файл.', false); return; }
      addPalette(t);
    });
    $('pal-file').addEventListener('change', function () {
      var f = $('pal-file').files && $('pal-file').files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onerror = function () { showPalMsg('Не удалось прочитать файл.', false); };
      fr.onload = function () { $('pal-text').value = String(fr.result); addPalette(String(fr.result)); };
      fr.readAsText(f);
      $('pal-file').value = '';
    });

    // экспорт
    $('ex-svg').addEventListener('click', downloadSVG);
    $('ex-png').addEventListener('click', downloadPNG);
    $('ex-copy').addEventListener('click', copySVG);
    $('pr-save').addEventListener('click', saveProject);
    $('pr-file').addEventListener('change', function () {
      var f = $('pr-file').files && $('pr-file').files[0];
      if (f) openProject(f);
      $('pr-file').value = '';
    });
  }

  /* ---------- запуск ---------- */

  function init() {
    if (!lib || !IC.editor) {
      notify('Не загружены библиотека или редактор (data/library.js, src/editor.js).', 'error');
      return;
    }
    state.custom = loadCustom();
    bindUI();
    setMode('metaphor');
    initAnalysis();
    setSeg($('seg-size'), 'size', state.size);
    setSeg($('seg-decor'), 'decor', state.decor);
    setSeg($('seg-zone'), 'zone', state.zone);
    setSeg($('seg-libkind'), 'kind', state.libKind);
    renderSchemes();
    renderLib();

    ed = IC.editor.create($('canvas'), lib, {
      getCustomSchemes: function () { return state.custom; },
      onChange: onChange,
      onSelect: function () { updateProps(); }
    });
    IC.app.editor = ed;

    doBuild(true);
    fitCanvas();
    updateUndo();
    updateProps();
  }

  IC.app = { notify: notify, state: state, editor: null };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.IC = window.IC || {});
