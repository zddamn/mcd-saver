'use strict';

/** 计算字符串的显示宽度（中日韩全角字符按 2 计） */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += c > 0x2e80 && c < 0xff61 ? 2 : 1;
  }
  return w;
}

function pad(s, width, align = 'left') {
  const str = String(s);
  const gap = Math.max(0, width - displayWidth(str));
  return align === 'right' ? ' '.repeat(gap) + str : str + ' '.repeat(gap);
}

function yuan(n) {
  return '¥' + Number(n).toFixed(2);
}

function printHeader(title) {
  console.log('\n' + '='.repeat(64));
  console.log('  ' + title);
  console.log('='.repeat(64));
}

/** 打印最优解排行榜 */
function printPlans(plans, baseline, demandText) {
  printHeader(`麦麦省钱最优解 · ${demandText}`);

  console.log(`\n基线（全部单点、不用券）：${yuan(baseline.price)}`);
  if (baseline.originalPrice > baseline.price) {
    console.log(`对照原价（划线价）：        ${yuan(baseline.originalPrice)}`);
  }

  if (!plans.length) {
    console.log('\n未找到可行方案。');
    return;
  }

  const best = plans[0];
  const saveVsBase = round2(baseline.price - best.price);

  console.log('\n方案对比（按实付升序，价格来自官方 calculate-price 实时核价）\n');
  console.log(
    pad('#', 4) +
      pad('购买组合', 30) +
      pad('用券', 14) +
      pad('实付', 10, 'right') +
      pad('省', 10, 'right') +
      pad('热量', 12, 'right')
  );
  console.log('-'.repeat(80));

  plans.forEach((p, i) => {
    let combo = p.items.map((it) => `${it.name}x${it.qty}`).join(' + ');
    if (p.extras && p.extras.length) combo += ` [+${p.extras.join('、')}]`;
    const coupon = p.coupon ? p.coupon.title : '—';
    const save = round2(baseline.price - p.price);
    const flag = i === 0 ? ' ★' : '';
    console.log(
      pad(`${i + 1}${flag}`, 4) +
        pad(ellipsis(combo, 28), 30) +
        pad(ellipsis(coupon, 12), 14) +
        pad(yuan(p.price), 10, 'right') +
        pad((save > 0 ? '-' : '+') + yuan(Math.abs(save)).slice(1), 10, 'right') +
        pad(kcalText(p.nutrition), 12, 'right')
    );
  });

  console.log('\n最优方案');
  for (const it of best.items) {
    console.log(`  · ${it.name} × ${it.qty}   ${yuan(it.price * it.qty)}`);
  }
  if (best.extras && best.extras.length) {
    console.log(`  · 白得：${best.extras.join('、')}（套餐自带，不需要的东西可视为加量）`);
  }
  if (best.coupon) console.log(`  · 用券：${best.coupon.title}`);
  console.log(`  → 实付 ${yuan(best.price)}（原价 ${yuan(best.originalPrice)}，优惠 ${yuan(best.discount)}）`);
  if (saveVsBase > 0) {
    const pct = baseline.price > 0 ? Math.round((saveVsBase / baseline.price) * 100) : 0;
    console.log(`  → 相比全部单点省 ${yuan(saveVsBase)}（${pct}%）`);
  }
  printNutritionLine(best.nutrition);

  // 随单购对比：方案池里只要有带卡价差的，就单独讲清楚
  const wo = plans.find((p) => p.withOrderPrice != null && p.price - p.withOrderPrice > 1);
  if (wo) {
    const gap = round2(wo.price - wo.withOrderPrice);
    console.log(
      `\n随单购对比：${wo.items.map((i) => i.name).join(' + ')}`
    );
    console.log(
      `  常规价 ${yuan(wo.price)} → 随单购价 ${yuan(wo.withOrderPrice)}（省 ${yuan(gap)}）`
    );
    console.log(
      `  注：随单购价需持有效麦金卡（「${wo.withOrderName}」带 withOrder 优惠），卡费另计且未计入，值不值看你一个月吃几次`
    );
  }

  if (plans.length > 1) {
    const worst = plans[plans.length - 1];
    const gap = round2(worst.price - best.price);
    if (gap > 0) {
      console.log(`\n  同需求下最贵方案 ${yuan(worst.price)}，最优/最差价差 ${yuan(gap)} —— 点法不同，真金白银。`);
    }
  }
}

