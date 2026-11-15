# Repository Guidelines

LongerMC（`mc.longer.xin`）Minecraft 服务器官网 + 白名单系统。纯静态前端 + Cloudflare Pages Functions + D1，**零构建、无依赖、无 package.json**。

## Project Overview

- **站点定位**：服务器展示页（首页 / 404）+ 白名单自助系统（申请、查询、修改）+ 人工审核后台。
- **白名单流程**：邮箱 6 位验证码（HMAC 存哈希）→ Turnstile 人机验证 → 提交申请 → 管理员人工审核 → 邮件通知 → 管理员**手动**在游戏服执行 `whitelist add <IGN>`，回到后台勾选「已人工加入原版白名单」。
- **系统边界（高频误解）**：代码**不会**修改服务器的 `whitelist.json`；`approved` 只代表系统记录通过，原版生效单独记录在 `manual_whitelisted_at`。不要"优化"成自动写入。

## Architecture & Data Flow

```
浏览器 (静态 HTML + IIFE JS)
  ├─ /api/whitelist/config      GET  下发 Turnstile siteKey、模拟模式开关、限流参数
  ├─ /api/whitelist/send-code   POST 邮箱验证码（Turnstile + 邮箱/IP 双维度限流 + 黑名单）
  ├─ /api/whitelist/verify-code POST 校验验证码 → 签发短期 ticket（auth_tickets）
  ├─ /api/whitelist/apply       POST ticket + 资料 → applications（pending_review）+ 邮件
  ├─ /api/whitelist/inquire     POST {ticket} → 脱敏状态（不回传完整邮箱/QQ/Discord）；票据查一次即作废
  ├─ /api/whitelist/modify      POST ticket → modification_requests + 邮件
  ├─ functions/admin/_middleware.js   /admin* 前置中间件：测试锁定 + /admin/test 自检页
  └─ /admin/api/whitelist/*     Cloudflare Access 保护：审核 / 黑名单 / 发件箱 / 审计
```

**后端分层**（`functions/`，Cloudflare Pages 文件路径路由）：

| 层 | 路径 | 说明 |
| --- | --- | --- |
| 路由 | `functions/api/whitelist/*.js` | 公开接口，导出 `onRequestGet` / `onRequestPost` |
| 路由 | `functions/admin/api/whitelist/[[path]].js` | 单文件 catch-all + 内部 `route()` 手写分发（GET 用 `sameOrigin()`，写操作用 `sameOriginStrict()`） |
| 共享 | `functions/_lib/*.js` | 非路由（`_` 前缀不注册路由），ESM 具名导出 |

**统一请求管线**（所有写接口同序，改动时保持一致）：

`sameOriginStrict()` → `readJson()` → 字段 `norm*()` 校验 → `verifyTurnstile()` → `pepper()` 生产校验 → `ipFingerprint()` → `hit()` 限流 → `readTicket()`（不消耗）→ 业务校验 → DB 写入 → `consumeTicket()` → `audit()` → `sendMail()` → `ok()`

关键不变量：
- **票据先读后消**：字段校验、重复检查全部通过并写入成功后才 `consumeTicket()`，避免用户填错一次就要重新收验证码。
- **公开接口一律脱敏**：`maskEmail / maskQq / maskDiscord`，禁止在 `/api/*` 返回完整联系方式。
- **防枚举（硬要求）**：`verify-code` 的 inquire / modify 分支里，「记录不存在」「验证码不正确」「验证码过期/锁定」三条路径**必须全部走 `notMatch()`**——同一个错误码 `code_invalid`、同一个 400、同一句文案、都不带 `remaining` 字段。
  早期实现里「验证码错」返回的是 `consumeCode` 的原始结果（文案不同、多一个 `remaining` 字段、过期时错误码还变成 `code_expired`/`code_locked`），
  于是只要过一次 Turnstile 就能区分「这个邮箱有没有申请记录」，**而且全程不需要真的发验证码邮件**（受害者收不到任何通知，完全静默）。
  代价是用户看不到「还剩几次」提示——这是防枚举该付的成本。
  apply 分支不查记录、无可枚举信息，保留 `remaining` 提示即可。
