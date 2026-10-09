#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadMenu, expandCombos, attachNutrition, searchMeals } = require('./menu');
const { loadNutrition, dietKeys } = require('./nutrition');
const { loadStoreCoupons, loadMyCoupons, loadAvailableCoupons, autoBind } = require('./coupons');
const {
  generatePlans,
  evaluatePlans,
  baselinePrice,
  suggestUpgrades,
  applyDietPreference,
} = require('./solver');
const {
  printPlans,
  printMenuSavings,
  printDietRank,
  printUpgrades,
  printNutritionLine,
  printPointsRank,
  printPointsForDemand,
  buildHtmlReport,
  yuan,
} = require('./reporter');
const { analyzePoints, rankDeals, applyToDemand } = require('./points');
const cache = require('./cache');

const DEFAULT_STORE = '1410388'; // 示例门店（麦当劳厦门立功路餐厅），可用 --store 覆盖

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(`
麦麦省钱最优解引擎 mcd-saver —— 基于麦当劳 MCP 的套餐/券组合求解器

用法:
  node src/cli.js best   --want "巨无霸,薯条,可乐"   求最低实付购买方案（含热量标注）
  node src/cli.js menu                                查看套餐省钱榜
  node src/cli.js diet   --diet low-fat               按饮食偏好推荐餐品（含热量/蛋白/脂肪/碳水/钠）
  node src/cli.js coupons                             盘点我的券 / 可领券
  node src/cli.js points                              积分商城：你的积分该换哪张券（自动过滤已过期）
  node src/cli.js report --want "巨无霸,薯条,可乐"    生成可视化 HTML 报告

饮食偏好:
  --diet <偏好>         low-calorie 低卡 / low-fat 低脂 / low-sugar 低糖(低碳水)
                        / low-sodium 低钠 / high-protein 高蛋白
  --max-kcal <数字>     热量上限，过滤掉超标的方案
  --tolerance <元>      为偏好让路愿意多花的钱（默认 max(3元, 最低价15%)）

  例：node src/cli.js best --want "巨无霸,薯条,可乐" --diet low-fat
      → 在同样省钱的方案里，选脂肪供能比最低的那个

通用参数:
  --store <门店编码>    默认 ${DEFAULT_STORE}
  --city <城市> --kw <位置关键词>   按位置搜索门店（优先于 --store）
  --html <文件路径>     输出 HTML 报告
  --top <N>             展示前 N 个方案（默认 8）
  --refresh             忽略本地缓存重新拉取
  --all                 积分榜含已过期商品
  --no-points           best 命令跳过积分建议（省 2 次请求）

环境变量:
  MCD_MCP_TOKEN         麦当劳 MCP Token（必填）
`);
}

async function resolveStore(args) {
  const { callTool } = require('./mcp-client');
  if (args.city && args.kw) {
    const res = await callTool('query-nearby-stores', {
      beType: 1,
      searchType: 2,
      city: args.city,
      keyword: args.kw,
    });
    const list = (res.data && Array.isArray(res.data) ? res.data : []);
    if (!list.length) throw new Error('未搜索到门店，请更换关键词');
    console.log(`搜索到 ${list.length} 家门店，取第一家：${list[0].storeName}`);
    return { storeCode: String(list[0].storeCode), storeName: list[0].storeName };
  }
  const storeCode = String(args.store || DEFAULT_STORE);
  return { storeCode, storeName: `门店 ${storeCode}` };
}

