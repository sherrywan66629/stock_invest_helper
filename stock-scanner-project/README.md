# 止跌形态多因子扫描器

一个帮助分析个股是否出现"止跌反转"信号的小工具：输入股票代码，自动拉取最近 60 个交易日的日线数据，从**K线形态、支撑位、量能变化、趋势动能**四个维度独立打分（各 0-100），供进一步判断参考。四项因子刻意不合成单一分数——避免一个数字掩盖不同维度之间的分歧。不构成投资建议。

在线体验：部署在 Cloudflare Pages 上，push 到 `main` 分支即自动构建部署。

---

## 整体架构

应用分两套完全独立的运行环境：**线上生产环境（Cloudflare Pages）**和**本地开发环境（`npm run dev`）**。两套环境的入口和"外壳"不同，但核心业务逻辑共用同一份代码。

### 生产环境（部署后）

```
浏览器（React 前端）
   │  首次访问：加载打包好的 HTML/JS/CSS
   ▼
Cloudflare Pages 静态托管（dist/）
   │
   │  用户点击股票代码 → fetch('/api/quote?ticker=AAPL')
   ▼
Cloudflare Pages Function（functions/api/quote.js）
   │  服务器对服务器请求，不受浏览器 CORS 限制
   ▼
Yahoo Finance 图表接口（非官方）
   │  返回最近 60 个交易日 OHLCV 数据
   ▼
浏览器接收 JSON → 前端计算四项因子分数 → 渲染分析结果
```

- **没有独立的"后端服务器"**。`functions/api/quote.js` 是一个 **Cloudflare Pages Function**——不是常驻进程，而是请求到达时才被临时执行的无服务器函数，运行在 Cloudflare 全球边缘节点的 V8 隔离环境里，用完即可销毁。
- **前后端同域名**，前端用相对路径 `fetch('/api/quote?...')` 请求，Cloudflare 根据 `functions/` 目录结构自动路由，不需要额外配置网关或处理跨域。

### 本地开发环境（`npm run dev`）

```
Vite 开发服务器（一个 Node 进程，npm run dev 启动）
   │  同时负责：① 实时编译并提供 React 页面  ② 拦截 /api/quote 请求
   ▼
vite.config.js 里的开发专用中间件（yahooQuoteDevMiddleware）
   │  调用和线上完全相同的核心逻辑
   ▼
functions/_yahoo.js 的 fetchYahooBars()
   │  真实网络请求，非 mock 数据
   ▼
Yahoo Finance 图表接口
```

- 纯 `vite dev` 本身不认识 `functions/` 这种 Cloudflare 专用的路由格式，直接跑会导致 `/api/quote` 404。
- 所以在 [`vite.config.js`](vite.config.js) 里额外注册了一个**只在本地生效**的中间件，把 `/api/quote` 请求接住，转发给和线上共用的同一份抓取逻辑。
- 这个中间件**不会被打包、不会被部署**，纯粹是本地开发的辅助工具，让你不用起额外的进程或登录任何账号就能测试完整流程。
- 会真实调用 Yahoo Finance，拿到的是当天真实数据，不是假数据。

**一个已知的局限**：本地测试覆盖的是共享的核心逻辑（`fetchYahooBars`），但没有覆盖 Cloudflare 那层 `onRequestGet` 请求解析外壳本身。如果想要更贴近真实 Workers 运行时的本地测试，可以改用 `wrangler pages dev`（Cloudflare 官方的本地模拟工具）。

---

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 UI | React 19 | 纯客户端渲染，观察列表等 UI 状态存在 `useState` 里，刷新页面即丢失；已抓取的行情数据额外缓存在 localStorage（见下文"数据缓存"） |
| 前端构建/开发工具 | Vite | 开发时提供实时编译 + 热更新的本地服务器；`npm run build` 时改用 Rollup 把代码打包成 `dist/` 静态文件 |
| 样式 | Tailwind CSS 4 | 通过 `@tailwindcss/vite` 插件接入 |
| 图标 | lucide-react | 图标组件库 |
| 后端 | Cloudflare Pages Functions | 无服务器函数，运行在 Cloudflare 边缘节点的 V8 隔离环境，不是常驻进程 |
| 数据源 | Yahoo Finance 图表接口（非官方） | `query1/query2.finance.yahoo.com`，无需 API Key，但非官方公开 API，可能变化 |
| 部署 | Cloudflare Pages（Git 集成） | push 到 GitHub 自动触发构建部署 |

