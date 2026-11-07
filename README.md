# Longer MC 服务器官网

Longer MC 的官方网站源码，用于展示服务器信息与玩家引导。

- **网站地址**：https://mc.longer.xin/
- **服务器地址**：`play.mc.longer.xin`
- **当前版本**：Java 版 1.21.11 原版生存服（后续考虑加入起床战争、空岛战争等小游戏）

## 功能

- 顶部非营利声明公告条（金色像素棋盘纹理，可跳转完整声明）
- 首页主视觉场景化（等距草方块上橡树与小猫、漂浮钻石/金/煤矿石方块、三层像素云、星空闪烁、山丘剪影上的像素树与闪烁火把）
- 服务器状态实时显示（在线状态、在线人数、玩家列表）
- 一键复制服务器地址
- 生存服特色介绍（bento 卡片带主题色条与像素水印装饰：草方块场景 / 像素小屋 / 玩家头像堆 / 信号强度条，QUICK JOIN 附三步入服提示）
- 服务器介绍（领地保护、多世界、跨版本、AuthMe、EssentialsX、经济、箱子商店、皮肤等 8 项插件一览）
- 服务器基本规则（5 条，每条配像素图标与类别标签，红石主题）
- 非营利声明（SimpFun 公益服说明、承诺期限至 2027 年 10 月，金色编号徽章 + 角括号面板）
- 小游戏预告（起床战争 / 空岛战争插画场景化：TNT 与爆炸粒子、双岛木桥与瀑布宝箱、下界传送门黑曜石纹理与紫光池；附 ROADMAP 进度条、优先级徽章与玩法提案引导）
- 加入教程（四步引导，每步配像素图标与幽灵编号，含首次进服 AuthMe 注册说明）
- 适配手机端（底部 MC 物品栏快捷导航），纯静态无依赖
- 主站入口（导航栏「主站」按钮、页脚主站卡片，指向 www.longer.xin）
- 社区入口（加入区「QQ 群 / Discord」卡片：群号一键复制 + 加群 / Discord 跳转；页脚同步展示群号与 Discord 邀请链接）
- 白名单系统（`/whitelist`）：在线申请、状态自助查询、信息修改申请；`/admin/whitelist` 为人工审核后台
  - 邮箱六位数验证码 + Cloudflare Turnstile 人机验证（均服务端校验）
  - 审核通过只代表系统记录通过，原版白名单由管理员手动执行，另有「已人工加入原版白名单」标记
  - 详见 [DEPLOY.md](DEPLOY.md)

## 目录结构

```
index.html            首页（含全部 SVG 图标 symbol）
404.html              404 页（自带精简版图标 symbol）
partials/nav.html     导航栏片段，由 js/nav.js 注入
partials/footer.html  页脚片段，由 js/footer.js 注入
css/style.css         全站样式
js/nav.js             载入导航栏片段
js/footer.js          载入页脚片段
js/main.js            交互（复制、滚动、导航高亮等）
js/status.js          服务器状态（mcsrvstat.us）
js/icons.js           白名单 / 后台页面用的精简图标 sprite
js/whitelist.js       白名单：申请 / 查询 / 修改页逻辑
js/admin-whitelist.js 白名单审核后台逻辑
css/whitelist.css     白名单与后台样式
whitelist/            白名单前台页面（index / apply / inquire / modify）
admin/whitelist/      白名单审核后台页面（由 Cloudflare Access 保护 /admin*）
functions/            Cloudflare Pages Functions（后端接口）
  _lib/               共享模块（非路由）
  api/whitelist/      公开接口
  admin/api/whitelist/ 管理接口
migrations/           D1 数据库迁移
wrangler.toml         本地开发 + D1 迁移配置（database_id 需自行替换）
.dev.vars.example     环境变量示例（复制为 .dev.vars 使用，勿提交）
DEPLOY.md             部署与配置说明（含需要手动执行的 D1 迁移命令）
```

导航与页脚是公共片段，改一次即在首页与 404 页同时生效（本地直接双击打开时因 `fetch` 限制不会注入，需用静态服务器预览）。

## 技术栈

- HTML5 + CSS3 + 原生 JavaScript
- 界面设计语言：Minecraft OreUI（色板 / 按钮斜面 / 硬边取自 minecraft.net 官方组件库 `mc-components.css`：0 圆角、2px `#171615` 描边、`inset 0 ±6px` 斜面、`#1157be` 焦点色）
- 服务器状态数据来自 [mcsrvstat.us](https://api.mcsrvstat.us/)
- 无框架、无构建步骤，直接部署即可
- 白名单系统：Cloudflare Pages Functions + D1 + Turnstile + Resend（无第三方运行时依赖）

## 复刻本项目

白名单系统依赖的外部服务都需要换成你自己的：

1. 复制 `.dev.vars.example` 为 `.dev.vars` 并填写（本地开发可全部留空，进入模拟模式）
2. 创建 D1 数据库并把 `database_id` 填进 `wrangler.toml`
3. 申请你自己的 Turnstile 站点密钥与 Resend API Key（并验证你自己的发件域名）
4. 按 [DEPLOY.md](DEPLOY.md) 配置 Pages 环境变量、D1 绑定与 Cloudflare Access
5. **替换「全人工通道」的联系方式**：不配 `FALLBACK_QQ_GROUP` / `FALLBACK_DISCORD_INVITE`
   时，`functions/_lib/env.js` 里的默认值会把用户引导到 **LongerMC 自己的 QQ 群与 Discord**。
   复刻时务必通过环境变量（或在该文件里改默认值）换成你自己的，
   否则你的玩家会跑到别人的群里问白名单。

仓库中不包含任何真实密钥、API Key 或私有地址；`.dev.vars`、`.wrangler/` 已在 `.gitignore` 中忽略。

## 本地预览

```bash
git clone https://github.com/你的用户名/仓库名.git
cd 仓库名
# 直接双击 index.html 即可，或用任意静态服务器：
python3 -m http.server 8080
```

然后访问 `http://localhost:8080`。

## 自定义

需要修改服务器地址时，搜索以下两处：

- `index.html` 中的 `play.mc.longer.xin`
- `index.html` 脚本中的 `var SERVER_IP = 'play.mc.longer.xin';`

社区入口（QQ 群号、加群链接、Discord 邀请链接）出现在以下位置，需要修改时请一并替换：

- `index.html` 加入区的 `#community` 卡片（群号、复制按钮、`加群` / `Discord` 按钮）
- `index.html` 首屏状态行的 QQ 群号
- `partials/footer.html` 的 `footer-qq` 与 `footer-discord`

> 注意：QQ 群 `1130448476` 是 **LongerMC 服务器专属群**（只聊服务器），与主站 www.longer.xin 的群不是同一个。

其他可替换资源：

- 站点 Logo：根目录 `icon.jpg`（导航、页脚、服务器图标与 favicon 共用）
- 像素英文字体：`assets/fonts/press-start-2p.woff2`（SIL OFL，许可证见同目录 `OFL.txt`）
- 在线玩家头像：由 [minotar.net](https://minotar.net/) 根据玩家名实时获取，加载失败时回退为内置像素头像

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。

## 版权

© 2026 龙ger_longer（Longer MC）

本站为玩家自建服务器官网，与 Mojang Studios、Microsoft 无任何隶属或关联关系。
