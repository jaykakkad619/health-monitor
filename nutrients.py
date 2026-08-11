# Reference daily values (%DV) are the FDA's generic adult reference values
# used on US nutrition labels (2016/2020 update) — not personalized to any
# individual's age, sex, or activity level.

NUTRIENTS = [
    {"key": "fiber_g", "label": "Fiber", "unit": "g", "dv": 28, "group": "Other Nutrients"},
    {"key": "sugar_g", "label": "Sugar", "unit": "g", "dv": None, "group": "Other Nutrients"},
    {"key": "sat_fat_g", "label": "Saturated Fat", "unit": "g", "dv": 20, "group": "Other Nutrients"},
    {"key": "cholesterol_mg", "label": "Cholesterol", "unit": "mg", "dv": 300, "group": "Other Nutrients"},
    {"key": "sodium_mg", "label": "Sodium", "unit": "mg", "dv": 2300, "group": "Other Nutrients"},
    {"key": "potassium_mg", "label": "Potassium", "unit": "mg", "dv": 4700, "group": "Minerals"},
    {"key": "calcium_mg", "label": "Calcium", "unit": "mg", "dv": 1300, "group": "Minerals"},
    {"key": "iron_mg", "label": "Iron", "unit": "mg", "dv": 18, "group": "Minerals"},
    {"key": "magnesium_mg", "label": "Magnesium", "unit": "mg", "dv": 420, "group": "Minerals"},
    {"key": "zinc_mg", "label": "Zinc", "unit": "mg", "dv": 11, "group": "Minerals"},
    {"key": "vitamin_a_mcg", "label": "Vitamin A", "unit": "mcg", "dv": 900, "group": "Vitamins"},
    {"key": "vitamin_c_mg", "label": "Vitamin C", "unit": "mg", "dv": 90, "group": "Vitamins"},
    {"key": "vitamin_d_mcg", "label": "Vitamin D", "unit": "mcg", "dv": 20, "group": "Vitamins"},
    {"key": "vitamin_e_mg", "label": "Vitamin E", "unit": "mg", "dv": 15, "group": "Vitamins"},
    {"key": "vitamin_k_mcg", "label": "Vitamin K", "unit": "mcg", "dv": 120, "group": "Vitamins"},
    {"key": "vitamin_b6_mg", "label": "Vitamin B6", "unit": "mg", "dv": 1.7, "group": "Vitamins"},
    {"key": "vitamin_b12_mcg", "label": "Vitamin B12", "unit": "mcg", "dv": 2.4, "group": "Vitamins"},
    {"key": "folate_mcg", "label": "Folate", "unit": "mcg", "dv": 400, "group": "Vitamins"},
]

NUTRIENT_KEYS = [n["key"] for n in NUTRIENTS]