/** 打印餐品省钱榜（套餐 vs 其成分单点价） */
function printMenuSavings(menu, topN = 15) {
  printHeader('套餐省钱榜（套餐现价 vs 成分单点价）');

  const rows = [];
  for (const m of menu.list) {
    if (!m.isCombo || !m.ingredientCodes) continue;
    let sum = 0;
    let ok = true;
    for (const [code, qty] of m.ingredientCodes) {
      const sub = menu.meals.get(code);
      if (!sub) { ok = false; break; }
      sum += sub.price * qty;
    }
    if (!ok || sum === 0) continue;
    rows.push({
      name: m.name,
      comboPrice: m.price,
      singlePrice: round2(sum),
      save: round2(sum - m.price),
      pct: Math.round(((sum - m.price) / sum) * 100),
    });
  }

  rows.sort((a, b) => b.save - a.save);
  const top = rows.slice(0, topN);

  console.log('\n' + pad('套餐', 32) + pad('套餐价', 11, 'right') + pad('单点合计', 12, 'right') + pad('省', 10, 'right') + pad('幅度', 8, 'right'));
  console.log('-'.repeat(73));
  for (const r of top) {
    console.log(
      pad(ellipsis(r.name, 30), 32) +
        pad(yuan(r.comboPrice), 11, 'right') +
        pad(yuan(r.singlePrice), 12, 'right') +
        pad(yuan(r.save), 10, 'right') +
        pad(`${r.pct}%`, 8, 'right')
    );
  }
}

function printNutritionLine(n) {
  if (!n || !n.kcal) return;
  const p = Math.round(((n.protein * 4) / n.kcal) * 100);
  const f = Math.round(((n.fat * 9) / n.kcal) * 100);
  const c = Math.round(((n.carb * 4) / n.kcal) * 100);
  console.log(
    `  → 营养：${Math.round(n.kcal)} kcal · 蛋白 ${n.protein}g · 脂肪 ${n.fat}g · 碳水 ${n.carb}g · 钠 ${n.sodium}mg`
  );
  console.log(`     供能比：蛋白 ${p}% / 脂肪 ${f}% / 碳水 ${c}%` + (n.incomplete ? '  ⚠️ 部分成分缺官方营养数据' : ''));
}

function kcalText(n) {
  if (!n || !n.kcal) return '—';
  return Math.round(n.kcal) + ' kcal';
}

/**
 * 积分商城兑换榜
 * 只展示尚未过期、且能算出「省多少」的券；识别不了的不硬给数字。
 */
