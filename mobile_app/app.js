import { db } from "./idb.js";
import { icons } from "./icons.js";
import { NUTRIENTS, NUTRIENT_KEYS } from "./nutrients.js";
import { SEED_EXERCISES, SEED_FOODS } from "./seed_data.js";

const view = document.getElementById("view");
const pageTitle = document.getElementById("pageTitle");
const tabs = document.querySelectorAll(".tab");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function groupBy(items, field) {
  const groups = new Map();
  for (const item of items) {
    const key = item[field];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function formatDisplayDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

async function dayTotals(dateStr) {
  const [foodLogs, exerciseLogs, foods, exercises] = await Promise.all([
    db.getAllByIndex("foodLogs", "byDate", dateStr),
    db.getAllByIndex("exerciseLogs", "byDate", dateStr),
    db.getAll("foods"),
    db.getAll("exercises"),
  ]);
  const foodsById = new Map(foods.map((f) => [f.id, f]));
  const exercisesById = new Map(exercises.map((e) => [e.id, e]));

  const foodRows = foodLogs
    .map((l) => {
      const f = foodsById.get(l.foodId);
      if (!f) return null;
      const row = {
        id: l.id,
        name: f.name,
        servingUnit: f.servingUnit,
        servings: l.servings,
        calories: f.calories * l.servings,
        proteinG: f.proteinG * l.servings,
        carbsG: f.carbsG * l.servings,
        fatG: f.fatG * l.servings,
      };
      for (const k of NUTRIENT_KEYS) row[k] = (f[k] || 0) * l.servings;
      return row;
    })
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);

  const exerciseRows = exerciseLogs
    .map((l) => {
      const e = exercisesById.get(l.exerciseId);
      if (!e) return null;
      return {
        id: l.id,
        name: e.name,
        unit: e.unit,
        quantity: l.quantity,
        caloriesBurned: e.caloriesPerUnit * l.quantity,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);

  const consumed = foodRows.reduce((s, r) => s + r.calories, 0);
  const burned = exerciseRows.reduce((s, r) => s + r.caloriesBurned, 0);
  const protein = foodRows.reduce((s, r) => s + r.proteinG, 0);
  const carbs = foodRows.reduce((s, r) => s + r.carbsG, 0);
  const fat = foodRows.reduce((s, r) => s + r.fatG, 0);

  const macroKcal = { protein: protein * 4, carbs: carbs * 4, fat: fat * 9 };
  const macroTotal = macroKcal.protein + macroKcal.carbs + macroKcal.fat;
  const macroPct = {
    protein: macroTotal ? (macroKcal.protein / macroTotal) * 100 : 0,
    carbs: macroTotal ? (macroKcal.carbs / macroTotal) * 100 : 0,
    fat: macroTotal ? (macroKcal.fat / macroTotal) * 100 : 0,
  };

  const nutrients = {};
  for (const n of NUTRIENTS) {
    const total = foodRows.reduce((s, r) => s + r[n.key], 0);
    const pct = n.dv ? Math.min((total / n.dv) * 100, 999) : null;
    nutrients[n.key] = { ...n, total, pct };
  }

  return { foodRows, exerciseRows, consumed, burned, net: consumed - burned, protein, carbs, fat, macroPct, nutrients, foods, exercises };
}

async function getGoal() {
  const row = await db.get("settings", "dailyCalorieGoal");
  return row ? parseFloat(row.value) : null;
}

function currentDashboardDate() {
  const hash = location.hash;
  const qIndex = hash.indexOf("?");
  if (qIndex === -1) return todayISO();
  const params = new URLSearchParams(hash.slice(qIndex));
  return params.get("date") || todayISO();
}

async function renderDashboard() {
  const dateStr = currentDashboardDate();
  const totals = await dayTotals(dateStr);
  const goal = await getGoal();
  const isToday = dateStr === todayISO();
  const ringPct = goal ? Math.min(totals.consumed / goal, 1) * 100 : 0;
  const overGoal = !!goal && totals.consumed > goal;
  const remaining = goal ? goal - totals.net : null;
  const prev = addDays(dateStr, -1);
  const next = addDays(dateStr, 1);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <p class="eyebrow">${isToday ? "Today" : "Logged day"}</p>
        <h1>${formatDisplayDate(dateStr)}</h1>
      </div>
      <div class="date-nav">
        <a class="icon-btn" href="#/?date=${prev}">${icons.chevronLeft}</a>
        <input type="date" id="datePicker" value="${dateStr}">
        <a class="icon-btn" href="#/?date=${next}">${icons.chevronRight}</a>
        ${isToday ? "" : `<a class="pill-btn" href="#/">Today</a>`}
      </div>
    </div>

    <section class="hero">
      <div class="ring-wrap">
        <div class="ring ${goal ? "" : "no-goal"}" style="--angle:${ringPct * 3.6}deg; --ring-color:${overGoal ? "var(--coral)" : "var(--lime)"}"></div>
        <div class="ring-center">
          <span class="ring-value">${Math.round(totals.consumed)}</span>
          <span class="ring-unit">kcal in</span>
        </div>
      </div>
      <div class="hero-stats">
        <div class="stat">
          <span class="stat-icon burn">${icons.dumbbell}</span>
          <div><span class="stat-value">${Math.round(totals.burned)}</span><span class="stat-label">burned</span></div>
        </div>
        <div class="stat">
          <span class="stat-icon net">${icons.pulse}</span>
          <div><span class="stat-value">${Math.round(totals.net)}</span><span class="stat-label">net calories</span></div>
        </div>
        ${
          goal
            ? `<div class="stat">
                <span class="stat-icon ${overGoal ? "over" : "goal"}">${icons.flame}</span>
                <div><span class="stat-value">${Math.round(remaining)}</span><span class="stat-label">${overGoal ? "over" : "remaining"} of ${Math.round(goal)}</span></div>
              </div>`
            : `<a class="stat-goal-empty" href="#/settings">${icons.plus} Set a daily goal</a>`
        }
      </div>
    </section>

    <section class="card">
      <h2>Macro Breakdown</h2>
      ${
        totals.protein || totals.carbs || totals.fat
          ? `<div class="macro-bar">
              <span class="seg protein" style="width:${totals.macroPct.protein}%"></span>
              <span class="seg carbs" style="width:${totals.macroPct.carbs}%"></span>
              <span class="seg fat" style="width:${totals.macroPct.fat}%"></span>
            </div>
            <div class="macro-legend">
              <span><i class="dot protein"></i>Protein &middot; ${totals.protein.toFixed(1)}g</span>
              <span><i class="dot carbs"></i>Carbs &middot; ${totals.carbs.toFixed(1)}g</span>
              <span><i class="dot fat"></i>Fat &middot; ${totals.fat.toFixed(1)}g</span>
            </div>`
          : `<p class="empty">Log a food to see your macro breakdown.</p>`
      }
    </section>

    <section class="card log-card food-theme">
      <div class="log-card-head"><h2>${icons.fork} Food Log</h2></div>
      <form id="quickAddFood" class="quick-add">
        <select id="foodSelect" required>
          <option value="" disabled selected>Select food&hellip;</option>
          ${totals.foods.map((f) => `<option value="${f.id}">${esc(f.name)} &middot; ${Math.round(f.calories)} kcal</option>`).join("")}
        </select>
        <input type="number" step="0.1" min="0" id="foodServings" placeholder="Qty" value="1" required>
        <button type="submit">${icons.plus}</button>
      </form>
      ${
        !totals.foods.length
          ? `<p class="empty">No foods yet. <a href="#/foods/new">Add one</a>.</p>`
          : !totals.foodRows.length
          ? `<p class="empty">Nothing logged yet today.</p>`
          : ""
      }
      <ul class="log-list">
        ${totals.foodRows
          .map(
            (row, i) => `
        <li class="log-item" style="animation-delay:${i * 40}ms">
          <div class="log-item-main"><span class="log-item-name">${esc(row.name)}</span><span class="log-item-meta">${row.servings} &times; ${esc(row.servingUnit)}</span></div>
          <span class="log-item-kcal">${Math.round(row.calories)}</span>
          <button class="icon-btn danger" data-delete-food-log="${row.id}">${icons.trash}</button>
        </li>`
          )
          .join("")}
      </ul>
    </section>

    <section class="card log-card exercise-theme">
      <div class="log-card-head"><h2>${icons.dumbbell} Exercise Log</h2></div>
      <form id="quickAddExercise" class="quick-add">
        <select id="exerciseSelect" required>
          <option value="" disabled selected>Select exercise&hellip;</option>
          ${totals.exercises.map((e) => `<option value="${e.id}">${esc(e.name)} &middot; ${Math.round(e.caloriesPerUnit)} kcal/${esc(e.unit)}</option>`).join("")}
        </select>
        <input type="number" step="0.1" min="0" id="exerciseQuantity" placeholder="Qty" value="1" required>
        <button type="submit">${icons.plus}</button>
      </form>
      ${
        !totals.exercises.length
          ? `<p class="empty">No exercises yet. <a href="#/exercises/new">Add one</a>.</p>`
          : !totals.exerciseRows.length
          ? `<p class="empty">Nothing logged yet today.</p>`
          : ""
      }
      <ul class="log-list">
        ${totals.exerciseRows
          .map(
            (row, i) => `
        <li class="log-item" style="animation-delay:${i * 40}ms">
          <div class="log-item-main"><span class="log-item-name">${esc(row.name)}</span><span class="log-item-meta">${row.quantity} ${esc(row.unit)}</span></div>
          <span class="log-item-kcal">${Math.round(row.caloriesBurned)}</span>
          <button class="icon-btn danger" data-delete-exercise-log="${row.id}">${icons.trash}</button>
        </li>`
          )
          .join("")}
      </ul>
    </section>

    <section class="card">
      <h2>Vitamins &amp; Minerals</h2>
      ${
        totals.protein || totals.carbs || totals.fat
          ? groupBy(Object.values(totals.nutrients), "group")
              .map(
                ([group, items]) => `
              <h3 class="nutrient-group-title">${group}</h3>
              <div class="nutrient-rows">
                ${items
                  .map(
                    (n) => `
                <div class="nutrient-row">
                  <span class="nutrient-name">${n.label}</span>
                  <span class="nutrient-amount">${n.total.toFixed(1)}${n.unit}</span>
                  ${
                    n.pct !== null
                      ? `<span class="nutrient-bar-track"><span class="nutrient-bar-fill" style="width:${n.pct}%"></span></span><span class="nutrient-pct">${Math.round(n.pct)}%</span>`
                      : `<span class="nutrient-bar-track"></span><span class="nutrient-pct">&mdash;</span>`
                  }
                </div>`
                  )
                  .join("")}
              </div>`
              )
              .join("")
          : `<p class="empty">Log a food to see your vitamin and mineral breakdown.</p>`
      }
    </section>
  `;

  document.getElementById("datePicker").addEventListener("change", (e) => {
    location.hash = `#/?date=${e.target.value}`;
  });

  document.getElementById("quickAddFood").addEventListener("submit", async (e) => {
    e.preventDefault();
    const foodId = Number(document.getElementById("foodSelect").value);
    const servings = parseFloat(document.getElementById("foodServings").value);
    if (!foodId || !servings) return;
    await db.add("foodLogs", { date: dateStr, foodId, servings });
    toast("Food logged");
    renderDashboard();
  });

  document.getElementById("quickAddExercise").addEventListener("submit", async (e) => {
    e.preventDefault();
    const exerciseId = Number(document.getElementById("exerciseSelect").value);
    const quantity = parseFloat(document.getElementById("exerciseQuantity").value);
    if (!exerciseId || !quantity) return;
    await db.add("exerciseLogs", { date: dateStr, exerciseId, quantity });
    toast("Exercise logged");
    renderDashboard();
  });

  view.querySelectorAll("[data-delete-food-log]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await db.remove("foodLogs", Number(btn.dataset.deleteFoodLog));
      renderDashboard();
    });
  });
  view.querySelectorAll("[data-delete-exercise-log]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await db.remove("exerciseLogs", Number(btn.dataset.deleteExerciseLog));
      renderDashboard();
    });
  });
}

