import { db } from "./idb.js";
import { icons } from "./icons.js";
import { NUTRIENTS, NUTRIENT_KEYS } from "./nutrients.js";
import { SEED_EXERCISES, SEED_FOODS } from "./seed_data.js";

const view = document.getElementById("view");
const pageTitle = document.getElementById("pageTitle");
const tabs = document.querySelectorAll(".tab");

// Open Food Facts integration. Their API reports every mass-based nutrient
// in grams regardless of scale (confirmed empirically) -- multiplier below
// converts that into whichever unit our own schema uses for that field.
const OFF_FIELD_MAP = [
  ["proteinG", "proteins", 1],
  ["carbsG", "carbohydrates", 1],
  ["fatG", "fat", 1],
  ["fiberG", "fiber", 1],
  ["sugarG", "sugars", 1],
  ["satFatG", "saturated-fat", 1],
  ["cholesterolMg", "cholesterol", 1000],
  ["sodiumMg", "sodium", 1000],
  ["potassiumMg", "potassium", 1000],
  ["calciumMg", "calcium", 1000],
  ["ironMg", "iron", 1000],
  ["magnesiumMg", "magnesium", 1000],
  ["zincMg", "zinc", 1000],
  ["vitaminAMcg", "vitamin-a", 1000000],
  ["vitaminCMg", "vitamin-c", 1000],
  ["vitaminDMcg", "vitamin-d", 1000000],
  ["vitaminEMg", "vitamin-e", 1000],
  ["vitaminKMcg", "vitamin-k", 1000000],
  ["vitaminB6Mg", "vitamin-b6", 1000],
  ["vitaminB12Mcg", "vitamin-b12", 1000000],
  ["folateMcg", "folates", 1000000],
];

function offProductToFood(p) {
  const n = p.nutriments || {};
  const hasServing = n["energy-kcal_serving"] !== undefined;
  const suffix = hasServing ? "_serving" : "_100g";
  const servingUnit = hasServing ? String(p.serving_size || "1 serving").trim() : "100g";
  const raw = (offKey) => {
    const v = n[offKey + suffix];
    const num = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(num) ? num : 0;
  };
  const brands = Array.isArray(p.brands) ? p.brands.join(", ") : String(p.brands || "");
  const servingSizeG = hasServing ? (Number.isFinite(parseFloat(p.serving_quantity)) ? parseFloat(p.serving_quantity) : null) : 100;
  const food = {
    name: String(p.product_name || p.generic_name || "Unnamed product").trim(),
    brand: brands.trim(),
    servingUnit,
    category: guessCategoryFromOff(p),
    servingSizeG,
    calories: raw("energy-kcal"),
  };
  for (const [ourKey, offKey, mult] of OFF_FIELD_MAP) food[ourKey] = raw(offKey) * mult;
  return food;
}

async function offSearch(query, pageSize = 15) {
  // api/v2/search ignores search_terms and returns the whole DB unfiltered
  // (confirmed empirically -- a nonsense query still returned 4.6M "matches").
  // search.openfoodfacts.org (the newer search-a-licious backend) filters
  // correctly but has no CORS headers, so it can't be called from the PWA.
  // This legacy endpoint is the one that both filters correctly AND allows
  // cross-origin browser requests, so both apps use it for consistency.
  // Using the .net mirror instead of .org -- .org's search.pl has been
  // returning 503 "temporarily unavailable" while .net serves it fine.
  const params = new URLSearchParams({ search_terms: query, search_simple: 1, action: "process", json: 1, page_size: pageSize });
  const resp = await fetch(`https://world.openfoodfacts.net/cgi/search.pl?${params}`);
  if (!resp.ok) throw new Error("Search failed");
  const data = await resp.json();
  return (data.products || []).filter((p) => p.product_name).map(offProductToFood);
}

