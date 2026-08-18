import io
import json
from datetime import date, datetime, timedelta
from pathlib import Path

from flask import Blueprint, Flask, flash, redirect, render_template, request, send_file, url_for

import db
from nutrients import NUTRIENT_KEYS, NUTRIENTS

app = Flask(__name__)
app.secret_key = "health-monitor-local-secret"
db.init_app(app)

mobile_bp = Blueprint("mobile_assets", __name__, static_folder="mobile_app", static_url_path="/mobile")
app.register_blueprint(mobile_bp)


@app.route("/mobile")
@app.route("/mobile/")
def mobile_root():
    return redirect("/mobile/index.html")


def get_setting(key, default=None):
    row = db.get_db().execute(
        "SELECT value FROM settings WHERE key = ?", (key,)
    ).fetchone()
    return row["value"] if row else default


def set_setting(key, value):
    conn = db.get_db()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


MEALS = [
    ("breakfast", "Breakfast"),
    ("lunch", "Lunch"),
    ("dinner", "Dinner"),
    ("snack", "Snack"),
    ("other", "Other"),
]
MEAL_LABELS = dict(MEALS)

FOOD_CATEGORIES = [
    ("fruits", "Fruits"),
    ("exotic_fruits", "Exotic Fruits"),
    ("vegetables", "Vegetables"),
    ("grains", "Grains"),
    ("protein", "Protein"),
    ("dairy", "Dairy"),
    ("snacks", "Snacks"),
    ("beverages", "Beverages"),
    ("other", "Other"),
]
CATEGORY_LABELS = dict(FOOD_CATEGORIES)


def guess_meal():
    hour = datetime.now().hour
    if hour < 11:
        return "breakfast"
    if hour < 16:
        return "lunch"
    if hour < 21:
        return "dinner"
    return "snack"


def day_totals(log_date):
    conn = db.get_db()

    nutrient_select = ",\n               ".join(f"f.{k} * fl.servings AS {k}" for k in NUTRIENT_KEYS)
    food_rows = conn.execute(
        f"""
        SELECT fl.id, fl.meal, f.name, f.serving_unit, fl.servings, fl.grams,
               f.calories * fl.servings AS calories,
               f.protein_g * fl.servings AS protein_g,
               f.carbs_g * fl.servings AS carbs_g,
               f.fat_g * fl.servings AS fat_g,
               {nutrient_select}
        FROM food_logs fl
        JOIN foods f ON f.id = fl.food_id
        WHERE fl.log_date = ?
        ORDER BY fl.id
        """,
        (log_date,),
    ).fetchall()

    exercise_rows = conn.execute(
        """
        SELECT el.id, e.name, e.unit, el.quantity,
               e.calories_per_unit * el.quantity AS calories_burned
        FROM exercise_logs el
        JOIN exercises e ON e.id = el.exercise_id
        WHERE el.log_date = ?
        ORDER BY el.id
        """,
        (log_date,),
    ).fetchall()

    consumed = sum(r["calories"] for r in food_rows)
    burned = sum(r["calories_burned"] for r in exercise_rows)
    protein = sum(r["protein_g"] for r in food_rows)
    carbs = sum(r["carbs_g"] for r in food_rows)
    fat = sum(r["fat_g"] for r in food_rows)

    macro_kcal = {"protein": protein * 4, "carbs": carbs * 4, "fat": fat * 9}
    macro_total = sum(macro_kcal.values())
    macro_pct = {
        k: (v / macro_total * 100 if macro_total else 0) for k, v in macro_kcal.items()
    }

    nutrients = {}
    for n in NUTRIENTS:
        total = sum(r[n["key"]] for r in food_rows)
        pct = min(total / n["dv"] * 100, 999) if n["dv"] else None
        nutrients[n["key"]] = {"total": total, "pct": pct, **n}

    meals = []
    for key, label in MEALS:
        rows = [r for r in food_rows if r["meal"] == key]
        if not rows and key == "other":
            continue
        meals.append({"key": key, "label": label, "rows": rows, "calories": sum(r["calories"] for r in rows)})

    return {
        "food_rows": food_rows,
        "meals": meals,
        "exercise_rows": exercise_rows,
        "consumed": consumed,
        "burned": burned,
        "net": consumed - burned,
        "protein": protein,
        "carbs": carbs,
        "fat": fat,
        "macro_pct": macro_pct,
        "nutrients": nutrients,
    }