async function renderFoodsList() {
  const foods = (await db.getAll("foods")).sort((a, b) => a.name.localeCompare(b.name));
  view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Your library</p><h1>Foods</h1></div>
      <a class="pill-btn" href="#/foods/new">${icons.plus} Add</a>
    </div>
    ${
      foods.length
        ? `<div class="item-grid">
            ${foods
              .map(
                (f, i) => `
            <div class="item-card" style="animation-delay:${i * 30}ms">
              <div class="item-card-top">
                <div><div class="item-name">${esc(f.name)}</div><div class="item-sub">per ${esc(f.servingUnit)}</div></div>
                <div class="item-kcal food">${Math.round(f.calories)}<span>kcal</span></div>
              </div>
              <div class="item-macros">
                <span><i class="dot protein"></i>${f.proteinG.toFixed(1)}g</span>
                <span><i class="dot carbs"></i>${f.carbsG.toFixed(1)}g</span>
                <span><i class="dot fat"></i>${f.fatG.toFixed(1)}g</span>
              </div>
              <div class="item-actions">
                <button data-edit-food="${f.id}">${icons.pencil} Edit</button>
                <button class="danger" data-delete-food="${f.id}">${icons.trash} Delete</button>
              </div>
            </div>`
              )
              .join("")}
          </div>`
        : `<p class="empty">No foods yet. <a href="#/foods/new">Add your first one</a>.</p>`
    }
  `;
  view.querySelectorAll("[data-edit-food]").forEach((b) =>
    b.addEventListener("click", () => (location.hash = `#/foods/${b.dataset.editFood}/edit`))
  );
  view.querySelectorAll("[data-delete-food]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this food? This also removes its log entries.")) return;
      const id = Number(b.dataset.deleteFood);
      await db.remove("foods", id);
      await db.removeWhere("foodLogs", (l) => l.foodId === id);
      toast("Food deleted");
      renderFoodsList();
    })
  );
}