async function offLookupBarcode(barcode) {
  const resp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`);
  if (!resp.ok) throw new Error("Lookup failed");
  const data = await resp.json();
  if (data.status !== 1) return null;
  return offProductToFood(data.product);
}

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

const ACTIVITY_LEVELS = [
  ["sedentary", "Sedentary (little/no exercise)", 1.2],
  ["light", "Lightly active (1-3 days/week)", 1.375],
  ["moderate", "Moderately active (3-5 days/week)", 1.55],
  ["active", "Very active (6-7 days/week)", 1.725],
  ["very_active", "Extremely active (hard exercise + physical job)", 1.9],
];
const GOAL_OPTIONS = [
  ["lose", "Lose weight", -500],
  ["maintain", "Maintain weight", 0],
  ["gain", "Gain weight", 500],
];
const PROFILE_KEYS = ["profileAge", "profileSex", "profileHeightCm", "profileWeightKg", "profileActivity", "profileGoal"];

function suggestedTargets(profile) {
  const age = parseFloat(profile.profileAge);
  const heightCm = parseFloat(profile.profileHeightCm);
  const weightKg = parseFloat(profile.profileWeightKg);
  const activity = ACTIVITY_LEVELS.find((a) => a[0] === profile.profileActivity);
  const goal = GOAL_OPTIONS.find((g) => g[0] === profile.profileGoal);
  if (!age || !heightCm || !weightKg || !activity || !goal || (profile.profileSex !== "male" && profile.profileSex !== "female")) {
    return null;
  }
  let bmr = 10 * weightKg + 6.25 * heightCm - 5 * age;
  bmr += profile.profileSex === "male" ? 5 : -161;
  const tdee = bmr * activity[2];
  const calories = Math.max(1200, tdee + goal[2]);
  const proteinG = weightKg * 1.6;
  const fatG = (calories * 0.25) / 9;
  const carbsG = Math.max(0, (calories - proteinG * 4 - fatG * 9) / 4);
  return { calories, proteinG, carbsG, fatG };
}

const MEALS = [
  ["breakfast", "Breakfast"],
  ["lunch", "Lunch"],
  ["dinner", "Dinner"],
  ["snack", "Snack"],
  ["other", "Other"],
];

const FOOD_CATEGORIES = [
  ["fruits", "Fruits"],
  ["exotic_fruits", "Exotic Fruits"],
  ["vegetables", "Vegetables"],
  ["grains", "Grains"],
  ["protein", "Protein"],
  ["dairy", "Dairy"],
  ["snacks", "Snacks"],
  ["beverages", "Beverages"],
  ["other", "Other"],
];
const CATEGORY_LABELS = Object.fromEntries(FOOD_CATEGORIES);

// Keyword -> our category, checked against OFF's categories_tags/food_groups_tags.
// Order matters: more specific matches (exotic fruit) must be checked before broader ones (fruit).
const OFF_CATEGORY_KEYWORDS = [
  ["exotic_fruits", ["exotic-fruit"]],
  ["fruits", ["fruit"]],
  ["vegetables", ["vegetable", "legume"]],
  ["dairy", ["dairy", "cheese", "yogurt", "yoghurt", "milk"]],
  ["protein", ["meat", "poultry", "fish", "seafood", "egg"]],
  ["grains", ["cereal", "bread", "pasta", "rice", "grain"]],
  ["beverages", ["beverage", "drink", "juice"]],
  ["snacks", ["snack", "chocolate", "candy", "biscuit", "cookie"]],
];

function guessCategoryFromOff(product) {
  const tags = [...(product.categories_tags || []), ...(product.food_groups_tags || [])];
  const text = tags.join(" ").toLowerCase();
  for (const [key, keywords] of OFF_CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => text.includes(kw))) return key;
  }
  return "other";
}

function toSnake(key) {
  return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function toCamel(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function objToSnake(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[toSnake(k)] = v;
  return out;
}

function objToCamel(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[toCamel(k)] = v;
  return out;
}

const EXPORT_STORES = ["foods", "exercises", "foodLogs", "exerciseLogs", "weightLogs", "recipes", "recipeIngredients"];

function toBackupShape(row) {
  const snake = objToSnake(row);
  if (snake.date !== undefined) {
    snake.log_date = snake.date;
    delete snake.date;
  }
  return snake;
}

function fromBackupShape(row) {
  const camel = objToCamel(row);
  if (camel.logDate !== undefined) {
    camel.date = camel.logDate;
    delete camel.logDate;
  }
  return camel;
}

async function exportData() {
  const data = { version: 1, exported_at: new Date().toISOString() };
  for (const store of EXPORT_STORES) {
    const rows = await db.getAll(store);
    data[toSnake(store)] = rows.map(toBackupShape);
  }
  const settingsRows = await db.getAll("settings");
  data.settings = {};
  for (const row of settingsRows) data.settings[toSnake(row.key)] = row.value;

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `health-monitor-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importData(data) {
  for (const store of EXPORT_STORES) await db.clear(store);
  await db.clear("settings");

  for (const store of EXPORT_STORES) {
    const rows = data[toSnake(store)] || [];
    for (const row of rows) await db.put(store, fromBackupShape(row));
  }
  const settingsObj = data.settings || {};
  for (const [snakeKey, value] of Object.entries(settingsObj)) {
    await db.put("settings", { key: toCamel(snakeKey), value });
  }
}

function guessMeal() {
  const hour = new Date().getHours();
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
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
        meal: l.meal || "other",
        name: f.name,
        servingUnit: f.servingUnit,
        servings: l.servings,
        grams: l.grams || null,
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

  const meals = [];
  for (const [key, label] of MEALS) {
    const rows = foodRows.filter((r) => r.meal === key);
    if (!rows.length && key === "other") continue;
    meals.push({ key, label, rows, calories: rows.reduce((s, r) => s + r.calories, 0) });
  }

  return { foodRows, meals, exerciseRows, consumed, burned, net: consumed - burned, protein, carbs, fat, macroPct, nutrients, foods, exercises };
}

async function getGoal() {
  const row = await db.get("settings", "dailyCalorieGoal");
  return row ? parseFloat(row.value) : null;
}

async function getSetting(key) {
  const row = await db.get("settings", key);
  return row ? row.value : null;
}

async function getProfile() {
  const entries = await Promise.all(PROFILE_KEYS.map(async (k) => [k, await getSetting(k)]));
  return Object.fromEntries(entries);
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
          ${totals.foods
            .map(
              (f) =>
                `<option value="${f.id}" data-serving-size-g="${f.servingSizeG || ""}" data-size-presets='${esc(JSON.stringify(f.sizePresets || []))}'>${esc(f.name)} &middot; ${Math.round(f.calories)} kcal</option>`
            )
            .join("")}
        </select>
        <input type="number" step="0.1" min="0" id="foodServings" placeholder="Qty" value="1" required>
        <select id="foodSizeSelect" class="size-select" style="display:none">
          <option value="">Custom grams&hellip;</option>
        </select>
        <input type="number" step="1" min="0" id="foodGrams" placeholder="grams" style="display:none">
        <select id="foodMeal" class="meal-select">
          ${MEALS.map(([key, label]) => `<option value="${key}" ${key === guessMeal() ? "selected" : ""}>${label}</option>`).join("")}
        </select>
        <button type="submit">${icons.plus}</button>
      </form>
      ${!totals.foods.length ? `<p class="empty">No foods yet. <a href="#/foods/new">Add one</a>.</p>` : ""}
      ${totals.meals
        .map(
          (group) => `
        <div class="meal-group">
          <div class="meal-group-head">
            <span class="meal-group-label">${group.label}</span>
            <span class="meal-group-kcal">${Math.round(group.calories)} kcal</span>
          </div>
          <ul class="log-list">
            ${
              group.rows.length
                ? group.rows
                    .map(
                      (row, i) => `
            <li class="log-item" style="animation-delay:${i * 40}ms">
              <div class="log-item-main"><span class="log-item-name">${esc(row.name)}</span><span class="log-item-meta">${row.grams ? `${Math.round(row.grams)}g` : `${row.servings} &times; ${esc(row.servingUnit)}`}</span></div>
              <span class="log-item-kcal">${Math.round(row.calories)}</span>
              <button class="icon-btn danger" data-delete-food-log="${row.id}">${icons.trash}</button>
            </li>`
                    )
                    .join("")
                : `<li class="meal-empty">Nothing logged</li>`
            }
          </ul>
        </div>`
        )
        .join("")}
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

  const foodSelect = document.getElementById("foodSelect");
  const foodQty = document.getElementById("foodServings");
  const foodSizeSelect = document.getElementById("foodSizeSelect");
  const foodGrams = document.getElementById("foodGrams");

  function updateFoodInputs() {
    const opt = foodSelect.selectedOptions[0];
    const servingSizeG = opt && opt.dataset.servingSizeG;
    let presets = [];
    try {
      presets = JSON.parse((opt && opt.dataset.sizePresets) || "[]");
    } catch (e) {
      presets = [];
    }

    foodSizeSelect.innerHTML = '<option value="">Custom grams&hellip;</option>';
    for (const p of presets) {
      const o = document.createElement("option");
      o.value = p.grams;
      o.textContent = `${p.label} (${p.grams}g)`;
      foodSizeSelect.appendChild(o);
    }

    if (presets.length) {
      foodSizeSelect.style.display = "";
      foodGrams.style.display = "";
      foodQty.style.display = "none";
      foodQty.required = false;
      foodSizeSelect.value = presets[0].grams;
      foodGrams.value = presets[0].grams;
    } else if (servingSizeG) {
      foodSizeSelect.style.display = "none";
      foodGrams.style.display = "";
      foodQty.style.display = "none";
      foodQty.required = false;
      foodGrams.value = servingSizeG;
    } else {
      foodSizeSelect.style.display = "none";
      foodGrams.style.display = "none";
      foodQty.style.display = "";
      foodQty.required = true;
      foodGrams.value = "";
    }
  }

  foodSizeSelect.addEventListener("change", () => {
    if (foodSizeSelect.value) foodGrams.value = foodSizeSelect.value;
  });
  foodSelect.addEventListener("change", updateFoodInputs);

  document.getElementById("quickAddFood").addEventListener("submit", async (e) => {
    e.preventDefault();
    const foodId = Number(foodSelect.value);
    const meal = document.getElementById("foodMeal").value;
    if (!foodId) return;

    let servings, grams;
    const gramsVisible = foodGrams.style.display !== "none";
    const gramsVal = gramsVisible ? parseFloat(foodGrams.value) : NaN;
    if (Number.isFinite(gramsVal) && gramsVal > 0) {
      const food = totals.foods.find((f) => f.id === foodId);
      if (!food || !food.servingSizeG) {
        toast("This food doesn't have a serving size in grams — log it by quantity instead.");
        return;
      }
      grams = gramsVal;
      servings = gramsVal / food.servingSizeG;
    } else {
      servings = parseFloat(foodQty.value);
      if (!servings) return;
    }

    await db.add("foodLogs", { date: dateStr, foodId, servings, grams: grams || null, meal });
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

function foodCardHtml(f, i) {
  return `
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
    </div>`;
}

async function renderFoodsList() {
  const hash = location.hash;
  const qIndex = hash.indexOf("?");
  const params = qIndex === -1 ? new URLSearchParams() : new URLSearchParams(hash.slice(qIndex));
  const activeCategory = params.get("category") || "";

  const allFoods = (await db.getAll("foods")).sort((a, b) => a.name.localeCompare(b.name));
  const counts = Object.fromEntries(FOOD_CATEGORIES.map(([key]) => [key, allFoods.filter((f) => (f.category || "other") === key).length]));
  const foods = activeCategory ? allFoods.filter((f) => (f.category || "other") === activeCategory) : allFoods;

  const groups = FOOD_CATEGORIES.map(([key, label]) => ({ key, label, rows: foods.filter((f) => (f.category || "other") === key) })).filter(
    (g) => g.rows.length
  );

  view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Your library</p><h1>Foods</h1></div>
      <div class="page-head-actions">
        <a class="pill-btn secondary" href="#/foods/scan">Scan barcode</a>
        <a class="pill-btn secondary" href="#/foods/search">Search online</a>
        <a class="pill-btn" href="#/foods/new">${icons.plus} Add</a>
      </div>
    </div>
    ${
      allFoods.length
        ? `<div class="filter-row">
            <a class="filter-chip ${!activeCategory ? "active" : ""}" href="#/foods">All &middot; ${allFoods.length}</a>
            ${FOOD_CATEGORIES.filter(([key]) => counts[key])
              .map(([key, label]) => `<a class="filter-chip ${activeCategory === key ? "active" : ""}" href="#/foods?category=${key}">${esc(label)} &middot; ${counts[key]}</a>`)
              .join("")}
          </div>`
        : ""
    }
    ${
      groups.length
        ? groups
            .map(
              (group) => `
          <div class="cat-group">
            <div class="cat-group-head">
              <span class="cat-group-label">${esc(group.label)}</span>
              <span class="cat-group-count">${group.rows.length} item${group.rows.length === 1 ? "" : "s"}</span>
            </div>
            <div class="item-grid">${group.rows.map((f, i) => foodCardHtml(f, i)).join("")}</div>
          </div>`
            )
            .join("")
        : activeCategory
        ? `<p class="empty">No foods in this category yet. <a href="#/foods">Show all foods</a>.</p>`
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

async function renderFoodSearch() {
  const hash = location.hash;
  const qIndex = hash.indexOf("?");
  const params = qIndex === -1 ? new URLSearchParams() : new URLSearchParams(hash.slice(qIndex));
  const query = params.get("q") || "";

  view.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Food library</p><h1>Search Online</h1></div></div>
    <form id="searchForm" class="search-bar">
      <input type="text" id="searchQuery" value="${esc(query)}" placeholder="e.g. oats, greek yogurt, protein bar" autofocus>
      <button type="submit" class="btn primary">Search</button>
    </form>
    <p class="empty">Searches a free public packaged-food database (Open Food Facts) &mdash; best for branded/packaged items, not home-cooked dishes. Requires internet; results vary in completeness.</p>
    <div id="searchResults"></div>
  `;

  document.getElementById("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("searchQuery").value.trim();
    location.hash = `#/foods/search?q=${encodeURIComponent(q)}`;
  });

  if (!query) return;

  const resultsEl = document.getElementById("searchResults");
  resultsEl.innerHTML = `<p class="empty">Searching&hellip;</p>`;
  let results = [];
  try {
    results = await offSearch(query);
  } catch (err) {
    resultsEl.innerHTML = `<p class="empty">Couldn't reach the online food database. Check your internet connection and try again.</p>`;
    return;
  }

  resultsEl.innerHTML = results.length
    ? `<div class="item-grid">
        ${results
          .map(
            (r, i) => `
        <div class="item-card" style="animation-delay:${i * 30}ms">
          <div class="item-card-top">
            <div><div class="item-name">${esc(r.name)}</div><div class="item-sub">${esc(r.brand)}${r.brand ? " &middot; " : ""}per ${esc(r.servingUnit)}</div></div>
            <div class="item-kcal food">${Math.round(r.calories)}<span>kcal</span></div>
          </div>
          <div class="item-macros">
            <span><i class="dot protein"></i>${r.proteinG.toFixed(1)}g</span>
            <span><i class="dot carbs"></i>${r.carbsG.toFixed(1)}g</span>
            <span><i class="dot fat"></i>${r.fatG.toFixed(1)}g</span>
          </div>
          <button type="button" class="btn primary" style="width:100%" data-add-search="${i}">${icons.plus} Add to my foods</button>
        </div>`
          )
          .join("")}
      </div>`
    : `<p class="empty">No results for &ldquo;${esc(query)}&rdquo;.</p>`;

  resultsEl.querySelectorAll("[data-add-search]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const r = results[Number(btn.dataset.addSearch)];
      const payload = {
        name: r.name,
        servingUnit: r.servingUnit,
        category: r.category || "other",
        servingSizeG: r.servingSizeG ?? null,
        calories: r.calories,
        proteinG: r.proteinG,
        carbsG: r.carbsG,
        fatG: r.fatG,
      };
      for (const k of NUTRIENT_KEYS) payload[k] = r[k] ?? 0;
      await db.add("foods", payload);
      toast(`Added "${r.name}" to your foods`);
      btn.textContent = "Added";
      btn.disabled = true;
    });
  });
}

let activeScanner = null;

function loadHtml5Qrcode() {
  if (window.Html5Qrcode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/html5-qrcode.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Failed to load scanner library"));
    document.head.appendChild(script);
  });
}

