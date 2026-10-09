'use strict';

const { callTool } = require('./mcp-client');
const { matchCoupons } = require('./coupons');
const { sumNutrition, DIETS } = require('./nutrition');

const MAX_PLANS = 400;
const MAX_DEPTH = 8;
/**
 * 套餐可以多带几件需求外的东西。
 * 现实里「巨无霸四件套」常常比「三件套」还便宜还多一件，
 * 只做严格覆盖会把这种神价方案漏掉，所以允许溢出。
 */
const MAX_OVERFLOW = 2;

/**
 * 生成所有能覆盖需求的购买方案（套餐 / 单品组合），不去重前先做集合剪枝
 *
 * @param {Object} menu        loadMenu + expandCombos 后的菜单
 * @param {Map<string,number>} demand   需求：商品编码 -> 数量
 */
function generatePlans(menu, demand) {
  // 需求转成「归一化名称」维度：套餐子项 code 与单品 code 不一致，只能靠名称对齐
  const demandNames = new Map();
  for (const [code, qty] of demand) {
    const m = menu.meals.get(code);
    if (!m) continue;
    demandNames.set(m.canonical, (demandNames.get(m.canonical) || 0) + qty);
  }

  // 保留与需求有交集的套餐（允许少量溢出），避免引入完全无关的大套餐
  const comboAtoms = [];
  for (const m of menu.list) {
    if (!m.isCombo || !m.ingredientNames) continue;
    if (overlapQty(m.ingredientNames, demandNames) === 0) continue;
    if (overflowQty(m.ingredientNames, demandNames) > MAX_OVERFLOW) continue;
    comboAtoms.push({
      code: m.code,
      name: m.name,
      price: m.price,
      covers: m.ingredientNames,
      kind: 'combo',
    });
  }

  const singleAtoms = [];
  for (const code of demand.keys()) {
    const m = menu.meals.get(code);
    if (!m) continue;
    singleAtoms.push({
      code,
      name: m.name,
      price: m.price,
      covers: new Map([[m.canonical, 1]]),
      kind: 'single',
    });
  }

  // 套餐在前（更可能便宜），让优质方案先被枚举出来
  const atoms = [...comboAtoms, ...singleAtoms].filter((a) => a.covers && a.covers.size > 0);
  const plans = [];
  const seen = new Set();

  // 兜底：纯单点方案一定存在，保证永远有解
  const baseItems = [];
  for (const [code, qty] of demand) {
    const m = menu.meals.get(code);
    if (!m) continue;
    baseItems.push({ code, name: m.name, qty, kind: 'single', price: m.price });
  }
  const baseKey = canonical(baseItems);
  seen.add(baseKey);
  plans.push({ items: baseItems, key: baseKey });

  function dfs(remaining, chosen, depth) {
    if (plans.length >= MAX_PLANS || depth > MAX_DEPTH) return;

    if (remaining.size === 0) {
      const key = canonical(chosen);
      if (!seen.has(key)) {
        seen.add(key);
        plans.push({ items: summarize(chosen), key });
      }
      return;
    }

    // 优先用套餐（更可能便宜），让优质方案先被生成出来
    for (const atom of atoms) {
      if (!fits(atom.covers, remaining)) continue;
      const next = subtract(remaining, atom.covers);
      chosen.push(atom);
      dfs(next, chosen, depth + 1);
      chosen.pop();
      if (plans.length >= MAX_PLANS) return;
    }
  }

  dfs(demandNames, [], 0);

  // 先按菜单理论价升序，让便宜的方案优先进入官方核价（核价有次数成本）
  for (const p of plans) {
    p.theory = round2(p.items.reduce((s, i) => s + (i.price || 0) * i.qty, 0));
  }
  plans.sort((a, b) => a.theory - b.theory);
  return plans;
}

/** covers 与 remaining 的交集数量（能帮需求消耗掉多少件） */
function overlapQty(covers, remaining) {
  let n = 0;
  for (const [k, qty] of covers) n += Math.min(qty, remaining.get(k) || 0);
  return n;
}

/** covers 中需求用不上的件数（溢出） */
function overflowQty(covers, remaining) {
  let n = 0;
  for (const [k, qty] of covers) n += qty - Math.min(qty, remaining.get(k) || 0);
  return n;
}

function fits(covers, remaining) {
  return overlapQty(covers, remaining) > 0 && overflowQty(covers, remaining) <= MAX_OVERFLOW;
}

function subtract(remaining, covers) {
  const next = new Map(remaining);
  for (const [k, qty] of covers) {
    const used = Math.min(qty, next.get(k) || 0);
    const left = (next.get(k) || 0) - used;
    if (left <= 0) next.delete(k);
    else next.set(k, left);
  }
  return next;
}

function canonical(chosen) {
  return chosen
    .map((a) => a.code)
    .sort()
    .join('|');
}

