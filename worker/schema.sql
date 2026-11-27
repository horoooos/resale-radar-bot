CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  query TEXT NOT NULL,
  category TEXT,
  max_buy_price INTEGER,
  expected_sale_price INTEGER,
  min_profit INTEGER NOT NULL,
  min_roi REAL NOT NULL,
  sale_fee_percent REAL NOT NULL,
  fixed_costs INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_watches_chat ON watches(chat_id, enabled);

CREATE TABLE IF NOT EXISTS watch_sources (
  watch_id INTEGER PRIMARY KEY,
  source_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  external_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  price INTEGER NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Другое',
  location TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);

CREATE TABLE IF NOT EXISTS notifications (
  watch_id INTEGER NOT NULL,
  external_id TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (watch_id, external_id)
);