- **防枚举（硬要求）**：`verify-code` 里「记录不存在 / 不匹配」必须返回与「验证码不正确」**完全同形**的响应——同一个错误码 `code_invalid`、同一个状态码 400、同一句文案（用 `notMatch()`）。**绝不能**用 404 `not_found` / 403 `not_modifiable` / 409 `pending_exists` 区分，否则等于告诉探测者"这个邮箱有没有申请记录、是什么状态"。`not_modifiable` / `pending_exists` 这类判断必须放在 `consumeCode()` **之后**。
- **防枚举（其余）**：`send-code` 对"记录不存在 / 命中黑名单"返回与成功同形的统一文案。
- **票据失败计次**：写接口（`apply` / `modify`）任何业务校验失败都要走 `deny()` → `failTicketAttempt()`，累计 5 次作废票据。新增写接口时必须沿用，否则一张票据可在有效期内被无限次用于探测。
- **冲突提示默认 generic**：`duplicateHintMode(env)` 默认统一文案，不返回对方 `reference`；`DUPLICATE_HINT_MODE=detailed` 才给字段级提示。
- **生产必须能真发信**：`send-code` 在 `isProduction()` 且 `emailDriver() !== 'resend'` 时直接 502，不允许"模拟发送"蒙混过关。
- **dev 兜底只在非生产生效，且判定是「安全默认」**：`isProduction()` 只有命中 `DEV_HOSTS`（默认 `localhost` / `127.0.0.1`）才返回 false，**其余未知域名一律按生产处理**。生产下 `dev-mock-turnstile-token`、`devCode` 回显、`DEV_ALLOW_ADMIN_BYPASS` 全部关闭。改这块时不要退回成「命中 `PRODUCTION_HOSTS` 才算生产」——那样预览域名 / 换域名会被误判成开发环境，三重兜底同时打开。

**前端组装**：`index.html` / `404.html` 内联 SVG sprite；`/whitelist/*` 与 `/admin/*` 页面用 `js/icons.js` 注入精简 sprite（`<body>` 最前、**不加 defer**）。`js/nav.js` / `js/footer.js` `fetch` 片段后 `outerHTML` 替换占位容器，并把 Promise 推入 `window.LMC_PARTIALS`；`main.js` / `status.js` 通过 `lmcReady()`（3s 超时兜底）等待注入完成再初始化。

## Key Directories

```
functions/_lib/            后端共享模块（见下表）
functions/api/whitelist/   公开 API（config / send-code / verify-code / apply / inquire / modify）
functions/admin/api/whitelist/  管理 API（Access 保护）
js/                        浏览器脚本（IIFE，无打包）
whitelist/{,apply,inquire,modify}/  白名单前台页面
admin/whitelist/           审核后台页面
partials/                  导航 / 页脚公共片段
css/style.css              全站样式（:root 设计令牌）
css/whitelist.css          白名单与后台样式（不改 style.css）
migrations/                D1 迁移（0001 建表，0002 黑名单种子，0003 加固：票据计次 + 唯一索引，0004 修改流程辅助验证因子，0005 换绑邮箱）
```

`functions/_lib` 模块职责：`http`（响应/来源校验/读体）、`env`（配置与生产判定）、`db`（D1 封装 + 脱敏 + `uniqueRef`）、`crypto`（HMAC/随机/常量时间比较）、`codes`（验证码与票据）、`ratelimit`（D1 固定窗口）、`turnstile`、`blacklist`（精确 + 正则，ReDoS 防护）、`validation`（`LIMITS` / `RE` / `norm*`）、`email`（Resend 或 log 驱动 + `email_outbox`）、`templates`（全部邮件文案）、`audit`（审计与 IP 指纹）、`access`（Access JWT / bypass）。

## Development Commands

仓库无构建、无包管理依赖，仅用 `npx` 调 wrangler（本地环境 Node v24 / wrangler 4.x 已验证可用）。

