# LongerMC 白名单系统 · 部署与配置说明

本文件说明如何把白名单系统跑起来。**代码只负责申请收集、邮箱验证、人工审核与邮件通知**，
不会自动修改 Minecraft 服务器的 `whitelist.json`——所有原版白名单操作由管理员手动执行。

---

## 0. 你会得到什么

| 路径 | 说明 |
| --- | --- |
| `/whitelist/` | 入口页：申请 / 查询 / 修改 三个入口 |
| `/whitelist/apply/` | 新申请（邮箱验证码 + Turnstile） |
| `/whitelist/inquire/` | 自助查询状态（IGN + 邮箱 + 验证码 + Turnstile，结果脱敏） |
| `/whitelist/modify/` | 修改 QQ / Discord / IGN（需修改理由，人工审核） |
| `/admin/whitelist/` | 审核后台（由 Cloudflare Access 保护 `/admin*`） |

技术栈：Cloudflare Pages Functions + D1；邮件走 **Resend HTTP API**；人机验证用 **Cloudflare Turnstile**。
（注意：这里用的是 Resend 第三方邮件 API，**不是** Cloudflare Email Routing / Email Workers，两者不要混用。）

---

## 1. 新增 / 修改的文件

```
migrations/0001_init.sql                          D1 初始化迁移（表 + 索引）
migrations/0002_blacklist_seed.sql                黑名单初始规则（临时邮箱等，可选，可在后台改）
migrations/0003_hardening.sql                     加固迁移：票据失败计次 + 有效申请唯一索引
migrations/0004_verify_factor.sql                 修改流程辅助验证因子（auth_tickets / modification_requests 各加一列）
migrations/0005_email_change.sql                  换绑邮箱（modification_requests 加 prev_email / new_email / email_changed）
functions/_lib/*.js                               后端共享模块（非路由）
functions/api/whitelist/*.js                      公开接口（config / send-code / verify-code / apply / inquire / modify）
functions/admin/api/whitelist/[[path]].js         管理后台接口（受 /admin* Access 保护）
css/whitelist.css                                 白名单相关样式（原有 style.css 未改动）
js/icons.js                                       新页面用的精简图标 sprite
js/whitelist.js                                   申请 / 查询 / 修改页逻辑
js/admin-whitelist.js                             审核后台逻辑
whitelist/index.html                              白名单入口页
whitelist/apply/index.html                        申请页
whitelist/inquire/index.html                      查询页
whitelist/modify/index.html                       修改页
admin/whitelist/index.html                        审核后台页
wrangler.toml                                     本地开发 + D1 迁移用（database_id 需替换）
.dev.vars.example                                 环境变量示例
.gitignore                                        忽略 .dev.vars / .wrangler
```

修改的现有文件（均为**追加 / 样式统一**，不删除任何原有内容）：

- `partials/nav.html`：导航增加「白名单」链接（首页 / 404 页 / 所有新页面共用）
- `partials/footer.html`：页脚 EXPLORE 增加「白名单申请」
- `index.html`：#join 区块增加白名单入口卡片
- `css/style.css`、`css/whitelist.css`：统一为 Minecraft OreUI 视觉语言（直角、硬描边、像素标题字）
- `README.md`、`AGENTS.md`：补充说明、目录结构与开发约定

未改动：`js/main.js`、`js/nav.js`、`js/footer.js`、`js/status.js`、`404.html`、`assets/`、`icon.jpg`，
以及 Cloudflare 侧的自定义域名跳转（`longer-mc.pages.dev → mc.longer.xin`）——
本项目**没有**新增 `_redirects` 文件，跳转逻辑完全不受影响。

---

## 2. 需要你在 Cloudflare / 第三方完成的外部配置

以下操作我都无法代做，请按清单执行；全部完成后系统才会在生产环境正常工作
（缺任何一项都不会阻塞部署，只会降级为「模拟模式」并在日志中提示）。

### 2.1 D1 数据库

```bash
# 0) ⚠️ 已经跑过旧版本的库，升级时必须再跑一次迁移（0003、0004）：
#    npx wrangler d1 migrations apply longer-mc-db --remote
#    （0003 给 auth_tickets 加 attempts 列并建「有效申请」唯一索引；
#      0004 给 auth_tickets / modification_requests 加 verify_factor 列；
#      0005 给 modification_requests 加邮箱变更相关列）

# 1) 创建数据库（记下输出的 database_id）
npx wrangler d1 create longer-mc-db

# 2) 把 database_id 填进 wrangler.toml 的 [[d1_databases]].database_id
#    ⚠️ 仓库里默认是占位值 TODO_REPLACE_WITH_YOUR_D1_DATABASE_ID，
#    不改的话本地 dev 与 d1 migrations apply 都会失败（连不上数据库）。

# 3) 初始化线上数据库（本地迁移请先跑 --local）
npx wrangler d1 migrations apply longer-mc-db --remote
```

