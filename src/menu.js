'use strict';

const { callTool } = require('./mcp-client');

/**
 * 套餐类餐品的命名特征。
 * 注意：不能用「盒」「盘」这类单字，否则「纯牛奶(盒装)」会被误判为套餐。
 */
const COMBO_HINT = /(件套|套餐|随心配|乐园餐|口福|双人|分享|拼盘|小食盘|双全盒)/;

/**
 * 拉取门店菜单
 * @returns {{ storeCode, categories, meals: Map<string, meal>, list: meal[] }}
 */
async function loadMenu(storeCode, orderType = 1, beType = 1, beCode) {
  const args = { storeCode, orderType, beType };
  if (beCode) args.beCode = beCode;

  const res = await callTool('query-meals', args);
  if (!res.ok) throw new Error('菜单拉取失败: ' + JSON.stringify(res.raw).slice(0, 300));

  const raw = res.data || {};
  const map = raw.meals || {};
  const meals = new Map();

  for (const [code, m] of Object.entries(map)) {
    meals.set(code, {
      code,
      name: m.name,
      price: toYuan(m.currentPrice),
      originalPrice: toYuan(m.originalPrice),
      image: m.image,
      discountType: m.discountType || null,
      canWithOrder: !!m.canWithOrder,
      withOrder: m.withOrder || null,
      isCombo: COMBO_HINT.test(m.name || ''),
      canonical: normalizeName(m.name),
      ingredients: null, // 懒加载：由 expandCombos 填充
    });
  }

  return {
    storeCode,
    categories: raw.categories || [],
    meals,
    list: [...meals.values()],
  };
}

/**
 * 展开所有套餐的成分（调用 query-meal-detail）
 * 套餐成分 = rounds[].choices[] 里 isDefault=1 的选项；若某轮无默认，取第一个。
 */
async function expandCombos(menu, { concurrency = 6, onProgress } = {}) {
  const combos = menu.list.filter((m) => m.isCombo);
  let done = 0;

  const queue = [...combos];
  async function worker() {
    while (queue.length) {
      const meal = queue.shift();
      try {
        const res = await callTool('query-meal-detail', {
          storeCode: menu.storeCode,
          orderType: 1,
          beType: 1,
          code: meal.code,
        });
        const rounds = (res.data && res.data.rounds) || [];
        const ingredients = [];
        for (const r of rounds) {
          const choices = r.choices || [];
          const def = choices.filter((c) => c.isDefault === 1);
          const picked = def.length ? def : choices.slice(0, Math.max(1, r.quantity || 1));
          for (const c of picked) {
            const qty = c.quantity || 1;
            for (let i = 0; i < qty; i++) ingredients.push({ code: c.code, name: c.name });
          }
        }
        // 空成分的套餐没有任何拆解价值，直接标记为不可拆解
        if (ingredients.length === 0) {
          meal.ingredients = null;
          meal.ingredientCodes = null;
        } else {
          meal.ingredients = ingredients;
          meal.ingredientCodes = countBy(ingredients.map((i) => i.code));
          // 名称维度：用于与需求做覆盖判定
          meal.ingredientNames = countBy(ingredients.map((i) => normalizeName(i.name)));
        }
      } catch (_) {
        meal.ingredients = null; // 展开失败就当它不可拆解
      }
      done++;
      if (onProgress) onProgress(done, combos.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, combos.length) }, worker));
  return menu;
}

/**
 * 把官方营养数据挂到每个餐品上。
 * 单品直接查表；套餐用拆出来的成分名逐个查表再求和（更准，且能覆盖套餐专属名）。
 */
function attachNutrition(menu, nutritionIndex) {
  const { lookup, sumNutrition } = require('./nutrition');

  for (const m of menu.list) {
    if (m.isCombo && m.ingredients && m.ingredients.length) {
      const items = m.ingredients.map((i) => ({
        name: i.name,
        qty: 1,
        nutrition: lookup(nutritionIndex, i.name),
      }));
      m.nutrition = sumNutrition(items);
    } else {
      m.nutrition = lookup(nutritionIndex, m.name);
    }
  }
  return menu;
}

/** 按关键词模糊匹配餐品（支持「巨无霸」「巨无霸三件套」等） */
function searchMeals(menu, keyword) {
  const kw = String(keyword).trim();
  if (!kw) return [];
  const hits = menu.list.filter((m) => m.name && m.name.includes(kw));
  // 精确同名优先，其次单品优先（单品更适合做需求拆解）
  hits.sort((a, b) => {
    const ea = a.name === kw ? 0 : 1;
    const eb = b.name === kw ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return a.isCombo - b.isCombo || a.price - b.price;
  });
  return hits;
}

/**
 * 商品名归一化：用于把「可乐中杯」「中薯条」这类套餐子项对齐到菜单单品「可乐」「薯条」。
 * 套餐子项的 code 往往与菜单单品 code 不同，必须靠名称对齐才能判断覆盖关系。
 */
function normalizeName(s) {
  let n = String(s || '').trim();
  n = n.replace(/【[^】]*】/g, '');
  n = n.replace(/[™®（）()]/g, '');
  n = n.replace(/\d+\s*(块|个|根|片|只|份)/g, '');
  n = n.replace(/(中杯|大杯|小杯)/g, '');
  n = n.replace(/^(中|大|小)/, '');
  n = n.replace(/(中|大|小)$/, '');
  n = n.replace(/[-—_·]/g, ''); // 营养表里常写作「麦辣鸡翅-2块」，连字符要去掉
  n = n.replace(/\s+/g, '');
  return n;
}

function countBy(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function toYuan(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

module.exports = {
  loadMenu,
  expandCombos,
  attachNutrition,
  searchMeals,
  countBy,
  toYuan,
  normalizeName,
  COMBO_HINT,
};