---

## 目录结构

```
stock-scanner-project/
├── src/
│   ├── App.jsx          # 应用外壳（左侧多 Tab 导航）+ 各 Tab 内容 + 四项打分逻辑，见下方"多 Tab 结构"
│   ├── main.jsx          # React 应用入口
│   └── index.css         # 全局样式（Tailwind）
│   └── ticker-cache.js    # localStorage 缓存工具（默认 6 小时滑动过期 + 每 PST 日强制清空，可按key覆盖 ttlMs/slide）
├── functions/
│   ├── _yahoo.js          # 抓取 Yahoo Finance 数据的核心逻辑（本地/线上共用，下划线开头不会被当作路由）
│   └── api/
│       ├── quote.js       # Cloudflare Pages Function，对应线上路由 /api/quote（日线数据，止跌扫描器 + Seeking Alpha 历史图表都用）
│       └── price.js       # Cloudflare Pages Function，对应线上路由 /api/price（轻量当前价查询，仅 Seeking Alpha Tab 用）
├── vite.config.js         # Vite 配置；额外注册了本地开发用的 /api/quote、/api/price 模拟中间件
├── index.html             # 页面入口 HTML
└── package.json           # 依赖声明 + npm scripts
```

---

## 多 Tab 结构

应用现在是一个左侧导航 + 右侧内容区的多 Tab 壳子，不再是单页面：

- `App`（[`src/App.jsx`](src/App.jsx)）只负责壳子本身：渲染 `Sidebar` 导航栏 + 根据当前选中的 Tab 渲染对应内容组件，自己不持有任何业务状态
- `TABS` 是一个数组，每一项是 `{ key, label, icon, Component }`——**新增一个 Tab，只需要在这个数组里加一行**，不需要动布局代码
- 每个 Tab 的组件（比如 `WatchlistTab`）自己管理自己的状态（股票列表、缓存、加载状态等），Tab 之间互不影响、互不共享状态
- 当前两个 Tab：
  - **关注股票止跌形态**（`WatchlistTab`）：原来唯一的功能页面，观察列表 + 单只股票的四项因子分析，逻辑不变
  - **Seeking Alpha 下半年选股**（`SeekingAlphaTab`）：Seeking Alpha 给出的 2026 下半年 10 只精选个股（名单和点评文字是手动整理进代码的静态数据，见 `SEEKING_ALPHA_2026H2`），每只股票展示当前股价、过去 1 年走势图（手写 SVG 折线，没有引入图表库），以及 1周/1月/3月/6月/1年 的涨跌幅，见下文"Seeking Alpha Tab 的数据是怎么来的"
- 切换 Tab 是纯前端状态（`useState`），不改变 URL——刷新页面会回到第一个 Tab，几个 Tab 之间也不能通过链接分享；如果之后需要"直接分享某个 Tab 的链接"，需要引入路由（比如 `react-router`）把 Tab 和 URL 绑定，目前还没做

---

## 请求是怎么串起来的（以点击一个股票代码为例）

1. 用户在"关注股票止跌形态"这个 Tab 里点击观察列表里的某个股票代码，`TickerPanel` 组件挂载，触发 `handleFetchLive`（[`src/App.jsx`](src/App.jsx)）
2. **先查本地缓存**（[`src/ticker-cache.js`](src/ticker-cache.js) 的 `getCachedBars`）：命中且未过期就直接用缓存数据渲染，不发请求；否则才继续下一步
3. 前端发起 `fetch('/api/quote?ticker=AAPL')`
4. **生产环境**：Cloudflare 路由到 `functions/api/quote.js` 的 `onRequestGet`；**本地环境**：Vite 中间件拦截同一路径
5. 两边都调用 `functions/_yahoo.js` 的 `fetchYahooBars(ticker)`，真实请求 Yahoo Finance，拿到最近 60 个交易日的 OHLCV 数据
6. 数据以 JSON 形式返回给前端，写入本地缓存（`setCachedBars`）
7. 前端把数据转成 CSV 格式塞进 `parseCSV`，再依次跑 `scoreCandlestick`、`scoreSupport`、`scoreVolume`、`scoreTrend` 四个函数算出四项因子分数
8. 四项分数**分别**渲染出来（观察列表卡片是 2×2 的小方块，详情面板是四条独立的因子明细）——不合成单一的综合分数，颜色按各自分数高低单独区分好坏