async function renderFoodForm(id) {
  const food = id ? await db.get("foods", id) : null;

  const nutrientGroupsHtml = groupBy(NUTRIENTS, "group")
    .map(
      ([group, items]) => `
      <h3 class="nutrient-group-title">${group}</h3>
      <div class="form-row-3">
        ${items
          .map(
            (n) => `<label>${n.label} (${n.unit})<input type="number" step="0.01" min="0" id="n_${n.key}" value="${food ? food[n.key] || 0 : 0}"></label>`
          )
          .join("")}
      </div>`
    )
    .join("");

  view.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Food library</p><h1>${food ? "Edit" : "Add"} Food</h1></div></div>
    <div class="card form-card">
      <form id="foodForm" class="form">
        <label>Name<input type="text" id="fName" required value="${food ? esc(food.name) : ""}" placeholder="e.g. Grilled chicken breast"></label>
        <label>Serving unit<input type="text" id="fUnit" value="${food ? esc(food.servingUnit) : "serving"}" placeholder="e.g. cup, 100g, slice"></label>
        <label>Calories per serving<input type="number" step="0.1" min="0" id="fCalories" required value="${food ? food.calories : ""}" placeholder="0"></label>
        <div class="form-row-3">
          <label>Protein (g)<input type="number" step="0.1" min="0" id="fProtein" value="${food ? food.proteinG : 0}"></label>
          <label>Carbs (g)<input type="number" step="0.1" min="0" id="fCarbs" value="${food ? food.carbsG : 0}"></label>
          <label>Fat (g)<input type="number" step="0.1" min="0" id="fFat" value="${food ? food.fatG : 0}"></label>
        </div>

        <details class="nutrient-details">
          <summary>Vitamins &amp; minerals (optional)</summary>
          ${nutrientGroupsHtml}
        </details>

        <div class="form-actions">
          <button type="submit" class="btn primary">Save Food</button>
          <a class="btn" href="#/foods">Cancel</a>
        </div>
      </form>
    </div>
  `;
  document.getElementById("foodForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById("fName").value.trim(),
      servingUnit: document.getElementById("fUnit").value.trim() || "serving",
      calories: parseFloat(document.getElementById("fCalories").value) || 0,
      proteinG: parseFloat(document.getElementById("fProtein").value) || 0,
      carbsG: parseFloat(document.getElementById("fCarbs").value) || 0,
      fatG: parseFloat(document.getElementById("fFat").value) || 0,
    };
    for (const n of NUTRIENTS) payload[n.key] = parseFloat(document.getElementById(`n_${n.key}`).value) || 0;
    if (food) {
      payload.id = food.id;
      await db.put("foods", payload);
    } else {
      await db.add("foods", payload);
    }
    toast("Food saved");
    location.hash = "#/foods";
  });
}

async function renderExercisesList() {
  const exercises = (await db.getAll("exercises")).sort((a, b) => a.name.localeCompare(b.name));
  view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Your library</p><h1>Exercises</h1></div>
      <a class="pill-btn" href="#/exercises/new">${icons.plus} Add</a>
    </div>
    ${
      exercises.length
        ? `<div class="item-grid">
            ${exercises
              .map(
                (e, i) => `
            <div class="item-card" style="animation-delay:${i * 30}ms">
              <div class="item-card-top">
                <div><div class="item-name">${esc(e.name)}</div><div class="item-sub">per ${esc(e.unit)}</div></div>
                <div class="item-kcal exercise">${e.caloriesPerUnit.toFixed(1)}<span>kcal</span></div>
              </div>
              <div class="item-actions">
                <button data-edit-exercise="${e.id}">${icons.pencil} Edit</button>
                <button class="danger" data-delete-exercise="${e.id}">${icons.trash} Delete</button>
              </div>
            </div>`
              )
              .join("")}
          </div>`
        : `<p class="empty">No exercises yet. <a href="#/exercises/new">Add your first one</a>.</p>`
    }
  `;
  view.querySelectorAll("[data-edit-exercise]").forEach((b) =>
    b.addEventListener("click", () => (location.hash = `#/exercises/${b.dataset.editExercise}/edit`))
  );
  view.querySelectorAll("[data-delete-exercise]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this exercise? This also removes its log entries.")) return;
      const id = Number(b.dataset.deleteExercise);
      await db.remove("exercises", id);
      await db.removeWhere("exerciseLogs", (l) => l.exerciseId === id);
      toast("Exercise deleted");
      renderExercisesList();
    })
  );
}

