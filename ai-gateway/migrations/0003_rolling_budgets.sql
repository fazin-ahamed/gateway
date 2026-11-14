-- 0003: Rolling-window budgets and prepaid credits for console accounts.
-- Additive only. NULL caps mean "no cap"; credits default to 0.
ALTER TABLE console_accounts ADD COLUMN budget_daily_usd REAL;
ALTER TABLE console_accounts ADD COLUMN budget_monthly_usd REAL;
ALTER TABLE console_accounts ADD COLUMN credits_usd REAL NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS spend_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  request_id TEXT,
  usd REAL NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_events_account_at ON spend_events(account_id, at);