@app.route("/")
def dashboard():
    log_date = request.args.get("date", date.today().isoformat())
    totals = day_totals(log_date)
    goal = get_setting("daily_calorie_goal")
    goal = float(goal) if goal else None

    ring_pct = min(totals["consumed"] / goal, 1) * 100 if goal else 0
    over_goal = bool(goal) and totals["consumed"] > goal
    remaining = (goal - totals["net"]) if goal else None

    conn = db.get_db()
    foods = conn.execute("SELECT * FROM foods ORDER BY name").fetchall()
    exercises = conn.execute("SELECT * FROM exercises ORDER BY name").fetchall()

    d = date.fromisoformat(log_date)
    display_date = f"{d.strftime('%A, %B')} {d.day}"
    prev_date = (d - timedelta(days=1)).isoformat()
    next_date = (d + timedelta(days=1)).isoformat()

    return render_template(
        "dashboard.html",
        log_date=log_date,
        display_date=display_date,
        today=date.today().isoformat(),
        prev_date=prev_date,
        next_date=next_date,
        totals=totals,
        goal=goal,
        ring_pct=ring_pct,
        ring_angle=ring_pct * 3.6,
        over_goal=over_goal,
        remaining=remaining,
        foods=foods,
        exercises=exercises,
        meals=MEALS,
        guessed_meal=guess_meal(),
    )


@app.route("/log/food", methods=["POST"])
def log_food():
    log_date = request.form["log_date"]
    food_id = request.form["food_id"]
    meal = request.form.get("meal") or "other"
    grams = request.form.get("grams")
    conn = db.get_db()

    if grams:
        food = conn.execute("SELECT serving_size_g FROM foods WHERE id = ?", (food_id,)).fetchone()
        if not food or not food["serving_size_g"]:
            flash("This food doesn't have a serving size in grams yet — log it by quantity, or add one from its Edit page.")
            return redirect(url_for("dashboard", date=log_date))
        servings = float(grams) / food["serving_size_g"]
    else:
        servings = request.form["servings"]
        grams = None

    conn.execute(
        "INSERT INTO food_logs (log_date, food_id, servings, grams, meal) VALUES (?, ?, ?, ?, ?)",
        (log_date, food_id, servings, grams, meal),
    )
    conn.commit()
    flash("Food logged.")
    return redirect(url_for("dashboard", date=log_date))


@app.route("/log/food/<int:log_id>/delete", methods=["POST"])
def delete_food_log(log_id):
    log_date = request.form["log_date"]
    conn = db.get_db()
    conn.execute("DELETE FROM food_logs WHERE id = ?", (log_id,))
    conn.commit()
    return redirect(url_for("dashboard", date=log_date))


@app.route("/log/exercise", methods=["POST"])
def log_exercise():
    log_date = request.form["log_date"]
    exercise_id = request.form["exercise_id"]
    quantity = request.form["quantity"]
    conn = db.get_db()
    conn.execute(
        "INSERT INTO exercise_logs (log_date, exercise_id, quantity) VALUES (?, ?, ?)",
        (log_date, exercise_id, quantity),
    )
    conn.commit()
    flash("Exercise logged.")
    return redirect(url_for("dashboard", date=log_date))


@app.route("/log/exercise/<int:log_id>/delete", methods=["POST"])
def delete_exercise_log(log_id):
    log_date = request.form["log_date"]
    conn = db.get_db()
    conn.execute("DELETE FROM exercise_logs WHERE id = ?", (log_id,))
    conn.commit()
    return redirect(url_for("dashboard", date=log_date))


@app.route("/foods")
def foods():
    rows = db.get_db().execute("SELECT * FROM foods ORDER BY name").fetchall()
    active_category = request.args.get("category") or ""

    counts = {}
    for key, label in FOOD_CATEGORIES:
        counts[key] = sum(1 for r in rows if (r["category"] or "other") == key)

    if active_category:
        rows = [r for r in rows if (r["category"] or "other") == active_category]

    groups = []
    for key, label in FOOD_CATEGORIES:
        group_rows = [r for r in rows if (r["category"] or "other") == key]
        if group_rows:
            groups.append({"key": key, "label": label, "rows": group_rows})

    return render_template(
        "foods.html",
        foods=rows,
        groups=groups,
        categories=FOOD_CATEGORIES,
        category_counts=counts,
        active_category=active_category,
        total_count=len(db.get_db().execute("SELECT id FROM foods").fetchall()),
    )