```bash
# 纯静态预览（无后端，nav/footer 片段仍可注入）
python3 -m http.server 8080            # → http://localhost:8080

# 完整本地开发（Functions + D1）
cp .dev.vars.example .dev.vars         # 全部留空 = 模拟模式
npx wrangler d1 migrations apply longer-mc-db --local
npx wrangler pages dev . --persist     # → http://localhost:8788/whitelist/

# 线上迁移（Pages 不会自动执行，每次改 migrations/ 都要手动跑）
npx wrangler d1 migrations apply longer-mc-db --remote

# 手工改数据
npx wrangler d1 execute longer-mc-db --remote --command "SELECT ..."
```

**部署**：git push 即触发 Pages 构建（Git 集成）；无 Build command、无 output directory。前提：`wrangler.toml` 的 `database_id` 已替换、Pages 绑定变量名 `DB`、生产环境变量已配、Access 覆盖 `/admin*`。

## Code Conventions & Common Patterns

**后端（`functions/`）**
- ESM `import` / `export`；`onRequestGet` / `onRequestPost` / `onRequest` 命名导出。相对路径导入必须写 `.js` 后缀。
- 2 空格缩进、单引号、语句结尾带分号；模板字符串拼 SQL。
- 中文注释 + 分隔注释块，文件头写接口清单与前置条件。新文件沿用该格式。
- 响应只用 `ok(data, status)` / `fail(code, message, status, extra)`；错误码 `snake_case`（`invalid_ign`、`rate_limited`、`ticket_invalid`）。**禁止**手写 `new Response` JSON。
- 所有外部输入先过 `functions/_lib/validation.js` 的 `norm*()`，禁止在路由里内联正则；长度上限统一取 `LIMITS`。
- D1 只用 `env.DB.prepare(sql).bind(...)`；禁止字符串拼接参数。列名 `snake_case`，`*_norm` 存小写规范化值，时间统一 `nowIso()`（ISO 字符串）。
- 状态值固定字符串：`pending_review | approved | rejected`；编号前缀 `WL-` / `MR-`，由 `uniqueRef()` 生成。
- 管理员写操作必须 `audit()` 留痕，`detail` 中不得写入验证码等敏感值；日志里 IP 只存 `ipFingerprint()` 指纹。
- 密钥只从 `env` 读（`cfg(env, 'X')`），新增配置项要同时更新 `.dev.vars.example`、`DEPLOY.md` 环境变量表。
- 邮件文案全部放 `functions/_lib/templates.js`，业务代码不得内联文案；HTML 必须过 `esc()`。

**前端（`js/`）**
- 统一 IIFE + `'use strict'`，浏览器脚本**不用** ESM、不用打包器；`js/whitelist.js` / `js/admin-whitelist.js` 用 `var` + `async/await`，`js/main.js` / `js/status.js` 保持 `var` + 回调风格，勿混入构建型语法。
- 页面通过 `<body data-page="apply|inquire|modify">` 分发（`js/whitelist.js` 尾部 `boot()`）。
- 动态插入 DOM 的文本必须 `esc()`（前端各文件的本地 `esc` 实现）。
- API 调用统一 `fetch(path, { credentials: 'same-origin' })`，解析失败降级为 `{ ok:false, error:{ code:'bad_response', ... } }`。
- 视觉语言固定为 **Minecraft OreUI**：只从 `css/style.css` 的 `:root` 取令牌（`--bg`、`--panel`、`--panel-2`、`--line-2`、`--grass*`、`--gold`、`--diamond`、`--red`、`--text*`、`--muted*`、`--ore-border`、`--ore-focus`、`--shadow-card*`）。
  - 硬约束：`border-radius` 恒为 0；描边 `2px solid #171615`；按钮斜面用 `inset 0 ±(3|6)px`（上下两段）；禁用态 = `#ede5e2` 底 + `#aba09c` 字；焦点 = `#1157be` 外环。
  - 标题 / 编号 / 英文标签用 `--pixel`（`Press Start 2P`），正文与中文一律 `--sans`（像素字无 CJK 字形）。像素字比常规字宽约一倍，小标签字号保持 7–10px。
  - 新增组件先在 `css/style.css` 定义令牌与形状，再在 `css/whitelist.css` 复用；不要引入第二套配色或圆角。