> **重要**：Cloudflare Pages 的 Git 自动构建**不会**执行 D1 迁移。
> 每次 `migrations/` 目录有新增文件（例如将来加了 `0002_xxx.sql`），
> 推送代码后都必须由你在本地手动再执行一次上面的 `migrations apply --remote`。
> 本地开发用：`npx wrangler d1 migrations apply longer-mc-db --local`。

### 2.2 Pages → D1 绑定

Cloudflare Dashboard → **Workers & Pages → 你的 Pages 项目 → Settings → Functions → D1 database bindings**：

- Variable name：`DB`（必须与代码一致）
- D1 database：`longer-mc-db`

> 变量绑定在 **Production** 与 **Preview** 分别配置；Preview 环境如未绑定，预览部署的接口会报错，属正常现象。

> **⚠️ 公开仓库请注意：预览部署会读你绑定给 Preview 的那个库。**
> 本项目通过 GitHub Git 集成部署——仓库公开时，**任何人 fork 后提的 Pull Request
> 都会自动触发预览部署**到 `<hash>.longer-mc.pages.dev`，而你为 Preview 绑定的
> D1 会直接暴露给那份 PR 代码。
> 建议二选一：
> - Preview 环境**不绑定** D1（预览部署的白名单接口会报错，但生产不受影响，最省心）；或
> - 单独建一个**测试用 D1 库**绑给 Preview，生产库只绑 Production。
>
> 同理，Preview 环境变量里也**不要**填生产用的 `RESEND_API_KEY`——
> 否则 PR 代码可以用你的额度发信。测试密钥单独申请一份。

### 2.3 Resend（邮件）

1. 注册 Resend → **Domains → Add Domain**，添加 `notify.longer.xin`
2. 按 Resend 提示在 Cloudflare DNS 添加 **SPF / DKIM（建议再加 DMARC）** TXT 记录，等待验证通过
3. **API Keys → Create API Key**（Sending access），得到 `re_xxx...`
4. 发件人：`whitelist@notify.longer.xin`（域名验证通过后才能用它发信）

### 2.4 Cloudflare Turnstile

Dashboard → **Turnstile → Add site**：

- 域名：`mc.longer.xin`（建议同时加 `localhost` 方便本地调试）
- Widget mode：`Managed`
- 得到 **Site Key**（公开，前端用）与 **Secret Key**（服务端用）

### 2.5 Cloudflare Access（保护 `/admin*`）—— 目标方案

> **如果 Zero Trust 免费版暂时无法激活（需要国际支付方式），先走 2.5.1 的 WAF 过渡方案，
> 以后激活成功再按 2.5.2 切回来。** 两条路都已在代码里支持，不需要改代码。

Zero Trust → **Settings → 新建 Self-hosted 应用**：

- Application domain：`mc.longer.xin`（建议同时加 `longer-mc.pages.dev`）
- 路径规则：**`/admin*`**（含星号）
- Policy：Action = Allow，规则选 Emails，填入你的管理员邮箱
- 可选（启用严格 JWT 校验）：记下 **Application Audience (AUD)** 与 **Team domain**，填进 `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`

> **⚠️ 路径必须写 `/admin*`，不能只写 `/admin/`！**
> `/admin/` 只匹配后台页面本身，**不会**匹配 `/admin/api/whitelist/*`，
> 那样所有审核 / 黑名单 / 审计接口就等于裸奔（任何人拿到地址都能调用）。
> 配好后请务必实际验证：未登录状态下直接访问
> `https://mc.longer.xin/admin/api/whitelist/me` 应该被 Access 拦截（跳转到登录页 / 403），
> 而不是返回 `{"ok":true,"actor":"..."}`。

> 生产环境不使用自建密码登录，完全依赖 Access。
> 本地开发没有 Access，可用 `.dev.vars` 里的 `DEV_ALLOW_ADMIN_BYPASS=1` 放行——
> 该开关**只对 `DEV_HOSTS` 命中的域名生效**（默认仅 localhost / 127.0.0.1），生产环境强制忽略。
>
> **⚠️ 不要把 `DEV_ALLOW_ADMIN_BYPASS` 配到 Cloudflare Pages 后台的环境变量里。**
> Pages 只需要配 2.6 表格里的生产变量；`.dev.vars` 只存在于你本机。

### 2.5.1 过渡方案：用 Cloudflare WAF 保护后台（当前采用）

激活 Zero Trust 需要绑卡或国际支付，暂时不方便时用这个。**WAF 在请求到达 Functions 之前拦截，
源 IP 伪造不了，所以这一层是实打实的。** 代码侧配套两个开关变量（2.6 表格）：