async function stopActiveScanner() {
  if (!activeScanner) return;
  const scanner = activeScanner;
  activeScanner = null;
  try {
    await scanner.stop();
  } catch (err) {
    // camera may already be stopped/torn down by navigation; nothing to do
  }
}

async function renderBarcodeScanner() {
  view.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Food library</p><h1>Scan Barcode</h1></div></div>
    <div class="card">
      <div id="scannerBox" class="scanner-box"></div>
      <p class="empty" id="scannerStatus">Starting camera&hellip;</p>
      <div class="form-actions"><a class="btn" href="#/foods">Cancel</a></div>
    </div>
    <div id="scanResult"></div>
  `;

  const statusEl = document.getElementById("scannerStatus");

  try {
    await loadHtml5Qrcode();
  } catch (err) {
    statusEl.textContent = "Couldn't load the barcode scanner. Check your internet connection (needed once) and try again.";
    return;
  }

  const formats = window.Html5QrcodeSupportedFormats
    ? [
        window.Html5QrcodeSupportedFormats.EAN_13,
        window.Html5QrcodeSupportedFormats.EAN_8,
        window.Html5QrcodeSupportedFormats.UPC_A,
        window.Html5QrcodeSupportedFormats.UPC_E,
      ]
    : undefined;

  const scanner = new window.Html5Qrcode("scannerBox", formats ? { formatsToSupport: formats } : undefined);
  activeScanner = scanner;
  let handled = false;

  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 240, height: 160 } },
      async (decodedText) => {
        if (handled) return;
        handled = true;
        statusEl.textContent = `Found barcode ${decodedText} — looking it up…`;
        await stopActiveScanner();
        await handleScannedBarcode(decodedText);
      },
      () => {}
    );
    statusEl.textContent = "Point your camera at a barcode.";
  } catch (err) {
    statusEl.textContent = "Couldn't access the camera. Check camera permissions for this site in your browser settings.";
    activeScanner = null;
  }
}

async function handleScannedBarcode(barcode) {
  const resultEl = document.getElementById("scanResult");
  if (!resultEl) return;
  resultEl.innerHTML = `<p class="empty">Looking up barcode ${esc(barcode)}&hellip;</p>`;

  let product = null;
  try {
    product = await offLookupBarcode(barcode);
  } catch (err) {
    resultEl.innerHTML = `<p class="empty">Couldn't reach the online food database. Check your internet connection and try again.</p>`;
    return;
  }

  if (!product) {
    resultEl.innerHTML = `<p class="empty">No product found for barcode ${esc(barcode)}. <a href="#/foods/new">Add it manually</a> or try <a href="#/foods/search">searching by name</a>.</p>`;
    return;
  }

  resultEl.innerHTML = `
    <div class="item-card">
      <div class="item-card-top">
        <div><div class="item-name">${esc(product.name)}</div><div class="item-sub">${esc(product.brand)}${product.brand ? " &middot; " : ""}per ${esc(product.servingUnit)}</div></div>
        <div class="item-kcal food">${Math.round(product.calories)}<span>kcal</span></div>
      </div>
      <div class="item-macros">
        <span><i class="dot protein"></i>${product.proteinG.toFixed(1)}g</span>
        <span><i class="dot carbs"></i>${product.carbsG.toFixed(1)}g</span>
        <span><i class="dot fat"></i>${product.fatG.toFixed(1)}g</span>
      </div>
      <button type="button" class="btn primary" style="width:100%" id="addScannedFood">${icons.plus} Add to my foods</button>
    </div>
  `;

  document.getElementById("addScannedFood").addEventListener("click", async () => {
    const payload = {
      name: product.name,
      servingUnit: product.servingUnit,
      category: product.category || "other",
      servingSizeG: product.servingSizeG ?? null,
      calories: product.calories,
      proteinG: product.proteinG,
      carbsG: product.carbsG,
      fatG: product.fatG,
    };
    for (const k of NUTRIENT_KEYS) payload[k] = product[k] ?? 0;
    await db.add("foods", payload);
    toast(`Added "${product.name}" to your foods`);
    location.hash = "#/foods";
  });
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

  const sizePresets = (food && food.sizePresets) || [];

  view.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Food library</p><h1>${food ? "Edit" : "Add"} Food</h1></div></div>
    <div class="card form-card">
      <form id="foodForm" class="form">
        <label>Name<input type="text" id="fName" required value="${food ? esc(food.name) : ""}" placeholder="e.g. Grilled chicken breast"></label>
        <div class="form-row-2">
          <label>Serving unit<input type="text" id="fUnit" value="${food ? esc(food.servingUnit) : "serving"}" placeholder="e.g. cup, 100g, slice"></label>
          <label>Category
            <select id="fCategory">
              ${FOOD_CATEGORIES.map(([key, label]) => `<option value="${key}" ${(food ? food.category : "other") === key ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="form-row-2">
          <label>Calories per serving<input type="number" step="0.1" min="0" id="fCalories" required value="${food ? food.calories : ""}" placeholder="0"></label>
          <label>Serving size in grams <span class="label-hint">(optional)</span><input type="number" step="0.1" min="0" id="fServingSizeG" value="${food && food.servingSizeG ? food.servingSizeG : ""}" placeholder="e.g. 100"></label>
        </div>
        <div class="form-row-3">
          <label>Protein (g)<input type="number" step="0.1" min="0" id="fProtein" value="${food ? food.proteinG : 0}"></label>
          <label>Carbs (g)<input type="number" step="0.1" min="0" id="fCarbs" value="${food ? food.carbsG : 0}"></label>
          <label>Fat (g)<input type="number" step="0.1" min="0" id="fFat" value="${food ? food.fatG : 0}"></label>
        </div>

        <label>Quick-pick sizes <span class="label-hint">(optional &mdash; e.g. Small/Medium/Large)</span></label>
        <div class="size-preset-list" id="sizePresetList">
          ${sizePresets.map((p) => sizePresetRowHtml(p.label, p.grams)).join("")}
        </div>
        <a class="btn" id="addSizePreset">${icons.plus} Add size</a>

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

  document.getElementById("addSizePreset").addEventListener("click", () => {
    document.getElementById("sizePresetList").insertAdjacentHTML("beforeend", sizePresetRowHtml("", ""));
  });
  document.getElementById("sizePresetList").addEventListener("click", (e) => {
    const btn = e.target.closest(".remove-size-preset");
    if (btn) btn.closest(".size-preset-row").remove();
  });

  document.getElementById("foodForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const servingSizeG = parseFloat(document.getElementById("fServingSizeG").value);
    const payload = {
      name: document.getElementById("fName").value.trim(),
      servingUnit: document.getElementById("fUnit").value.trim() || "serving",
      category: document.getElementById("fCategory").value || "other",
      servingSizeG: Number.isFinite(servingSizeG) && servingSizeG > 0 ? servingSizeG : null,
      sizePresets: readSizePresetRows(),
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

function sizePresetRowHtml(label, grams) {
  return `
    <div class="size-preset-row">
      <input type="text" class="sizePresetLabel" value="${esc(label)}" placeholder="e.g. Medium">
      <input type="number" step="0.1" min="0" class="sizePresetGrams" value="${grams}" placeholder="grams">
      <span class="unit-suffix">g</span>
      <button type="button" class="icon-btn danger remove-size-preset">${icons.trash}</button>
    </div>`;
}

function readSizePresetRows() {
  const presets = [];
  document.querySelectorAll("#sizePresetList .size-preset-row").forEach((row) => {
    const label = row.querySelector(".sizePresetLabel").value.trim();
    const grams = parseFloat(row.querySelector(".sizePresetGrams").value);
    if (label && Number.isFinite(grams) && grams > 0) presets.push({ label, grams });
  });
  return presets;
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
  const profile = await getProfile();
  const suggestion = suggestedTargets(profile);

  view.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Preferences</p><h1>Settings</h1></div></div>

    <div class="card form-card">
      <h2>Your Profile &amp; Targets</h2>
      <form id="settingsForm" class="form">
        <div class="form-row-3">
          <label>Age<input type="number" step="1" min="0" id="pAge" value="${profile.profileAge || ""}" placeholder="e.g. 30"></label>
          <label>Sex
            <select id="pSex">
              <option value="" ${!profile.profileSex ? "selected" : ""}>&mdash;</option>
              <option value="male" ${profile.profileSex === "male" ? "selected" : ""}>Male</option>
              <option value="female" ${profile.profileSex === "female" ? "selected" : ""}>Female</option>
            </select>
          </label>
          <label>Height (cm)<input type="number" step="0.1" min="0" id="pHeight" value="${profile.profileHeightCm || ""}" placeholder="e.g. 170"></label>
        </div>
        <div class="form-row-3">
          <label>Weight (kg)<input type="number" step="0.1" min="0" id="pWeight" value="${profile.profileWeightKg || ""}" placeholder="e.g. 70"></label>
          <label>Activity level
            <select id="pActivity">
              <option value="" ${!profile.profileActivity ? "selected" : ""}>&mdash;</option>
              ${ACTIVITY_LEVELS.map(([k, label]) => `<option value="${k}" ${profile.profileActivity === k ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </label>
          <label>Goal
            <select id="pGoal">
              <option value="" ${!profile.profileGoal ? "selected" : ""}>&mdash;</option>
              ${GOAL_OPTIONS.map(([k, label]) => `<option value="${k}" ${profile.profileGoal === k ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </label>
        </div>

        ${
          suggestion
            ? `<div class="suggestion-box">
                <p class="suggestion-title">Based on your profile</p>
                <p class="suggestion-line">
                  <strong>${Math.round(suggestion.calories)} kcal/day</strong>
                  <button type="button" class="btn" id="useSuggestedCalories" data-value="${Math.round(suggestion.calories)}">Use this</button>
                </p>
                <p class="suggestion-macros">Suggested macros &middot; Protein ${Math.round(suggestion.proteinG)}g &middot; Carbs ${Math.round(suggestion.carbsG)}g &middot; Fat ${Math.round(suggestion.fatG)}g</p>
              </div>`
            : `<p class="empty">Fill in all profile fields above to get a personalized calorie/macro suggestion (Mifflin-St Jeor formula).</p>`
        }

        <label>Daily calorie goal (net)<input type="number" step="1" min="0" id="goalInput" value="${goal ?? ""}" placeholder="e.g. 2000"></label>
        <div class="form-actions"><button type="submit" class="btn primary">Save</button></div>
      </form>
    </div>

    <div class="card">
      <h2>Backup &amp; Restore</h2>
      <p class="empty">Export everything as a file. The same file can be restored here later, or imported into the PC app.</p>
      <div class="form-actions"><button type="button" class="btn primary" id="exportBtn">Export data</button></div>
      <form id="importForm" class="form" style="margin-top:1rem">
        <label>Restore from backup file<input type="file" id="importFile" accept="application/json" required></label>
        <div class="form-actions"><button type="submit" class="btn">Import &amp; replace data</button></div>
      </form>
    </div>

    <div class="card">
      <h2>About this data</h2>
      <p class="empty">Nutrient %DV figures use generic FDA adult reference values &mdash; they are not personalized medical or dietary advice. Consult a healthcare provider or registered dietitian for guidance specific to you.</p>
      <p class="empty">All data lives only on this device, in this browser. Uninstalling the app or clearing site data will erase it.</p>
    </div>
  `;

  document.getElementById("useSuggestedCalories")?.addEventListener("click", (e) => {
    document.getElementById("goalInput").value = e.target.dataset.value;
  });

  document.getElementById("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = document.getElementById("goalInput").value.trim();
    if (val) await db.put("settings", { key: "dailyCalorieGoal", value: val });
    else await db.remove("settings", "dailyCalorieGoal");

    const fields = {
      profileAge: document.getElementById("pAge").value,
      profileSex: document.getElementById("pSex").value,
      profileHeightCm: document.getElementById("pHeight").value,
      profileWeightKg: document.getElementById("pWeight").value,
      profileActivity: document.getElementById("pActivity").value,
      profileGoal: document.getElementById("pGoal").value,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value) await db.put("settings", { key, value: String(value) });
      else await db.remove("settings", key);
    }
    toast("Settings saved");
    renderSettings();
  });

  document.getElementById("exportBtn").addEventListener("click", exportData);
  document.getElementById("importForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = document.getElementById("importFile").files[0];
    if (!file) return;
    if (!confirm("This replaces ALL current data with the backup file. Continue?")) return;
    try {
      const text = await file.text();
      await importData(JSON.parse(text));
      toast("Data restored from backup");
      renderSettings();
    } catch (err) {
      alert("That backup file couldn't be imported — it may be corrupted or in the wrong format.");
    }
  });
}

async function renderWeight() {
  const rows = (await db.getAll("weightLogs")).sort((a, b) => a.date.localeCompare(b.date));
  const n = rows.length;
  const points = [];
  if (n) {
    const values = rows.map((r) => r.weightKg);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = high - low || 1;
    rows.forEach((r, i) => {
      const x = n > 1 ? (i / (n - 1)) * 100 : 50;
      const y = 100 - ((r.weightKg - low) / span) * 100;
      points.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    });
  }
  const polyline = points.map(([x, y]) => `${x},${y}`).join(" ");
  const latest = rows[rows.length - 1];

  view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Body tracking</p><h1>Weight</h1></div>
      ${
        latest
          ? `<div class="latest-weight"><span class="latest-weight-value">${latest.weightKg.toFixed(1)}<small>kg</small></span><span class="latest-weight-date">${latest.date}</span></div>`
          : ""
      }
    </div>
    <section class="card">
      <form id="weightForm" class="quick-add">
        <input type="date" id="weightDate" value="${todayISO()}" required>
        <input type="number" step="0.1" min="0" id="weightKg" placeholder="Weight (kg)" required>
        <button type="submit">${icons.plus}</button>
      </form>
      ${
        points.length > 1
          ? `<div class="weight-chart-wrap"><svg class="weight-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline points="${polyline}" fill="none" stroke="var(--lime)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
              ${points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.8" fill="var(--lime)"/>`).join("")}
            </svg></div>`
          : !rows.length
          ? `<p class="empty">Log your weight to start seeing a trend.</p>`
          : ""
      }
    </section>
    <section class="card">
      <h2>History</h2>
      ${
        rows.length
          ? `<ul class="log-list">
              ${rows
                .slice()
                .reverse()
                .map(
                  (r) => `
              <li class="log-item">
                <div class="log-item-main"><span class="log-item-name">${r.weightKg.toFixed(1)} kg</span><span class="log-item-meta">${r.date}</span></div>
                <button class="icon-btn danger" data-delete-weight="${r.id}">${icons.trash}</button>
              </li>`
                )
                .join("")}
            </ul>`
          : `<p class="empty">No entries yet.</p>`
      }
    </section>
  `;

  document.getElementById("weightForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const dateVal = document.getElementById("weightDate").value;
    const weightKg = parseFloat(document.getElementById("weightKg").value);
    if (!dateVal || !weightKg) return;
    await db.add("weightLogs", { date: dateVal, weightKg });
    toast("Weight logged");
    renderWeight();
  });

  view.querySelectorAll("[data-delete-weight]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await db.remove("weightLogs", Number(btn.dataset.deleteWeight));
      renderWeight();
    });
  });
}