async function renderExerciseForm(id) {
  const exercise = id ? await db.get("exercises", id) : null;
  view.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Exercise library</p><h1>${exercise ? "Edit" : "Add"} Exercise</h1></div></div>
    <div class="card form-card">
      <form id="exerciseForm" class="form">
        <label>Name<input type="text" id="eName" required value="${exercise ? esc(exercise.name) : ""}" placeholder="e.g. Running"></label>
        <label>Unit<input type="text" id="eUnit" value="${exercise ? esc(exercise.unit) : "minute"}" placeholder="e.g. minute, session, km"></label>
        <label>Calories burned per unit<input type="number" step="0.1" min="0" id="eCalories" required value="${exercise ? exercise.caloriesPerUnit : ""}" placeholder="0"></label>
        <div class="form-actions">
          <button type="submit" class="btn primary">Save Exercise</button>
          <a class="btn" href="#/exercises">Cancel</a>
        </div>
      </form>
    </div>
  `;
  document.getElementById("exerciseForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById("eName").value.trim(),
      unit: document.getElementById("eUnit").value.trim() || "minute",
      caloriesPerUnit: parseFloat(document.getElementById("eCalories").value) || 0,
    };
    if (exercise) {
      payload.id = exercise.id;
      await db.put("exercises", payload);
    } else {
      await db.add("exercises", payload);
    }
    toast("Exercise saved");
    location.hash = "#/exercises";
  });
}

async function renderHistory() {
  const [foodLogs, exerciseLogs] = await Promise.all([db.getAll("foodLogs"), db.getAll("exerciseLogs")]);
  const dates = Array.from(new Set([...foodLogs.map((l) => l.date), ...exerciseLogs.map((l) => l.date)]))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 60);

  const rows = [];
  for (const d of dates) rows.push({ date: d, ...(await dayTotals(d)) });
  const maxConsumed = Math.max(1, ...rows.map((r) => r.consumed));
  const maxBurned = Math.max(1, ...rows.map((r) => r.burned));

  view.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Last 60 logged days</p><h1>History</h1></div></div>
    ${
      rows.length
        ? `<div class="history-list">
            ${rows
              .map(
                (r, i) => `
            <a class="history-row" href="#/?date=${r.date}" style="animation-delay:${i * 25}ms">
              <span class="history-date">${r.date}</span>
              <span class="history-bars">
                <span class="history-bar-track"><span class="history-bar-fill consumed" style="width:${(r.consumed / maxConsumed) * 100}%"></span></span>
                <span class="history-bar-track"><span class="history-bar-fill burned" style="width:${(r.burned / maxBurned) * 100}%"></span></span>
              </span>
              <span class="history-net">${Math.round(r.net)}<small>kcal</small></span>
            </a>`
              )
              .join("")}
          </div>`
        : `<p class="empty">No history yet. Log a food or exercise to get started.</p>`
    }
  `;
}

