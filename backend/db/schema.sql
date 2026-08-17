CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_conv_id
  ON conversations(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS jira_tickets_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL UNIQUE,
  summary TEXT,
  status TEXT,
  priority TEXT,
  assignee TEXT,
  sla_remaining_minutes REAL,
  sla_name TEXT,
  at_risk INTEGER DEFAULT 0,
  raw_json TEXT,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jira_at_risk
  ON jira_tickets_cache(at_risk);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  decision_text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nudges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  nag_count INTEGER DEFAULT 0,
  date_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  priority TEXT DEFAULT 'normal',
  due_date TEXT,
  source TEXT,
  ms_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS calendar_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,
  subject TEXT,
  start_time TEXT,
  end_time TEXT,
  is_all_day INTEGER DEFAULT 0,
  location TEXT,
  organizer TEXT,
  show_as TEXT,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nudges_active ON nudges(active, date_key);
CREATE INDEX IF NOT EXISTS idx_todos_done ON todos(done);
CREATE INDEX IF NOT EXISTS idx_todos_ms_id ON todos(ms_id);
CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_cache(start_time);

CREATE TABLE IF NOT EXISTS import_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relative_path TEXT NOT NULL UNIQUE,
  type TEXT,
  destination TEXT,
  confidence TEXT,
  reason TEXT,
  backend TEXT,
  classified_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_import_cls_path ON import_classifications(relative_path);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  event_data TEXT,
  hour INTEGER,
  day_of_week INTEGER,
  date_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_log(date_key, event_type);

CREATE TABLE IF NOT EXISTS inbox_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL UNIQUE,
  subject TEXT,
  from_name TEXT,
  from_email TEXT,
  urgency TEXT,
  category TEXT,
  summary TEXT,
  reason TEXT,
  received TEXT,
  is_read INTEGER DEFAULT 0,
  has_attachments INTEGER DEFAULT 0,
  dismissed INTEGER DEFAULT 0,
  dismissed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inbox_dismissed ON inbox_items(dismissed);
CREATE INDEX IF NOT EXISTS idx_inbox_email_id ON inbox_items(email_id);

CREATE TABLE IF NOT EXISTS vault_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relative_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  chunk_text TEXT,
  file_modified TEXT,
  embedded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(relative_path, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_path ON vault_embeddings(relative_path);
CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON vault_embeddings(content_hash);

-- Entity extraction — people, tasks, decisions extracted from notes
CREATE TABLE IF NOT EXISTS extracted_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_value TEXT NOT NULL,
  context TEXT,
  extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entities_path ON extracted_entities(source_path);
CREATE INDEX IF NOT EXISTS idx_entities_type ON extracted_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_value ON extracted_entities(entity_value);

-- Backlinks — tracks which notes mention which entities/notes
CREATE TABLE IF NOT EXISTS note_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  target_path TEXT,
  target_entity TEXT,
  link_type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_links_source ON note_links(source_path);
CREATE INDEX IF NOT EXISTS idx_links_target ON note_links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_entity ON note_links(target_entity);

-- Do Next — high-signal tasks identified in standups, chat sessions, or manually
CREATE TABLE IF NOT EXISTS do_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_do_next_done ON do_next(done, due_date);

-- NOVA flagged tickets ("Nick, look at this") — mirror of NOVA's risk scorer,
-- pushed in via POST /api/nova-signals. NOVA is source of truth; each push
-- replaces the whole active set, so resolved/reviewed tickets drop off.
CREATE TABLE IF NOT EXISTS nova_flags (
  ticket_key TEXT PRIMARY KEY,
  risk_score INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  why TEXT,
  summary TEXT,
  assignee TEXT,
  ticket_status TEXT,
  reasons TEXT,
  flagged_at DATETIME,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_summary (
  date_key TEXT PRIMARY KEY,
  standup_done INTEGER DEFAULT 0,
  standup_hour INTEGER,
  standup_snooze_count INTEGER DEFAULT 0,
  todo_snooze_count INTEGER DEFAULT 0,
  eod_done INTEGER DEFAULT 0,
  captures_count INTEGER DEFAULT 0,
  chat_count INTEGER DEFAULT 0,
  chat_topics TEXT,
  tabs_opened TEXT,
  summary_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- SARA Action Suggestions (Phase 5A)
CREATE TABLE IF NOT EXISTS sara_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  focus_item_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_sara_actions_status ON sara_actions(status);
-- #107(b) — the scoped dedupe reads filter on type and on the payload's
-- sourcePath, and both were falling back to a full scan of 16k rows.
CREATE INDEX IF NOT EXISTS idx_sara_actions_type ON sara_actions(type);
CREATE INDEX IF NOT EXISTS idx_sara_actions_source_path
  ON sara_actions(json_extract(payload, '$.sourcePath'));

-- Location visit history (Phase 5)
CREATE TABLE IF NOT EXISTS location_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key TEXT NOT NULL,
  place_name TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  arrival TEXT NOT NULL,
  departure TEXT,
  duration_minutes INTEGER DEFAULT 0,
  source TEXT DEFAULT 'owntracks',
  place_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_location_visits_date ON location_visits(date_key);
CREATE INDEX IF NOT EXISTS idx_location_visits_place ON location_visits(place_name);

-- MoSCoW task prioritisation (Phase 6A)
CREATE TABLE IF NOT EXISTS task_moscow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT UNIQUE NOT NULL,
  moscow TEXT NOT NULL CHECK(moscow IN ('must', 'should', 'could', 'wont')),
  task_text TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_moscow_key ON task_moscow(task_key);
CREATE INDEX IF NOT EXISTS idx_task_moscow_priority ON task_moscow(moscow);

-- Tasks — NEURO is the source of truth (13 Aug 2026 migration).
-- Before this, task metadata lived in three places at once: a triage worksheet,
-- task_moscow, and vault markdown. This table is the one store; the vault gets a
-- regenerated read-only export note instead (see services/task-export.js).
-- priority is 1-3 as Nick uses it: 3 = most pressing, 1 = least. Not the
-- high/normal/low string the vault parser produces — that is derived on read.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in-progress', 'done', 'dropped')),
  moscow TEXT CHECK(moscow IS NULL OR moscow IN ('must', 'should', 'could', 'wont')),
  -- 1 = the bucket is a proposal, not a decision. The 12 Aug triage worksheet marked
  -- inferred buckets with a trailing `?`; importing those as decided would invent
  -- calls Nick never made, so they carry the flag and stay in the review queue.
  moscow_proposed INTEGER NOT NULL DEFAULT 0,
  priority INTEGER CHECK(priority IS NULL OR priority BETWEEN 1 AND 3),
  due_date TEXT,
  -- Where it came from: master-todo-import | capture | watch | obsidian-capture |
  -- meeting-promotion | chat | mcp | manual
  source TEXT NOT NULL DEFAULT 'manual',
  -- Provenance backlink into the vault (relative path), so a task can always be
  -- traced to the note that produced it.
  origin_path TEXT,
  origin_line INTEGER,
  context TEXT,
  notes TEXT,
  ms_id TEXT,
  -- Roughly how long this takes, in minutes. NULL means NOT ESTIMATED, and is
  -- deliberately distinguishable from a small number: "what fits before my next
  -- meeting" has to be able to say which answers it is assuming rather than
  -- quietly treating an unknown as thirty minutes.
  estimate_minutes INTEGER,
  -- Normalised text. UNIQUE so re-running the importer or draining the same
  -- capture line twice cannot create a duplicate.
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_moscow ON tasks(moscow);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);

-- Apple Health time series. One row per (metric, sample time), because a stress
-- score is only meaningful against a rolling PERSONAL baseline — an absolute HRV
-- of 45ms is good for one person and poor for another. The daily KV rows in
-- agent_state (health_data_<date>) are left alone and still back /today and
-- /history; this table is additive.
-- UNIQUE(metric, recorded_at) makes ingest idempotent: a 30-minute poll that
-- re-sends the same watch sample folds instead of duplicating and skewing the
-- baseline.
CREATE TABLE IF NOT EXISTS health_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  -- When the WATCH took the reading, not when we received it. At a 30-minute
  -- poll these differ by up to half an hour, which matters for ordering.
  recorded_at DATETIME NOT NULL,
  source TEXT NOT NULL DEFAULT 'ingest',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(metric, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_health_samples_metric_time ON health_samples(metric, recorded_at DESC);

-- Host/infrastructure metrics: Pi 5, Pi 4, router, broadband.
--
-- Deliberately NOT health_samples: that table is Apple Health data, and its
-- UNIQUE(metric, recorded_at) has no source column — pi5's temp_c and pi4's
-- temp_c at the same second would collide and silently drop one.
--
-- Collection stays in cron-written CSVs so it survives the backend being down
-- (which is exactly when a wedged router needs recording). This table is the
-- queryable, retained, backed-up copy the panel reads.
CREATE TABLE IF NOT EXISTS host_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,        -- pi5 | pi4 | router | broadband
  metric TEXT NOT NULL,        -- load_pct | temp_c | down_mbps | ...
  value REAL,
  recorded_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- Makes imports idempotent: re-running the importer over the same CSV rows
  -- cannot duplicate them, which is what allows a safe watermark trim.
  UNIQUE(source, metric, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_host_metrics_lookup ON host_metrics(source, metric, recorded_at DESC);

-- Commitments other people owe Nick, lifted out of meeting notes.
--
-- Was the agent_state KV blob until 15 Aug. Moved because the chasing UI needs
-- to filter, sort and — the deciding one — SNOOZE, which is a per-item date the
-- blob had nowhere to put. The key stays the dedupe key (person::normalised
-- text) so a second sighting folds instead of duplicating, exactly as before.
CREATE TABLE IF NOT EXISTS waiting_on (
  key           TEXT PRIMARY KEY,
  person        TEXT NOT NULL,
  person_full   TEXT,
  text          TEXT NOT NULL,
  source_path   TEXT,
  source_date   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | done | dropped
  asked_at      TEXT,
  chase_count   INTEGER NOT NULL DEFAULT 0,
  -- Dated from the MEETING, not from when the row was written, or a backfill
  -- over four months reports a June commitment as nought days old.
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  sightings     INTEGER NOT NULL DEFAULT 1,
  reopened_at   TEXT,
  resolved_at   TEXT,
  snoozed_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_waiting_on_status ON waiting_on(status, first_seen);
CREATE INDEX IF NOT EXISTS idx_waiting_on_person ON waiting_on(person, status);

-- Replies Nick has sent from triage (#69).
--
-- Before this the send path called dismissEmail(id,'replied') and that was the
-- ENTIRE record — the only evidence a reply happened lived in Outlook's Sent
-- Items. So "I answered that on Tuesday" was not answerable from NEURO, and it
-- was the newest write path in the system and the least observable.
--
-- Denormalised on purpose: subject/from are copied in rather than joined back
-- to the triage blob, because that blob is a rolling cache (~290 entries) and a
-- reply must stay answerable long after the email it answered has rolled out.
CREATE TABLE IF NOT EXISTS sent_replies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id      TEXT NOT NULL,
  subject       TEXT,
  from_name     TEXT,
  from_email    TEXT,
  -- JSON array of {name,email}. On a plain reply/replyAll GRAPH picks the
  -- recipients, not NEURO — so recipients_source records whether this is what
  -- was actually addressed ('explicit') or NEURO's best reading of the thread
  -- ('inferred'). Storing an inferred list as fact is how a record stops being
  -- worth having.
  recipients        TEXT,
  recipients_source TEXT NOT NULL DEFAULT 'unknown',  -- explicit | inferred | unknown
  reply_all     INTEGER NOT NULL DEFAULT 0,
  body          TEXT NOT NULL,
  sent_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sent_replies_sent ON sent_replies(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sent_replies_email ON sent_replies(email_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Management Actions & Conversations Log — PIP competencies 3 and 4.
--
-- Competency 3: every management conversation, concern or action logged within
-- TWO WORKING DAYS, each with an owner and a due date, followed to resolution.
-- Competency 4: the count of OVERDUE management actions, baselined at
-- 27 Jul 2026, to reach zero by the 60-day review (11 Sep 2026) and thereafter
-- nothing overdue by more than five working days.
--
-- The baseline is deliberately NOT a stored number. A hand-agreed integer is
-- unfalsifiable a month later and cannot be recomputed when a row turns out to
-- have been miscounted; derived from due_date and resolved_date it can be
-- re-run against any date and always agrees with the rows underneath it.
--
-- `logged_at` is separate from `entry_date` because the two-working-day rule is
-- a fact about the GAP between them. Collapsing them into one column would make
-- the one thing competency 3 is measured on impossible to evidence.
CREATE TABLE IF NOT EXISTS management_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date    TEXT NOT NULL,              -- when the conversation/concern happened
  logged_at     TEXT NOT NULL,              -- when it was written down (the compliance clock)
  type          TEXT NOT NULL,              -- conversation | concern | action
  person        TEXT,                       -- canonical first name, matching waiting_on
  summary       TEXT NOT NULL,
  action        TEXT,
  owner         TEXT,
  due_date      TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | in-progress | blocked | done
  resolved_date TEXT,
  -- Chris spot-checks People HR, so whether an item also reached People HR is a
  -- distinct fact from whether NEURO knows about it. Never inferred.
  hr_logged     INTEGER NOT NULL DEFAULT 0,
  source        TEXT,                       -- vault path, plaud id, '1-2-1', 'manual'
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mgmt_log_due ON management_log(due_date);
CREATE INDEX IF NOT EXISTS idx_mgmt_log_status ON management_log(status);
CREATE INDEX IF NOT EXISTS idx_mgmt_log_entry ON management_log(entry_date DESC);
