'use strict';

const { callTool } = require('./mcp-client');
const { normalizeName, toYuan } = require('./menu');

/**
 * 积分维度：账户余额 + 积分商城商品券 + 性价比估算
 *
 * 关键设计：
 * 1. 官方 mall-points-products 返回的列表里混有大量已过期商品（downTime 早于今天），
 *    必须用 MCP 的 now-time-info 拿服务器时间过滤，否则会推荐根本换不了的券。
 * 2. 券的价值 = 券面组合在菜单里的单点价之和 − 券价。我们不做兑换下单，只做估算与排序。
 */

/** 拉取积分账户 */
async function loadAccount() {
  const res = await callTool('query-my-account', {});
  const d = res.data || {};
  return {
    available: Number(d.availablePoint || 0),
    accumulative: Number(d.accumulativePoint || 0),
    expired: Number(d.expiredPoint || 0),
    used: Number(d.usedPoint || 0),
    frozen: Number(d.frozenPoint || 0),
    expireThisMonth: Number(d.currentMouthExpirePoint || 0),
    expireNextMonth: Number(d.nextMouthExpirePoint || 0),
    currency: d.currency || '积分',
  };
}

/** 拉取积分商城（默认只要商品券，这是能直接抵餐费的类别） */
async function loadMall(catRuleIds = '1>4') {
  const res = await callTool('mall-points-products', { catRuleIds });
  const raw = res.data || {};
  // 官方返回的是「以序号为 key 的对象」，不是数组，必须 Object.values
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list.filter((x) => x && x.spuName).map((p) => ({
    spuId: p.spuId,
    name: p.spuName,
    selling: p.selling || p.spuName,
    point: Number(p.point || 0),
    price: toYuan(p.price),
    image: p.spuImage || '',
    category: p.catName || '',
    status: p.status,
    upTime: p.upTime || '',
    downTime: p.downTime || '',
  }));
}

/**
 * 服务器当前时间。用 MCP now-time-info，失败时降级到本地时间（并标记降级）。
 */
async function serverNow() {
  try {
    const res = await callTool('now-time-info', {});
    const d = res.data || {};
    const ts = Number(d.timestamp);
    if (Number.isFinite(ts) && ts > 0) {
      return { ts, date: d.date || new Date(ts).toISOString().slice(0, 10), source: 'MCP 服务器时间' };
    }
  } catch (_) {
    /* 降级 */
  }
  return { ts: Date.now(), date: new Date().toISOString().slice(0, 10), source: '本地时间（MCP 不可用）' };
}

/**
 * 从券名解析出「券价 / 份数 / 商品名」
 * 例：18.8元2份麦辣鸡翅 → { price: 18.8, qty: 2, name: '麦辣鸡翅' }
 *     麦麦脆汁鸡两件套   → { price: null, qty: 1, name: '麦麦脆汁鸡两件套' }
 */
function parseDeal(text) {
  let s = String(text || '').trim();
  let price = null;
  let qty = 1;

  const pm = s.match(/(\d+(?:\.\d+)?)\s*元/);
  if (pm) {
    price = toYuan(pm[1]);
    s = s.replace(pm[0], '');
  }
  const qm = s.match(/(\d+)\s*份/);
  if (qm) {
    qty = Number(qm[1]);
    s = s.replace(qm[0], '');
  } else {
    const cn = { 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 双: 2 };
    const cm = s.match(/^([两二三四五双])/);
    if (cm) {
      qty = cn[cm[1]] || 1;
    }
  }
  s = s.replace(/任选\s*\d*\s*份?/g, '');
  s = s.trim();
  // raw 保留未剥离「任选/指定」的原名 —— 估价时要靠它判断券面是否本就模糊
  return { price, qty, name: s, raw: String(text || '').trim() };
}

/** 券是否已过期（downTime 早于今天 0 点） */
function isExpired(deal, nowTs) {
  if (!deal.downTime) return false;
  const end = new Date(deal.downTime.replace(' ', 'T')).getTime();
  if (!Number.isFinite(end)) return false;
  return end < nowTs;
}

/** 券还剩几天过期 */
function daysLeft(deal, nowTs) {
  if (!deal.downTime) return null;
  const end = new Date(deal.downTime.replace(' ', 'T')).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.ceil((end - nowTs) / 86400000);
}