def _size_presets_from_form():
    """Parallel 'size_label'/'size_grams' fields (like a recipe's ingredient rows) -> JSON or None."""
    labels = request.form.getlist("size_label")
    grams = request.form.getlist("size_grams")
    presets = []
    for label, grams_str in zip(labels, grams):
        label = label.strip()
        if not label or not grams_str:
            continue
        try:
            presets.append({"label": label, "grams": float(grams_str)})
        except ValueError:
            continue
    return json.dumps(presets) if presets else None


def parse_size_presets(raw):
    try:
        return json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []


def _food_form_values():
    values = [
        request.form["name"],
        request.form.get("serving_unit") or "serving",
        request.form.get("category") or "other",
        request.form.get("serving_size_g") or None,
        _size_presets_from_form(),
        request.form["calories"],
        request.form.get("protein_g") or 0,
        request.form.get("carbs_g") or 0,
        request.form.get("fat_g") or 0,
    ]
    values += [request.form.get(k) or 0 for k in NUTRIENT_KEYS]
    return values


_FOOD_COLUMNS = ["name", "serving_unit", "category", "serving_size_g", "size_presets", "calories", "protein_g", "carbs_g", "fat_g"] + NUTRIENT_KEYS


@app.route("/foods/new", methods=["GET", "POST"])
def new_food():
    if request.method == "POST":
        conn = db.get_db()
        placeholders = ", ".join("?" for _ in _FOOD_COLUMNS)
        conn.execute(
            f"INSERT INTO foods ({', '.join(_FOOD_COLUMNS)}) VALUES ({placeholders})",
            _food_form_values(),
        )
        conn.commit()
        flash("Food added.")
        return redirect(url_for("foods"))
    return render_template("food_form.html", food=None, nutrients=NUTRIENTS, categories=FOOD_CATEGORIES, size_presets=[])


@app.route("/foods/<int:food_id>/edit", methods=["GET", "POST"])
def edit_food(food_id):
    conn = db.get_db()
    if request.method == "POST":
        assignments = ", ".join(f"{col} = ?" for col in _FOOD_COLUMNS)
        conn.execute(
            f"UPDATE foods SET {assignments} WHERE id = ?",
            _food_form_values() + [food_id],
        )
        conn.commit()
        flash("Food updated.")
        return redirect(url_for("foods"))
    food = conn.execute("SELECT * FROM foods WHERE id = ?", (food_id,)).fetchone()
    return render_template(
        "food_form.html",
        food=food,
        nutrients=NUTRIENTS,
        categories=FOOD_CATEGORIES,
        size_presets=parse_size_presets(food["size_presets"]),
    )


@app.route("/foods/<int:food_id>/delete", methods=["POST"])
def delete_food(food_id):
    conn = db.get_db()
    conn.execute("DELETE FROM foods WHERE id = ?", (food_id,))
    conn.commit()
    flash("Food deleted.")
    return redirect(url_for("foods"))


@app.route("/exercises")
def exercises():
    rows = db.get_db().execute("SELECT * FROM exercises ORDER BY name").fetchall()
    return render_template("exercises.html", exercises=rows)


@app.route("/exercises/new", methods=["GET", "POST"])
def new_exercise():
    if request.method == "POST":
        conn = db.get_db()
        conn.execute(
            "INSERT INTO exercises (name, unit, calories_per_unit) VALUES (?, ?, ?)",
            (
                request.form["name"],
                request.form["unit"] or "minute",
                request.form["calories_per_unit"],
            ),
        )
        conn.commit()
        flash("Exercise added.")
        return redirect(url_for("exercises"))
    return render_template("exercise_form.html", exercise=None)


@app.route("/exercises/<int:exercise_id>/edit", methods=["GET", "POST"])
def edit_exercise(exercise_id):
    conn = db.get_db()
    if request.method == "POST":
        conn.execute(
            "UPDATE exercises SET name = ?, unit = ?, calories_per_unit = ? WHERE id = ?",
            (
                request.form["name"],
                request.form["unit"] or "minute",
                request.form["calories_per_unit"],
                exercise_id,
            ),
        )
        conn.commit()
        flash("Exercise updated.")
        return redirect(url_for("exercises"))
    exercise = conn.execute(
        "SELECT * FROM exercises WHERE id = ?", (exercise_id,)
    ).fetchone()
    return render_template("exercise_form.html", exercise=exercise)


@app.route("/exercises/<int:exercise_id>/delete", methods=["POST"])
def delete_exercise(exercise_id):
    conn = db.get_db()
    conn.execute("DELETE FROM exercises WHERE id = ?", (exercise_id,))
    conn.commit()
    flash("Exercise deleted.")
    return redirect(url_for("exercises"))