function printPointsRank({ account, now, deals }, { topN = 10, showExpired = false } = {}) {
  const { rankDeals } = require('./points');
  const ranked = rankDeals(deals, { includeExpired: showExpired });
  const live = ranked.filter((d) => !d.expired);
  const expiredCount = deals.length - live.length;

  printHeader(`我的 ${account.currency}`);
  console.log(
    `  可用 ${account.available} 分 · 累计获得 ${account.accumulative} 分 · 已用 ${account.used} 分 · 已过期 ${account.expired} 分`
  );
  if (account.expireThisMonth > 0) {
    console.log(`  ⚠️ 本月将过期 ${account.expireThisMonth} 分，优先换掉它们`);
  }
  console.log(`  当前时间：${now.date}（${now.source}）`);

  if (expiredCount) {
    console.log(
      `\n  注：积分商城共返回 ${deals.length} 件商品，其中 ${expiredCount} 件已过期（官方列表不自动清理），已过滤。`
    );
  }

  console.log('\n可兑换商品券（按「每 100 积分能省多少」排序）\n');
  console.log(
    pad('积分', 7, 'right') +
      pad('券', 24) +
      pad('券价', 9, 'right') +
      pad('单点估', 10, 'right') +
      pad('省', 9, 'right') +
      pad('每100分', 10, 'right') +
      pad('剩余', 9, 'right')
  );
  console.log('-'.repeat(78));

  // 表格只放估得出价的券；估不出的统一放到下面的「待确认」列表，避免重复且误导
  const priced = live.filter((d) => d.regular != null && d.couponPrice != null);
  let shown = 0;
  for (const d of priced) {
    if (shown >= topN) break;
    const flag = d.affordable ? '' : '✗';
    const price = d.couponPrice != null ? yuan(d.couponPrice) : '—';
    const regular = d.regular != null ? (d.approx ? '≈' : '') + yuan(d.regular) : '待确认';
    const save = d.save != null ? yuan(d.save) : '—';
    const per = d.per100 != null ? yuan(d.per100) : '—';
    const left = d.daysLeft != null ? `${d.daysLeft} 天` : '—';
    console.log(
      pad(`${flag}${d.point}`, 7, 'right') +
        pad(ellipsis(d.dealName, 22), 24) +
        pad(price, 9, 'right') +
        pad(regular, 10, 'right') +
        pad(save, 9, 'right') +
        pad(per, 10, 'right') +
        pad(left, 9, 'right')
    );
    if (d.matched.length) {
      console.log(`        └ ${d.matched.map((m) => `${m.name}(${yuan(m.price)})`).join(' + ')}${d.qty > 1 ? ' ×' + d.qty : ''}`);
    }
    shown++;
  }

  const pending = live.filter((d) => !(d.regular != null && d.couponPrice != null));
  if (pending.length) {
    console.log(`\n另有 ${pending.length} 张券不自动估价 —— 券面写的是「任选/指定」，或本店菜单没有对应单品，硬猜会给出错误数字：`);
    for (const d of pending) {
      console.log(`  · ${d.name}（${d.point} 分，券价 ${d.couponPrice != null ? yuan(d.couponPrice) : '见券面'}）`);
    }
  }

  const unaffordable = live.filter((d) => !d.affordable);
  if (unaffordable.length) {
    const need = Math.min(...unaffordable.map((d) => d.point)) - account.available;
    console.log(`\n✗ = 当前积分不够。最近的一张还差 ${need} 分。`);
  }

  console.log('\n说明：单点估 = 券内商品按本店菜单单点价计算；≈ 表示只识别到部分成分，实际可能更高。');
  console.log('      本工具只做对比分析，不会替你发起兑换，兑换请在麦当劳官方渠道确认券面规则。');
}

/** 针对某笔需求，提示「用积分券可能更便宜」 */
function printPointsForDemand(suggestions) {
  if (!suggestions || !suggestions.length) return;
  console.log('\n积分换券方案（比上面的最优解更省）');
  for (const s of suggestions) {
    const d = s.deal;
    console.log(
      `  · 花 ${d.point} 积分换「${d.dealName}」券（${yuan(d.couponPrice)}）`
    );
    console.log(`    抵掉：${s.covered.join('、')}${s.rest.length ? `；剩下单点：${s.rest.join('、')}` : ''}`);
    console.log(`    合计 ${yuan(s.total)}，比最优现金方案省 ${yuan(s.delta)}`);
  }
  console.log('  注：积分为沉没成本，是否划算取决于你自己的用分习惯。');
}

/**
 * 餐品分组：低脂榜如果只按脂肪供能比全局排序，会被一堆 0 脂肪的饮料霸榜，
 * 对用户毫无参考价值。所以按「主食 / 小食 / 饮料 / 甜品」分组各推 top。
 */
const FOOD_GROUPS = [
  { key: '主食', test: /堡|卷|麦满分|粥|饭/ },
  { key: '小食', test: /薯条|鸡|翅|派|薯饼|鸡块|鸡球|玉米|沙拉|虾|洋葱|脆/ },
  { key: '甜品', test: /圆筒|新地|麦旋风|冰淇淋|奶冻|雪冰/ },
  { key: '饮料', test: /可乐|雪碧|咖啡|茶|奶|汁|汽|冰|美式|奶铁|牛奶|豆浆|水/ },
];

function groupOf(name) {
  for (const g of FOOD_GROUPS) if (g.test.test(name)) return g.key;
  return '其他';
}

/**
 * 饮食偏好榜：按指定偏好（低脂/低糖/低钠/高蛋白/低卡）给餐品排序
 */