async function renderRecipesList() {
  const [recipeRows, foods] = await Promise.all([db.getAll("recipes"), db.getAll("foods")]);
  const foodsById = new Map(foods.map((f) => [f.id, f]));
  const rows = recipeRows
    .map((r) => ({ ...r, food: foodsById.get(r.foodId) }))
    .filter((r) => r.food)
    .sort((a, b) => a.name.localeCompare(b.name));

  view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Your library</p><h1>Recipes</h1></div>
      <a class="pill-btn" href="#/recipes/new">${icons.plus} Add</a>
    </div>
    ${
      rows.length
        ? `<div class="item-grid">
            ${rows
              .map(
                (r, i) => `
            <div class="item-card" style="animation-delay:${i * 30}ms">
              <div class="item-card-top">
                <div><div class="item-name">${esc(r.name)}</div><div class="item-sub">makes ${r.yieldsServings} serving${r.yieldsServings != 1 ? "s" : ""}</div></div>
                <div class="item-kcal food">${Math.round(r.food.calories)}<span>kcal/serving</span></div>
              </div>
              <div class="item-macros">
                <span><i class="dot protein"></i>${r.food.proteinG.toFixed(1)}g</span>
                <span><i class="dot carbs"></i>${r.food.carbsG.toFixed(1)}g</span>
                <span><i class="dot fat"></i>${r.food.fatG.toFixed(1)}g</span>
              </div>
              <div class="item-actions">
                <button data-edit-recipe="${r.id}">${icons.pencil} Edit</button>
                <button class="danger" data-delete-recipe="${r.id}">${icons.trash} Delete</button>
              </div>
            </div>`
              )
              .join("")}
          </div>`
        : `<p class="empty">No recipes yet. <a href="#/recipes/new">Add your first one</a>.</p>`
    }
  `;

  view.querySelectorAll("[data-edit-recipe]").forEach((b) =>
    b.addEventListener("click", () => (location.hash = `#/recipes/${b.dataset.editRecipe}/edit`))
  );
  view.querySelectorAll("[data-delete-recipe]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this recipe? This also removes it from your food list and any logged entries.")) return;
      const id = Number(b.dataset.deleteRecipe);
      const recipe = await db.get("recipes", id);
      if (recipe) {
        await db.remove("foods", recipe.foodId);
        await db.removeWhere("foodLogs", (l) => l.foodId === recipe.foodId);
        await db.remove("recipes", id);
        await db.removeWhere("recipeIngredients", (ri) => ri.recipeId === id);
      }
      toast("Recipe deleted");
      renderRecipesList();
    })
  );
}