@app.route("/history")
def history():
    conn = db.get_db()
    dates = conn.execute(
        """
        SELECT log_date FROM (
            SELECT log_date FROM food_logs
            UNION
            SELECT log_date FROM exercise_logs
        )
        ORDER BY log_date DESC
        LIMIT 60
        """
    ).fetchall()
    rows = [{"log_date": d["log_date"], **day_totals(d["log_date"])} for d in dates]

    max_consumed = max((r["consumed"] for r in rows), default=0) or 1
    max_burned = max((r["burned"] for r in rows), default=0) or 1
    for r in rows:
        r["consumed_pct"] = r["consumed"] / max_consumed * 100
        r["burned_pct"] = r["burned"] / max_burned * 100

    return render_template("history.html", rows=rows)


ACTIVITY_LEVELS = [
    ("sedentary", "Sedentary (little/no exercise)", 1.2),
    ("light", "Lightly active (1-3 days/week)", 1.375),
    ("moderate", "Moderately active (3-5 days/week)", 1.55),
    ("active", "Very active (6-7 days/week)", 1.725),
    ("very_active", "Extremely active (hard exercise + physical job)", 1.9),
]
ACTIVITY_MULTIPLIERS = {k: m for k, _, m in ACTIVITY_LEVELS}
GOAL_ADJUSTMENTS = [
    ("lose", "Lose weight", -500),
    ("maintain", "Maintain weight", 0),
    ("gain", "Gain weight", 500),
]
GOAL_ADJUSTMENT_MAP = {k: adj for k, _, adj in GOAL_ADJUSTMENTS}

PROFILE_KEYS = ["profile_age", "profile_sex", "profile_height_cm", "profile_weight_kg", "profile_activity", "profile_goal"]


def get_profile():
    return {k: get_setting(k) for k in PROFILE_KEYS}


def suggested_targets(profile):
    """Mifflin-St Jeor BMR -> TDEE -> calorie/macro suggestion. None if profile incomplete."""
    try:
        age = float(profile["profile_age"])
        height_cm = float(profile["profile_height_cm"])
        weight_kg = float(profile["profile_weight_kg"])
        sex = profile["profile_sex"]
        activity = profile["profile_activity"]
        goal = profile["profile_goal"]
        if sex not in ("male", "female") or activity not in ACTIVITY_MULTIPLIERS or goal not in GOAL_ADJUSTMENT_MAP:
            return None
    except (TypeError, ValueError):
        return None

    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age
    bmr += 5 if sex == "male" else -161
    tdee = bmr * ACTIVITY_MULTIPLIERS[activity]
    calories = max(1200, tdee + GOAL_ADJUSTMENT_MAP[goal])

    protein_g = weight_kg * 1.6
    fat_g = calories * 0.25 / 9
    carbs_g = max(0, (calories - protein_g * 4 - fat_g * 9) / 4)

    return {"calories": calories, "protein_g": protein_g, "carbs_g": carbs_g, "fat_g": fat_g}


@app.route("/settings", methods=["GET", "POST"])
def settings():
    if request.method == "POST":
        goal = request.form.get("daily_calorie_goal", "").strip()
        if goal:
            set_setting("daily_calorie_goal", goal)
        else:
            conn = db.get_db()
            conn.execute("DELETE FROM settings WHERE key = 'daily_calorie_goal'")
            conn.commit()

        for key in PROFILE_KEYS:
            value = request.form.get(key, "").strip()
            if value:
                set_setting(key, value)
            else:
                conn = db.get_db()
                conn.execute("DELETE FROM settings WHERE key = ?", (key,))
                conn.commit()

        flash("Settings saved.")
        return redirect(url_for("settings"))

    goal = get_setting("daily_calorie_goal")
    profile = get_profile()
    return render_template(
        "settings.html",
        goal=goal,
        profile=profile,
        suggestion=suggested_targets(profile),
        activity_levels=ACTIVITY_LEVELS,
        goal_options=GOAL_ADJUSTMENTS,
    )


EXPORT_TABLES = {
    "foods": ["id", "name", "serving_unit", "calories", "protein_g", "carbs_g", "fat_g"] + NUTRIENT_KEYS,
    "exercises": ["id", "name", "unit", "calories_per_unit"],
    "food_logs": ["id", "log_date", "food_id", "servings", "meal"],
    "exercise_logs": ["id", "log_date", "exercise_id", "quantity"],
    "weight_logs": ["id", "log_date", "weight_kg"],
    "recipes": ["id", "food_id", "name", "yields_servings"],
    "recipe_ingredients": ["id", "recipe_id", "food_id", "servings"],
}