| 变量 | 作用 |
| --- | --- |
| `ADMIN_ALLOW_ACCESS_FALLBACK` | `1` = 允许「没有 Access 头」的请求进入后台，由 WAF 的 IP 白名单负责拦截 |
| `ADMIN_FALLBACK_ACTOR` | 可选，过渡期审计日志里的操作人，默认 `waf-admin@local.invalid` |
| `ADMIN_LOCKDOWN_TEST` | `1` = 测试锁定：除 `/admin/test` 外，所有后台页面与接口一律 403 |

> 三个开关**严格只认 `1`**。写成 `true` / `yes` / `0` / 留空都算关闭，避免手滑打开无条件入口。

#### WAF 规则怎么建

Cloudflare Dashboard → 你的域名 → **Security → WAF → Custom rules → Create rule**：

- **Expression**（用表达式编辑器，不要只填一个路径等于）：
  ```
  (starts_with(http.request.uri.path, "/admin")) and (not ip.src in {你的公网IP 另一个常用IP})
  ```
- **Action**：`Block`

**路径一定要用 `starts_with(..., "/admin")`**，这样 `/admin/whitelist/` 和
`/admin/api/whitelist/*` 都覆盖。**不要写成 `equals "/admin"` 或 `"/admin/"`**——
那正是漏掉审核接口的错误写法。

把你常用的几个来源 IP 都加进去（家里、公司、常开的热点）。
**家庭宽带 IP 会变，哪天进不去后台了，先查公网 IP 是不是变了，再回 WAF 改规则。**

#### 上线顺序（顺序错了会有裸奔窗口期，务必照做）

1. **先配 `ADMIN_LOCKDOWN_TEST=1`**（此时后台全锁，只有 `/admin/test` 可访问）
   —— 这一步最重要：即使后面 WAF 写错或变量配早了，别人也拿不到任何申请数据
2. 配好上面那条 WAF 规则
3. 打开 `https://mc.longer.xin/admin/test` 自检：
   - 允许的 IP → 应看到「🔒 测试锁定已开启」的自检页
   - 换成不在白名单的网络（手机热点）→ 应被 Cloudflare WAF 拦截
   - 伪造头测试：`curl -H "cf-access-authenticated-user-email: hacker@example.com" https://mc.longer.xin/admin/api/whitelist/me`
     → 应被 WAF 拦截或返回 403 `admin_lockdown`，**绝不能返回 `{"ok":true,...}`**
4. 三项都过了，**才**把 `ADMIN_ALLOW_ACCESS_FALLBACK=1`
5. 最后把 `ADMIN_LOCKDOWN_TEST=0`，后台才真正可用

> 反过来（先开 fallback 再测 WAF）会在测试期间留一个任何人都能进后台的窗口，别这么做。

#### 过渡期会退化的地方

- 审计日志里的操作人是固定值 `waf-admin@local.invalid`（不是真实登录身份）。
  目前只有你一个管理员，影响很小；`mode` 会记为 `ip-allowlist`，便于日后追溯。
- **过渡期不要配 `ADMIN_ALLOWED_EMAILS`**：配了但没匹配上会让后台 403。
- **绝对不要配 `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`**：配了代码会要求 JWT，
  而 WAF 不提供 JWT，后台立刻 401。
- `DEV_ALLOW_ADMIN_BYPASS` 依旧不要配到 Pages。

### 2.5.2 以后切回 Cloudflare Access 的清理清单

激活 Zero Trust 成功后，按顺序做（**顺序错了会留后门**）：

1. 按 2.5 建 Access 应用，路径 `/admin*`，Policy 允许你的管理员邮箱
2. 配 `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` + `ADMIN_ALLOWED_EMAILS`
3. **把 `ADMIN_ALLOW_ACCESS_FALLBACK` 改成 `0`（或删除）** —— 不删等于留了个无条件入口
4. **把 `ADMIN_LOCKDOWN_TEST` 改成 `0`（或删除）**
5. **删除 WAF 规则** —— WAF 在 Access 之前执行，留着会让已认证但换了 IP 的你自己被挡
6. 实测：未登录浏览器访问 `/admin/api/whitelist/me` 应被 Access 拦截；
   登录后访问应返回 `{"ok":true,...}`，且 `mode` 是 `access-jwt`

`/admin/test` 自检页可以一直留着：它不读数据库、不调用后台接口、不含任何申请数据，
任何模式下都能用来确认「当前来源 IP 是否被放行」。

### 2.6 Pages 环境变量

Cloudflare Dashboard → Pages 项目 → **Settings → Environment variables**（Production 环境）：

