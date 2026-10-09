# 发布执行包 · 开发者平台发文（合规分享，非刷量）

> 用途：复制下方对应平台的成稿，注册对应账号后粘贴发布即可。
> 所有文案均为「真实分享工具 + 诚实讲发现 + Star 诉求放次要位」，符合比赛红线（正常分享到社区、请朋友点 Star 被允许；刷/买/换量互刷禁止）。
> 仓库：https://github.com/zddamn/mcd-saver ｜ 落地页：https://zddamn.github.io/mcd-saver/

---

## 〇、发布手册（先读）

### 账号注册顺序（挑 2 个就够，别全做）
1. **掘金 juejin.cn** —— 手机号注册，中国开发者密度最高，技术长文转化最好。**首选**。
2. **知乎 zhihu.com** —— 手机号注册，去搜「麦当劳怎么点最划算 / 最便宜」，回答已有高赞问题，流量最大。
3. **少数派 sspai.com** —— 邮箱注册，偏效率/技巧，适合「命令行算清麦当劳」这种巧思。
4. **Reddit r/SideProject**（英文）—— 邮箱注册，全球开发者， novelty 高（用官方 MCP 做工具）。
5. V2EX 需邀请码，门槛高，能搞到再发 /go/programming。

### 发布要点（决定能不能拿到 Star）
- **钩子放最前**：第一句就抛「巨无霸四件套菜单标 ¥32，官方核价 ¥59.5」这种反直觉事实，别铺垫。
- **正文要有真东西**：给代码/命令/数据，让人觉得「这人真做了」，才愿意点进仓库。
- **Star 诉求软且诚实**：结尾一句「参加麦当劳 MCP 大赛，排名看 Star，觉得有意思点个 ⭐」即可，别反复要。
- **配图**：发帖时贴上 `https://zddamn.github.io/mcd-saver/og-image.png`（大图）或 `qrcode.png`（扫码），点击率更高。
- **时机**：工作日晚 20–22 点、周末上午发布，错峰但别卡整点。

### 红线（违反取消资格）
- ❌ 买 Star / 刷量 / 换量互刷 / 多账号自点
- ❌ 泄露 Token 或任何凭证
- ❌ 贬低其他品牌或参赛作品
- ✅ 真实分享、请朋友点 Star、在相关话题下真诚回答并附链接

---

## 一、掘金（技术长文，首选）

**标题**：用麦当劳官方 MCP 做了个省钱引擎，顺手发现菜单标价有三分之一是假的

**正文**：

```
麦当劳中国前段时间开放了官方 MCP Server（mcp.mcd.cn），35 个工具，能拉菜单、拆套餐、核价、查券、查积分。
我拿它写了个命令行工具 mcd-saver：告诉它你想吃什么，它枚举所有套餐/单品组合，逐个调官方 calculate-price 核价，给你最低实付的那一版。

做的过程里发现三件事先没想到的事：

1. 菜单标价不能信。
   「巨无霸四件套」菜单标 ¥32，官方核价 ¥59.50 —— 那个 ¥32 是「随单购麦金卡优惠价」，不买卡拿不到。
   按标价排序会得出「四件套比三件套便宜 5 块」的错误结论，真实核价是贵 22.5。
   现在引擎对同一方案核两次价：常规价和随单购价（withOrder 参数），都给你看。

2. 积分商城不清理过期商品。
   mall-points-products 一次返回 24 件商品券，其中 15 件的 downTime 早于今天。
   直接展示的话，大半是根本换不了的。得用 now-time-info 拿服务器时间过滤，剩下 9 件能换的，再按「每 100 积分省多少」排序。

3. 套餐成分和菜单单品不是同一套编码。
   套餐里的可乐 code 是 3050，菜单里是 9900008751。只能在归一化名称维度做匹配。

实测：「巨无霸+薯条+可乐」单点 ¥50，最优解「巨无霸三件套」¥37，省 26%。
另外全餐品标了热量（套餐按成分累加，三件套 949 kcal），支持低脂/低糖/低钠/高蛋白/低卡排序。

零第三方依赖，Node 18+ 直接跑：
https://github.com/zddamn/mcd-saver

参加麦当劳 MCP 开发者大赛，排名只看 GitHub Star，觉得这思路有意思的话点个 ⭐，谢谢。
```

---

## 二、知乎（回答体，流量最大）

