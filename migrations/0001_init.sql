-- ============================================================
-- LongerMC · 白名单系统 初始化迁移
-- 用法见 DEPLOY.md：
--   npx wrangler d1 migrations apply longer-mc-db --remote
--   （本地）npx wrangler d1 migrations apply longer-mc-db --local
-- 全部使用 IF NOT EXISTS，重复执行安全。
-- ============================================================

-- ---------------- 白名单申请 ----------------
CREATE TABLE IF NOT EXISTS applications (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  reference              TEXT NOT NULL UNIQUE,          -- 申请编号 WL-XXXXXX
  email                  TEXT NOT NULL,                 -- 用户填写原始邮箱
  email_norm             TEXT NOT NULL,                 -- 去空格小写后的邮箱
  qq                     TEXT,
  qq_norm                TEXT,
  discord                TEXT,
  discord_norm           TEXT,
  ign                    TEXT NOT NULL,                 -- Minecraft 游戏 ID
  ign_norm               TEXT NOT NULL,
  email_verified_at      TEXT,
  turnstile_ok           INTEGER NOT NULL DEFAULT 0,
  turnstile_checked_at   TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending_review', -- pending_review|approved|rejected
  reject_reason          TEXT,
  review_note            TEXT,
  reviewed_by            TEXT,
  reviewed_at            TEXT,
  -- approved 仅代表审核通过；原版服务器是否生效单独记录
  manual_whitelisted_at  TEXT,
  manual_whitelist_by    TEXT,
  manual_whitelist_note  TEXT,
  submit_ip_hash         TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_email   ON applications(email_norm);
CREATE INDEX IF NOT EXISTS idx_app_ign     ON applications(ign_norm);
CREATE INDEX IF NOT EXISTS idx_app_status  ON applications(status);
CREATE INDEX IF NOT EXISTS idx_app_qq      ON applications(qq_norm);
CREATE INDEX IF NOT EXISTS idx_app_discord ON applications(discord_norm);

-- ---------------- 信息修改申请 ----------------
CREATE TABLE IF NOT EXISTS modification_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reference       TEXT NOT NULL UNIQUE,                 -- MR-XXXXXX
  application_id  INTEGER NOT NULL,
  email_norm      TEXT NOT NULL,
  prev_qq         TEXT,
  prev_discord    TEXT,
  prev_ign        TEXT NOT NULL,
  new_qq          TEXT,
  new_discord     TEXT,
  new_ign         TEXT,
  ign_changed     INTEGER NOT NULL DEFAULT 0,
  reason          TEXT NOT NULL,                        -- 修改理由（必填）
  email_verified_at TEXT,
  turnstile_ok    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending_review', -- pending_review|approved|rejected
  reject_reason   TEXT,
  review_note     TEXT,
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  applied_at      TEXT,
  request_ip_hash TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mod_app    ON modification_requests(application_id);
CREATE INDEX IF NOT EXISTS idx_mod_status ON modification_requests(status);
CREATE INDEX IF NOT EXISTS idx_mod_email  ON modification_requests(email_norm);

-- ---------------- 邮箱验证码（只存哈希） ----------------
CREATE TABLE IF NOT EXISTS email_verifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email_norm      TEXT NOT NULL,
  purpose         TEXT NOT NULL,                        -- apply|inquire|modify
  code_hash       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  consumed_at     TEXT,
  request_ip_hash TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ev_lookup ON email_verifications(email_norm, purpose, consumed_at);

-- ---------------- 验证通过后的短期票据 ----------------
CREATE TABLE IF NOT EXISTS auth_tickets (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                        -- apply|inquire|modify
  email_norm      TEXT NOT NULL,
  ign_norm        TEXT,
  application_id  INTEGER,
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_exp ON auth_tickets(expires_at);

-- ---------------- 限流计数（固定窗口） ----------------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rl_exp ON rate_limits(expires_at);

-- ---------------- 黑名单邮箱规则 ----------------
CREATE TABLE IF NOT EXISTS blacklisted_emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule       TEXT NOT NULL,                             -- 精确邮箱 或 正则表达式
  rule_type  TEXT NOT NULL CHECK (rule_type IN ('exact','regex')),
  reason     TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bl_rule ON blacklisted_emails(rule_type, lower(rule));

-- ---------------- 审计日志 ----------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT,
  action      TEXT NOT NULL,
  object_type TEXT,
  object_id   TEXT,
  note        TEXT,
  detail      TEXT,
  ip_hash     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_obj  ON audit_logs(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

-- ---------------- 邮件发件箱（真实发送记录 / 开发环境模拟记录） ----------------
CREATE TABLE IF NOT EXISTS email_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email   TEXT NOT NULL,
  subject    TEXT,
  template   TEXT,
  body_text  TEXT,
  status     TEXT NOT NULL,                             -- simulated|sent|failed
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_time ON email_outbox(created_at);