| 变量 | 必填 | 示例 |
| --- | --- | --- |
| `RESEND_API_KEY` | 是（真实发信） | `re_xxxxxxxx` |
| `EMAIL_FROM` | 是 | `LongerMC Whitelist <whitelist@notify.longer.xin>` |
| `TURNSTILE_SITE_KEY` | 是 | `0x4AAAAAAA...` |
| `TURNSTILE_SECRET` | 是 | `0x4AAAAAAA...` |
| `CODE_PEPPER` | 是 | 32 位以上随机串 |
| `APP_BASE_URL` | 否 | `https://mc.longer.xin` |
| `PRODUCTION_HOSTS` | 否 | `mc.longer.xin,longer-mc.pages.dev` |
| `DEV_HOSTS` | 否 | `localhost,127.0.0.1,[::1],0.0.0.0` |
| `TURNSTILE_ALLOWED_HOSTNAMES` | 否 | 空（默认只允许当前访问域名签发的凭证） |
| `EMAIL_DRIVER` | 否 | 空（自动：有 `RESEND_API_KEY` 就用 resend，否则 log） |
| `EMAIL_REPLY_TO` | 否 | `admin@longer.xin`（邮件的 Reply-To 头） |
| `FALLBACK_QQ_GROUP` / `FALLBACK_DISCORD_INVITE` | 否 | `1130448476` / `https://discord.gg/Ab4Gw2vBK` |
| `FALLBACK_QQ_GROUP_URL` | 否 | `https://qm.qq.com/q/xxxx`（点击直达链接，不填只显示群号） |
| `DUPLICATE_HINT_MODE` | 否 | `generic`（安全优先） |
| `ADMIN_ALLOWED_EMAILS` | **用 Access 时强烈建议配**（WAF 过渡期不要配） | `you@example.com`（多个用逗号分隔） |
| `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` | 否（开启 JWT 严格校验时必填）；**WAF 过渡期绝对不要配** | 见 2.5 |
| `ADMIN_ALLOW_ACCESS_FALLBACK` | WAF 过渡期设 `1`，切 Access 后设 `0` | `1` / `0`，严格只认 `1` |
| `ADMIN_FALLBACK_ACTOR` | 否 | `waf-admin@local.invalid`（过渡期审计操作人） |
| `ADMIN_LOCKDOWN_TEST` | 配置 WAF 阶段设 `1`，验证通过后设 `0` | `1` / `0`，严格只认 `1` |

**绝对不要**把 `DEV_ALLOW_ADMIN_BYPASS` / `DEV_ADMIN_EMAIL` 配到 Pages（那是本地开发专用）。

> **`ADMIN_ALLOWED_EMAILS` 强烈建议配上。**
> 代码在没配 `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` 时**不做 JWT 校验**，
> 只信任 Access 注入的 `Cf-Access-Authenticated-User-Email` 请求头。
> 只要 `/admin/api/*` 没被 Cloudflare Access 挡住，这个头就能被客户端伪造。
> 配了这个变量，等于在 Access 之外再加一层白名单兜底。
> 要彻底堵死，请把 `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` 也配上（见 2.5）。
>
> **WAF 过渡期（2.5.1）例外**：此时没有 Access 注入的头，
> 请**不要**配 `ADMIN_ALLOWED_EMAILS` / `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`，
> 改由 `ADMIN_ALLOW_ACCESS_FALLBACK=1` + WAF IP 白名单保护。

**生产环境一旦缺少 `RESEND_API_KEY`：`/api/whitelist/send-code` 会直接返回 502**，
而不是假装发送成功——否则用户永远收不到验证码、页面却提示"已发送"，排查成本极高。

`CODE_PEPPER` 可用下面命令生成：

```bash
openssl rand -hex 32
```

#### 生产 / 开发判定（重要）

判定逻辑是**安全默认**：只有命中 `DEV_HOSTS`（默认 `localhost` / `127.0.0.1`）才算开发环境，
**其余未知域名一律按生产处理**。被判为生产时会关闭三样 dev 兜底：
验证码回显 `devCode`、Turnstile 模拟 token、`DEV_ALLOW_ADMIN_BYPASS`。

**这意味着 Pages 预览部署（`abc123.longer-mc.pages.dev`）也会被当成生产环境**，因此预览环境必须：

- 配好 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET`，且 Turnstile 站点域名要覆盖预览域名
- 配好 `CODE_PEPPER`
- 管理后台 bypass 不可用，要进后台必须通过 Access（Access 应用需包含预览域名 + `/admin*`）；
  若走 WAF 过渡方案，WAF 规则需同时覆盖预览域名，且你的 IP 要在白名单里

如果你确实希望把某个域名当开发环境，把它加进 `DEV_HOSTS` 即可（不建议在生产域名上这么做）。

### 2.7 初始黑名单规则

`migrations/0002_blacklist_seed.sql` 已内置一份默认规则，执行迁移后自动生效：

| 类型 | 规则 | 说明 |
| --- | --- | --- |
| 正则 | 常见一次性 / 临时邮箱（第 1 组，如 mailinator、yopmail 等） | 减少临时邮箱批量申请 |
| 正则 | 常见一次性 / 临时邮箱（第 2 组，如 temp-mail、getnada 等） | 同上 |
| 正则 | 无效 / 占位域名（localhost、example.com 等） | 拦截无效邮箱 |
| 精确 | `spam@example.com` | **占位示例**，example.com 是保留域名不会误伤真实用户，确认后可直接删除 |

全部默认启用（已验证不会误伤 gmail / qq / outlook / 163 / foxmail / icloud 等常见邮箱）。
如果不想拦截临时邮箱，到后台「黑名单邮箱」把对应规则**停用**或**删除**即可，之后随时可加回来。

后台「黑名单邮箱」页可随时维护；也可用 SQL 直接初始化（精确 + 正则示例）：

```bash
npx wrangler d1 execute longer-mc-db --remote --command \
  "INSERT INTO blacklisted_emails (rule, rule_type, reason, enabled, created_at, updated_at)
   VALUES ('abuse@example.com', 'exact', '滥用申请', 1, datetime('now'), datetime('now'))"

