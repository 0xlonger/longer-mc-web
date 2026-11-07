-- ============================================================
-- LongerMC · 白名单加固迁移（第二轮审查修复）
--
-- 执行（Pages 不会自动跑迁移，必须手动）：
--   npx wrangler d1 migrations apply longer-mc-db --local
--   npx wrangler d1 migrations apply longer-mc-db --remote
--
-- wrangler 会在 d1_migrations 里记录已应用的文件，正常不会重复执行。
-- 索引部分用了 IF NOT EXISTS，重复执行安全；
-- 但 ALTER TABLE ADD COLUMN 在 SQLite 里没有 IF NOT EXISTS 写法，
-- 若手工重复执行本文件会报 duplicate column: attempts，忽略该错误即可。
-- ============================================================

-- ------------------------------------------------------------
-- 1) auth_tickets 增加 attempts 列
--    用途：写接口（提交申请 / 提交修改）每次校验失败都 +1，
--    超过上限直接作废票据，逼迫重新做一次邮箱验证。
--    这样「拿一张票据反复提交来探测别人是否申请过」的成本
--    从「30 分钟内无限次」降到「每张票据 5 次」。
-- ------------------------------------------------------------
ALTER TABLE auth_tickets ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- ------------------------------------------------------------
-- 2) 有效申请的部分唯一索引
--    应用层查重是「SELECT 后 INSERT」两步，并发下理论上能插入两条
--    pending_review。这里在数据库层面兜底：同一邮箱 / IGN / QQ / Discord
--    在「待审核 + 已通过」范围内只允许一条。
--
--    说明：
--    - 只约束 pending_review / approved，rejected 的历史记录不受影响
--      （同一个人被拒后可以用同一个邮箱重新申请）；
--    - qq_norm / discord_norm 可能为 NULL，索引里排除了 NULL
--      （SQLite 认为 NULL 之间互不相等，不会出现「两个人都没填 QQ 就冲突」）。
--
--    ⚠️ 如果执行时报错 UNIQUE constraint failed：
--    说明库里已经存在重复的有效记录，先把重复数据处理掉
--    （保留一条，其余改成 rejected 或删除）再重跑本迁移。
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_active_email
  ON applications(email_norm)
  WHERE status IN ('pending_review', 'approved');

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_active_ign
  ON applications(ign_norm)
  WHERE status IN ('pending_review', 'approved');

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_active_qq
  ON applications(qq_norm)
  WHERE status IN ('pending_review', 'approved') AND qq_norm IS NOT NULL AND qq_norm <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_active_discord
  ON applications(discord_norm)
  WHERE status IN ('pending_review', 'approved') AND discord_norm IS NOT NULL AND discord_norm <> '';

-- ------------------------------------------------------------
-- 3) 过期数据清理用的索引（配合代码里的低频清理）
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ev_cleanup  ON email_verifications(created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_kind ON auth_tickets(kind, created_at);
