CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_conv_id
  ON conversations(conversation_id, created_at DESC);

-- ⚠ DEAD as of 27 Aug 2026. The Jira queue feature was removed on 3 July 2026
-- (48e6481, "too much noise") and the readers that had been reintroduced against
-- the rows it left behind were removed on 27 Aug — see the note in
-- db/database.js. Nothing reads or writes this table.
--
-- Left defined and empty deliberately, following `inbox_items`: dropping it is a
-- destructive migration that buys nothing, and the twelve rows still in it are
-- the only surviving evidence of what the queue looked like on 3 July.
-- Escalations never used this table and are unaffected.
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
  -- 1 = has attendees other than Nick, 0 = solo block, NULL = we could not tell.
  -- NULL is a real answer and must never be read as 0: the NOVA bridge supplies
  -- no attendee list, and with no signed-in address Nick's own entry cannot be
  -- told from anyone else's. See calendar-sync + plaud-admin-blocks.attendeesOther.
  attendees_other INTEGER,
  -- Which calendar this row came from: 'graph' (work, via MSAL or the NOVA
  -- bridge), 'apple' (pushed from the phone by Scriptable), 'ics'.
  --
  -- ⚠ Load-bearing for DELETES, not just for display. calendar-sync is
  -- replace-by-window and runs every few minutes; before this column it emptied
  -- the WHOLE table, so a second calendar's events would be silently wiped
  -- within minutes of arriving. clearCalendarCache now requires a source.
  source TEXT NOT NULL DEFAULT 'graph',
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- ⚠ The index on `source` is NOT here. This whole file is executed by an
-- unguarded db.exec() BEFORE any migration runs, and `CREATE TABLE IF NOT
-- EXISTS` is a no-op against the live table — so on an existing database the
-- column does not exist yet at this point, and an index naming it throws and
-- takes db.init() down with it. The backend then does not start at all.
-- It is created in the migration block instead, after the ALTER. See database.js.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Every notification NEURO decided to send, and what became of it.
--
-- Until this existed the only record was console.log, so "why didn't I get the
-- 5pm nudge?" was unanswerable once the pm2 log rolled — and two paths in
-- sendToAll returned SILENTLY (no subscriptions, VAPID not configured), which
-- is indistinguishable from a quiet day. Same species as the frozen Jira cache:
-- a system that has stopped delivering looks exactly like one with nothing to say.
--
-- `outcome` is one of: sent | suppressed | failed | undeliverable.
-- `reason` carries the governor's verdict or the transport error.
CREATE TABLE IF NOT EXISTS push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  type TEXT,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_log_created ON push_log(created_at DESC);

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

-- RETIRED 26 Aug 2026. Written by nothing since `inbox-scanner.js` was removed:
-- it was a second inbox triage nothing reconciled with the one the panel shows,
-- and with no dismiss path reaching it, it only grew. Inbox state now lives in
-- `agent_state.email_triage`. Kept (empty) rather than dropped — the definition
-- is harmless and the history is not worth a destructive migration.
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

-- One row per cloud AI call (26 Aug 2026). Before this the only record was a
-- single "tokens today" counter that reset at midnight, so "what did last week
-- cost" and "which task is spending it" were unanswerable. Rows, not daily
-- rollups: a few hundred a day is nothing, and the rollups are queries.
-- cost_usd is NULL when the model is unpriced or the tokens were never
-- reported -- never 0, which would read as free.
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  task_type TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_usd REAL,
  cost_source TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_date ON ai_calls(date_key);
CREATE INDEX IF NOT EXISTS idx_ai_calls_task ON ai_calls(date_key, task_type);

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

-- Raw position points pushed BY a device, rather than polled FROM a recorder.
--
-- The OwnTracks path reads points out of the Recorder's HTTP API, so NEURO never
-- owned a point. A native iOS app has nowhere to put one, which is why this
-- table exists: it is the store `location.getTodayPoints()` range-queries when
-- the phone is the source. Shape deliberately MATCHES the OwnTracks point
-- (`lat`, `lon`, `tst`) so the clustering in `services/location.js` needs no
-- second code path — see the mapping in `services/location-points.js`.
--
-- ⚠ `tst` is unix SECONDS, not milliseconds, because that is what OwnTracks
-- emits and what `clusterPoints()` subtracts to get a duration. A device sending
-- milliseconds makes every dwell ~1000x too long, which passes the 20-minute
-- floor trivially and turns a drive-past into a working day.
--
-- UNIQUE(device_id, tst) is what makes the ingest idempotent: the phone keeps an
-- offline queue and WILL re-send a batch it never saw acknowledged, so a replay
-- has to fold rather than double-count.
CREATE TABLE IF NOT EXISTS location_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  tst INTEGER NOT NULL,
  accuracy REAL,
  source TEXT NOT NULL DEFAULT 'ios',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_id, tst)
);