**新增接口检查清单**
1. 在 `functions/api/whitelist/` 新建 `<name>.js`，导出 `onRequestPost`。
2. 按上表管线顺序实现；写操作加 `buckets.writeIp()` 限流。
3. 复用 `norm*()` / `checkBlacklist()` / `readTicket()` / `sendMail()`，不重复实现。
4. 需要新表 → 新建 `migrations/000N_xxx.sql`（`IF NOT EXISTS`），并提醒部署时手动 `--remote`。
5. 前端只调用 `/api/whitelist/<name>`，错误提示读 `data.error.message`。

## Important Files

| 文件 | 作用 |
| --- | --- |
| `index.html` | 首页，内联全站 SVG symbol sprite；复制按钮靠 `data-copy` / `data-copy-done` / `data-copy-fail`、导航高亮靠 `data-nav` 属性驱动 |
| `js/status.js:12` | 服务器地址常量 `SERVER_IP = 'play.mc.longer.xin'` 与 mcsrvstat.us 轮询（60s） |
| `js/whitelist.js:580` | 白名单三页面的 `boot()` / 页面分发 |
| `js/admin-whitelist.js` | 后台标签页、列表、审核动作 |
| `functions/_lib/http.js` | `ok` / `fail` / `sameOrigin`（读，宽松）/ `sameOriginStrict`（写，严格）/ `readJson` / `clientIp` |
| `functions/_lib/env.js` | 所有配置读取与 `isProduction` |
| `functions/_lib/access.js:95` | `requireAdmin()`（bypass → JWT → 邮箱头 → 白名单） |
| `functions/admin/api/whitelist/[[path]].js` | 全部管理端点（文件头注释即接口清单） |
| `migrations/0001_init.sql` | 8 张表：`applications`、`modification_requests`、`email_verifications`、`auth_tickets`、`rate_limits`、`blacklisted_emails`、`audit_logs`、`email_outbox` |
| `wrangler.toml` | D1 绑定 `DB`、`migrations_dir`、`compatibility_date` |
| `DEPLOY.md` | 外部服务配置、环境变量表、审核员操作指引、安全设计速览 |

## Runtime/Tooling Preferences

- **运行时**：Cloudflare Workers/Pages Functions（ESM、Web Crypto、`fetch`）；不使用 Node API、`Buffer`、`process`。
- **包管理器**：无。不要引入 `package.json`、`node_modules` 或构建步骤；wrangler 通过 `npx` 即用即取。
- **Node**：仅用于本机跑 wrangler；版本已实测 v24。
- **数据库**：D1（SQLite 方言）。`ON CONFLICT ... DO UPDATE`、`datetime('now')` 均可用。
- **外部依赖**：Resend HTTP API（`api.resend.com`，**不是** Cloudflare Email Routing）、Turnstile、Cloudflare Access、`api.mcsrvstat.us`（服务器状态）、`minotar.net`（头像）。
- **字体**：自托管 `assets/fonts/press-start-2p.woff2`（SIL OFL，见同目录 `OFL.txt`）。
- 无 `_redirects` / `_routes.json` / `_headers`；域名跳转由 Cloudflare 后台配置，勿新增。

## Testing & QA

- **没有测试框架、没有测试文件、没有 lint/format 配置、没有 CI**。新增测试基建属于范围外变更，先与维护者确认。
- 验证方式为端到端手跑：

```bash
npx wrangler pages dev . --persist
# 1) /api/whitelist/config 返回 production:false、email.simulated:true、mockToken 非空
# 2) send-code（需 Turnstile mock token: "dev-mock-turnstile-token"）→ 响应含 devCode
# 3) verify-code → 拿 ticket
# 4) apply / inquire / modify 走完整链路
# 5) 后台：DEV_ALLOW_ADMIN_BYPASS=1 打开 /admin/whitelist/，验证审核与 audit_logs 落库
# 6) 邮件内容在 /admin/api/whitelist/outbox 可见（status=simulated）
```

