# Longer MC 服务器官网

Longer MC 的官方网站源码，用于展示服务器信息与玩家引导。

- **网站地址**：https://mc.longer.xin
- **服务器地址**：`play.mc.longer.xin`
- **当前版本**：Java 版 1.21.11 原版生存服（后续将加入起床战争、空岛战争等小游戏）

## 功能

- 服务器状态实时显示（在线状态、在线人数、玩家列表）
- 一键复制服务器地址
- 生存服特色介绍与即将上线的小游戏预告
- 加入教程（四步引导）
- 适配手机端，纯静态无依赖

## 技术栈

- HTML5 + CSS3 + 原生 JavaScript
- 服务器状态数据来自 [mcsrvstat.us](https://api.mcsrvstat.us/)
- 无框架、无构建步骤，直接部署即可

## 本地预览

```bash
git clone https://github.com/你的用户名/仓库名.git
cd 仓库名
# 直接双击 index.html 即可，或用任意静态服务器：
python3 -m http.server 8080
```

然后访问 `http://localhost:8080`。

## 部署到 Cloudflare Pages

1. 将本仓库推送到 GitHub。
2. 在 Cloudflare 控制台进入 **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
3. 选择本仓库，构建配置留空（或按要求填写）：
   - **Build command**：留空
   - **Build output directory**：`/`
4. 部署完成后，在 **Custom domains** 中添加 `mc.longer.xin`，按提示配置 CNAME 记录即可。

## 自定义

需要修改服务器地址时，搜索以下两处：

- `index.html` 中的 `play.mc.longer.xin`
- `index.html` 脚本中的 `var SERVER_IP = 'play.mc.longer.xin';`

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。

## 版权

© 2026 龙ger_longer（Longer MC）

本站为玩家自建服务器官网，与 Mojang Studios、Microsoft 无任何隶属或关联关系。