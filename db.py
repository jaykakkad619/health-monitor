import json
import sqlite3
from pathlib import Path

import click
from flask import g

from nutrients import NUTRIENT_KEYS
from seed_data import SEED_EXERCISES, SEED_FOODS

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


def _seed(conn):
    """Load the starter food/exercise library into an empty database only."""
    if conn.execute("SELECT COUNT(*) FROM foods").fetchone()[0] == 0:
        cols = ["name", "serving_unit", "category", "serving_size_g", "size_presets", "calories", "protein_g", "carbs_g", "fat_g"] + NUTRIENT_KEYS
        placeholders = ", ".join("?" for _ in cols)
        for f in SEED_FOODS:
            size_presets = json.dumps(f["size_presets"]) if f.get("size_presets") else None
            values = [
                f["name"], f["serving_unit"], f.get("category", "other"), f.get("serving_size_g"), size_presets,
                f["calories"], f["protein_g"], f["carbs_g"], f["fat_g"],
            ]
            values += [f[k] for k in NUTRIENT_KEYS]
            conn.execute(f"INSERT INTO foods ({', '.join(cols)}) VALUES ({placeholders})", values)

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