- **修改流程身份验证**：邮箱必填并验码，再从 `ign` / `qq` / `discord` 里选一项做辅助验证（`findApplicationByFactor`）。票据用 `verify_factor` 记住用的是哪一项，**该项本次不可修改**，`modify` 必须拦住（错误码 `factor_locked`）。三项都对不上时前端引导走全人工通道。
- **查询只验邮箱**：`inquire` 用 `findApplicationByEmail()`（只按邮箱定位），不再要求填 IGN。
- **换绑邮箱**：`modify` 接收 `newEmail` + `newEmailCode`，用 `purpose='change_email'` 的验证码独立验证新邮箱；审核通过后更新 `email` / `email_norm`，通知邮件发往新邮箱。旧邮箱停用时引导走全人工通道。
- **发件箱脱敏**：`email.js` 对 `verifyCode` 模板只存占位正文，主题里的 6 位数字抹掉——否则"验证码只存哈希"在发件箱这侧被绕过。
- **修改字段的 null / '' 语义必须贯穿前后端**：`null`=不变、`''`=清空、其它=新值。前端展示**禁止**用 `m.new_qq || '（不变）'` 这类写法（`||` 会把空串吞掉，把「清空」显示成「不变」，与后端 `pick()` 实际行为不符，审核员会误批）。统一走 `fmtNew()`。
- **写接口限流按用途分桶**：`buckets.applyIp` / `buckets.modifyIp` 各自计数（不要合并成一个 `writeIp`，否则改信息要跟新申请抢额度）。邮箱维度的冷却与每小时上限才是主要防线，IP 桶只兜底。
- **新增一种「有效变更」时，前后端的判定必须同时加**：后端 `modify` 把邮箱变更单独算一项有效变更，前端提交校验（`js/whitelist.js` 的「请至少修改一项」）也要把「已勾选更换邮箱」算进去，否则只想换邮箱的用户会被前端挡住（且提示文案还是误导性的）。已发生过一次。
- **后台详情的「修改前后对比」必须覆盖所有可变更字段**：换绑邮箱等于账户归属转移，审核员看不到新地址就点通过，等于把白名单交给了提交者。新增可修改字段时同步补一行。
- **Cloudflare Access JWT 校验的两个硬事实**（`functions/_lib/access.js`）：
  1. JWT payload 里 **`aud` 是数组**（`["<AUD>"]`），不是字符串。用 `payload.aud !== aud`
     做比较会恒为 true，导致所有已登录请求 401 `bad_aud`、后台完全打不开。
     必须用 `Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud`。
  2. 代码把 `ACCESS_TEAM_DOMAIN` 当**纯 team name** 用，自己拼
     `https://${team}.cloudflareaccess.com`。而控制台显示的是完整域名，
     照抄会拼出 `.cloudflareaccess.com.cloudflareaccess.com` → JWKS 拉取失败 → 401。
     所以必须容错去掉协议、尾部斜杠和 `.cloudflareaccess.com` 后缀。
  - `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` **必须同时配**才启用校验；校验开启后
    `verifyAccessJwt` 先于 fallback 执行，fallback 不能绕过 JWT。
  3. `iss` 比较必须规范化（去协议 / 尾斜杠 / 转小写）后比 host，不要整串精确比较；
     且 `bad_iss` 错误信息要带「实际 / 期望」两个 host，否则管理员无从排查。
  - 回归重点：aud 数组/字符串都通过、team 三种写法都拼对 JWKS URL、
    aud/iss/exp/签名不匹配全部拒绝、无 JWT 时 `no_jwt`。
- **后台有两种保护模式，切换靠环境变量、不改代码**：
  - 正式：Cloudflare Access（`/admin*`）+ `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` JWT 校验
  - 过渡：`ADMIN_ALLOW_ACCESS_FALLBACK=1` + Cloudflare WAF 的 IP 白名单
  - `ADMIN_LOCKDOWN_TEST=1` 时由 `functions/admin/_middleware.js` 把除 `/admin/test` 外的
    **所有** `/admin*`（含静态页面）一律 403，锁定优先级最高。
  - 三个开关**严格只认字符串 `'1'`**，不要改成宽松的真值判断。
  - `requireAdmin()` 里 fallback 必须放在 JWT 校验**之后**——不能让 fallback 绕过 JWT。
  - 开启 fallback 的唯一前提是 WAF 已实测生效；切回 Access 时必须把两个变量都归零并删 WAF 规则。