async function renderSettings() {
  const goal = await getGoal();
  view.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Preferences</p><h1>Settings</h1></div></div>
    <div class="card form-card">
      <form id="settingsForm" class="form">
        <label>Daily calorie goal (net, optional)<input type="number" step="1" min="0" id="goalInput" value="${goal ?? ""}" placeholder="e.g. 2000"></label>
        <div class="form-actions"><button type="submit" class="btn primary">Save</button></div>
      </form>
      <p class="empty" style="margin-top:1rem">All data lives only on this device, in this browser. Uninstalling the app or clearing site data will erase it.</p>
    </div>
  `;
  document.getElementById("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = document.getElementById("goalInput").value.trim();
    if (val) await db.put("settings", { key: "dailyCalorieGoal", value: val });
    else await db.remove("settings", "dailyCalorieGoal");
    toast("Settings saved");
  });
}

const routes = [
  { pattern: /^#\/(\?.*)?$/, tab: "dashboard", title: "Dashboard", render: renderDashboard },
  { pattern: /^#\/foods$/, tab: "foods", title: "Foods", render: renderFoodsList },
  { pattern: /^#\/foods\/new$/, tab: "foods", title: "Add Food", render: () => renderFoodForm(null) },
  { pattern: /^#\/foods\/(\d+)\/edit$/, tab: "foods", title: "Edit Food", render: (m) => renderFoodForm(Number(m[1])) },
  { pattern: /^#\/exercises$/, tab: "exercises", title: "Exercises", render: renderExercisesList },
  { pattern: /^#\/exercises\/new$/, tab: "exercises", title: "Add Exercise", render: () => renderExerciseForm(null) },
  { pattern: /^#\/exercises\/(\d+)\/edit$/, tab: "exercises", title: "Edit Exercise", render: (m) => renderExerciseForm(Number(m[1])) },
  { pattern: /^#\/history$/, tab: "history", title: "History", render: renderHistory },
  { pattern: /^#\/settings$/, tab: "settings", title: "Settings", render: renderSettings },
];

async function router() {
  const hash = location.hash || "#/";
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (m) {
      tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === r.tab));
      pageTitle.textContent = r.title;
      await r.render(m);
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = "#/";
}

async function seedIfEmpty() {
  const [foods, exercises] = await Promise.all([db.getAll("foods"), db.getAll("exercises")]);
  if (foods.length === 0) {
    for (const f of SEED_FOODS) await db.add("foods", f);
  }
  if (exercises.length === 0) {
    for (const e of SEED_EXERCISES) await db.add("exercises", e);
  }
}

window.addEventListener("hashchange", router);
seedIfEmpty().then(router);