@app.route("/settings/export")
def export_data():
    conn = db.get_db()
    data = {"version": 1, "exported_at": datetime.now().isoformat()}
    for table, cols in EXPORT_TABLES.items():
        rows = conn.execute(f"SELECT {', '.join(cols)} FROM {table}").fetchall()
        data[table] = [dict(r) for r in rows]
    settings_rows = conn.execute("SELECT key, value FROM settings").fetchall()
    data["settings"] = {r["key"]: r["value"] for r in settings_rows}

    buf = io.BytesIO(json.dumps(data, indent=2).encode("utf-8"))
    return send_file(
        buf,
        mimetype="application/json",
        as_attachment=True,
        download_name=f"health-monitor-backup-{date.today().isoformat()}.json",
    )


@app.route("/settings/import", methods=["POST"])
def import_data():
    file = request.files.get("backup_file")
    if not file or not file.filename:
        flash("No file selected.")
        return redirect(url_for("settings"))

    conn = db.get_db()
    try:
        data = json.load(file.stream)
        conn.execute("DELETE FROM recipe_ingredients")
        conn.execute("DELETE FROM recipes")
        conn.execute("DELETE FROM food_logs")
        conn.execute("DELETE FROM exercise_logs")
        conn.execute("DELETE FROM weight_logs")
        conn.execute("DELETE FROM foods")
        conn.execute("DELETE FROM exercises")
        conn.execute("DELETE FROM settings")

        for table, cols in EXPORT_TABLES.items():
            placeholders = ", ".join("?" for _ in cols)
            for row in data.get(table) or []:
                conn.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})", [row.get(c) for c in cols])

        for key, value in (data.get("settings") or {}).items():
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (key, value))

        conn.commit()
        flash("Data restored from backup.")
    except Exception:
        conn.rollback()
        flash("That backup file couldn't be imported — it may be corrupted or in the wrong format.")
    return redirect(url_for("settings"))


@app.route("/weight", methods=["GET", "POST"])
def weight():
    conn = db.get_db()
    if request.method == "POST":
        conn.execute(
            "INSERT INTO weight_logs (log_date, weight_kg) VALUES (?, ?)",
            (request.form["log_date"], request.form["weight_kg"]),
        )
        conn.commit()
        flash("Weight logged.")
        return redirect(url_for("weight"))

    rows = conn.execute("SELECT * FROM weight_logs ORDER BY log_date ASC").fetchall()
    n = len(rows)
    points = []
    if n:
        values = [r["weight_kg"] for r in rows]
        low, high = min(values), max(values)
        span = (high - low) or 1
        for i, r in enumerate(rows):
            x = (i / (n - 1) * 100) if n > 1 else 50
            y = 100 - ((r["weight_kg"] - low) / span * 100)
            points.append((round(x, 2), round(y, 2)))
    polyline = " ".join(f"{x},{y}" for x, y in points)

    return render_template(
        "weight.html",
        rows=list(reversed(rows)),
        points=points,
        polyline=polyline,
        latest=rows[-1] if rows else None,
        today=date.today().isoformat(),
    )


@app.route("/weight/<int:log_id>/delete", methods=["POST"])
def delete_weight(log_id):
    conn = db.get_db()
    conn.execute("DELETE FROM weight_logs WHERE id = ?", (log_id,))
    conn.commit()
    return redirect(url_for("weight"))


RECIPE_NUTRITION_KEYS = ["calories", "protein_g", "carbs_g", "fat_g"] + NUTRIENT_KEYS


def compute_recipe_nutrition(ingredients, yields_servings):
    """ingredients: list of (food_id, servings). Returns per-serving nutrition dict."""
    conn = db.get_db()
    totals = {k: 0.0 for k in RECIPE_NUTRITION_KEYS}
    for food_id, servings in ingredients:
        food = conn.execute("SELECT * FROM foods WHERE id = ?", (food_id,)).fetchone()
        if not food:
            continue
        for k in RECIPE_NUTRITION_KEYS:
            totals[k] += food[k] * servings
    yields_servings = yields_servings or 1
    return {k: v / yields_servings for k, v in totals.items()}


def _recipe_ingredients_from_form():
    food_ids = request.form.getlist("ingredient_food_id")
    servings_list = request.form.getlist("ingredient_servings")
    pairs = []
    for fid, srv in zip(food_ids, servings_list):
        if fid and srv:
            pairs.append((int(fid), float(srv)))
    return pairs