function printDietRank(menu, dietKey, topN = 5, { grouped = true, includePartial = false } = {}) {
  const DIETS = require('./nutrition').DIETS;
  const d = DIETS[dietKey];
  if (!d) {
    console.log(`未知的饮食偏好：${dietKey}`);
    console.log(`可选：${Object.keys(DIETS).join(' / ')}`);
    return;
  }

  const all = menu.list.filter((m) => m.nutrition && m.nutrition.kcal > 0);
  // 数据不完整的套餐（部分成分缺官方营养）数值偏低，默认不参与推荐，否则会霸榜误导
  const partial = all.filter((m) => m.nutrition.incomplete);
  const pool = includePartial ? all : all.filter((m) => !m.nutrition.incomplete);

  const rows = pool
    .map((m) => ({ meal: m, score: d.score(m.nutrition) }))
    .sort((a, b) => a.score - b.score);

  printHeader(`${d.label}推荐榜（排序指标：${d.metric}）`);

  const head =
    '\n' +
    pad('餐品', 30) +
    pad('价格', 10, 'right') +
    pad('热量', 11, 'right') +
    pad('蛋白', 9, 'right') +
    pad('脂肪', 9, 'right') +
    pad('碳水', 9, 'right') +
    pad('钠', 10, 'right');

  function printRow(r) {
    const n = r.meal.nutrition;
    return (
      pad(ellipsis(r.meal.name + (r.meal.isCombo ? '（套餐）' : '') + (r.meal.nutrition.incomplete ? ' *' : ''), 28), 30) +
      pad(yuan(r.meal.price), 10, 'right') +
      pad(`${Math.round(n.kcal)} kcal`, 11, 'right') +
      pad(`${n.protein}g`, 9, 'right') +
      pad(`${n.fat}g`, 9, 'right') +
      pad(`${n.carb}g`, 9, 'right') +
      pad(`${n.sodium}mg`, 10, 'right')
    );
  }

  if (!grouped) {
    console.log(head);
    console.log('-'.repeat(88));
    for (const r of rows.slice(0, topN * 3)) console.log(printRow(r));
  } else {
    const buckets = new Map();
    for (const r of rows) {
      const g = groupOf(r.meal.name);
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g).push(r);
    }
    const order = [...FOOD_GROUPS.map((g) => g.key), '其他'];
    for (const g of order) {
      const list = buckets.get(g);
      if (!list || !list.length) continue;
      console.log(`\n【${g}】`);
      console.log(head.trimStart());
      console.log('-'.repeat(88));
      for (const r of list.slice(0, topN)) console.log(printRow(r));
    }
  }

  if (dietKey === 'low-sugar') {
    console.log('\n注：官方营养表未单独给出糖含量，本榜以碳水化合物（含糖）近似，排序指标为碳水供能比。');
  }
  const miss = menu.list.filter((m) => !m.nutrition).length;
  if (miss) console.log(`\n注：${miss} 个餐品未匹配到官方营养数据，未参与排序。`);
  if (partial.length) {
    console.log(
      `注：另有 ${partial.length} 个套餐的部分成分缺官方营养数据，数值偏低，已排除（--partial 可纳入，带 * 标记）。`
    );
  }
}

/** 打印「加价升级」建议 */
function printUpgrades(upgrades) {
  if (!upgrades || !upgrades.length) return;

  console.log('\n加价升级（需求不变，多花一点能白得多少）\n');
  for (const u of upgrades) {
    const extra = u.extras.map((e) => `${e.name}${e.qty > 1 ? '×' + e.qty : ''}`).join('、');
    const src = u.verified ? '官方核价' : `菜单标价 ${yuan(u.menuPrice)}，未核价`;
    console.log(`  · 换「${u.name}」${yuan(u.price)}（${src}）：多花 ${yuan(u.delta)}，多得 ${extra}`);
    console.log(`    这些东西单点值 ${yuan(u.extraValue)}，净赚 ${yuan(u.net)}`);
  }
}

