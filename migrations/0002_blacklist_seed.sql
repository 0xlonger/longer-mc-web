-- ============================================================
-- LongerMC · 黑名单邮箱初始规则（可选）
--
-- 这是一份「开箱可用」的默认规则，主要是常见的一次性 / 临时邮箱域名，
-- 用于减少用临时邮箱批量提交申请的情况。
--
-- 说明：
--   1) 规则全部默认启用（enabled = 1）；如你希望放宽，可在后台
--      「黑名单邮箱」页面把对应规则停用或删除，也可以继续新增。
--   2) 精确规则里的 example.com 是 IANA 保留的示例域名，不是真实邮箱，
--      仅作占位示例，确认无误后可直接删除。
--   3) 正则规则均为扁平的「域名白名单式」写法，不含嵌套量词，无 ReDoS 风险；
--      后台新增规则时会校验正则长度（≤200）与嵌套量词，非法规则会被拒绝。
-- ============================================================

-- 常见一次性 / 临时邮箱（第 1 组）
INSERT OR IGNORE INTO blacklisted_emails (rule, rule_type, reason, enabled, created_at, updated_at)
VALUES ('^.*@(mailinator|guerrillamail|10minutemail|tempmail|throwawaymail|trashmail|yopmail|sharklasers|dispostable|maildrop|mailnesia)\.com$',
        'regex', '一次性 / 临时邮箱', 1, datetime('now'), datetime('now'));

-- 常见一次性 / 临时邮箱（第 2 组）
INSERT OR IGNORE INTO blacklisted_emails (rule, rule_type, reason, enabled, created_at, updated_at)
VALUES ('^.*@(temp-mail|tempmail|fake-mail|fakemail|getnada|emailondeck|mintemail|mailcatch|spamgourmet|mailnull|tempinbox)\.(com|org|net|io)$',
        'regex', '一次性 / 临时邮箱', 1, datetime('now'), datetime('now'));

-- 明显无效 / 占位域名
INSERT OR IGNORE INTO blacklisted_emails (rule, rule_type, reason, enabled, created_at, updated_at)
VALUES ('^.*@(localhost|localhost\.localdomain|example\.com|example\.net|example\.org|test|invalid)$',
        'regex', '无效或占位域名', 1, datetime('now'), datetime('now'));

-- 精确规则示例（example.com 为保留示例域名；确认后可直接删除本条）
INSERT OR IGNORE INTO blacklisted_emails (rule, rule_type, reason, enabled, created_at, updated_at)
VALUES ('spam@example.com', 'exact', '示例精确规则：滥用申请（可删除）', 1, datetime('now'), datetime('now'));
