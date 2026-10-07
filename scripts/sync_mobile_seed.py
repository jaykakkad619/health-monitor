"""Regenerate mobile_app/seed_data.js from seed_data.py.

seed_data.py is the single source of truth for the starter food/exercise
library; the PWA needs the same data as an ES module with camelCase keys.
Run this after editing seed_data.py:

    python scripts/sync_mobile_seed.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import seed_data  # noqa: E402

HEADER = """// Starter library of common Indian foods (with full nutrition data) and
// common exercises. Loaded once into an empty database on first run —
// values are typical/average reference amounts, not lab-measured for any
// specific brand or recipe. Edit or delete any entry freely.
//
// GENERATED from seed_data.py by scripts/sync_mobile_seed.py — edit that
// file instead and re-run the script.
"""


def camel(key):
    return re.sub(r"_([a-z0-9])", lambda m: m.group(1).upper(), key)


def js_value(v):
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return repr(v)


def js_row(row):
    return "  { " + ", ".join(f"{camel(k)}: {js_value(v)}" for k, v in row.items()) + " },"


def js_list(name, rows):
    return "\n".join([f"export const {name} = [", *(js_row(r) for r in rows), "];"])


def main():
    parts = [HEADER, js_list("SEED_FOODS", seed_data.SEED_FOODS)]
    if hasattr(seed_data, "SEED_FOODS_V2"):
        parts += ["", js_list("SEED_FOODS_V2", seed_data.SEED_FOODS_V2)]
    if hasattr(seed_data, "SEED_RECATEGORIZE"):
        mapping = {name: list(pair) for name, pair in seed_data.SEED_RECATEGORIZE.items()}
        parts += ["", f"export const SEED_VERSION = {seed_data.SEED_VERSION};"]
        parts += ["", "// Seed foods whose category changed in v2: name -> [old, new]."]
        parts += [f"export const SEED_RECATEGORIZE = {json.dumps(mapping, ensure_ascii=False, indent=2)};"]
    parts += ["", js_list("SEED_EXERCISES", seed_data.SEED_EXERCISES), ""]
    out = ROOT / "mobile_app" / "seed_data.js"
    out.write_text("\n".join(parts), encoding="utf-8", newline="\n")
    print(f"Wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