-- Range queries by time are the only read pattern (`getTodayPoints`), and the
-- staleness check reads the newest row regardless of device.
CREATE INDEX IF NOT EXISTS idx_location_points_tst ON location_points(tst);
CREATE INDEX IF NOT EXISTS idx_location_points_device ON location_points(device_id, tst);

-- What a device says about ITSELF — battery, motion, connectivity, focus.
--
-- Everything here is currently read out of Home Assistant's iOS Companion app
-- (`services/ha.js getPhoneStatus`), which means NEURO's picture of what Nick is
-- physically doing depends on a third-party app relaying sensors the phone
-- already owns. A native app reports them directly; HA is then kept for
-- smart-home ACTUATION, which is the only thing it is uniquely able to do.
--
-- ⚠ ONE ROW PER DEVICE, not a history. This is current state — "what is the
-- phone doing now" — and the questions asked of it (is he moving, is he
-- driving, is the phone dead) are all about the present. Motion HISTORY, if it
-- is ever wanted, is a different table with a different shape; overloading this
-- one would make every read a "latest per device" subquery.
--
-- ⚠ `reported_at` is when the DEVICE observed the state, `received_at` when the
-- Pi was told. They differ by however long the phone was off the tailnet, and
-- conflating them makes a queued report look current. The write is guarded on
-- `reported_at` moving FORWARD — an offline queue can deliver an old report
-- after a new one, and last-write-wins would then rewind the phone's state.
CREATE TABLE IF NOT EXISTS device_status (
  device_id TEXT PRIMARY KEY,
  reported_at TEXT NOT NULL,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  battery_level REAL,
  battery_state TEXT,
  connection_type TEXT,
  ssid TEXT,
  geocoded_location TEXT,
  activity TEXT,
  activity_since TEXT,
  steps INTEGER,
  distance_m REAL,
  floors_ascended INTEGER,
  focus_mode INTEGER,
  -- The raw report, so a sensor the app learns to send before NEURO learns to
  -- model it is kept rather than dropped on the floor.
  payload TEXT
);

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
  -- Which part of Nick's life this belongs to: 'work' or 'personal'.
  -- NOT the same axis as `context` above, which is derived by todo-intelligence
  -- and holds a KIND OF WORK (queue, customer, admin). A task can be personal
  -- admin; the two are orthogonal and conflating them would make the domain
  -- unreadable the moment the classifier changed its mind.
  -- Defaults to 'work' because that is true of every row that existed when the
  -- column was added, and because the two mistakes are asymmetric — see
  -- shared/task-domain.cjs for why unknown fails towards the visible one.
  domain TEXT NOT NULL DEFAULT 'work' CHECK(domain IN ('work', 'personal')),
  notes TEXT,
  -- Whose idea was this: 'commitment' (somebody else asked, or is waiting on it)
  -- or 'improvement' (Nick's own). NULL means NOT YET CLASSIFIED and is a real,
  -- reported state — deliberately NOT defaulted, unlike `domain` above. The two
  -- mistakes point in opposite directions and both are expensive in a report
  -- read by the person assessing a PIP: guessing 'commitment' manufactures
  -- broken promises out of Nick's own stretch goals, guessing 'improvement'
  -- hides a real one. See shared/task-origin.cjs.
  origin TEXT CHECK(origin IS NULL OR origin IN ('commitment', 'improvement')),
  -- 1 = inferred from provenance, not a call Nick has made. Same contract as
  -- moscow_proposed: a proposal is shown with a '?' and never counted as a
  -- decision he made.
  origin_proposed INTEGER NOT NULL DEFAULT 0,
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
-- of 45ms is good for one person and poor for another.
--
-- ⚠ This is now the ONLY store. It used to sit beside a daily KV blob in
-- agent_state (health_data_<date>) written by POST /api/health/ingest, and that
-- pairing failed in the way this codebase keeps finding: the phone moved to the
-- FreeReps app, which posts to /api/v1/ingest/ and writes samples ONLY, so the
-- blob stopped being written and every reader of it (chat context, journal
-- context, /today, /history, /status) silently returned null for months. A null
-- reads as "no data yet", not as "the writer is gone". One writer now.
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

-- One row per day, derived from health_samples.
--
-- health_samples holds ~1.1M rows across 66 metrics and two years, which is the
-- right shape for a rolling HRV baseline and the wrong shape for every other
-- question: "how does a normal Tuesday look", "was last night short", "has
-- resting heart rate been climbing" all mean scanning hundreds of thousands of
-- rows per read. Nothing outside the desktop HealthCard ever asked, and this is
-- why.
--
-- MATERIALISED rather than derived on read, following `wins`: several consumers
-- want to JOIN against a day (blocks, wins, focus sessions), and a join against
-- a subquery over a million rows is not a thing to put on the planner's path at
-- 07:15.
--
-- ⚠ `complete` is the load-bearing column. A day is recomputed for as long as it
-- is still in the trailing window, because today's row is a PARTIAL day — half
-- its steps have not happened yet. A consumer averaging today's row in with
-- finished days silently drags every average down; `complete = 0` is how it
-- knows not to.
CREATE TABLE IF NOT EXISTS health_daily (
  day TEXT PRIMARY KEY,              -- YYYY-MM-DD, local-ish (see health-daily.js)
  -- Sleep, keyed on the night you WOKE on — apple-health.rollupSleepNights owns
  -- that rule and this table stores its answer rather than re-deriving it.
  asleep_hours REAL,
  sleep_source TEXT,                 -- staged | unspecified | none
  deep_hours REAL,
  rem_hours REAL,
  core_hours REAL,
  awake_hours REAL,
  sleep_efficiency REAL,
  -- Medians, not means: HRV is noisy and log-normal, and one 12ms reading during
  -- a difficult call should not move the day. Same call stress-score makes.
  hrv_median REAL,
  hrv_samples INTEGER,
  rhr_median REAL,
  -- Sums for the counters, averages for the rates.
  steps REAL,
  active_energy REAL,
  exercise_minutes REAL,
  stand_minutes REAL,
  daylight_minutes REAL,
  respiratory_rate REAL,
  wrist_temp REAL,
  spo2 REAL,
  weight_kg REAL,
  complete INTEGER NOT NULL DEFAULT 0,
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
  --
  -- THREE states, and the third is the point: NULL = not asked, 0 = confirmed
  -- NOT in People HR, 1 = confirmed in. The first cut was a NOT NULL boolean
  -- defaulting to 0, which made "we never asked" indistinguishable from "it is
  -- missing" — so the seeded batch reported three People HR gaps that had never
  -- been measured, in a report going to the manager who spot-checks People HR.
  -- Same lesson as state-of-play's `never` vs `stale`: unknown is not broken.
  hr_logged     INTEGER,
  source        TEXT,                       -- vault path, plaud id, '1-2-1', 'manual'
  -- The task this action is mirrored into, when it is something Nick has to DO.
  -- The log is the compliance record; the task store is where work is looked
  -- for. A management action that lives only here is one nobody sees, which is
  -- exactly how the first seeded batch produced three overdue items that could
  -- not be found in Tasks, Focus or on the phone.
  task_id       INTEGER,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mgmt_log_due ON management_log(due_date);
CREATE INDEX IF NOT EXISTS idx_mgmt_log_status ON management_log(status);
CREATE INDEX IF NOT EXISTS idx_mgmt_log_entry ON management_log(entry_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Overtime approvals — PIP competency 1.
--
-- The finding was that overtime was approved on headline indicators (ticket
-- counts, activity status) without cross-checking logged work, and that Working
-- Time Regulation limits were not considered at the point of approval. The plan
-- requires that from 27 Jul 2026 EVERY approval follows the five-step checklist
-- in Section 8 of the WTR briefing, each check recorded, with the line manager
-- auditing a sample at the 30/60/90-day checkpoints.
--
-- So this table is the checklist, one column per step, not a notes field. A free
-- text box would let an approval be recorded without the checks being done,
-- which is precisely the behaviour being corrected. `approved_at` cannot be set
-- while any step is unanswered — enforced in the service, because the point is
-- to make the evidence a by-product of approving rather than a thing to remember
-- afterwards.
--
-- THREE states per check, as with management_log.hr_logged: NULL = not done,
-- 0 = done and FAILED, 1 = done and passed. A boolean defaulting to 0 would make
-- "not yet checked" indistinguishable from "checked and found in breach", and
-- this record is the one Chris audits.
CREATE TABLE IF NOT EXISTS overtime_approvals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  person          TEXT NOT NULL,             -- who worked it
  work_date       TEXT NOT NULL,             -- the date worked (not the claim date)
  hours           REAL NOT NULL,
  reason          TEXT,                      -- why it was needed
  requested_at    TEXT NOT NULL,             -- when the claim reached Nick
  logged_at       TEXT NOT NULL,             -- when it was written down here

  -- Step 1: verified against Jira/NOVA systems activity.
  chk_activity        INTEGER,
  chk_activity_note   TEXT,                  -- the evidence: tickets touched, solved, comments
  -- Step 2: cumulative hours checked against the 48-hour rolling 17-week average.
  chk_48h             INTEGER,
  rolling_avg_hours   REAL,                  -- computed at approval time and KEPT
  -- Step 3: valid signed opt-out confirmed, where the average would be exceeded.
  chk_optout          INTEGER,
  -- Step 4: rest entitlements checked (11h daily, 24h weekly).
  chk_rest            INTEGER,
  -- Step 5: the check recorded. Set when the other four are answered.
  chk_recorded        INTEGER,

  outcome         TEXT,                      -- approved | declined | pending
  approved_by     TEXT,
  approved_at     TEXT,                      -- NULL until all five steps answered
  declined_reason TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_overtime_person_date ON overtime_approvals(person, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_overtime_outcome ON overtime_approvals(outcome);
CREATE INDEX IF NOT EXISTS idx_overtime_work_date ON overtime_approvals(work_date DESC);

-- Contracted weekly hours, needed to turn recorded overtime into a 48-hour
-- rolling average. Without it the average is computable only if you assume a
-- standard week, and assuming is the habit this whole table exists to replace.
CREATE TABLE IF NOT EXISTS working_time_profile (
  person            TEXT PRIMARY KEY,
  contracted_hours  REAL NOT NULL,
  -- NULL = never asked. A missing opt-out is not the same as a refused one, and
  -- step 3 has to be able to say which.
  optout_signed     INTEGER,
  optout_date       TEXT,
  notes             TEXT,
  updated_at        TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Wins — the derived ledger of finished work.
--
-- Measured before building: over 30 days NEURO recorded FOUR completions,
-- against 271 commits, 57 executed SARA actions and a full diary. The Momentum
-- card on the Today tab read 0 with no streak on every one of the nine visits
-- it got. The reward surface existed and was starved, because the only thing
-- feeding it was self-report — a tickbox — and self-report is the first thing
-- avoidance eats.
--
-- So a win is DETECTED, not declared. Same rule the rest of the system already
-- follows: who reports to Nick is READ not typed, 1-2-1s are detected not
-- declared, the tracker is generated. This was the last hand-typed ledger.
--
-- Rows are materialised rather than derived on read, following sent_replies:
-- several sources are ROLLING caches (calendar_cache, the triage blob) that
-- lose their own history, and a counter that shrinks when a cache rolls is
-- worse than no counter. Materialising also makes the feed scrollable, which
-- is half of why `git log` feels good.
--
-- dedupe_key is UNIQUE so sync() is idempotent: it runs hourly, on startup and
-- over a backfill range, and a second sighting of the same commit or action
-- folds rather than inflating the count. Getting that wrong would make the
-- number climb on its own, which destroys the only property that matters here
-- — that the number is TRUE.
CREATE TABLE IF NOT EXISTS wins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Local date the work happened, never toISOString() (the Pi may run UTC).
  date_key     TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  source       TEXT NOT NULL,   -- git | action | reply | task | ritual | decision | one-to-one | manual
  kind         TEXT NOT NULL,   -- finer label within a source, e.g. 'reply_email'
  text         TEXT NOT NULL,
  -- What proves it: a commit sha, a sara_action id, a task id, a note path.
  -- A win with no evidence is an assertion, and an assertion is what the old
  -- tickbox already was. 'manual' is the one source allowed a null here.
  evidence     TEXT,
  -- Commits fold to one row per repo per day and carry the count, so git can
  -- never dominate the feed the way one long transcript once dominated search.
  count        INTEGER NOT NULL DEFAULT 1,
  dedupe_key   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wins_date ON wins(date_key DESC);
CREATE INDEX IF NOT EXISTS idx_wins_occurred ON wins(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_wins_source ON wins(source);

-- ── Task blocks — tasks pushed into the O365 calendar (18 Aug 2026) ──────────
--
-- Nick's rule, carried over from meetings: a block in the diary is a PLAN, not
-- finished work. `meeting-notes-source` will not count a meeting until the Plaud
-- note lands, because the note is what proves both that he was there and that
-- the meeting was processed. A time block has exactly the same hole and no Plaud
-- recording to close it — nobody records a solo work block — so the evidence is
-- an outcome note Nick writes.
--
-- **A block holds MANY tasks.** The first cut keyed the block on a single
-- task_id, and that is wrong for the way the work actually arrives: several
-- five-minute jobs belong in one thirty-minute window, and the whole point of
-- batching them is that they produce ONE write-up between them. Four separate
-- notes for one sitting is friction that would kill the feature. So the block is
-- the unit and `task_block_items` is the membership.
--
-- The window is chosen independently of what is in it — a 30-minute block may
-- hold 20 minutes of work, deliberately. Nothing here forces them to agree.
--
-- status:
--   scheduled        the block exists; nothing has been claimed about it yet
--   awaiting-writeup at least one member task has been ticked — HELD
--   complete         a real outcome note landed
--   released         closed with no note, by an explicit decision + a reason
--   dropped          the block was abandoned
CREATE TABLE IF NOT EXISTS task_blocks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL only when the Graph create failed; the row is still written so the
  -- stub note and the failure are both traceable rather than silently lost.
  event_id        TEXT,
  event_web_link  TEXT,
  -- Local date/time, never toISOString() — the Pi may run UTC.
  date_key        TEXT NOT NULL,
  start_time      TEXT NOT NULL,   -- HH:MM
  end_time        TEXT NOT NULL,   -- HH:MM
  -- Length of the WINDOW, which is a decision about the diary, not a sum of the
  -- estimates inside it.
  minutes         INTEGER NOT NULL,
  -- 1 when the length came from time-fit's ASSUMED_MINUTES rather than from an
  -- estimate or an explicit choice. Carried to the screen, same rule as #87: a
  -- guess presented as a measurement is the answer you stop trusting.
  minutes_assumed INTEGER NOT NULL DEFAULT 0,
  -- Vault-relative path of the outcome stub. One per BLOCK, not per task.
  note_path       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK(status IN ('scheduled','awaiting-writeup','complete','released','dropped')),
  release_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);

-- Which tasks are in the block.
--
-- `allotted_minutes` is what the task was given INSIDE the window — the number
-- Nick judged when he packed it. It is written back to `tasks.estimate_minutes`
-- (snapped to the coarse buckets) because that judgement is exactly the estimate
-- the task never had: 0 of 154 open tasks carried one, and asking for estimates
-- up front is how the priority field ended up 18% populated. Asking at the
-- moment he is already thinking about duration is the only version that gets
-- answered.
--
-- `awaiting` records that THIS task's completion was held — the tick happened.
-- It is per item, not per block, because a batch of four routinely finishes
-- three: the write-up releases the hold on all of them, but only the ones
-- actually ticked are completed. Auto-completing the rest would mark work done
-- that nobody did, which is the exact thing "a win is detected, not declared"
-- exists to stop.
CREATE TABLE IF NOT EXISTS task_block_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id         INTEGER NOT NULL,
  task_id          INTEGER NOT NULL,
  allotted_minutes INTEGER,
  awaiting         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  UNIQUE(block_id, task_id)
);

-- The idempotency guard, checked BEFORE the Graph create — by the time Graph has
-- answered, a double-click has already made the duplicate. Keyed on the slot
-- rather than the event id, which does not exist yet at that point. Deleting the
-- block in Outlook is a DECISION: nothing rescans the calendar to recreate it,
-- the same call plaud-admin-blocks made and for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_blocks_slot ON task_blocks(date_key, start_time);
CREATE INDEX IF NOT EXISTS idx_task_blocks_status ON task_blocks(status);
CREATE INDEX IF NOT EXISTS idx_task_block_items_task ON task_block_items(task_id);
CREATE INDEX IF NOT EXISTS idx_task_block_items_block ON task_block_items(block_id);

-- ── Mobile outbox ledger (Phase 2) ───────────────────────────────────────────
--
-- Every operation the phone sends, recorded ONCE, keyed on the id the DEVICE
-- generated. This is the whole idempotency story: NEURO owns the canonical
-- record, and the device owns the identity of the intent that created it.
--
-- ⚠ `status` has four values and keeping them apart is the point:
--   applied         — the canonical record exists; `canonical_id` names it.
--   failed          — nothing was written; a replay is SAFE and expected.
--   rejected        — the operation was refused (unknown kind, bad payload).
--                     A replay changes nothing; the device must stop retrying.
--   pending         — a row written immediately before the work started, which
--                     can only survive a crash MID-APPLY. It is never replayed:
--                     a note may or may not have landed and re-applying would
--                     duplicate it, so it is reported as needing attention and
--                     the device keeps its copy. Local intent is preserved and
--                     nothing is silently overwritten or discarded.
--
-- The applier is fully SYNCHRONOUS between the ledger read and the write, so in
-- a single Node process better-sqlite3 makes this a real mutex — two concurrent
-- replays of one operationId cannot both see "not there yet". That is only true
-- in-process (`plaud-admin-blocks`' rule), which is where it runs.
--
-- Deliberately NO capture text is stored here: the payload lives in the vault or
-- the tasks table, which are the canonical homes for it. A second copy in a
-- ledger is a second store, and SARA/mobile stores nothing.
CREATE TABLE IF NOT EXISTS mobile_sync_operations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL,
  operation_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  client_schema TEXT,
  created_at    TEXT,            -- when the DEVICE made it (may be offline-old)
  received_at   TEXT NOT NULL,   -- when NEURO first saw it
  settled_at    TEXT,
  status        TEXT NOT NULL,
  canonical_id  TEXT,
  detail        TEXT,
  UNIQUE(device_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_mobile_sync_status ON mobile_sync_operations(status);
CREATE INDEX IF NOT EXISTS idx_mobile_sync_device ON mobile_sync_operations(device_id, received_at);

-- ── Attention records (Phase 3, Gate 1 — 30 Aug 2026) ───────────────────────
--
-- The durable identity of a surfaced thing. Full contract in
-- `docs/attention-contract.md`.
--
-- Before this, an attention item lived for exactly one HTTP request:
-- decision-engine recomputed the pool on every call and the answer was rendered
-- and thrown away. So nothing could be ACKNOWLEDGED (the only durable state was
-- a suppression timer, which cannot tell "I have seen this" from "hide it for
-- 30 minutes" from "this is finished"), and a notification had no idea what it
-- was about — the governor deduped on a fingerprint of the TEXT, so a meeting
-- alert counting down produced a new fingerprint each time and passed cleanly.
--
-- ⚠ `dedupe_key` is the identity of the THING, not the engine's item id. Engine
-- ids are unstable by construction: `collectOverdueTodos` emits
-- `todo-overdue-top` for one overdue task and `todo-overdue-summary` for two, so
-- a dismissal recorded against one silently stopped applying the moment a second
-- task went overdue.
--
-- ⚠ Terminal states (resolved / expired / suppressed) NEVER re-match. If the
-- same dedupe_key appears again a NEW record is opened — which is what makes a
-- daily recurrence work without the key carrying a date, and what stops
-- yesterday's dismissal silencing today's standup.
--
-- `evidence` is never invented: an item with nothing citable stores `[]`, and
-- the notification gate refuses to interrupt on it. Surfacing without evidence
-- is fine (hiding real work on a bookkeeping failure is the worse error);
-- interrupting without it is not.
CREATE TABLE IF NOT EXISTS attention_records (
  id                TEXT PRIMARY KEY,
  dedupe_key        TEXT NOT NULL,
  type              TEXT NOT NULL,
  state             TEXT NOT NULL,   -- active|acknowledged|deferred|suppressed|resolved|expired
  title             TEXT,
  say               TEXT,
  reason            TEXT,
  tab               TEXT,
  urgency           TEXT,
  tier              INTEGER,
  score             INTEGER,
  domain            TEXT,            -- work|personal|null, from the item's meta
  operational       INTEGER NOT NULL DEFAULT 0,  -- opened by a raw push, not the pool
  confidence        TEXT,            -- JSON {level, why}
  evidence          TEXT,            -- JSON [{source, ref, observedAt, detail}]
  actions           TEXT,            -- JSON [action ids]
  meta              TEXT,            -- JSON, the engine's own meta
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  surfaced_at       TEXT,
  notified_at       TEXT,
  notify_signature  TEXT,            -- urgency|tier when it last interrupted
  state_changed_at  TEXT NOT NULL,
  defer_until       TEXT,
  defer_reason      TEXT,
  resolution        TEXT             -- why it left: acted|gone|aged-out|dismissed
);
CREATE INDEX IF NOT EXISTS idx_attention_open ON attention_records(state, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_attention_seen ON attention_records(last_seen_at DESC);

-- The audit trail. "Recent notifications/attention history with the reason each
-- was surfaced" is a required control surface, and a state column alone cannot
-- answer it — it holds only the latest value, so a card deferred three times
-- looks identical to one deferred once.
CREATE TABLE IF NOT EXISTS attention_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  TEXT NOT NULL,
  at         TEXT NOT NULL,
  event      TEXT NOT NULL,   -- opened|surfaced|notified|acknowledged|deferred|dismissed|resolved|expired|notify-refused
  detail     TEXT,
  FOREIGN KEY (record_id) REFERENCES attention_records(id)
);
CREATE INDEX IF NOT EXISTS idx_attention_events_record ON attention_events(record_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_attention_events_at ON attention_events(at DESC);

-- What the desktop agent saw, rolled up per day per machine.
--
-- The live samples are a ~13-hour ring buffer in agent_state by design: "what is
-- he doing lately" is disposable state. That leaves no history at all, which is
-- the whole reason RescueTime looked like the better option until its coverage
-- was measured (9 blind weekdays in three months, 0.16h logged against 8.21h
-- actually worked). This is the durable half. Same shape as health_daily:
-- materialised rather than derived on read, because the samples it is built from
-- age out of the ring within the day.
--
-- ONE ROW PER (day, host). Deliberately not merged across machines: summing two
-- hosts double-counts an hour spent switching between them, and the raw samples
-- needed to take a union are gone by the time anyone asks.
CREATE TABLE IF NOT EXISTS desktop_daily (
  day             TEXT NOT NULL,     -- YYYY-MM-DD, LOCAL (never toISOString)
  host            TEXT NOT NULL,
  -- present = active + idle + locked, by construction. Intervals longer than the
  -- agent's reporting gap are NOT counted: a machine asleep for an hour was not
  -- an hour at the desk.
  present_minutes REAL,
  active_minutes  REAL,
  idle_minutes    REAL,
  locked_minutes  REAL,
  apps            TEXT,              -- JSON { app: minutes }, active time only
  top_app         TEXT,
  top_app_minutes REAL,
  longest_run_minutes REAL,          -- longest unbroken stretch in ONE app
  first_at        TEXT,
  last_at         TEXT,
  sample_count    INTEGER NOT NULL DEFAULT 0,
  -- The DAY is over. Says nothing about whether the agent was running for all of
  -- it — that is what sample_count and first/last_at are for.
  complete        INTEGER NOT NULL DEFAULT 0,
  computed_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, host)
);
CREATE INDEX IF NOT EXISTS idx_desktop_daily_day ON desktop_daily(day DESC);

-- RescueTime, kept as a second opinion that desktop_daily audits.
--
-- ⚠ NO PRODUCTIVITY PULSE, by design. Measured r = -0.96 against meeting count:
-- it is a coding-vs-meetings ratio, and NEURO already derives both halves from
-- git and the calendar. Storing it would add a number that looks like insight
-- and carries none.
--
-- ⚠ `domains` holds BARE HOSTNAMES only. RescueTime's activity rows carry query
-- strings and OAuth parameters verbatim, and its account holds full window
-- titles; services/rescuetime.js cuts every value to a hostname before it gets
-- here, and restrict_kind=document is never requested.
--
-- The day key is RescueTime's OWN, in the account's timezone, used verbatim.
CREATE TABLE IF NOT EXISTS rescuetime_daily (
  day           TEXT PRIMARY KEY,
  total_minutes REAL,
  categories    TEXT,            -- JSON { category: minutes }
  domains       TEXT,            -- JSON { hostname: minutes }
  top_category  TEXT,
  complete      INTEGER NOT NULL DEFAULT 0,
  fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