---

## Seeking Alpha Tab 的数据是怎么来的

这个 Tab 复用了同一个 `/api/quote` 接口和同一套 Yahoo Finance 抓取逻辑（`functions/_yahoo.js`），但请求参数和用途不一样：

- 止跌扫描器 Tab 请求 `/api/quote?ticker=AAPL`（不带 `range`，默认 `range=6mo`），拿到的是**最近 60 个交易日**、给四项因子打分用的
- Seeking Alpha Tab 请求 `/api/quote?ticker=CRDO&range=1y`，拿到的是 Yahoo **一年区间返回的全部日线数据**（不截断到 60 条），只用来画走势图和算区间涨跌幅，不跑四项因子打分
- `functions/_yahoo.js` 的 `fetchYahooBars(ticker, { range, limit })` 支持两种调用方式：`limit: 60`（默认，止跌扫描器用）会把结果裁到最后 60 条；`limit: null`（Seeking Alpha 用）原样返回 Yahoo 给的全部数据
- 涨跌幅（1周/1月/3月/6月）用**交易日数**近似（5/21/63/126 个交易日），不是按自然日精确对齐节假日；1年涨跌幅直接用这批一年数据里第一条和最后一条的收盘价算，因为拿到的数据本身就是"最近一年"
- 应用启动进入这个 Tab 时会给 10 只股票依次发起后台请求（错峰 150ms 一个，原因同止跌扫描器的观察列表自动加载），每张卡片上的刷新按钮可以单独强制刷新某一只

**卡片顶部的"当前股价"是单独一条请求，不是从上面这批一年数据里取最后一条**——因为这批一年数据默认按 6 小时缓存（见下文"数据缓存"），如果拿它的最后一条当"当前价"，波动大的股票在这 6 小时里显示的价格会明显滞后于实际走势。所以：

- 走势图和涨跌幅：仍然用 `/api/quote?ticker=X&range=1y` 这批数据，缓存 6 小时（历史数据，不要求分钟级新鲜度）
- 卡片顶部的"当前股价"：单独请求 `/api/price?ticker=X`（新增的 `functions/api/price.js`），只读 Yahoo 返回的 `meta.regularMarketPrice` 这一个字段，不解析整年的日线数据；缓存策略也不一样，见下文
- 这两个数值来自两次独立请求，正常情况下会有几美分到几美元的出入（取决于当天波动），这是预期行为，不是 bug

---

## 怎么理解"趋势动能"这个因子

四个因子里，趋势动能（`scoreTrend`，基于 RSI 和 20 日均线）是**最容易让人困惑、也最常年份持续偏低**的一个，值得单独说清楚。

**它和其他三个因子有一个本质区别：它是"滞后确认"，不是"提前预警"。** K线形态、支撑位、量能变化，理论上一天的数据变化就能立刻反映出来；但 RSI 和 20 日均线都是"把过去一段时间的数据平均/换算出来"的指标——均线要连续好几天真的上涨，才会跟着抬头；RSI 要连续几天真的收阳，才会明显回升。这意味着：**趋势动能永远是四项里最后一个"亮起来"的。**

**这解释了为什么它经常普遍偏低**：如果你观察列表里大部分股票的趋势动能分数都不高，很可能不是工具有问题，而是**这批股票目前大多还处于"下跌或磨底阶段"，还没有一只被均线/RSI 真正确认反转**——这本身就是一个有意义的信息：说明现在多是"潜在候选"阶段，还没到"技术面已确认"的阶段。

**具体怎么用它**：不要等四项因子同时给高分才行动，那基本等于"等涨完了才确认"。更实际的思路是——先看 K线形态、支撑位、量能变化这三项是不是已经出现企稳迹象，再把趋势动能当成"时机确认器"：盯着它有没有开始从低位往上走（哪怕还没冲到"高分"档），这往往意味着前面那三项的迹象正在被实际的价格表现兑现。**低分不代表这只股票不值得关注，只代表"技术面还没确认"，可能恰恰是还处于早期阶段。**

---

## 数据缓存

已抓取的行情数据缓存在浏览器 localStorage 里（[`src/ticker-cache.js`](src/ticker-cache.js)），避免每次打开同一只股票都重新请求 Yahoo Finance。规则：