npx wrangler d1 execute longer-mc-db --remote --command \
  "INSERT INTO blacklisted_emails (rule, rule_type, reason, enabled, created_at, updated_at)
   VALUES ('^.*@spam\\.example\\.com$', 'regex', '整域封禁', 1, datetime('now'), datetime('now'))"
```

---

## 3. 本地开发（零外部密钥也能端到端跑通）

```bash
cp .dev.vars.example .dev.vars     # 留空即为模拟模式
npx wrangler d1 migrations apply longer-mc-db --local
npx wrangler pages dev .
# 打开 http://localhost:8788/whitelist/

# 新版 Wrangler 已移除 --persist：本地持久化默认开启，数据写在 .wrangler/state。
# 需要指定目录才用：npx wrangler pages dev . --persist-to .wrangler/state
```

模拟模式下的行为：

- **邮件**：不发真实邮件，只打印日志并写入 D1 `email_outbox`；后台「邮件发送记录」页可查看
- **验证码**：为方便测试，接口在「非生产 + 模拟发送」时会在响应里回显 `devCode`，前端直接显示在提示条上
- **Turnstile**：未配置密钥时接受固定模拟 token `dev-mock-turnstile-token`（仅非生产域名）
- **管理员**：`DEV_ALLOW_ADMIN_BYPASS=1` 可直接进入 `/admin/whitelist/`

生产环境（命中 `PRODUCTION_HOSTS`）会强制关闭以上全部兜底：
缺 `CODE_PEPPER` / `TURNSTILE_SECRET` 时接口直接报错，绝不静默放行。

---

## 4. 部署流程（Git Push 自动部署）

1. 提交代码并推送到 GitHub（Pages 已绑定仓库，Push 即触发部署）
2. **手动执行数据库迁移**（见 2.1，Pages 不会自动执行）
3. 确认 Pages → Settings → Functions 里 D1 绑定名为 `DB`
4. 确认生产环境变量已配置（见 2.6）
5. **按 2.5.1 的顺序配好后台保护**（先 `ADMIN_LOCKDOWN_TEST=1` → 配 WAF → 自检 →
   再 `ADMIN_ALLOW_ACCESS_FALLBACK=1` → 最后 `ADMIN_LOCKDOWN_TEST=0`）。
   若已激活 Zero Trust，则改为按 2.5 配 Access 覆盖 `/admin*`
6. 打开 `https://mc.longer.xin/whitelist/` 验证三个入口
7. 打开 `https://mc.longer.xin/admin/whitelist/` 验证后台可用；
   并用未放行的网络 / 伪造头验证后台确实被挡（见 2.5.1 第 3 步）

本项目**零构建**：不需要 Build command、不需要 output directory、不需要 `package.json`。

---

## 5. 审核员操作指引（写进后台的提示）

系统在审核详情页明确区分「审核通过」与「原版白名单已生效」：

1. 打开待审核申请，人工核验：
   - 该 QQ 号是否已加入 / 已申请加入服务器 QQ 交流群（**QQ 等级需满 15 级**才可进群），且该 QQ 号尚未申请过白名单；
   - 或该 Discord 是否已加入 / 已申请加入 Discord 服务器；
   - IGN 是否规范、是否与已有记录冲突（系统只做基本的重复检查，最终由你判断）
2. 点「通过申请」→ 系统记录 `approved` + 发邮件，并展示 `whitelist add <IGN>`
3. **你手动到 Minecraft 服务器执行** `whitelist add <IGN>`
4. 回到后台勾选「已人工加入原版白名单」并保存 → 记录 `manual_whitelisted_at` 与操作人
5. 拒绝必须填写原因（≥5 字），系统会发邮件告知申请人
6. 修改申请通过后：
   - **若 IGN 变化**，系统会**自动清空**该记录的「已人工加入原版白名单」标记，
     你必须手动执行 `whitelist remove <旧ID>` + `whitelist add <新ID>`，
     完成后回到后台重新勾选标记。不要以为还显示「已加入」就万事大吉——变了 IGN 之后它一定会被清空。
   - 若只改 QQ / Discord，原版白名单不受影响，标记保持原样。
