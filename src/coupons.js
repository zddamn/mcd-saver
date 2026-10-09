'use strict';

const { callTool } = require('./mcp-client');

/**
 * 拉取门店维度可用券（唯一能直接带 couponId/couponCode 进 calculate-price 的来源）
 */
async function loadStoreCoupons(storeCode, orderType = 1, beType = 1, beCode) {
  const args = { storeCode, orderType, beType };
  if (beCode) args.beCode = beCode;
  const res = await callTool('query-store-coupons', args);
  const list = Array.isArray(res.data) ? res.data : [];

  // 同一 couponId 可能有多个券码，按 couponId 归并
  const grouped = new Map();
  for (const c of list) {
    const key = c.couponId || c.title;
    if (!grouped.has(key)) {
      grouped.set(key, {
        couponId: c.couponId,
        couponCode: c.couponCode,
        title: c.title,
        tradeDateTime: c.tradeDateTime,
        promotionId: c.promotionId,
        count: 0,
        products: [],
      });
    }
    const g = grouped.get(key);
    g.count++;
    for (const p of c.products || []) {
      if (!g.products.some((x) => x.productCode === p.productCode)) g.products.push(p);
    }
  }
  return [...grouped.values()];
}

/**
 * 解析官方返回的 markdown 券文本。
 * 官方 query-my-coupons / available-coupons 只给格式化文本，**不含 couponId/couponCode**，
 * 所以券无法带进 calculate-price 核价 —— 能做的只有盘点、到期提醒与到手价展示。
 */
function parseCouponText(text) {
  const src = String(text || '');
  const totalMatch = src.match(/共\s*(\d+)\s*张/);
  const blocks = src.split(/\n##\s+/).slice(1);

  const list = blocks.map((b) => {
    const lines = b.split('\n');
    const title = (lines[0] || '').trim();
    const price = (b.match(/\*\*优惠\*\*:\s*¥?\s*([\d.]+)/) || [])[1] || null;
    const valid = (b.match(/\*\*有效期\*\*:\s*(.*)/) || [])[1] || '';
    const tagsLine = (b.match(/\*\*标签\*\*:\s*(.*)/) || [])[1] || '';
    return {
      title,
      price: price ? Number(price) : null,
      valid: valid.trim(),
      tags: tagsLine
        .split(/[、,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      expiringToday: /今日到期/.test(tagsLine),
    };
  });

  return {
    total: totalMatch ? Number(totalMatch[1]) : list.length,
    list,
    text: src,
  };
}

/** 拉取卡包内所有券（官方不返回 couponCode，无法进核价，仅做盘点与到期提醒） */
async function loadMyCoupons() {
  const res = await callTool('query-my-coupons', { page: '1', pageSize: '200' });
  return parseCouponText(res.raw && res.raw._raw ? res.raw._raw : '');
}

/** 拉取可领取券列表 */
async function loadAvailableCoupons() {
  const res = await callTool('available-coupons', {});
  const raw = res.raw && res.raw._raw ? res.raw._raw : '';
  const parsed = parseCouponText(raw);
  // 可领券文本格式不同：只有「优惠券标题 / 状态」
  const pending = [];
  const re = /优惠券标题：(.+?)\s*\n\s*状态：(\S+)/g;
  let m;
  while ((m = re.exec(raw))) {
    pending.push({ title: m[1].trim(), status: m[2].trim() });
  }
  parsed.pending = pending;
  parsed.claimable = pending.filter((p) => /待领取|可领取|未领取/.test(p.status)).length;
  return parsed;
}

/** 一键领取所有可领券 */
async function autoBind() {
  const res = await callTool('auto-bind-coupons', {});
  return { ok: res.ok, text: res.raw && res.raw._raw ? res.raw._raw : '' };
}

/**
 * 找出能作用于指定商品编码集合的券
 * @param {Array} coupons loadStoreCoupons 的结果
 * @param {Set<string>} codes 目标商品编码
 */
function matchCoupons(coupons, codes) {
  const out = [];
  for (const c of coupons) {
    for (const p of c.products || []) {
      if (codes.has(String(p.productCode))) {
        out.push({ coupon: c, productCode: String(p.productCode), productName: p.productName });
        break;
      }
    }
  }
  return out;
}

module.exports = {
  loadStoreCoupons,
  loadMyCoupons,
  loadAvailableCoupons,
  autoBind,
  matchCoupons,
};