@app.route("/recipes")
def recipes():
    conn = db.get_db()
    rows = conn.execute(
        """
        SELECT r.id, r.name, r.yields_servings, f.calories, f.protein_g, f.carbs_g, f.fat_g
        FROM recipes r JOIN foods f ON f.id = r.food_id
        ORDER BY r.name
        """
    ).fetchall()
    return render_template("recipes.html", recipes=rows)


@app.route("/recipes/new", methods=["GET", "POST"])
def new_recipe():
    conn = db.get_db()
    if request.method == "POST":
        name = request.form["name"]
        yields_servings = float(request.form.get("yields_servings") or 1)
        ingredients = _recipe_ingredients_from_form()
        nutrition = compute_recipe_nutrition(ingredients, yields_servings)

        cols = ["name", "serving_unit", "calories", "protein_g", "carbs_g", "fat_g"] + NUTRIENT_KEYS
        placeholders = ", ".join("?" for _ in cols)
        values = [name, "1 serving", nutrition["calories"], nutrition["protein_g"], nutrition["carbs_g"], nutrition["fat_g"]]
        values += [nutrition[k] for k in NUTRIENT_KEYS]
        cur = conn.execute(f"INSERT INTO foods ({', '.join(cols)}) VALUES ({placeholders})", values)
        food_id = cur.lastrowid

        cur = conn.execute(
            "INSERT INTO recipes (food_id, name, yields_servings) VALUES (?, ?, ?)",
            (food_id, name, yields_servings),
        )
        recipe_id = cur.lastrowid
        for fid, srv in ingredients:
            conn.execute(
                "INSERT INTO recipe_ingredients (recipe_id, food_id, servings) VALUES (?, ?, ?)",
                (recipe_id, fid, srv),
            )
        conn.commit()
        flash("Recipe saved.")
        return redirect(url_for("recipes"))

    foods = conn.execute("SELECT * FROM foods ORDER BY name").fetchall()
    return render_template("recipe_form.html", recipe=None, ingredients=[], foods=foods)


@app.route("/recipes/<int:recipe_id>/edit", methods=["GET", "POST"])
def edit_recipe(recipe_id):
    conn = db.get_db()
    recipe = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
    if request.method == "POST":
        name = request.form["name"]
        yields_servings = float(request.form.get("yields_servings") or 1)
        ingredients = _recipe_ingredients_from_form()
        nutrition = compute_recipe_nutrition(ingredients, yields_servings)

        assignments = ", ".join(f"{col} = ?" for col in ["name", "calories", "protein_g", "carbs_g", "fat_g"] + NUTRIENT_KEYS)
        values = [name, nutrition["calories"], nutrition["protein_g"], nutrition["carbs_g"], nutrition["fat_g"]]
        values += [nutrition[k] for k in NUTRIENT_KEYS]
        conn.execute(f"UPDATE foods SET {assignments} WHERE id = ?", values + [recipe["food_id"]])

        conn.execute("UPDATE recipes SET name = ?, yields_servings = ? WHERE id = ?", (name, yields_servings, recipe_id))
        conn.execute("DELETE FROM recipe_ingredients WHERE recipe_id = ?", (recipe_id,))
        for fid, srv in ingredients:
            conn.execute(
                "INSERT INTO recipe_ingredients (recipe_id, food_id, servings) VALUES (?, ?, ?)",
                (recipe_id, fid, srv),
            )
        conn.commit()
        flash("Recipe updated.")
        return redirect(url_for("recipes"))

    ingredient_rows = conn.execute(
        """
        SELECT ri.food_id, ri.servings, f.name
        FROM recipe_ingredients ri JOIN foods f ON f.id = ri.food_id
        WHERE ri.recipe_id = ?
        """,
        (recipe_id,),
    ).fetchall()
    foods = conn.execute("SELECT * FROM foods ORDER BY name").fetchall()
    return render_template("recipe_form.html", recipe=recipe, ingredients=ingredient_rows, foods=foods)


@app.route("/recipes/<int:recipe_id>/delete", methods=["POST"])
def delete_recipe(recipe_id):
    conn = db.get_db()
    recipe = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
    if recipe:
        conn.execute("DELETE FROM foods WHERE id = ?", (recipe["food_id"],))
    conn.commit()
    flash("Recipe deleted.")
    return redirect(url_for("recipes"))


