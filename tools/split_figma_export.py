#!/usr/bin/env python3
"""
Разрезает SVG-экспорт из Figma на отдельные объекты библиотеки.

Вход:
  tools/figma-export.svg          — экспорт служебного фрейма _export (svgIdAttribute=true),
                                    где каждый объект лежит в группе obj__<id>__<S|L>__<main|bg|fon>
  tools/figma-export-layout.json  — положение и размер каждой группы внутри фрейма
  data/catalog.json, data/palettes.json

Выход:
  data/library.json               — библиотека для сервиса: разметка объектов с цветами,
                                    заменёнными на роли палитры (fill="@bg1" и т.п.)
  library/<S|L>/<main|bg|decor>/<id>.svg — те же объекты отдельными SVG (исходные цвета)

Объекты не меняются: копируются все контуры как есть, меняется только система координат
(сдвиг в 0,0) и цвет записывается ссылкой на роль, чтобы перекрашивать композицию.
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)

NAMED = {"white": "#FFFFFF", "black": "#000000"}


def tag(el):
    return el.tag.split("}")[-1]


def load():
    svg = ET.parse(ROOT / "tools" / "figma-export.svg").getroot()
    layout = json.loads((ROOT / "tools" / "figma-export-layout.json").read_text("utf-8"))
    catalog = json.loads((ROOT / "data" / "catalog.json").read_text("utf-8"))
    palettes = json.loads((ROOT / "data" / "palettes.json").read_text("utf-8"))
    return svg, layout, catalog, palettes


def find_groups(svg):
    found = {}
    for el in svg.iter():
        i = el.get("id", "")
        if i.startswith("obj__"):
            found[i] = el
    return found


def clean(el):
    """Убирает id/clip-path (служебные имена слоёв Figma) и разворачивает пустые <g>."""
    for e in el.iter():
        e.attrib.pop("id", None)
        e.attrib.pop("clip-path", None)
    changed = True
    while changed:
        changed = False
        for parent in el.iter():
            kids = list(parent)
            for idx, k in enumerate(kids):
                if tag(k) == "g" and not k.attrib:
                    parent.remove(k)
                    for j, gk in enumerate(list(k)):
                        parent.insert(idx + j, gk)
                    changed = True
                    break
            if changed:
                break


def norm_color(v):
    v = v.strip()
    if v.lower() in NAMED:
        return NAMED[v.lower()]
    if re.fullmatch(r"#[0-9a-fA-F]{6}", v):
        return v.upper()
    return v


def tokenize_colors(el, color_to_role, where):
    used = set()
    for e in el.iter():
        for attr in ("fill", "stroke"):
            v = e.get(attr)
            if not v or v == "none":
                continue
            c = norm_color(v)
            if c not in color_to_role:
                raise SystemExit(f"{where}: цвет {c} не входит в палитру — проверьте palettes.json")
            role = color_to_role[c]
            used.add(role)
            e.set(attr, "@" + role)
    return sorted(used)


def serialize_children(el):
    parts = []
    for k in el:
        s = ET.tostring(k, encoding="unicode")
        s = s.replace(' xmlns="http://www.w3.org/2000/svg"', "")
        parts.append(s)
    out = "".join(parts)
    out = re.sub(r">\s+<", "><", out)
    return out


def detokenize(markup, colors):
    return re.sub(r"@(bg1|bg2|bg3|ink|obj1|obj2|obj3|paper)", lambda m: colors[m.group(1)], markup)


def main():
    svg, layout, catalog, palettes = load()
    groups = find_groups(svg)
    pos = {g["name"]: g for g in layout["groups"]}
    schemes = {s["id"]: s for s in palettes["schemes"]}

    def role_map(scheme_id):
        cols = schemes[scheme_id]["colors"]
        # порядок важен: если цвет встречается в двух ролях, берём первую (фон приоритетнее)
        m = {}
        for role in palettes["roles"]:
            m.setdefault(cols[role].upper(), role)
        return m

    lib = {"version": 1, "source": "Figma: «Тестовое | иллюстрации», страница «Библиотека компонентов»",
           "sizes": {"L": {"base": 1000}, "S": {"base": 500}},
           "objects": [], "decors": []}

    out_dir = ROOT / "library"
    total_paths = 0

    for obj in catalog["objects"]:
        entry = {"id": obj["id"], "name": obj["name"], "aliases": obj["aliases"], "tags": obj["tags"], "variants": {}}
        for size in ("L", "S"):
            entry["variants"][size] = {}
            for kind in ("main", "bg"):
                key = f"obj__{obj['id']}__{size}__{kind}"
                el, p = groups[key], pos[key]
                clean(el)
                roles = tokenize_colors(el, role_map(palettes["sourceScheme"]), key)
                inner = serialize_children(el)
                total_paths += inner.count("<path")
                markup = f'<g transform="translate({-p["x"]:.3f} {-p["y"]:.3f})">{inner}</g>'
                entry["variants"][size][kind] = {"w": round(p["w"], 3), "h": round(p["h"], 3), "roles": roles, "svg": markup}
                f = out_dir / size / kind / f"{obj['id']}.svg"
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(
                    f'<svg xmlns="http://www.w3.org/2000/svg" width="{p["w"]:.2f}" height="{p["h"]:.2f}" '
                    f'viewBox="0 0 {p["w"]:.3f} {p["h"]:.3f}" fill="none">'
                    + detokenize(markup, schemes[palettes["sourceScheme"]]["colors"]) + "</svg>\n", "utf-8")
        lib["objects"].append(entry)

    for d in catalog["decors"]:
        entry = {"id": d["id"], "name": d["name"], "scheme": d["id"], "variants": {}}
        for size in ("L", "S"):
            key = f"{d['source']}__{size}__fon"
            el, p = groups[key], pos[key]
            # первый <rect> во фрейме — это заливка фона; её рисует сам сервис
            frame = el[0]
            first = next((k for k in frame if tag(k) == "rect"), None)
            if first is not None:
                frame.remove(first)
            clean(el)
            roles = tokenize_colors(el, role_map(d["id"]), key)
            inner = serialize_children(el)
            markup = f'<g transform="translate({-p["x"]:.3f} {-p["y"]:.3f})">{inner}</g>'
            entry["variants"][size] = {"w": p["w"], "h": p["h"], "roles": roles, "svg": markup}
            f = out_dir / size / "decor" / f"{d['id']}.svg"
            f.parent.mkdir(parents=True, exist_ok=True)
            cols = schemes[d["id"]]["colors"]
            f.write_text(
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{p["w"]:.0f}" height="{p["h"]:.0f}" '
                f'viewBox="0 0 {p["w"]:.0f} {p["h"]:.0f}" fill="none"><rect width="100%" height="100%" fill="{cols["bg1"]}"/>'
                + detokenize(markup, cols) + "</svg>\n", "utf-8")
        lib["decors"].append(entry)

    lib["palettes"] = palettes
    payload = json.dumps(lib, ensure_ascii=False, separators=(",", ":"))
    (ROOT / "data" / "library.json").write_text(payload, "utf-8")
    # та же библиотека в виде скрипта: так index.html открывается двойным кликом (file://) без сервера
    (ROOT / "data" / "library.js").write_text("window.IC_LIBRARY=" + payload + ";\n", "utf-8")
    size_kb = (ROOT / "data" / "library.json").stat().st_size / 1024
    print(f"objects: {len(lib['objects'])} x 2 размера x 2 вида, decors: {len(lib['decors'])}, paths: {total_paths}, library.json: {size_kb:.0f} KB")


if __name__ == "__main__":
    sys.exit(main())