7. 审核按钮做了幂等保护：已经是「已通过」的申请再点通过会返回 409 提示，不会重复发邮件 / 重复写审计日志。
   想把「已拒绝」改判为「已通过」，直接点「通过申请」即可。
8. 修改申请通过时，系统会**再跑一次冲突检查**（提交时没撞不代表审核时没撞）。
   若新 IGN / QQ / Discord 已被别人的有效申请占用，通过会被拒绝（409），此时请改为拒绝并说明原因。

> 系统**不会**自动验证 QQ 群成员 / QQ 等级 / Discord 加入情况，这些一律由人工核验并在备注中记录。

#### 修改申请的字段语义（管理员需知）

- 留空 = **不修改**（沿用原值）
- 勾选「清空」= 把该项置空（前端有独立复选框，后端用 `clearQq` / `clearDiscord` 标志）
- 填新值 = 改为新值
- QQ 与 Discord **不能同时为空**：通过后至少要保留一个联系方式，否则通过会被拒绝

**建议：清空联系方式属于敏感操作**（等于放弃一个联系渠道），审核时留意修改理由是否合理；
若你希望完全禁止前台清空，把 `whitelist/modify/index.html` 里两个「清空」复选框删掉即可，
后端在没有 `clearQq` / `clearDiscord` 标志时天然不会清空任何字段。

---

## 6. 安全设计速览

- 验证码：6 位、HMAC-SHA256 存哈希（pepper 来自 `CODE_PEPPER`）、10 分钟有效、一次性、单码失败 5 次作废
- 频率限制：邮箱 60 秒冷却 + 每小时 5 次；IP 每小时 20 次；验证尝试与写操作同样限流
- 查询/修改必须完成邮箱验证码 + Turnstile，服务端二次校验 token
- 防枚举：查询发送验证码时，无论 IGN 与邮箱是否匹配都返回同一句提示
- 结果脱敏：公开接口只返回掩码后的邮箱 / QQ / Discord
- `/admin*` 由 Cloudflare Access 保护（`GET` 请求也做同源校验）；每次审核动作写入 `audit_logs`（管理员 / 时间 / 备注 / IP 指纹）
- 写操作做同源校验（Origin / Sec-Fetch-Site）+ 字段白名单 + 长度限制
- 黑名单正则：长度 ≤200、条数上限 50、拒绝无效正则与嵌套 / 多分支重复量词、编译后试跑、逐条 try/catch，避免 ReDoS
- 日志脱敏：IP 只存 HMAC 指纹，邮件日志只打印掩码地址
- **生产判定采用安全默认**：只有 `DEV_HOSTS`（默认 localhost / 127.0.0.1）算开发环境，未知域名一律按生产处理，
  避免预览域名 / 换域名时被误判成开发环境而打开 dev 兜底

#### 关于邮件发件箱里的邮箱明文

`email_outbox` 表会**明文保存收件人邮箱和邮件正文**，这是有意保留的：

- 排查投递失败（Resend 报错、收件人写错）必须能查到具体地址；
- 该表只能通过 `/admin/api/whitelist/outbox` 读取，而该接口受 Cloudflare Access 保护；
- 后台页面上**已做脱敏展示**（`a***@g****.com`），完整地址只在申请详情页出现。

**因此：后台的访问范围等同于「可查看玩家邮箱」的权限**，请只把 Access 策略开放给可信管理员，
不要把后台页面投屏 / 截图公开分享。若你的合规要求不允许落库明文，可在 `functions/_lib/email.js`
的 `sendMail()` 里把 `to_email` 改成写入 `maskEmail(to)`（代价是排障时看不到真实收件人）。

---

## 6.4 打包 / 提交前请先清理本地状态

`.wrangler/` 是 `wrangler pages dev` 生成的本地状态目录，里面可能包含
**本地 D1 的 SQLite 文件**（测试申请记录、验证码、邮件）。它已被 `.gitignore` 忽略，
但如果你用「压缩整个目录」的方式打包或拷给别人，会被一起带出去。

发布前建议：

```bash
rm -rf .wrangler
git status --porcelain   # 确认待提交内容里没有 .wrangler / *.sqlite
```

---

## 6.5 修改白名单信息的身份验证规则

修改流程要求**邮箱 + QQ / Discord / 游戏 ID 三选一**双重验证：

1. **邮箱必填**，并必须通过 6 位验证码（证明邮箱控制权）；
2. **辅助验证三选一**：填 QQ、Discord 或游戏 ID 中的**任意一项**，
   系统比对这一项是否与「该邮箱绑定的记录」一致；
