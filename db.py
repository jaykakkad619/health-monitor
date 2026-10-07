import json
import sqlite3
from pathlib import Path

import click
from flask import g

from nutrients import NUTRIENT_KEYS
from seed_data import SEED_EXERCISES, SEED_FOODS, SEED_FOODS_V2, SEED_RECATEGORIZE, SEED_VERSION

DB_PATH = Path(__file__).parent / "health_monitor.db"
SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(e=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA_PATH.read_text())
    _migrate(db)
    _seed(db)
    db.close()


def _migrate(conn):
    """Add any columns missing from an older schema version."""
    existing = {row[1] for row in conn.execute("PRAGMA table_info(foods)")}
    for key in NUTRIENT_KEYS:
        if key not in existing:
            conn.execute(f"ALTER TABLE foods ADD COLUMN {key} REAL NOT NULL DEFAULT 0")
    if "category" not in existing:
        conn.execute("ALTER TABLE foods ADD COLUMN category TEXT NOT NULL DEFAULT 'other'")
    if "serving_size_g" not in existing:
        conn.execute("ALTER TABLE foods ADD COLUMN serving_size_g REAL")
    if "size_presets" not in existing:
        conn.execute("ALTER TABLE foods ADD COLUMN size_presets TEXT")

    food_log_cols = {row[1] for row in conn.execute("PRAGMA table_info(food_logs)")}
    if "meal" not in food_log_cols:
        conn.execute("ALTER TABLE food_logs ADD COLUMN meal TEXT NOT NULL DEFAULT 'other'")
    if "grams" not in food_log_cols:
        conn.execute("ALTER TABLE food_logs ADD COLUMN grams REAL")

    conn.commit()


def _insert_seed_foods(conn, foods, skip_existing=False):
    cols = ["name", "serving_unit", "category", "serving_size_g", "size_presets", "calories", "protein_g", "carbs_g", "fat_g"] + NUTRIENT_KEYS
    placeholders = ", ".join("?" for _ in cols)
    existing = {row[0].lower() for row in conn.execute("SELECT name FROM foods")} if skip_existing else set()
    for f in foods:
        if f["name"].lower() in existing:
            continue
        size_presets = json.dumps(f["size_presets"]) if f.get("size_presets") else None
        values = [
            f["name"], f["serving_unit"], f.get("category", "other"), f.get("serving_size_g"), size_presets,
            f["calories"], f["protein_g"], f["carbs_g"], f["fat_g"],
        ]
        values += [f.get(k, 0) for k in NUTRIENT_KEYS]
        conn.execute(f"INSERT INTO foods ({', '.join(cols)}) VALUES ({placeholders})", values)


def _fill_seed_blanks(conn):
    """Give v1 seed foods the fields v2 added, without touching anything the user set."""
    for f in SEED_FOODS:
        if f.get("serving_size_g"):
            conn.execute("UPDATE foods SET serving_size_g = ? WHERE name = ? AND serving_size_g IS NULL", (f["serving_size_g"], f["name"]))
        if f.get("size_presets"):
            conn.execute("UPDATE foods SET size_presets = ? WHERE name = ? AND size_presets IS NULL", (json.dumps(f["size_presets"]), f["name"]))
        if f.get("caffeine_mg"):
            conn.execute("UPDATE foods SET caffeine_mg = ? WHERE name = ? AND caffeine_mg = 0", (f["caffeine_mg"], f["name"]))
    for name, (old, new) in SEED_RECATEGORIZE.items():
        conn.execute("UPDATE foods SET category = ? WHERE name = ? AND category = ?", (new, name, old))


def _seed(conn):
    """Load the starter library into an empty database, or top up an older one.

    `seed_version` in settings records which batches a database has already
    received, so each batch is applied once — foods the user deleted or
    edited afterwards are left alone. A database from before versioning
    existed has foods but no setting, which means it already has batch 1.
    """
    row = conn.execute("SELECT value FROM settings WHERE key = 'seed_version'").fetchone()
    has_foods = conn.execute("SELECT COUNT(*) FROM foods").fetchone()[0] > 0
    version = int(row[0]) if row else (1 if has_foods else 0)

    if version < 1:
        _insert_seed_foods(conn, SEED_FOODS)
    if version < 2:
        _insert_seed_foods(conn, SEED_FOODS_V2, skip_existing=True)
        _fill_seed_blanks(conn)
    if version < SEED_VERSION:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('seed_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(SEED_VERSION),),
        )

    if conn.execute("SELECT COUNT(*) FROM exercises").fetchone()[0] == 0:
        for e in SEED_EXERCISES:
            conn.execute(
                "INSERT INTO exercises (name, unit, calories_per_unit) VALUES (?, ?, ?)",
                (e["name"], e["unit"], e["calories_per_unit"]),
            )
    conn.commit()


def init_app(app):
    app.teardown_appcontext(close_db)
    app.cli.add_command(init_db_command)


@click.command("init-db")
def init_db_command():
    """Create database tables if they don't already exist."""
    init_db()
    click.echo("Database initialized.")
