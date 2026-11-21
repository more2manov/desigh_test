# Контракт интерфейса: src/editor.js ↔ src/app.js

Порядок скриптов в index.html: data/library.js → src/palette.js → src/scene.js → src/semantic.js → src/layout.js → src/editor.js → src/app.js.
Библиотека: `window.IC_LIBRARY` (lib). Сцена — формат src/scene.js (`{format,size,schemeId,decor,scale,titleZone,items:[{uid,objectId,kind,x,y,rotation,colorShift}]}`).

## editor.js → `IC.editor.create(container, lib, opts) → ed`
`opts = { getCustomSchemes(): scheme[], onChange(scene, reason), onSelect(uid|null) }`.
Editor владеет текущей сценой и историей. Рендерит `<svg>` в container через `IC.scene.render(lib, scene, {customSchemes})`,
масштабируется по ширине контейнера (viewBox), поверх — слой выделения (рамка + ручка поворота), не попадающий в экспорт.

Методы `ed`:
- `setScene(scene, {resetHistory?:bool})` — заменить сцену (клонирует). По умолчанию кладёт шаг в историю.
- `getScene()` — клон текущей сцены.
- `update(fn, reason)` — `fn(sceneDraft)` мутирует черновик; editor пушит историю, перерисовывает, зовёт onChange. Используется app.js для формата, S↔L (`IC.scene.switchSize`), схемы, декора, масштаба сцены, зоны заголовка.
- `select(uid|null)`, `getSelected()` → item | null.
- Операции над выделенным (no-op без выделения): `duplicate()`, `remove()`, `raise()`, `lower()`, `toFront()`, `toBack()`, `toggleKind()` (main↔bg), `shiftColors()` (colorShift+1), `setRotation(deg)`, `resetRotation()`, `nudge(dx, dy)`.
- `addObject(objectId, kind)` — добавить в центр холста (со смещением, если место занято), выделить.
- `undo()`, `redo()`, `canUndo()`, `canRedo()`.
- `exportSVG()` → строка `IC.scene.render(lib, scene, {export:true, customSchemes})`.
- `exportPNG(scaleFactor=1)` → `Promise<Blob>` (SVG → Image → canvas).
- `refresh()` — перерисовать (например, после смены своих палитр).
- `destroy()`.

Поведение мыши/клавиатуры (внутри editor.js):
- pointer events + getScreenCTM; при перетаскивании меняется только атрибут transform группы (`IC.scene.itemTransform`), полный рендер и шаг истории — на pointerup.
- Ручка поворота над рамкой; Shift — шаг 15°.
- Клавиши (если фокус не в input/textarea/select): стрелки — 1 px (Shift — 10 px), Delete/Backspace, Ctrl+D, Ctrl+Z, Ctrl+Y и Ctrl+Shift+Z, `[` / `]` — ниже/выше.
- Клик по пустому месту — снять выделение.
- Масштаба отдельного объекта нет (правило задания) — только `scene.scale` через `update`.
- История: до 100 шагов, хранит клоны сцен.

## app.js
Строит UI вокруг editor: панель «Сборка» (вызывает IC.semantic + IC.layout.variants(lib, opts, 6)), полоса 6 превью (рендер `IC.scene.render` в маленьком контейнере, клик → `ed.setScene(variant.scene)`), библиотека (`ed.addObject`), панель свойств (методы выше; обновляется по onSelect/onChange), палитры (своя — `IC.palette.parseUserPalette`, хранение в localStorage `ic.customSchemes` в try/catch), экспорт, сохранение/открытие проекта JSON `{app:'illustration-composer', version:1, scene, customSchemes}`.
Сообщения пользователю — свой тост/строка статуса `IC.app.notify(text, type)`; alert/confirm/prompt запрещены.