async function computeRecipeNutrition(ingredients, yieldsServings) {
  const totals = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const k of NUTRIENT_KEYS) totals[k] = 0;
  for (const { foodId, servings } of ingredients) {
    const food = await db.get("foods", foodId);
    if (!food) continue;
    totals.calories += food.calories * servings;
    totals.proteinG += food.proteinG * servings;
    totals.carbsG += food.carbsG * servings;
    totals.fatG += food.fatG * servings;
    for (const k of NUTRIENT_KEYS) totals[k] += (food[k] || 0) * servings;
  }
  const y = yieldsServings || 1;
  const result = {};
  for (const k of Object.keys(totals)) result[k] = totals[k] / y;
  return result;
}

function ingredientRowHtml(foods, selectedFoodId, servings) {
  return `
    <div class="ingredient-row">
      <select class="ingredientFoodId" required>
        <option value="" ${!selectedFoodId ? "disabled selected" : ""}>Select food&hellip;</option>
        ${foods.map((f) => `<option value="${f.id}" ${f.id === selectedFoodId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
      </select>
      <input type="number" step="0.1" min="0" class="ingredientServings" value="${servings ?? 1}" placeholder="Servings" required>
      <button type="button" class="icon-btn danger remove-ingredient">${icons.trash}</button>
    </div>`;
}

async function renderRecipeForm(id) {
  const foods = (await db.getAll("foods")).sort((a, b) => a.name.localeCompare(b.name));
  const recipe = id ? await db.get("recipes", id) : null;
  const ingredientRows = id ? await db.getAllByIndex("recipeIngredients", "byRecipe", id) : [];

  view.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Recipe library</p><h1>${recipe ? "Edit" : "Add"} Recipe</h1></div></div>
    <div class="card form-card">
      <form id="recipeForm" class="form">
        <label>Recipe name<input type="text" id="rName" required value="${recipe ? esc(recipe.name) : ""}" placeholder="e.g. My dal + rice + sabzi plate"></label>
        <label>Yields (servings)<input type="number" step="0.1" min="0.1" id="rYields" value="${recipe ? recipe.yieldsServings : 1}" placeholder="e.g. 4"></label>
        <div class="ingredient-list" id="ingredientList">
          ${
            ingredientRows.length
              ? ingredientRows.map((ing) => ingredientRowHtml(foods, ing.foodId, ing.servings)).join("")
              : ingredientRowHtml(foods, null, 1)
          }
        </div>
        <a class="btn" id="addIngredient">${icons.plus} Add ingredient</a>
        <div class="form-actions">
          <button type="submit" class="btn primary">Save Recipe</button>
          <a class="btn" href="#/recipes">Cancel</a>
        </div>
      </form>
    </div>
  `;

  document.getElementById("addIngredient").addEventListener("click", () => {
    document.getElementById("ingredientList").insertAdjacentHTML("beforeend", ingredientRowHtml(foods, null, 1));
  });
  document.getElementById("ingredientList").addEventListener("click", (e) => {
    const btn = e.target.closest(".remove-ingredient");
    if (btn) btn.closest(".ingredient-row").remove();
  });

  document.getElementById("recipeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("rName").value.trim();
    const yieldsServings = parseFloat(document.getElementById("rYields").value) || 1;
    const ingredients = Array.from(document.querySelectorAll(".ingredient-row"))
      .map((row) => ({
        foodId: Number(row.querySelector(".ingredientFoodId").value),
        servings: parseFloat(row.querySelector(".ingredientServings").value),
      }))
      .filter((i) => i.foodId && i.servings);

    const nutrition = await computeRecipeNutrition(ingredients, yieldsServings);
    const foodPayload = {
      name,
      servingUnit: "1 serving",
      calories: nutrition.calories,
      proteinG: nutrition.proteinG,
      carbsG: nutrition.carbsG,
      fatG: nutrition.fatG,
    };
    for (const k of NUTRIENT_KEYS) foodPayload[k] = nutrition[k];

    if (recipe) {
      await db.put("foods", { ...foodPayload, id: recipe.foodId });
      await db.put("recipes", { ...recipe, name, yieldsServings });
      await db.removeWhere("recipeIngredients", (ri) => ri.recipeId === recipe.id);
      for (const ing of ingredients) {
        await db.add("recipeIngredients", { recipeId: recipe.id, foodId: ing.foodId, servings: ing.servings });
      }
    } else {
      const foodId = await db.add("foods", foodPayload);
      const recipeId = await db.add("recipes", { foodId, name, yieldsServings });
      for (const ing of ingredients) {
        await db.add("recipeIngredients", { recipeId, foodId: ing.foodId, servings: ing.servings });
      }
    }
    toast("Recipe saved");
    location.hash = "#/recipes";
  });
}