function summarize(chosen) {
  const m = new Map();
  for (const a of chosen) {
    const cur = m.get(a.code) || { code: a.code, name: a.name, qty: 0, kind: a.kind, price: a.price };
    cur.qty += 1;
    m.set(a.code, cur);
  }
  return [...m.values()];
}

/**
 * 「加价升级」建议：需求不变，再多花一点钱换套餐，能白得多少东西。
 * 这是套餐定价里最常见的信息差 —— 很多人不知道加 3 元就能多拿一份麦乐鸡。
 *
 * @returns {Array<{name,code,delta,extraValue,net,extras}>}
 */
function suggestUpgrades(menu, demand, bestPrice, topN = 3, verifiedPrices) {
  // 归一化名称 -> 最便宜的单品价（用于估算「白得的东西值多少」）
  const idx = new Map();
  for (const m of menu.list) {
    if (m.isCombo) continue;
    const cur = idx.get(m.canonical);
    if (cur === undefined || m.price < cur) idx.set(m.canonical, m.price);
  }

  const demandNames = new Map();
  for (const [code, qty] of demand) {
    const m = menu.meals.get(code);
    if (!m) continue;
    demandNames.set(m.canonical, (demandNames.get(m.canonical) || 0) + qty);
  }

  const out = [];
  for (const m of menu.list) {
    if (!m.isCombo || !m.ingredientNames) continue;

    const need = new Map(demandNames);
    let coveredValue = 0;
    let coveredCount = 0;
    const extras = [];
    let extraValue = 0;

    for (const [name, qty] of m.ingredientNames) {
      let left = qty;
      const have = need.get(name) || 0;
      const used = Math.min(have, left);
      if (used > 0) {
        need.set(name, have - used);
        left -= used;
        coveredCount += used;
        coveredValue += (idx.get(name) || 0) * used;
      }
      if (left > 0) {
        const unit = idx.get(name) || 0;
        extras.push({ name, qty: left, unit });
        extraValue += unit * left;
      }
    }

    // 必须是「需求被完整满足」的套餐，否则不是升级而是换个吃法
    const fullyCovered = [...need.values()].every((v) => v === 0);
    if (!fullyCovered) continue;
    if (extras.length === 0) continue; // 没有多出的东西

    // 优先用官方核价。菜单标价可能是「随单购麦金卡优惠价」，不买卡根本拿不到，
    // 直接拿标价算升级会给出完全错误的建议。
    const verified = verifiedPrices && verifiedPrices.has(m.code);
    const effPrice = verified ? verifiedPrices.get(m.code) : m.price;
    const base = bestPrice != null ? bestPrice : coveredValue;
    const delta = round2(effPrice - base); // 相对当前最优方案要多掏的钱
    const net = round2(extraValue - delta);
    if (net <= 0) continue; // 不划算就不推荐
    if (delta > 20) continue; // 跨度太大不算「加一点」

    out.push({
      name: m.name,
      code: m.code,
      price: effPrice,
      menuPrice: m.price,
      verified,
      delta,
      extraValue: round2(extraValue),
      net,
      extras,
    });
  }

  out.sort((a, b) => b.net - a.net);
  return out.slice(0, topN);
}

/**
 * 用官方 calculate-price 对方案做真实核价（含券）
 * @returns {Promise<Array>} 按实付升序排列的方案列表
 */
async function evaluatePlans(menu, plans, coupons, { limit = 12, demand } = {}) {
  const storeArgs = { storeCode: menu.storeCode, orderType: 1, beType: 1 };
  const results = [];

  const candidatePlans = plans.slice(0, limit);
  // 随单购核价要额外打接口，只给靠前的方案算，控制请求量（官方限制 600 次/分钟）
  const WO_PLAN_LIMIT = 5;

  for (const [pi, plan] of candidatePlans.entries()) {
    const codes = new Set(plan.items.map((i) => i.code));
    const couponHits = coupons && coupons.length ? matchCoupons(coupons, codes) : [];

    // 随单购价：菜单上带 withOrder 的餐品，持有麦金卡时是另一个价
    let withOrderPrice = null;
    let withOrderName = null;
    if (pi < WO_PLAN_LIMIT) {
      const woMeal = plan.items
        .map((i) => menu.meals.get(i.code))
        .find((m) => m && m.withOrder && m.withOrder.membershipCode);
      if (woMeal) {
        const woItems = plan.items.map((i) => ({ productCode: i.code, quantity: i.qty }));
        try {
          const r2 = await callTool('calculate-price', {
            ...storeArgs,
            items: woItems,
            withOrder: {
              membershipCode: woMeal.withOrder.membershipCode,
              membershipSpecId: woMeal.withOrder.specId,
            },
          });
          if (r2.data && r2.data.price !== undefined) {
            withOrderPrice = fen(r2.data.price);
            withOrderName = woMeal.name;
          }
        } catch (_) {
          /* 随单购核价失败不影响主流程 */
        }
      }
    }

    const variants = [{ coupon: null }];
    for (const hit of couponHits.slice(0, 3)) variants.push({ coupon: hit });

    for (const v of variants) {
      const items = plan.items.map((i) => ({ productCode: i.code, quantity: i.qty }));
      if (v.coupon) {
        const target = items.find((i) => i.productCode === v.coupon.productCode);
        if (target) {
          target.couponId = v.coupon.coupon.couponId;
          target.couponCode = v.coupon.coupon.couponCode;
        }
      }

      try {
        const res = await callTool('calculate-price', { ...storeArgs, items });
        const d = res.data || {};
        if (d.price === undefined) continue;
        const itemsWithNut = plan.items.map((i) => ({
          ...i,
          nutrition: (menu.meals.get(i.code) || {}).nutrition || null,
        }));

        results.push({
          items: plan.items.map((i) => ({ ...i })),
          nutrition: sumNutrition(itemsWithNut),
          extras: demand ? getExtras(menu, plan, demand) : [],
          withOrderPrice: v.coupon ? null : withOrderPrice, // 券与随单购不叠加，只给无券版
          withOrderName: v.coupon ? null : withOrderName,
          coupon: v.coupon ? { title: v.coupon.coupon.title, productName: v.coupon.productName } : null,
          price: fen(d.price),
          originalPrice: fen(d.originalPrice),
          discount: fen(d.discount),
          productPrice: fen(d.productPrice),
          breakdown: (d.productList || []).map((p) => ({
            code: p.productCode,
            name: p.productName,
            qty: p.quantity,
            subtotal: fen(p.subtotal),
            originalSubtotal: fen(p.originalSubtotal),
          })),
        });
      } catch (_) {
        /* 单个方案核价失败不阻断整体 */
      }
    }
  }

  results.sort((a, b) => a.price - b.price);
  return dedupe(results).slice(0, limit);
}

