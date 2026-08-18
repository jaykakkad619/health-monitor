PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    serving_unit TEXT NOT NULL DEFAULT 'serving',
    category TEXT NOT NULL DEFAULT 'other',
    serving_size_g REAL,
    size_presets TEXT,
    calories REAL NOT NULL,
    protein_g REAL NOT NULL DEFAULT 0,
    carbs_g REAL NOT NULL DEFAULT 0,
    fat_g REAL NOT NULL DEFAULT 0,
    fiber_g REAL NOT NULL DEFAULT 0,
    sugar_g REAL NOT NULL DEFAULT 0,
    sat_fat_g REAL NOT NULL DEFAULT 0,
    cholesterol_mg REAL NOT NULL DEFAULT 0,
    sodium_mg REAL NOT NULL DEFAULT 0,
    potassium_mg REAL NOT NULL DEFAULT 0,
    calcium_mg REAL NOT NULL DEFAULT 0,
    iron_mg REAL NOT NULL DEFAULT 0,
    magnesium_mg REAL NOT NULL DEFAULT 0,
    zinc_mg REAL NOT NULL DEFAULT 0,
    vitamin_a_mcg REAL NOT NULL DEFAULT 0,
    vitamin_c_mg REAL NOT NULL DEFAULT 0,
    vitamin_d_mcg REAL NOT NULL DEFAULT 0,
    vitamin_e_mg REAL NOT NULL DEFAULT 0,
    vitamin_k_mcg REAL NOT NULL DEFAULT 0,
    vitamin_b6_mg REAL NOT NULL DEFAULT 0,
    vitamin_b12_mcg REAL NOT NULL DEFAULT 0,
    folate_mcg REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'minute',
    calories_per_unit REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS food_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date TEXT NOT NULL,
    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    servings REAL NOT NULL,
    grams REAL,
    meal TEXT NOT NULL DEFAULT 'other',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exercise_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date TEXT NOT NULL,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    quantity REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weight_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date TEXT NOT NULL,
    weight_kg REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    yields_servings REAL NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    servings REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_food_logs_date ON food_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_exercise_logs_date ON exercise_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_weight_logs_date ON weight_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