/** 券名里表示「这是多件组合」的词 —— 这类券若只识别出一小部分，误差太大，宁可不估 */
const BUNDLE_HINT = /(组合|件套|套餐)/;

/** 券名里没有实际指向的虚词 */
const NOISE = /(任选|指定|随心|和|与)/g;

/**
 * 找菜单里「以 frag 开头的单品」。唯一命中才可信，多个就是歧义。
 */
function prefixSingles(menu, frag) {
  if (!frag || frag.length < 2) return [];
  return menu.list.filter(
    (m) => !m.isCombo && m.name && normalizeName(m.name).startsWith(normalizeName(frag))
  );
}

/**
 * 用菜单估算券里「都含什么、单点要多少钱」。
 *
 * 匹配顺序：
 *   1. 贪心最长完整名匹配（「巨无霸可乐组合」→ 巨无霸）
 *   2. 剩余片段按长度递减尝试「前缀唯一匹配」（「板烧可乐」→ 板烧 → 板烧鸡腿堡）
 *
 * 诚实原则：
 *   - 组合券（含「组合/件套」）只要有片段没识别出来，就返回 regular=null，
 *     因为少算一整件会让结果严重失真，宁可不给数字。
 *   - 单一商品券识别到就给估算，但打 approx 标记，输出时用 ≈ 提示可能偏低。
 */
function estimateRegular(menu, dealName, rawText) {
  const raw = String(rawText || dealName || '');

  // 「指定小食任选」「香芋派/菠萝派任选」这类券文案本身就模糊（菜单里没有对应的抽象品类），
  // 硬猜只会给出错误数字 —— 一律不估算，交给用户自己看券面。
  if (/(任选|指定)/.test(raw)) return { matched: [], regular: null, partial: false, unknown: true };

  let rest = String(dealName || '').replace(/(组合|件套|套餐)\s*$/g, '');

  const candidates = menu.list
    .filter((m) => m.name && normalizeName(m.name).length >= 2)
    .map((m) => ({ meal: m, canon: normalizeName(m.name), raw: m.name }))
    .sort((a, b) => b.canon.length - a.canon.length);

  const matched = [];
  const seenCodes = new Set();

  function take(meal, fragLen) {
    if (seenCodes.has(meal.code)) return;
    seenCodes.add(meal.code);
    matched.push({ name: meal.name, price: meal.price, code: meal.code });
    const idx = rest.indexOf(fragLen);
    if (idx >= 0) rest = rest.slice(0, idx) + rest.slice(idx + fragLen.length);
    else rest = '';
  }

  // 1. 完整名匹配
  let guard = 0;
  while (rest && guard++ < 6) {
    let hit = null;
    for (const c of candidates) {
      if (c.canon && normalizeName(rest).includes(c.canon)) {
        hit = c;
        break;
      }
    }
    if (!hit) break;
    take(hit.meal, hit.raw);
  }

  // 2. 剩余片段：长度递减的前缀唯一匹配
  guard = 0;
  while (rest && guard++ < 6) {
    const norm = normalizeName(rest);
    let picked = null;
    for (let len = norm.length; len >= 2 && !picked; len--) {
      for (let start = 0; start + len <= norm.length; start++) {
        const frag = norm.slice(start, start + len);
        if (NOISE.test(frag)) continue;
        NOISE.lastIndex = 0;
        const hits = prefixSingles(menu, frag);
        if (hits.length === 1) {
          picked = { meal: hits[0], frag };
          break;
        }
      }
    }
    if (!picked) break;
    // 前缀匹配扣掉的是归一化片段，这里用长度粗扣（原文位置不可靠）
    const meal = picked.meal;
    if (seenCodes.has(meal.code)) break;
    seenCodes.add(meal.code);
    matched.push({ name: meal.name, price: meal.price, code: meal.code });
    const pos = normalizeName(rest).indexOf(picked.frag);
    rest = pos >= 0 ? rest.slice(0, pos) + rest.slice(pos + picked.frag.length) : '';
  }

  // 剩余片段里是否还有实质内容（去掉虚词后）
  const leftover = normalizeName(rest).replace(NOISE, '').replace(/[\d./]/g, '');
  const partial = leftover.length >= 2;

  if (!matched.length) return { matched: [], regular: null, partial: false, unknown: true };
  if (partial && BUNDLE_HINT.test(raw)) {
    return { matched, regular: null, partial: true, unknown: false };
  }
  return {
    matched,
    regular: toYuan(matched.reduce((s, m) => s + m.price, 0)),
    partial,
    unknown: false,
  };
}