const routes = [
  { pattern: /^#\/(\?.*)?$/, tab: "dashboard", title: "Dashboard", render: renderDashboard },
  { pattern: /^#\/foods(\?.*)?$/, tab: "foods", title: "Foods", render: renderFoodsList },
  { pattern: /^#\/foods\/new$/, tab: "foods", title: "Add Food", render: () => renderFoodForm(null) },
  { pattern: /^#\/foods\/search(\?.*)?$/, tab: "foods", title: "Search Online", render: renderFoodSearch },
  { pattern: /^#\/foods\/scan$/, tab: "foods", title: "Scan Barcode", render: renderBarcodeScanner },
  { pattern: /^#\/foods\/(\d+)\/edit$/, tab: "foods", title: "Edit Food", render: (m) => renderFoodForm(Number(m[1])) },
  { pattern: /^#\/exercises$/, tab: "exercises", title: "Exercises", render: renderExercisesList },
  { pattern: /^#\/exercises\/new$/, tab: "exercises", title: "Add Exercise", render: () => renderExerciseForm(null) },
  { pattern: /^#\/exercises\/(\d+)\/edit$/, tab: "exercises", title: "Edit Exercise", render: (m) => renderExerciseForm(Number(m[1])) },
  { pattern: /^#\/recipes$/, tab: "recipes", title: "Recipes", render: renderRecipesList },
  { pattern: /^#\/recipes\/new$/, tab: "recipes", title: "Add Recipe", render: () => renderRecipeForm(null) },
  { pattern: /^#\/recipes\/(\d+)\/edit$/, tab: "recipes", title: "Edit Recipe", render: (m) => renderRecipeForm(Number(m[1])) },
  { pattern: /^#\/weight$/, tab: "weight", title: "Weight", render: renderWeight },
  { pattern: /^#\/history$/, tab: "history", title: "History", render: renderHistory },
  { pattern: /^#\/settings$/, tab: "settings", title: "Settings", render: renderSettings },
];

async function router() {
  const hash = location.hash || "#/";
  if (!/^#\/foods\/scan$/.test(hash)) await stopActiveScanner();
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
window.addEventListener("pagehide", stopActiveScanner);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopActiveScanner();
});
seedIfEmpty().then(router);