- **锁后台必须覆盖静态页面**：只在 API catch-all 里加判断挡不住 `/admin/whitelist/` 这个静态 HTML，
  要用 `_middleware.js` 覆盖整个 `/admin*`。新增后台路径时确认它仍在中间件覆盖范围内。
- **后端改了错误码，前端兜底判断必须同步改**：`verify-code` 为防枚举已不再返回 `not_found`（统一为 `code_invalid`），前端 `js/whitelist.js` 里所有 `errCode === 'not_found'` 的判断都要带上 `code_invalid`，否则「全人工通道」这类出口引导会静默失效（用户反复重试却拿不到人工联系方式）。已发生过一次。
- **业务校验失败一律 `deny()`，不要 `fail()`**：`deny()` 会累计票据失败次数。`consumeCode` 自身的 5 次限制只保护「单个验证码」，不消耗主票据；走 `fail()` 的话攻击者可以拿一张主票据无限次试别的东西（例如换绑邮箱时试新邮箱验证码）。
- **人机验证失败必须走 `deny()` 而不是 `fail()`**：否则不计入票据失败次数，攻击者可以拿一张票据反复提交做字段探测（每次故意不勾人机验证即可绕过计次）。
- **`/api/whitelist/inquire` 是 POST**：票据放 body，不要改回 GET（query 会留在浏览器历史、访问日志、Referer）。
- 回归重点：换绑邮箱确认信双发、后台列表含邮箱变更、人机验证失败计次、查询 POST、verify-code 四情形同形（防枚举）、换绑邮箱、查询仅邮箱、修改流程三选一验证与锁定、写接口无 `Origin` 必须 403（CSRF 收紧）、Discord 旧版格式不接受 `<` `>` 等字符、票据失败计次与作废、冲突提示不泄露字段、`verify-code` 中性文案、生产缺 `RESEND_API_KEY` 必须 502、`isProduction` 分支（生产缺 `CODE_PEPPER` / `TURNSTILE_SECRET` 必须显式报错，不得放行）、票据一次性、限流窗口、黑名单正则校验、公开接口无 PII 泄漏、**审核动作幂等**（重复通过 / 拒绝必须返回 `already_reviewed`）、**申请 approve 分支必须重跑冲突检查**（被拒绝的记录不受唯一索引约束，改判为 approved 时 UPDATE 会撞索引；不检查就变成 500 `server_error`，管理员看不出原因）、**IGN 变更后 `manual_whitelisted_at` 必须被清空**、修改字段语义（`null`=不变 / `''`=清空 / 其它=新值）。
- 每次改 `migrations/` 或生产环境变量后，部署清单必须包含 `migrations apply --remote`。

**已实测（本仓库当前状态）**：`pages dev` 起服务后，未跑迁移时任何接口都抛 `D1_ERROR: no such table: rate_limits` —— 本地首次启动必须先 `migrations apply --local`。迁移后完整链路可用：`send-code → verify-code → apply` 返回 `WL-XXXXXX`，同一 ticket 二次提交返回 `ticket_invalid`，`inquire` 返回脱敏记录（`c*@d.com` / `12****78`），不匹配的 IGN+邮箱返回与成功同样的提示（防枚举生效）。管理员接口在无 `.dev.vars` 时可用请求头 `cf-access-authenticated-user-email: <email>` 直连验证；`DEV_ALLOW_ADMIN_BYPASS=1` 需真实存在 `.dev.vars`。

**易踩坑**：dev server 报错栈里的 `.wrangler/functions/_lib/*.js` 是编译副本，**永远改 `functions/` 源文件**；`.wrangler/` 已在 `.gitignore`。