# Open Food Facts integration. Their API reports every mass-based nutrient
# in grams regardless of scale (confirmed empirically) -- multiplier below
# converts that into whichever unit our own schema uses for that field.
OFF_FIELD_MAP = [
    ("protein_g", "proteins", 1),
    ("carbs_g", "carbohydrates", 1),
    ("fat_g", "fat", 1),
    ("fiber_g", "fiber", 1),
    ("sugar_g", "sugars", 1),
    ("sat_fat_g", "saturated-fat", 1),
    ("cholesterol_mg", "cholesterol", 1000),
    ("sodium_mg", "sodium", 1000),
    ("potassium_mg", "potassium", 1000),
    ("calcium_mg", "calcium", 1000),
    ("iron_mg", "iron", 1000),
    ("magnesium_mg", "magnesium", 1000),
    ("zinc_mg", "zinc", 1000),
    ("vitamin_a_mcg", "vitamin-a", 1_000_000),
    ("vitamin_c_mg", "vitamin-c", 1000),
    ("vitamin_d_mcg", "vitamin-d", 1_000_000),
    ("vitamin_e_mg", "vitamin-e", 1000),
    ("vitamin_k_mcg", "vitamin-k", 1_000_000),
    ("vitamin_b6_mg", "vitamin-b6", 1000),
    ("vitamin_b12_mcg", "vitamin-b12", 1_000_000),
    ("folate_mcg", "folates", 1_000_000),
]
OFF_USER_AGENT = "HealthMonitorApp-Personal/1.0"


