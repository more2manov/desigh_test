# PROGRESS — конструктор иллюстраций

Срок сдачи: вторник 24.11.2026. Детали задания — HANDOFF.md. Правила работы — CLAUDE.md. Репозиторий: github.com/more2manov/desigh_test (main).

## Сделано
- data/library.json, data/library.js — библиотека: 10 объектов × L/S × main/bg, 3 декора, палитры (1,5 МБ, не открывать целиком).
- data/catalog.json — названия, алиасы, теги; data/palettes.json — 3 схемы (bg1 bg2 bg3 ink | obj1 obj2 obj3 paper).
- library/<L|S>/<main|bg|decor>/*.svg — объекты отдельными файлами.
- src/palette.js — перекраска ролей, colorShift, разбор своей палитры.
- src/scene.js — модель сцены, форматы, рендер SVG (каждый объект в <g id>), смена S↔L.
- src/semantic.js — офлайн-подбор по метафоре и разбор списка объектов.
- src/layout.js — автокомпоновка IC.layout: compose(lib, {main, bg, format, size, titleZone, seed, schemeId, decor}) → {seed, scene, score, primaryUid, metrics}; variants(lib, opts, 6); metrics; commonScale(dims, area, titled); zones(W,H,zone) → {area,title}; rng (mulberry32).
  - С зоной заголовка fill 0.62/0.74/0.84 (1/2/3+ главных), крупнейший объект ≤1.03 области; без зоны — как раньше.
  - Фон: площадь видимой части 35–65% и ≥30% по ширине и высоте; нет места — объект не ставится.
- src/editor.js — холст IC.editor.create(container, lib, opts): выделение, перетаскивание (только transform во время жеста), рамка и ручка поворота (Shift — 15°), клавиши (по e.code, работают в русской раскладке), история до 100 шагов, exportSVG/exportPNG. Контракт — docs/INTERFACE.md.
- index.html, css/app.css, src/app.js — интерфейс: три колонки (сборка — холст+6 вариантов — свойства/библиотека/палитры/экспорт), складываются <1000px; свои палитры в localStorage 'ic.customSchemes'; проект JSON {app, version:1, scene, customSchemes}; скачивание через claude.use('downloads') или <a download>; сообщения — IC.app.notify. При старте собирается «финансовая грамотность».
- tests/run-tests.js — 15 тестов (вкл. плотность og/banner, фон ≥30% по осям, зона заголовка); tests/editor-smoke.js — 13 тестов editor на заглушке DOM; tests/load-ic.js — загрузка src/*.js в vm.
- tools/render-examples.js — examples/*.svg + *.png (finance-literacy, startup-idea, lamp-headphones-phone).
- docs/screenshot-step2.png — снимок интерфейса 1440×900.

## Решения
- Чистый JS без сборки, <script src> + window.IC; порядок скриптов — docs/INTERFACE.md.
- Главный объект = первый в main; выход за край ≤3%, у остальных главных ≤20%. Видимость по bbox, ужатым на 12%, сетка 10×10.
- uid в layout детерминированные (s<seed>-n). Масштаб сцены в UI — проценты scale·base/1000 (20–300%).
- Фоновые объекты в цветах bg1/bg3 частично сливаются с холстом — так и в макете, роли не меняем.
- Смена формата/S↔L/зоны не пересобирает сцену, а пересчитывает её; полоса вариантов пересобирается с тем же seed.
- Браузерная проверка: Playwright MCP не открывает file:// → локальный сервер `py -m http.server 8765 --bind 127.0.0.1` (python в PATH — заглушка Store). Папка .playwright-mcp/ в .gitignore.
- Git: main, push после каждого коммита. .gitattributes: LF. _to_delete/ и .mcp.json в .gitignore.

## Известные проблемы
- bbox вместо силуэтов: пустоты могут выглядеть крупными.
- banner/top: занятость ~0.61 (ограничена высотой области).
- При 1440×900 полоса вариантов ниже первого экрана (надо прокрутить).
- variants не меняет colorShift (у всех 0).
- claude.use('downloads') проверен только по коду (работает лишь на claude.ai).

## Дальше
- Ждём шаг 3 (по HANDOFF: analyzers.js — LLM для метафор, README, GitHub Pages, демо).
