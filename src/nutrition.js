'use strict';

const { callTool } = require('./mcp-client');
const { normalizeName } = require('./menu');

/**
 * 麦当劳官方营养数据（list-nutrition-foods）
 *
 * 返回的是一段 CSV 文本，形如：
 *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *     巨无霸,null,2146,513,27,26,42,961,171
 *
 * 关键特性：这里的名称用的是「中薯条」「可乐中杯」「麦乐鸡4块」这类
 * 套餐子项的叫法，与 query-meal-detail 拆出来的成分名几乎一致，
 * 因此可以直接复用 menu.js 的 normalizeName 做对齐。
 */

function parseCsv(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('[')) continue; // 跳过表头 [160]{...}:
    const p = t.split(',');
    if (p.length < 9) continue;
    out.push({
      name: p[0].trim(),
      desc: p[1] && p[1] !== 'null' ? p[1].trim() : null,
      kj: num(p[2]),
      kcal: num(p[3]),
      protein: num(p[4]), // g
      fat: num(p[5]), // g
      carb: num(p[6]), // g
      sodium: num(p[7]), // mg
      calcium: num(p[8]), // mg
    });
  }
  return out;
}

function num(v) {
  const n = Number(String(v || '').trim());
  return Number.isFinite(n) ? n : 0;
}

async function loadNutrition() {
  const res = await callTool('list-nutrition-foods', {});
  const raw = typeof res.data === 'string' ? res.data : res.data && res.data.data;
  const list = parseCsv(raw);

  // 精确名索引 + 归一化名索引（套餐子项名称靠归一化命中）
  const exact = new Map();
  const canon = new Map();
  for (const n of list) {
    if (!exact.has(n.name)) exact.set(n.name, n);
    const k = normalizeName(n.name);
    if (k && !canon.has(k)) canon.set(k, n);
  }
  return { list, exact, canon };
}

/**
 * 按餐品名查营养：精确 → 归一化 → 包含回退。
 * 包含回退用于「原味双层深海鳕鱼堡」→「双层深海鳕鱼堡」这类带前缀/后缀的情况。
 */
function lookup(index, name) {
  if (!index || !name) return null;
  if (index.exact.has(name)) return index.exact.get(name);

  const k = normalizeName(name);
  if (!k) return null;
  if (index.canon.has(k)) return index.canon.get(k);

  let best = null;
  let bestLen = 0;
  for (const [ck, rec] of index.canon) {
    if (!ck || ck.length < 2) continue;
    if (Math.abs(ck.length - k.length) > 5) continue; // 防止「派」匹配到「香芋派」这种过短的误命中
    if (k.includes(ck) || ck.includes(k)) {
      const len = Math.min(k.length, ck.length);
      if (len > bestLen) {
        best = rec;
        bestLen = len;
      }
    }
  }
  return best;
}

/** 套餐营养 = 各成分营养之和；缺失成分会被记录到 missing，结果标为不完整 */
function sumNutrition(items) {
  const total = { kcal: 0, kj: 0, protein: 0, fat: 0, carb: 0, sodium: 0, calcium: 0 };
  const missing = [];
  for (const it of items) {
    if (it.nutrition) {
      const q = it.qty || 1;
      total.kcal += it.nutrition.kcal * q;
      total.kj += it.nutrition.kj * q;
      total.protein += it.nutrition.protein * q;
      total.fat += it.nutrition.fat * q;
      total.carb += it.nutrition.carb * q;
      total.sodium += it.nutrition.sodium * q;
      total.calcium += it.nutrition.calcium * q;
    } else if (it.name) {
      missing.push(it.name);
    }
  }
  return {
    ...roundAll(total),
    incomplete: missing.length > 0,
    missing: [...new Set(missing)],
  };
}

function roundAll(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = Math.round(v * 10) / 10;
  return out;
}

/** 能量占比：脂肪/碳水/蛋白质各提供多少比例的能量 */
function macros(n) {
  const kcal = n.kcal || 0;
  if (kcal <= 0) return { fatPct: 0, carbPct: 0, proteinPct: 0 };
  return {
    fatPct: Math.round(((n.fat * 9) / kcal) * 100),
    carbPct: Math.round(((n.carb * 4) / kcal) * 100),
    proteinPct: Math.round(((n.protein * 4) / kcal) * 100),
  };
}

/**
 * 饮食偏好定义
 * score 越小越符合该偏好（统一为"升序最优"）
 */
const DIETS = {
  'low-calorie': {
    label: '低卡',
    metric: '热量',
    score: (n) => n.kcal,
    fmt: (n) => `${n.kcal} kcal`,
  },
  'low-fat': {
    label: '低脂',
    metric: '脂肪供能比',
    score: (n) => (n.kcal > 0 ? (n.fat * 9) / n.kcal : 0),
    fmt: (n) => `${n.fat}g / ${macros(n).fatPct}%`,
  },
  'low-sugar': {
    label: '低糖（低碳水）',
    metric: '碳水供能比',
    // 官方营养表未单独给出糖，用碳水化合物近似，输出时会明确标注
    score: (n) => (n.kcal > 0 ? (n.carb * 4) / n.kcal : 0),
    fmt: (n) => `${n.carb}g / ${macros(n).carbPct}%`,
  },
  'low-sodium': {
    label: '低钠',
    metric: '钠密度',
    score: (n) => (n.kcal > 0 ? n.sodium / n.kcal : 0),
    fmt: (n) => `${n.sodium}mg`,
  },
  'high-protein': {
    label: '高蛋白',
    metric: '蛋白供能比',
    score: (n) => (n.kcal > 0 ? -n.protein / n.kcal : 0), // 取负，升序即越高越好
    fmt: (n) => `${n.protein}g / ${macros(n).proteinPct}%`,
  },
};

function dietKeys() {
  return Object.keys(DIETS);
}

module.exports = { loadNutrition, lookup, sumNutrition, macros, DIETS, dietKeys, parseCsv };