3. **用哪一项验证，本次就不能改那一项**——
   要改游戏 ID，就得改用 QQ 或 Discord 来验证（反之亦然）；
4. 三项都对不上（例如记不清当时填的 QQ、或记录里没有其它联系方式）时，
   页面会引导走**全人工通道**，并提示提交足够证据。

**审核员注意**：后台每条修改申请都记录了 `verify_factor`（本次用哪一项验的身份），
详情可查。若用户走全人工通道，请比照同样的标准人工核对后再改。

---

## 6.6 状态查询与换绑邮箱

**查询（/whitelist/inquire）**：只需填邮箱 + 邮箱验证码，不再要求游戏 ID。
验证码本身已证明了对邮箱的控制权，再要求游戏 ID 只是给记不清 ID 的用户添麻烦。
每一步（发码、校验）都要过 Turnstile。

**换绑邮箱（在 /whitelist/modify 里勾选）**：

1. 仍要先通过「当前邮箱验证码 + QQ/Discord/游戏 ID 三选一辅助验证」
2. 新邮箱必须**独立完成一次验证码验证**（用途 `change_email`，与主身份的验证码互不干扰）
3. 新邮箱也要过黑名单与唯一性检查

**当前邮箱已经无法使用时**，在线流程无法验证身份——页面会明确提示改走全人工通道，
并要求提供充足证据（游戏 ID、原邮箱、能证明账号归属的材料）。这一点在修改页上写明了。

**审核员注意**：换绑邮箱的申请通过后，通知邮件会发往**新邮箱**（旧邮箱多半已停用），
后台详情里能看到邮箱的前后值。

---

## 6.7 网页通道不可用时的「全人工白名单」

网页端（`/whitelist/apply` `/inquire` `/modify`）因故不可用时，用户不必卡住：
**直接加入 QQ 群或 Discord 服务器，说明自己无法在网页完成操作，管理员会走全人工流程处理**。

- 这段说明显示在白名单四个页面的底部，以及每一封系统邮件的下方
- 默认值与首页「加入区」一致：QQ 群 `1130448476`、Discord `https://discord.gg/Ab4Gw2vBK`
- 想换成别的群 / 邀请链接，配置 `FALLBACK_QQ_GROUP` / `FALLBACK_DISCORD_INVITE` 即可（见 2.6）

**审核员须知**：走全人工流程时，请在后台补一条申请记录（或直接人工加白名单后在后台标记），
并核对 QQ 群成员 / QQ 等级 / Discord 加入情况，保证与网页流程同一标准。

---

## 6.8 行为速查（排查时参考）

| 行为 | 说明 |
| --- | --- |
| 票据失败计次 | 提交申请 / 修改时，任何校验失败都会给票据计 1 次；累计 5 次票据作废，需要重新做邮箱验证 |
| 冲突提示统一 | 默认返回「信息与已有记录冲突」，不告诉对方是 IGN 还是 QQ 撞了，也不返回对方编号（可切 `DUPLICATE_HINT_MODE=detailed`） |
| 写接口限流收紧 | `/apply` 与 `/modify` 从 15 次 / 10 分钟收紧到 5 次 / 10 分钟 |
| 生产缺邮件配置 | 直接 502 报错，不再静默模拟发送 |
| Turnstile 域名核对 | 凭证的 `hostname` 不在允许列表内、`challenge_ts` 超过 5 分钟，一律判失败 |
| 数据库唯一索引 | 同一邮箱 / IGN / QQ / Discord 在「待审核 + 已通过」范围内只允许一条（0003 迁移） |
| 管理端限流 | 后台所有接口 300 次 / 10 分钟（Access 之外的兜底） |
| verify-code 防枚举 | 「记录不存在」「验证码错」「验证码过期/锁定」三条失败路径全部返回同一个 400 `code_invalid`（文案一致、都不带 `remaining`）。代价：用户看不到「还剩几次」提示 |
| 查询票据一次性 | 查完即作废，再次查询需重新做一次邮箱验证 |
| 换绑邮箱验证码 | 延后到全部校验通过后才消耗，理由太短 / 人机验证没勾都不会浪费那封邮件 |
| 只换绑邮箱可提交 | 前端「请至少修改一项」的校验把「已勾选更换邮箱」算作有效变更（原来会挡住只想换邮箱的用户） |
| 后台详情显示邮箱前后值 | 修改详情的「前后对比」补了「绑定邮箱」行，并加了换绑邮箱的审核提醒 |
| 后台区分「清空」与「不变」 | 修改详情 / 列表里 `''` 显示「（清空）」、`null` 显示「（不变）」，与后端 `pick()` 实际行为一致 |
| 写接口限流拆分 | apply 与 modify 各用独立 IP 桶，各 12 次 / 10 分钟（原来共用 5 次）；发码 IP 20 → 30 次 / 小时 |
| 安全响应头 | 新增 `_headers`（nosniff / X-Frame-Options / Referrer-Policy / Permissions-Policy / HSTS），CSP 需先在预览验证，见文件末尾注释 |
| 冲突提示含出路 | 撞车时不说具体哪一项，但会提示可到 QQ 群 / Discord 请管理员人工核对 |
| 发件箱不存验证码 | 验证码邮件的正文在发件箱里只留占位说明，主题里的 6 位数字也一并抹掉 |
| 查询仅验邮箱 | /whitelist/inquire 不再要求填游戏 ID |
| 换绑邮箱 | 新邮箱需独立验码；审核通过后记录与通知邮箱一并更新 |
| 并发冲突友好化 | 撞上唯一索引时返回 409 duplicate_field，不再是 500 |
| 换绑邮箱的确认信 | 提交确认信同时发旧邮箱与新邮箱（换绑的常见原因就是旧邮箱停用，只发旧邮箱用户收不到）；审核通过信发新邮箱 |
| 后台列表显示邮箱变更 | 修改列表的「变更项」会显示「邮箱」，不必点开详情 |
| 人机验证失败计次 | 申请 / 修改接口的人机验证失败也累计票据失败次数，5 次后作废（与 AGENTS.md 约定一致） |
| 查询走 POST | /api/whitelist/inquire 改为 POST，票据放 body 不放 URL（避免留在浏览器历史与访问日志） |
| 改判通过查冲突 | 后台把已拒绝申请改判为通过时，先查 IGN/邮箱/QQ/Discord 是否被别的有效申请占用，冲突返回 409 并带占用方编号（否则 UPDATE 撞唯一索引 → 500） |
| 来源校验收紧 | 写接口（含后台写操作）若既无 `Origin` 也无 `Sec-Fetch-Site` 一律 403；`Sec-Fetch-Site: none` 的写请求也拒绝。GET 保持宽松，避免误伤 |
| Discord 格式收紧 | 旧版 `name#1234` 只放行字母数字 `.` `_` `-` 与空格，不再接受 `<` `>` `"` `=` 等 |
| 过期数据清理 | 发送验证码时约 5% 概率顺带清理过期 / 已用的验证码与票据 |

