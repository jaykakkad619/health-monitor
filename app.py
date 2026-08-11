from datetime import date, timedelta
from pathlib import Path

from flask import Blueprint, Flask, flash, redirect, render_template, request, url_for

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


def day_totals(log_date):
    conn = db.get_db()

    nutrient_select = ",\n               ".join(f"f.{k} * fl.servings AS {k}" for k in NUTRIENT_KEYS)
    food_rows = conn.execute(
        f"""
        SELECT fl.id, f.name, f.serving_unit, fl.servings,
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

    return {
        "food_rows": food_rows,
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
    )


@app.route("/log/food", methods=["POST"])
def log_food():
    log_date = request.form["log_date"]
    food_id = request.form["food_id"]
    servings = request.form["servings"]
    conn = db.get_db()
    conn.execute(
        "INSERT INTO food_logs (log_date, food_id, servings) VALUES (?, ?, ?)",
        (log_date, food_id, servings),
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
    return render_template("foods.html", foods=rows)


def _food_form_values():
    values = [
        request.form["name"],
        request.form["serving_unit"] or "serving",
        request.form["calories"],
        request.form.get("protein_g") or 0,
        request.form.get("carbs_g") or 0,
        request.form.get("fat_g") or 0,
    ]
    values += [request.form.get(k) or 0 for k in NUTRIENT_KEYS]
    return values


_FOOD_COLUMNS = ["name", "serving_unit", "calories", "protein_g", "carbs_g", "fat_g"] + NUTRIENT_KEYS


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
    return render_template("food_form.html", food=None, nutrients=NUTRIENTS)


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
    return render_template("food_form.html", food=food, nutrients=NUTRIENTS)


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
        flash("Settings saved.")
        return redirect(url_for("settings"))
    goal = get_setting("daily_calorie_goal")
    return render_template("settings.html", goal=goal)


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