/** 把「巨无霸,薯条,可乐」解析成 demand: Map<code, qty> */
function resolveDemand(menu, wantText) {
  const wants = String(wantText)
    .split(/[,，、+＋\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const demand = new Map();
  const unresolved = [];

  for (const w of wants) {
    const hits = searchMeals(menu, w);
    if (!hits.length) {
      unresolved.push(w);
      continue;
    }
    const pick = hits[0];
    demand.set(pick.code, (demand.get(pick.code) || 0) + 1);
  }

  return { demand, unresolved, wants };
}

/** 确保拿到带套餐成分 + 营养数据的菜单（优先本地缓存） */
async function ensureMenu(args, storeCode) {
  let menu = args.refresh ? null : cache.read(storeCode);
  const fresh = !menu;

  if (menu) {
    console.log(`菜单：${menu.list.length} 个餐品（本地缓存，--refresh 可强制刷新）`);
  } else {
    menu = await loadMenu(storeCode);
    console.log(`菜单：${menu.list.length} 个餐品`);
    console.log(`展开套餐成分中…`);
    menu = await expandCombos(menu, {
      onProgress: (d, t) => process.stdout.write(`\r  已展开 ${d}/${t}`),
    });
    process.stdout.write('\r  套餐成分展开完成\n');
  }

  const nut = await loadNutrition();
  menu = attachNutrition(menu, nut);
  const withKcal = menu.list.filter((m) => m.nutrition && m.nutrition.kcal > 0).length;
  console.log(`营养数据：${nut.list.length} 条官方记录，已匹配 ${withKcal}/${menu.list.length} 个餐品`);
  if (fresh) cache.write(menu);

  return menu;
}

async function cmdBest(args) {
  const want = args.want;
  if (!want) {
    console.error('缺少 --want 参数，例如：--want "巨无霸,薯条,可乐"');
    process.exit(1);
  }

  const { storeCode, storeName } = await resolveStore(args);
  console.log(`门店：${storeName}（${storeCode}）`);

  const menu = await ensureMenu(args, storeCode);

  const { demand, unresolved, wants } = resolveDemand(menu, want);
  if (!demand.size) {
    console.error(`\n未能匹配到任何餐品：${unresolved.join('、')}`);
    console.error('可用 --store 切换门店，或先运行 menu 命令查看餐品名。');
    process.exit(1);
  }
  if (unresolved.length) console.log(`未匹配（已忽略）：${unresolved.join('、')}`);

  const coupons = await loadStoreCoupons(storeCode);
  console.log(`门店可核价券：${coupons.length} 组`);

  // 卡包券：官方只给文本、不给 couponCode，核不了价，但到期提醒很有价值
  const mine = await loadMyCoupons();
  if (mine.total) {
    const expiring = mine.list.filter((c) => c.expiringToday);
    console.log(`卡包券：${mine.total} 张（官方不返回 couponCode，无法自动核价，需你在 App 内使用）`);
    if (expiring.length) {
      console.log(`  ⚠️ ${expiring.length} 张今日到期：${expiring.map((c) => `${c.title}(¥${c.price})`).join('、')}`);
    }
  }

  const plans = generatePlans(menu, demand);
  console.log(`生成候选方案：${plans.length} 个`);

  const limit = Number(args.top || 8);
  const evaluated = await evaluatePlans(menu, plans, coupons, { limit, demand });

  const baseline = baselinePrice(menu, demand);

  // 饮食偏好：先按热量上限过滤，再在「与最低价相差不超过容差」的方案里挑最符合的
  const diet = typeof args.diet === 'string' ? args.diet : null;
  const pref = applyDietPreference(evaluated, {
    diet,
    maxKcal: args['max-kcal'],
    tolerance: args.tolerance,
  });

  if (pref.pool.length === 0) {
    console.log(`\n⚠️ 没有方案能满足 ${args['max-kcal']} kcal 的热量上限，下面是最低热量的几个方案：`);
    const byKcal = evaluated.slice().sort((a, b) => (a.nutrition.kcal || 0) - (b.nutrition.kcal || 0));
    printPlans(byKcal.slice(0, limit), baseline, wants.join(' + '));
    return;
  }

  printPlans(pref.pool, baseline, wants.join(' + '));

  if (diet && pref.chosen && pref.chosen !== pref.cheapest) {
    console.log(`\n按「${diet}」偏好调整`);
    console.log(`  最低价方案 ${yuan(pref.cheapest.price)}，在 +${yuan(pref.tol)} 容差内有 ${pref.near.length} 个方案`);
    console.log(`  其中最适合的是：${pref.chosen.items.map((i) => i.name + '×' + i.qty).join(' + ')}`);
    printNutritionLine(pref.chosen.nutrition);
  } else if (diet) {
    console.log(`\n「${diet}」偏好下最低价方案本身就是最优解，无需加价。`);
  }

  // 单项方案的官方核价 —— 升级建议必须用它，不能用菜单标价
  const verified = new Map();
  for (const r of evaluated) {
    if (r.items.length === 1) verified.set(r.items[0].code, r.price);
  }
  printUpgrades(suggestUpgrades(menu, demand, pref.pool[0].price, 3, verified));

  // 积分维度：这笔单能不能用积分券更便宜
  if (!args['no-points']) {
    try {
      const pts = await analyzePoints(menu);
      const live = rankDeals(pts.deals);
      const tips = applyToDemand(live, menu, demand, pref.pool[0].price);
      if (tips.length) {
        printPointsForDemand(tips);
      } else {
        const best100 = live.find((d) => d.affordable && d.per100 != null);
        console.log(
          `\n积分：可用 ${pts.account.available} 分，本单没有更省的换券方案` +
            (best100 ? `；当前性价比最高的是「${best100.dealName}」（${best100.point} 分省 ${yuan(best100.save)}）` : '')
        );
      }
    } catch (e) {
      console.log(`\n（积分模块不可用：${e.message}）`);
    }
  }

  if (args.html) {
    const html = buildHtmlReport({
      demandText: wants.join(' + '),
      plans: pref.pool,
      baseline,
      storeName,
    });
    const out = path.resolve(args.html);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html, 'utf8');
    console.log(`\nHTML 报告已生成：${out}`);
  }
}

async function cmdMenu(args) {
  const { storeCode, storeName } = await resolveStore(args);
  console.log(`门店：${storeName}（${storeCode}）`);
  const menu = await ensureMenu(args, storeCode);
  printMenuSavings(menu, Number(args.top || 15));
}

async function cmdDiet(args) {
  const { storeCode, storeName } = await resolveStore(args);
  console.log(`门店：${storeName}（${storeCode}）`);
  const diet = typeof args.diet === 'string' ? args.diet : 'low-calorie';
  const menu = await ensureMenu(args, storeCode);
  printDietRank(menu, diet, Number(args.top || 5), {
    grouped: !args.all,
    includePartial: !!args.partial,
  });
  console.log(`\n可选偏好：${dietKeys().join(' / ')}`);
}

async function cmdCoupons(args) {
  const { storeCode, storeName } = await resolveStore(args);
  console.log(`门店：${storeName}（${storeCode}）\n`);

  const store = await loadStoreCoupons(storeCode);
  console.log(`【本店可核价券】${store.length} 组 —— 唯一能带 couponCode 进官方核价的来源`);
  for (const c of store) {
    const names = (c.products || []).map((p) => p.productName).join('、');
    console.log(`  · ${c.title}（${c.count} 张） 适用：${names || '见券面'}`);
    console.log(`    有效期：${c.tradeDateTime || '—'}`);
  }
  if (!store.length) console.log('  （本店暂无可核价券，换门店试试）');

  if (args.bind) {
    const r = await autoBind();
    console.log(`\n一键领券：${r.ok ? '完成' : '失败'}`);
  }

  const mine = await loadMyCoupons();
  console.log(`\n【我的卡包】${mine.total} 张 —— 官方不返回 couponCode，无法自动核价，需在 App 内使用`);
  for (const c of mine.list) {
    console.log(`  ${c.expiringToday ? '⚠️' : '  '} ${c.title}${c.price != null ? ` ¥${c.price}` : ''}`);
    if (c.valid) console.log(`     有效期：${c.valid}${c.tags.length ? ` · ${c.tags.join('/')}` : ''}`);
  }

  const avail = await loadAvailableCoupons();
  console.log(`\n【可领取】${avail.claimable} 张待领（共 ${(avail.pending || []).length} 张在架）`);
  if (avail.claimable) console.log('  运行 coupons --bind 可一键领取');
}

async function cmdPoints(args) {
  const { storeCode, storeName } = await resolveStore(args);
  console.log(`门店：${storeName}（${storeCode}）`);
  const menu = await ensureMenu(args, storeCode);
  const pts = await analyzePoints(menu);
  printPointsRank(pts, {
    topN: Number(args.top || 10),
    showExpired: !!args.all,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  try {
    if (cmd === 'best') await cmdBest(args);
    else if (cmd === 'menu') await cmdMenu(args);
    else if (cmd === 'diet') await cmdDiet(args);
    else if (cmd === 'coupons') await cmdCoupons(args);
    else if (cmd === 'points') await cmdPoints(args);
    else if (cmd === 'report') {
      args.html = args.html || 'report.html';
      await cmdBest(args);
    } else usage();
  } catch (e) {
    console.error('\n执行失败：' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { resolveDemand, generatePlans, evaluatePlans };
