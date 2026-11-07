-- ============================================================
-- LongerMC · 修改流程支持「更换绑定邮箱」
--
-- 背景：用户可能想换绑邮箱（旧邮箱停用、换了邮箱服务商等）。
-- 规则：
--   - 仍要先通过「当前邮箱验证码 + 一项辅助验证」证明身份
--   - 新邮箱必须独立完成一次验证码验证（证明对新邮箱的控制权）
--   - 当前邮箱已经无法使用时，在线流程走不通，只能走全人工通道
--
-- 执行：
--   npx wrangler d1 migrations apply longer-mc-db --local
--   npx wrangler d1 migrations apply longer-mc-db --remote
--
-- SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS 写法，
-- 若手工重复执行报 duplicate column，忽略即可（wrangler 会记录已应用的迁移）。
-- ============================================================

-- 修改申请：记录邮箱的前后值，供审核员核对与留痕
ALTER TABLE modification_requests ADD COLUMN prev_email TEXT;
ALTER TABLE modification_requests ADD COLUMN new_email TEXT;
ALTER TABLE modification_requests ADD COLUMN email_changed INTEGER NOT NULL DEFAULT 0;
