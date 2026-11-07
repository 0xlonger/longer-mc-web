-- ============================================================
-- LongerMC · 修改流程「辅助验证因子」
--
-- 背景：修改白名单信息时，除了邮箱验证码，还要求用
-- QQ / Discord / 游戏 ID 中的一项做辅助验证（比对是否与该邮箱绑定的记录一致）。
-- 用哪一项验证，本次就不能修改哪一项——所以票据必须记住「本次用的哪一项」。
--
-- 执行：
--   npx wrangler d1 migrations apply longer-mc-db --local
--   npx wrangler d1 migrations apply longer-mc-db --remote
--
-- SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS 写法，
-- 若手工重复执行报 duplicate column，忽略即可（wrangler 会记录已应用的迁移）。
-- ============================================================

-- 票据：本次修改用的是哪一项辅助验证（ign / qq / discord）；申请与查询票据为空
ALTER TABLE auth_tickets ADD COLUMN verify_factor TEXT;

-- 修改申请：留一份存档，供管理员审核时判断「身份是怎么验的」
ALTER TABLE modification_requests ADD COLUMN verify_factor TEXT;
