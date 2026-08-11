// Reference daily values (%DV) are the FDA's generic adult reference values
// used on US nutrition labels (2016/2020 update) — not personalized to any
// individual's age, sex, or activity level.

export const NUTRIENTS = [
  { key: "fiberG", label: "Fiber", unit: "g", dv: 28, group: "Other Nutrients" },
  { key: "sugarG", label: "Sugar", unit: "g", dv: null, group: "Other Nutrients" },
  { key: "satFatG", label: "Saturated Fat", unit: "g", dv: 20, group: "Other Nutrients" },
  { key: "cholesterolMg", label: "Cholesterol", unit: "mg", dv: 300, group: "Other Nutrients" },
  { key: "sodiumMg", label: "Sodium", unit: "mg", dv: 2300, group: "Other Nutrients" },
  { key: "potassiumMg", label: "Potassium", unit: "mg", dv: 4700, group: "Minerals" },
  { key: "calciumMg", label: "Calcium", unit: "mg", dv: 1300, group: "Minerals" },
  { key: "ironMg", label: "Iron", unit: "mg", dv: 18, group: "Minerals" },
  { key: "magnesiumMg", label: "Magnesium", unit: "mg", dv: 420, group: "Minerals" },
  { key: "zincMg", label: "Zinc", unit: "mg", dv: 11, group: "Minerals" },
  { key: "vitaminAMcg", label: "Vitamin A", unit: "mcg", dv: 900, group: "Vitamins" },
  { key: "vitaminCMg", label: "Vitamin C", unit: "mg", dv: 90, group: "Vitamins" },
  { key: "vitaminDMcg", label: "Vitamin D", unit: "mcg", dv: 20, group: "Vitamins" },
  { key: "vitaminEMg", label: "Vitamin E", unit: "mg", dv: 15, group: "Vitamins" },
  { key: "vitaminKMcg", label: "Vitamin K", unit: "mcg", dv: 120, group: "Vitamins" },
  { key: "vitaminB6Mg", label: "Vitamin B6", unit: "mg", dv: 1.7, group: "Vitamins" },
  { key: "vitaminB12Mcg", label: "Vitamin B12", unit: "mcg", dv: 2.4, group: "Vitamins" },
  { key: "folateMcg", label: "Folate", unit: "mcg", dv: 400, group: "Vitamins" },
];

export const NUTRIENT_KEYS = NUTRIENTS.map((n) => n.key);
