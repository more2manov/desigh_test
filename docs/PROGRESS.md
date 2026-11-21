# PROGRESS — конструктор иллюстраций

Срок сдачи: вторник 24.11.2026. Детали задания — HANDOFF.md. Репозиторий: github.com/more2manov/desigh_test (main).

## Сделано
- data/library.json, data/library.js — библиотека: 10 объектов × L/S × main/bg, 3 декора, палитры (1,5 МБ, не открывать целиком).
- data/catalog.json — названия, алиасы, теги; data/palettes.json — 3 схемы (bg1 bg2 bg3 ink | obj1 obj2 obj3 paper).
- library/<L|S>/<main|bg|decor>/*.svg — объекты отдельными файлами.
- src/palette.js — перекраска ролей, colorShift, разбор своей палитры.
- src/scene.js — модель сцены, форматы, рендер SVG (каждый объект в <g id>), смена S↔L.
- src/semantic.js — офлайн-подбор по метафоре и разбор списка объектов.
- src/layout.js — автокомпоновка, IC.layout:
  - compose(lib, {main:[{id}], bg:[{id}], format, size, titleZone, seed, schemeId, decor}) → {seed, scene, score, primaryUid, metrics};
  - variants(lib, opts, count=6) — seeds seed + i·7919; metrics(lib, scene) — видимость/перекрытия;
  - commonScale, zones(W,H,zone) → {area,title}, rng (mulberry32), константы TITLE_LEFT/TOP, SHRINK, TOLERANCE.
  - ~500 случайных раскладок + доводка, ~14 мс на compose.
- tests/load-ic.js — загрузка src/*.js в vm с заглушкой window + библиотека (общий для тестов и примеров).
- tests/run-tests.js — 12 тестов (масштаб, библиотека, видимость, слои, зона заголовка, перекрытия, детерминизм, скорость, semantic ×3, render). Запуск: node tests/run-tests.js.
- tools/render-examples.js — examples/*.svg + *.png (headless Chrome, если есть): finance-literacy, startup-idea, lamp-headphones-phone.
- tools/ — экспорт из Figma и split_figma_export.py.

## Решения
- Чистый JS без сборки, <script src> + общий window.IC; index.html открывается с file://, на Pages и как артефакт.
- Главный объект = первый в списке main (primaryUid); выход за край холста ≤3%, у остальных главных ≤20%.
- Видимость/перекрытия считаются по bbox, ужатым на 12%, сеткой 10×10 (приближённо).
- Фоновые объекты: видимость = доля bbox внутри холста, 35–65%.
- uid детерминированные (s<seed>-n), чтобы один seed давал идентичную сцену.
- Git: ветка main, push после каждого коммита. .gitattributes: LF. _to_delete/ и .mcp.json в .gitignore.

## Известные проблемы
- bbox вместо силуэтов: пустоты могут выглядеть крупными, фоновые объекты иногда — тонкие полоски у края.
- Фоновые объекты в цветах bg1/bg3; bg1 = цвет холста, часть фонового объекта сливается с фоном.
- Широкий формат + зона заголовка + 2 объекта — композиция разреженная (fill ограничен 0.5).
- variants не меняет colorShift (у всех 0).

## Дальше
- Ждём шаг 2 от пользователя (по HANDOFF: analyzers.js, интерфейс, экспорт, README).
