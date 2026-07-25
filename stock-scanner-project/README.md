# 止跌形态多因子扫描器

一个帮助分析个股是否出现"止跌反转"信号的小工具：输入股票代码，自动拉取最近 60 个交易日的日线数据，从**K线形态、支撑位、量能变化、趋势动能**四个维度打分，输出一个可解释的综合分数（0-100），供进一步判断参考。不构成投资建议。

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
| 前端 UI | React 19 | 纯客户端渲染，观察列表勾选、权重等 UI 状态存在 `useState` 里，刷新页面即丢失；已抓取的行情数据额外缓存在 localStorage（见下文"数据缓存"） |
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
│   ├── App.jsx          # 唯一的前端组件：观察列表 + 单只股票分析面板 + 四项打分逻辑
│   ├── main.jsx          # React 应用入口
│   └── index.css         # 全局样式（Tailwind）
│   └── ticker-cache.js    # localStorage 缓存工具（6 小时滑动过期 + 每 PST 日强制清空）
├── functions/
│   ├── _yahoo.js          # 抓取 Yahoo Finance 数据的核心逻辑（本地/线上共用，下划线开头不会被当作路由）
│   └── api/
│       └── quote.js       # Cloudflare Pages Function，对应线上路由 /api/quote
├── vite.config.js         # Vite 配置；额外注册了本地开发用的 /api/quote 模拟中间件
├── index.html             # 页面入口 HTML
└── package.json           # 依赖声明 + npm scripts
```

---

## 请求是怎么串起来的（以点击一个股票代码为例）

1. 用户点击观察列表里的某个股票代码，`TickerPanel` 组件挂载，触发 `handleFetchLive`（[`src/App.jsx`](src/App.jsx)）
2. **先查本地缓存**（[`src/ticker-cache.js`](src/ticker-cache.js) 的 `getCachedBars`）：命中且未过期就直接用缓存数据渲染，不发请求；否则才继续下一步
3. 前端发起 `fetch('/api/quote?ticker=AAPL')`
4. **生产环境**：Cloudflare 路由到 `functions/api/quote.js` 的 `onRequestGet`；**本地环境**：Vite 中间件拦截同一路径
5. 两边都调用 `functions/_yahoo.js` 的 `fetchYahooBars(ticker)`，真实请求 Yahoo Finance，拿到最近 60 个交易日的 OHLCV 数据
6. 数据以 JSON 形式返回给前端，写入本地缓存（`setCachedBars`）
7. 前端把数据转成 CSV 格式塞进 `parseCSV`，再依次跑 `scoreCandlestick`、`scoreSupport`、`scoreVolume`、`scoreTrend` 四个函数算出四项因子分数
8. 按用户设置的权重加权算出综合分数，渲染成仪表盘 + 因子明细

---

## 数据缓存

已抓取的行情数据缓存在浏览器 localStorage 里（[`src/ticker-cache.js`](src/ticker-cache.js)），避免每次打开同一只股票都重新请求 Yahoo Finance。规则：

- **6 小时滑动过期**：每次命中缓存，过期倒计时从命中那一刻重新开始算 6 小时；只要还在这 6 小时内被访问过，缓存就不会过期
- **每 PST 日强制清空**：不管滑动窗口有没有到期，太平洋时间每天 00:00 都会把整个缓存清空重来——包括页面一直开着跨过午夜的情况（`App` 组件里用 `setTimeout` 精确调度到下一个 PST 零点）
- 应用启动时会用缓存里还没过期的数据，直接把观察列表卡片的分数渲染出来，不用逐个点开
- 点"刷新数据"按钮会绕过缓存、强制发起真实请求；缓存命中时面板上会标注"（本地缓存，6小时内）"

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

- **观察列表本身不持久化**：股票代码列表、因子权重仍然只存在内存里，刷新页面会恢复成默认列表（已抓取的行情数据有 localStorage 缓存，但列表和权重没有）
- **Yahoo Finance 是非官方接口**：没有 SLA 保证，未来可能变化或限流
- **Pages Function 完全无状态**：每次请求可能是全新的 V8 隔离环境，不能用普通 JS 变量做跨请求缓存；现有的 6 小时缓存是纯前端 localStorage 方案，不涉及后端存储
- **候选迭代方向**：观察列表/权重持久化（localStorage）、更稳定的数据源、给分析结果加历史走势图表