**去搜并回答**：「麦当劳怎么点最划算？」「麦当劳有哪些省钱技巧？」

**回答**：

```
不抖机灵，直接上可复现的数据。

结论：同样一份订单，点法不同价差能到 37%，而「看起来最便宜的那个」经常是最贵的。

原因是麦当劳菜单里标的价格不全是你最终付的价格。举个实测的例子：
「巨无霸四件套」菜单标 ¥32，但那是随单购麦金卡优惠价。调官方核价接口，不买卡的实际价格是 ¥59.50。
而「巨无霸三件套」标 ¥37，核价也是 ¥37 —— 老老实实 ¥37。
按标价排，四件套便宜 5 块；按实付排，四件套贵 22.5 块。

这类事手算不出来，所以我写了个工具，把官方 MCP 的核价能力接进去，对每个候选方案逐个核价，挑最便宜的：
https://github.com/zddamn/mcd-saver （开源，零依赖）

顺带发现积分商城返回的 24 张券里 15 张已过期，官方列表不会自己清理 ——
也就是说你在 App 里看到的「积分商城」，可能有一半是点进去才发现换不了的。工具里用官方时间接口做了过滤。

注：这是参赛作品，数据全部来自麦当劳官方核价接口，工具本身不做任何优惠计算，所以陷阱会被自动暴露。
```

---

## 三、少数派（效率/技巧体）

**标题**：用一行命令算清麦当劳怎么点最便宜

**正文**：

```
麦门信徒的自我修养：不但要知道 1+1，还要知道官方核价接口认为你该付多少钱。

同样是 巨无霸+薯条+可乐：
· 全部单点 ¥50
· 三件套 ¥37  ← 省 26%

坑在后面 —— 菜单上「巨无霸四件套」标 ¥32，看着比三件套便宜对吧？实际核价 ¥59.5。
那个 ¥32 是「随单购麦金卡价」，不买卡根本拿不到。

我写了个命令行工具，把麦当劳官方 MCP 的核价能力接进去，自动枚举所有组合、逐个官方核价挑最便宜的，
还顺手发现积分商城 24 张券里 15 张已过期（官方不清理）。零依赖，Node 18+ 能跑：
https://github.com/zddamn/mcd-saver

参加麦当劳 MCP 大赛，排名看 Star，觉得有用的话点个 ⭐。
```

---

## 四、Reddit r/SideProject（英文，全球开发者）

**Title**: I built a CLI on McDonald's official MCP server — and found their menu prices lie

**Body**:

```
McDonald's China opened an official MCP server (mcp.mcd.cn) with 35 tools: pull menus, break down combos, price-check, list coupons, points.

I wired it into a zero-dependency Node CLI, mcd-saver: tell it what you want to eat, it enumerates every combo/single-item combination and calls the official calculate-price on each, then returns the cheapest real price.

Three things I didn't expect while building it:

1. Menu prices lie. The "Big Mac 4-piece combo" shows ¥32 — that's a membership-only price. The official price-check returns ¥59.50 for a regular user. Sorting by display price tells you the combo is ¥5 cheaper than the 3-piece; the real price is ¥22.50 more expensive. The engine now price-checks twice (regular vs. member-with-order) and shows both.

2. The points mall doesn't clean up expired coupons. It returns 24 coupons, 15 of them already past their downTime. The tool filters with the server's own clock and ranks the rest by "savings per 100 points."

3. Combo item codes ≠ menu item codes (combo Coke is 3050, menu Coke is 9900008751), so matching has to happen on normalized names.

Zero deps, Node 18+: https://github.com/zddamn/mcd-saver
It's an entry for McDonald's MCP hackathon (ranked by GitHub Stars) — if the approach is interesting, a ⭐ helps.
```

---

## 五、V2EX（需邀请码，能进再发 /go/programming）

**标题**：用麦当劳官方 MCP 做了个省钱 CLI，发现菜单标价有三分之一是假的

**正文**（同掘金精简版，去掉代码块、保留三个发现 + 仓库链接即可，V2EX 偏讨论不耐长文）。

---

## 六、发布后

- 发完把链接贴回你自己的 GitHub Issue #10 或仓库 README 顶部「在哪里看到我们」区块（可选）。
- 隔半天回来看评论，真诚回复「数据准吗」「这有什么用」类质疑（话术见 PROMO.md 第四节 FAQ）。
- 别自顶、别多账号，自然发酵即可。