/**
 * 主流程：账户 + 商城 + 菜单 → 性价比榜单
 * @returns {{ account, now, deals: Array }}
 */
async function analyzePoints(menu, { now: injectedNow } = {}) {
  const account = await loadAccount();
  const mall = await loadMall();
  const now = injectedNow || (await serverNow());

  const deals = mall.map((p) => {
    const parsed = parseDeal(p.selling || p.name);
    const est = estimateRegular(menu, parsed.name, parsed.raw);
    const qty = parsed.qty || 1;
    const couponPrice = parsed.price; // null = 券名未标价
    const regular = est.regular == null ? null : toYuan(est.regular * qty);
    const save = regular != null && couponPrice != null ? toYuan(regular - couponPrice) : null;
    const per100 = save != null && p.point > 0 ? Math.round((save / p.point) * 100 * 100) / 100 : null;

    return {
      ...p,
      dealName: parsed.name,
      qty,
      couponPrice,
      matched: est.matched,
      regular,
      save,
      per100,
      partial: !!est.partial,
      unknown: !!est.unknown,
      approx: !!est.partial && regular != null,
      expired: isExpired(p, now.ts),
      daysLeft: daysLeft(p, now.ts),
      affordable: p.point <= account.available,
    };
  });

  return { account, now, deals };
}

/**
 * 排序：可换（未过期）优先 → 每 100 积分省得多优先 → 省得多优先 → 积分少优先
 */
function rankDeals(deals, { onlyAffordable = false, includeExpired = false } = {}) {
  let out = deals.filter((d) => (includeExpired ? true : !d.expired));
  if (onlyAffordable) out = out.filter((d) => d.affordable);

  const score = (d) => (d.per100 == null ? -Infinity : d.per100);
  out.sort((a, b) => {
    const ea = a.per100 == null ? 1 : 0;
    const eb = b.per100 == null ? 1 : 0;
    if (ea !== eb) return ea - eb; // 能估算的排前面
    if (score(b) !== score(a)) return score(b) - score(a);
    if ((b.save || 0) !== (a.save || 0)) return (b.save || 0) - (a.save || 0);
    return a.point - b.point;
  });
  return out;
}

/**
 * 针对具体需求，判断积分券能否更便宜。
 * 思路：券覆盖掉的那些餐品不再单独买，剩下的按单点价补。
 * 只在「券能覆盖需求中的至少一项」时才给建议。
 */
function applyToDemand(deals, menu, demand, bestPrice) {
  const demandMeals = [...demand.entries()].map(([code, qty]) => {
    const m = menu.meals.get(code);
    return { code, qty, name: m ? m.name : code, price: m ? m.price : 0 };
  });

  const out = [];
  for (const d of deals) {
    if (d.expired || !d.affordable || d.couponPrice == null) continue;
    const covered = [];
    const rest = [...demandMeals];
    for (const mi of d.matched) {
      const idx = rest.findIndex((r) => r.name === mi.name || normalizeName(r.name) === normalizeName(mi.name));
      if (idx >= 0) {
        covered.push(rest[idx]);
        rest.splice(idx, 1);
      }
    }
    if (!covered.length) continue;

    const restCost = toYuan(rest.reduce((s, r) => s + r.price * r.qty, 0));
    const total = toYuan(d.couponPrice + restCost);
    const delta = toYuan(bestPrice - total);
    if (delta <= 0) continue;

    out.push({
      deal: d,
      covered: covered.map((c) => c.name),
      rest: rest.map((r) => `${r.name}${r.qty > 1 ? '×' + r.qty : ''}`),
      total,
      delta,
    });
  }
  out.sort((a, b) => b.delta - a.delta);
  return out.slice(0, 3);
}

module.exports = {
  loadAccount,
  loadMall,
  serverNow,
  parseDeal,
  estimateRegular,
  analyzePoints,
  rankDeals,
  applyToDemand,
  isExpired,
  daysLeft,
};