/**
 * 在已核价的方案池里叠加饮食偏好：
 * 先按热量上限过滤，再在「与最低价相差不超过容差」的方案中选最符合偏好的那个。
 * 不做成纯营养排序，是因为这是个省钱引擎 —— 省钱是主目标，健康是在省到位的方案里挑。
 */
function applyDietPreference(results, { diet, maxKcal, tolerance } = {}) {
  let pool = results.slice();
  const droppedByKcal = [];

  if (maxKcal != null && !Number.isNaN(Number(maxKcal))) {
    const cap = Number(maxKcal);
    pool = pool.filter((p) => {
      const kcal = p.nutrition ? p.nutrition.kcal : 0;
      const ok = !kcal || kcal <= cap;
      if (!ok) droppedByKcal.push(p);
      return ok;
    });
  }

  if (!pool.length) return { pool, chosen: null, cheapest: null, near: [], tol: 0, droppedByKcal };

  const cheapest = pool[0];
  let chosen = cheapest;
  let near = [];
  let tol = 0;

  if (diet && DIETS[diet]) {
    const score = DIETS[diet].score;
    tol =
      tolerance != null && !Number.isNaN(Number(tolerance))
        ? Number(tolerance)
        : Math.max(3, Math.round(cheapest.price * 15) / 100);
    near = pool.filter((p) => p.price <= cheapest.price + tol);
    const ranked = near.slice().sort((a, b) => score(a.nutrition || {}) - score(b.nutrition || {}));
    chosen = ranked[0] || cheapest;
  }

  return { pool, chosen, cheapest, near, tol, droppedByKcal };
}

/** 方案里「需求之外白得的东西」——套餐溢出部分 */
function getExtras(menu, plan, demand) {
  const need = new Map();
  for (const [code, qty] of demand) {
    const m = menu.meals.get(code);
    if (!m) continue;
    need.set(m.canonical, (need.get(m.canonical) || 0) + qty);
  }

  const extras = [];
  for (const item of plan.items) {
    const meal = menu.meals.get(item.code);
    if (!meal || !meal.ingredientNames) continue;
    for (let n = 0; n < item.qty; n++) {
      for (const [name, qty] of meal.ingredientNames) {
        const used = Math.min(qty, need.get(name) || 0);
        if (used > 0) need.set(name, (need.get(name) || 0) - used);
        const left = qty - used;
        if (left > 0) extras.push(name);
      }
    }
  }
  return [...new Set(extras)];
}

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key =
      r.items.map((i) => `${i.code}x${i.qty}`).sort().join('|') +
      '#' + (r.coupon ? r.coupon.title : '-');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** 基线：全部单点，不做任何套餐/券优化 */
function baselinePrice(menu, demand) {
  let sum = 0;
  let original = 0;
  for (const [code, qty] of demand) {
    const m = menu.meals.get(code);
    if (!m) continue;
    sum += m.price * qty;
    original += (m.originalPrice || m.price) * qty;
  }
  return { price: round2(sum), originalPrice: round2(original) };
}

function fen(v) {
  return round2(Number(v || 0) / 100);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  generatePlans,
  evaluatePlans,
  baselinePrice,
  suggestUpgrades,
  applyDietPreference,
  fits,
  subtract,
};