def _off_request(url):
    import urllib.request

    # Accept header matters: OFF's bot-protection rejects requests without one,
    # and urllib (unlike curl/browsers) doesn't send one by default.
    req = urllib.request.Request(url, headers={"User-Agent": OFF_USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.load(resp)


# Keyword -> our category, checked against OFF's categories_tags/food_groups_tags.
# Order matters: more specific matches (exotic fruit) must be checked before broader ones (fruit).
OFF_CATEGORY_KEYWORDS = [
    ("exotic_fruits", ["exotic-fruit"]),
    ("fruits", ["fruit"]),
    ("vegetables", ["vegetable", "legume"]),
    ("dairy", ["dairy", "cheese", "yogurt", "yoghurt", "milk"]),
    ("protein", ["meat", "poultry", "fish", "seafood", "egg"]),
    ("grains", ["cereal", "bread", "pasta", "rice", "grain"]),
    ("beverages", ["beverage", "drink", "juice"]),
    ("snacks", ["snack", "chocolate", "candy", "biscuit", "cookie"]),
]


def guess_category_from_off(product):
    text = " ".join(product.get("categories_tags", []) + product.get("food_groups_tags", [])).lower()
    for key, keywords in OFF_CATEGORY_KEYWORDS:
        if any(kw in text for kw in keywords):
            return key
    return "other"


def off_product_to_food(p):
    n = p.get("nutriments", {})
    has_serving = n.get("energy-kcal_serving") is not None
    suffix = "_serving" if has_serving else "_100g"
    serving_unit = (p.get("serving_size") or "1 serving").strip() if has_serving else "100g"

    def raw(off_key):
        v = n.get(f"{off_key}{suffix}")
        try:
            return float(v) if v is not None else 0.0
        except (TypeError, ValueError):
            return 0.0

    brands = p.get("brands") or ""
    if isinstance(brands, list):
        brands = ", ".join(brands)

    if has_serving:
        try:
            serving_size_g = float(p["serving_quantity"]) if p.get("serving_quantity") else None
        except (TypeError, ValueError):
            serving_size_g = None
    else:
        serving_size_g = 100.0

    food = {
        "name": (p.get("product_name") or p.get("generic_name") or "Unnamed product").strip(),
        "brand": brands.strip(),
        "serving_unit": serving_unit,
        "category": guess_category_from_off(p),
        "serving_size_g": serving_size_g,
        "calories": raw("energy-kcal"),
    }
    for our_key, off_key, mult in OFF_FIELD_MAP:
        food[our_key] = raw(off_key) * mult
    return food


def off_search(query, page_size=15):
    import urllib.parse

    # api/v2/search ignores search_terms and returns the whole DB unfiltered
    # (confirmed empirically -- a nonsense query still returned 4.6M "matches").
    # search.openfoodfacts.org (the newer search-a-licious backend) filters
    # correctly but has no CORS headers, so it can't be called from the PWA.
    # This legacy endpoint is the one that both filters correctly AND allows
    # cross-origin browser requests, so both apps use it for consistency.
    # Using the .net mirror instead of .org -- .org's search.pl has been
    # returning 503 "temporarily unavailable" while .net serves it fine.
    params = urllib.parse.urlencode(
        {"search_terms": query, "search_simple": 1, "action": "process", "json": 1, "page_size": page_size}
    )
    data = _off_request(f"https://world.openfoodfacts.net/cgi/search.pl?{params}")
    return [off_product_to_food(p) for p in data.get("products", []) if p.get("product_name")]


def off_lookup_barcode(barcode):
    data = _off_request(f"https://world.openfoodfacts.org/api/v2/product/{barcode}.json")
    if data.get("status") != 1:
        return None
    return off_product_to_food(data["product"])


@app.route("/foods/search")
def search_foods():
    query = request.args.get("q", "").strip()
    results, error = [], None
    if query:
        try:
            results = off_search(query)
        except Exception:
            error = "Couldn't reach the online food database. Check your internet connection and try again."
    return render_template("food_search.html", query=query, results=results, error=error)


@app.route("/foods/search/add", methods=["POST"])
def add_searched_food():
    payload = json.loads(request.form["food_json"])
    cols = ["name", "serving_unit", "category", "serving_size_g", "calories", "protein_g", "carbs_g", "fat_g"] + NUTRIENT_KEYS
    values = [
        payload.get("name") or "Unnamed product",
        payload.get("serving_unit") or "100g",
        payload.get("category") or "other",
        payload.get("serving_size_g") or None,
        payload.get("calories") or 0,
        payload.get("protein_g") or 0,
        payload.get("carbs_g") or 0,
        payload.get("fat_g") or 0,
    ]
    values += [payload.get(k) or 0 for k in NUTRIENT_KEYS]
    placeholders = ", ".join("?" for _ in cols)
    conn = db.get_db()
    conn.execute(f"INSERT INTO foods ({', '.join(cols)}) VALUES ({placeholders})", values)
    conn.commit()
    flash(f'Added "{payload.get("name")}" to your foods.')
    return redirect(url_for("foods"))


@app.route("/foods/scan", methods=["GET", "POST"])
def scan_barcode():
    barcode, product, error = None, None, None
    if request.method == "POST":
        barcode = request.form.get("barcode", "").strip()
        if barcode:
            try:
                product = off_lookup_barcode(barcode)
                if not product:
                    error = f'No product found for barcode "{barcode}".'
            except Exception:
                error = "Couldn't reach the online food database. Check your internet connection and try again."
    return render_template("food_scan.html", barcode=barcode, product=product, error=error)


def lan_ip():
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def get_or_create_cert(ip):
    """Return (cert_path, key_path) for a stable, long-lived self-signed cert.

    Reused across restarts so a phone that trusts it once stays trusted,
    instead of getting a fresh untrusted cert every time the server starts.
    Regenerated only if the LAN IP has changed since it was issued.
    """
    import datetime
    import ipaddress

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    cert_dir = Path(__file__).parent / ".certs"
    cert_dir.mkdir(exist_ok=True)
    cert_path = cert_dir / "cert.pem"
    key_path = cert_dir / "key.pem"
    meta_path = cert_dir / "meta.txt"

    if cert_path.exists() and key_path.exists() and meta_path.exists():
        if meta_path.read_text().strip() == ip:
            return str(cert_path), str(key_path)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Health Monitor Local")])
    san = x509.SubjectAlternativeName(
        [
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            x509.IPAddress(ipaddress.ip_address(ip)),
        ]
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(san, critical=False)
        .sign(key, hashes.SHA256())
    )

    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    meta_path.write_text(ip)

    return str(cert_path), str(key_path)


if __name__ == "__main__":
    import threading
    import webbrowser

    from werkzeug.serving import run_simple

    db.init_db()

    ip = lan_ip()
    cert_path, key_path = get_or_create_cert(ip)
    print("=" * 60, flush=True)
    print("Health Monitor is running.", flush=True)
    print("  On this PC:      http://127.0.0.1:5000/", flush=True)
    print(f"  From your phone: https://{ip}:5443/mobile/", flush=True)
    print("  (same WiFi network required. First time only: your browser", flush=True)
    print("   will warn about an untrusted certificate — this is a stable,", flush=True)
    print("   self-signed cert this PC keeps reusing, saved at:", flush=True)
    print(f"   {cert_path}", flush=True)
    print("   To stop seeing that warning for good, copy that .pem file to", flush=True)
    print("   your phone and trust it once (see the setup notes). Then use", flush=True)
    print("   'Add to Home Screen' to install the app.)", flush=True)
    print("=" * 60, flush=True)

    threading.Thread(
        target=lambda: run_simple("0.0.0.0", 5443, app, ssl_context=(cert_path, key_path)),
        daemon=True,
    ).start()

    threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:5000/")).start()
    run_simple("127.0.0.1", 5000, app, use_reloader=False)