/** 生成可视化 HTML 报告（用于分享，暗色主题） */
function buildHtmlReport({ demandText, plans, baseline, storeName }) {
  const best = plans[0];
  const worst = plans[plans.length - 1];
  const maxPrice = worst ? worst.price : best.price;
  const minPrice = best.price;
  const span = Math.max(0.01, maxPrice - minPrice);

  const rows = plans
    .map((p, i) => {
      const width = 8 + ((p.price - minPrice) / span) * 88; // 便宜的条短
      const pct = ((p.price - minPrice) / span) * 100;
      const save = round2(baseline.price - p.price);
      return `
      <div class="row ${i === 0 ? 'best' : ''}">
        <div class="rank">${i === 0 ? '★ 最优' : '#' + (i + 1)}</div>
        <div class="combo">${escapeHtml(p.items.map((it) => `${it.name}×${it.qty}`).join(' + '))}
          ${p.coupon ? `<span class="tag">券: ${escapeHtml(p.coupon.title)}</span>` : ''}
        </div>
        <div class="bar-wrap"><div class="bar" style="width:${width}%;--p:${pct}"></div></div>
        <div class="price">¥${p.price.toFixed(2)}</div>
        <div class="save">${save > 0 ? '省 ¥' + save.toFixed(2) : '+¥' + Math.abs(save).toFixed(2)}</div>
      </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>麦麦省钱最优解 · ${escapeHtml(demandText)}</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#252a35;--txt:#e6e9ef;--dim:#8b93a7;--gold:#ffb400;--red:#e5484d;--green:#30c85e}
  *{box-sizing:border-box}
  body{margin:0;padding:32px;background:var(--bg);color:var(--txt);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:920px;margin:0 auto}
  h1{font-size:22px;margin:0 0 6px}
  .sub{color:var(--dim);font-size:13px;margin-bottom:24px}
  .hero{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
  .stat{flex:1;min-width:150px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .stat .k{color:var(--dim);font-size:12px}
  .stat .v{font-size:22px;font-weight:700;margin-top:6px}
  .stat .v.gold{color:var(--gold)} .stat .v.green{color:var(--green)} .stat .v.red{color:var(--red)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:8px 16px 16px}
  .row{display:grid;grid-template-columns:64px 1fr 180px 78px 84px;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
  .row:last-child{border-bottom:0}
  .row.best .rank{color:var(--gold)}
  .rank{font-size:12px;color:var(--dim)}
  .combo{font-size:14px;line-height:1.5}
  .tag{display:inline-block;margin-left:6px;font-size:11px;color:var(--gold);border:1px solid var(--gold);border-radius:6px;padding:1px 6px}
  .bar-wrap{height:8px;background:#1e222b;border-radius:4px;overflow:hidden}
  .bar{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--green),var(--gold),var(--red))}
  .price{text-align:right;font-weight:700;font-size:15px}
  .save{text-align:right;font-size:13px;color:var(--green)}
  .foot{margin-top:18px;color:var(--dim);font-size:12px;line-height:1.7}
</style></head>
<body><div class="wrap">
  <h1>麦麦省钱最优解</h1>
  <div class="sub">${escapeHtml(storeName || '')} · 需求：${escapeHtml(demandText)} · 价格由麦当劳官方 MCP <code>calculate-price</code> 实时核价</div>
  <div class="hero">
    <div class="stat"><div class="k">最优实付</div><div class="v gold">¥${best.price.toFixed(2)}</div></div>
    <div class="stat"><div class="k">全部单点基线</div><div class="v">¥${baseline.price.toFixed(2)}</div></div>
    <div class="stat"><div class="k">省下</div><div class="v green">¥${Math.max(0, round2(baseline.price - best.price)).toFixed(2)}</div></div>
    <div class="stat"><div class="k">最优/最差价差</div><div class="v red">¥${round2((worst ? worst.price : best.price) - best.price).toFixed(2)}</div></div>
  </div>
  <div class="card">${rows}</div>
  <div class="foot">
    数据来源于麦当劳中国官方 MCP Server，实时拉取菜单、门店可用券，并用官方核价接口逐一验证。<br>
    餐品价格、供应状态与券可用性以麦当劳官方渠道实时结果为准。本项目为参赛作品，非麦当劳官方产品。
  </div>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ellipsis(s, max) {
  const str = String(s);
  return displayWidth(str) <= max ? str : str.slice(0, Math.max(1, max - 1)) + '…';
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  printPlans,
  printMenuSavings,
  printDietRank,
  printUpgrades,
  printNutritionLine,
  printPointsRank,
  printPointsForDemand,
  buildHtmlReport,
  pad,
  yuan,
};