---

### 关于来源校验的一点取舍

写接口现在要求请求必须能证明自己来自本站：要么带同源 `Origin`，要么带
`Sec-Fetch-Site: same-origin`。**没有任何相关头部的写请求（例如裸 `curl`）会被 403 拒绝**。

绝大多数用户不受影响——现代浏览器对同源表单 / fetch 提交都会带 `Origin`。
但如果将来有用户反馈"点提交就报来源校验失败"，先查两件事：

1. 是否用了会剥离 `Origin` 头的代理 / 网关；
2. 是否从 `mc.longer.xin` 之外的域名（如 `longer-mc.pages.dev` 的旧书签）发起提交。

确认是环境问题、又需要临时放行时，可把该接口改回宽松的 `sameOrigin()`
（`functions/_lib/http.js` 里两个函数并存，替换调用即可）。

---

## 7. 常见问题

**Q：Pages 预览环境（`.pages.dev`）后台打不开？**
A：Preview 环境也需要配置 D1 绑定和环境变量；且 Access 应用需包含 `longer-mc.pages.dev` 域名与 `/admin*` 路径。

**Q：申请提交后收不到邮件？**
A：先到后台「邮件发送记录」看 status：`simulated` 说明没配 `RESEND_API_KEY`；`failed` 会显示 Resend 返回的错误（常见于域名未验证或 `EMAIL_FROM` 域名与已验证域名不一致）。

**Q：Turnstile 一直提示未通过？**
A：确认 Site Key 与 Secret Key 属于同一个站点，且站点域名包含当前访问域名（本地调试需加 `localhost`）。

**Q：改了 `migrations/` 但线上表没变？**
A：Pages 不会自动跑迁移，必须手动执行 `npx wrangler d1 migrations apply longer-mc-db --remote`。

**Q：后台突然进不去了（走 WAF 过渡方案时）？**
A：九成是公网 IP 变了。打开 `https://mc.longer.xin/admin/test`——
能看到自检页说明 WAF 放行了当前 IP（问题在别处）；被 Cloudflare 拦截说明 IP 已变，
到 Security → WAF → Custom rules 把新 IP 加进白名单即可。

**Q：`/admin/api/*` 返回 403 `admin_lockdown`？**
A：`ADMIN_LOCKDOWN_TEST` 还是 `1`。WAF 验证完成后把它改成 `0`。

**Q：Zero Trust 激活成功了，怎么切回 Access？**
A：按 2.5.2 的 6 步清理清单做完。最容易漏的是**删 WAF 规则**和
**把 `ADMIN_ALLOW_ACCESS_FALLBACK` 改成 0**——前者会挡住换 IP 的你自己，
后者等于留了一个无条件入口。
