# PROGRESS — конструктор иллюстраций

Срок сдачи: вторник 24.11.2026. Детали задания — HANDOFF.md.

## Сделано
- data/library.json, data/library.js — библиотека: 10 объектов × L/S × main/bg, 3 декора, палитры (1,5 МБ, не открывать целиком).
- data/catalog.json — названия, алиасы, теги; data/palettes.json — 3 схемы (bg1 bg2 bg3 ink | obj1 obj2 obj3 paper).
- library/<L|S>/<main|bg|decor>/*.svg — объекты отдельными файлами.
- src/palette.js — перекраска ролей, colorShift, разбор своей палитры.
- src/scene.js — модель сцены, форматы, рендер SVG (каждый объект в <g id>), смена S↔L.
- src/semantic.js — офлайн-подбор по метафоре и разбор списка объектов.
- tools/ — экспорт из Figma и split_figma_export.py.

## Решения
- Чистый JS без сборки, <script src> + общий window.IC; index.html открывается с file://, на Pages и как артефакт.
- Git: репозиторий github.com/more2manov/desigh_test, ветка main, push после каждого коммита.
- _to_delete/ в .gitignore, не трогать.

## Известные проблемы
- нет

## Дальше
- Шаг 1: src/layout.js, tests/run-tests.js, tools/render-examples.js, examples/.