- **6 小时滑动过期**：每次命中缓存，过期倒计时从命中那一刻重新开始算 6 小时；只要还在这 6 小时内被访问过，缓存就不会过期
- **每 PST 日强制清空**：不管滑动窗口有没有到期，太平洋时间每天 00:00 都会把整个缓存清空重来——包括页面一直开着跨过午夜的情况（`App` 组件里用 `setTimeout` 精确调度到下一个 PST 零点）
- 应用启动时会用缓存里还没过期的数据，直接把观察列表卡片的分数渲染出来，不用逐个点开
- 点"刷新数据"按钮会绕过缓存、强制发起真实请求；缓存命中时面板上会标注"（本地缓存，6小时内）"
- Seeking Alpha Tab 的一年数据复用同一套缓存机制，但用 `"TICKER@1y"`（比如 `"CRDO@1y"`）而不是 `"TICKER"` 作为缓存key，避免和止跌扫描器的 60 条数据相互覆盖
- Seeking Alpha Tab 的"当前股价"用的是**另一套更短的缓存策略**：`"TICKER@price"` 这个key，**30 分钟固定过期，不滑动**——`src/ticker-cache.js` 的 `getCachedBars` 支持传 `{ ttlMs, slide: false }` 覆盖默认的 6 小时/滑动策略，就是给这个用例加的。"不滑动"意味着即使这 30 分钟里被反复查看，也不会像默认策略那样每次续期——到点就必须重新请求，不会因为频繁打开这个 Tab 而变相延长缓存寿命

**观察列表自动加载**：应用启动时（以及每次新增股票代码时），会自动为**没有有效缓存**的股票代码依次发起后台请求，不需要用户点开每个面板去触发。要点：

- 每个股票代码的加载**完全独立**——某一个失败（比如代码打错了、Yahoo 暂时无响应）只会让那一张卡片显示"自动获取失败"，不影响其他任何一个
- 请求之间做了**错峰**（每个间隔 150ms 才发出下一个），而不是 23 个同时炸出去，减少被 Yahoo 这个非官方接口限流的概率
- 如果用户在后台加载还没跑到某只股票代码之前，就手动点开了它的面板，面板会检测到"已经在后台加载中"，不会重复发起请求

---

## 本地开发

```bash
npm install
npm run dev
```

打开 `http://localhost:5173`，前端和 `/api/quote` 接口都能直接用（见上文"本地开发环境"）。

```bash
npm run build     # 打包生产版本到 dist/
npm run preview   # 本地预览打包结果（注意：/api/quote 在 preview 模式下不可用，仅前端静态文件）
npm run lint       # 运行 oxlint 代码检查
```

---

## 部署到 Cloudflare Pages

项目通过 Cloudflare Pages 控制台连接 GitHub 仓库自动部署，构建设置：

| 设置项 | 值 |
|---|---|
| Root directory | `stock-scanner-project` |
| Build command | `npm run build` |
| Build output directory | `dist` |

`functions/` 目录会被 Cloudflare 自动识别为 Pages Functions，无需额外配置。

---

## 已知限制 / 后续可迭代方向

- **观察列表本身不持久化**：股票代码列表仍然只存在内存里，刷新页面会恢复成默认列表（已抓取的行情数据有 localStorage 缓存，但列表本身没有）
- **Yahoo Finance 是非官方接口**：没有 SLA 保证，未来可能变化或限流
- **Pages Function 完全无状态**：每次请求可能是全新的 V8 隔离环境，不能用普通 JS 变量做跨请求缓存；现有的 6 小时缓存是纯前端 localStorage 方案，不涉及后端存储
- **Seeking Alpha 的选股名单和点评是手动写死在代码里的静态数据**（`SEEKING_ALPHA_2026H2`），不会自动更新——如果 Seeking Alpha 出新一期名单，需要手动改代码
- **涨跌幅按交易日数近似**：1周/1月/3月/6月分别按 5/21/63/126 个交易日回溯，不是按自然日精确匹配，遇到长假可能有一两天的误差
- **Tab 切换不反映在 URL 上**：刷新页面会回到默认 Tab，无法通过链接直接分享某个 Tab
- **候选迭代方向**：观察列表持久化（localStorage）、更稳定的数据源、给止跌扫描器的分析结果也加历史走势图表、Seeking Alpha 名单支持在 UI 里编辑而不是改代码、Tab 状态接入 URL 路由
