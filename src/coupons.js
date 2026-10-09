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

/** 拉取卡包内所有券（不校验门店可用性，仅做资产盘点与到期提醒） */
async function loadMyCoupons() {
  const res = await callTool('query-my-coupons', { page: '1', pageSize: '200' });
  return { text: res.raw && res.raw._raw ? res.raw._raw : '', ok: res.ok };
}

/** 拉取可领取券列表 */
async function loadAvailableCoupons() {
  const res = await callTool('available-coupons', {});
  return { text: res.raw && res.raw._raw ? res.raw._raw : '', ok: res.ok };
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
