const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

let embeddingsService = null;
function getEmbeddingsService() {
  if (!embeddingsService) {
    try { embeddingsService = require('./embeddings'); }
    catch { embeddingsService = null; }
  }
  return embeddingsService;
}

function getVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

function isConfigured() {
  const vaultPath = getVaultPath();
  return vaultPath && fs.existsSync(vaultPath);
}

/**
 * The vault root, or a loud refusal.
 *
 * ⚠ `getVaultPath()` returns `''` when unset, and `path.join('', 'Daily')` is
 * RELATIVE — so every writer that resolves a path from the root used to create
 * its folder wherever the process happened to be running, write a real note
 * into it, and report success. On a dev box that is inside the repo; `Daily/`
 * and a `STANDUP.md` both turned up in the checkout that way. It is the capture
 * drop-box bug (`path.join('', 'Tasks', 'Capture.md')`), and it has now been
 * found in three separate writers, which is the argument for one accessor
 * rather than six guards.
 *
 * It THROWS rather than returning null: these callers are about to write, and
 * the failure has to be loud. Readers keep using `getVaultPath()` — an empty
 * path simply fails `existsSync` and reads as "no vault", which is correct.
 */
function requireVaultPath() {
  const vaultPath = getVaultPath();
  if (!vaultPath) throw new Error('OBSIDIAN_VAULT_PATH is not configured — refusing to write outside the vault');
  return vaultPath;
}

function todayDateString() {
  const d = new Date();
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// The `### ` heading `syncMicrosoftTasks` writes over Microsoft tasks whose plan
// or list could not be read, and which `parseVaultTodos` reads back as null.
// Written and parsed in one place so the two halves cannot drift — a heading the
// parser did not recognise would arrive on a card as a literal plan name.
const PLAN_UNKNOWN_HEADING = '(plan unknown)';

// How often a Microsoft task recurs, carried onto its mirror line.
//
// ⚠ An HTML COMMENT, never text on the line — `parseTaskLine` strips comments
// out of the display text, so this cannot land in the task's own wording and
// from there in its dedupe key. That is the same rule the plan name follows by
// living in a `### ` heading (17/27 Aug), for the same reason.
//
// Placed BEFORE the `<!--id:-->` comment, which several editors anchor to the
// end of the line (`setTaskPercent`, `setTaskFields`). The token vocabulary is
// `shared/ms-task.cjs`'s, so the writer here and every reader agree by
// construction rather than by two copies staying in step.
function recComment(recurrence) {
  const token = require('../../shared/ms-task.cjs').recurrenceToken(recurrence);
  return token ? ` <!--rec:${token}-->` : '';
}

// Daily notes
function readTodayDailyNote() {
  const notePath = path.join(getVaultPath(), 'Daily', `${todayDateString()}.md`);
  if (!fs.existsSync(notePath)) return null;
  return fs.readFileSync(notePath, 'utf-8');
}

function writeTodayDailyNote(content) {
  const dir = path.join(requireVaultPath(), 'Daily');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const notePath = path.join(dir, `${todayDateString()}.md`);
  fs.writeFileSync(notePath, content, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(notePath, 'daily-note'); } catch {}
  return notePath;
}

function appendToDailyNote(content) {
  // ⚠ An unconfigured vault must REFUSE, not fall back to the working
  // directory. `path.join('', 'Daily')` is RELATIVE, so this used to create a
  // `Daily/` folder wherever the process happened to be running and report
  // success — which on a dev box is inside the repo. That is the capture
  // drop-box bug (`path.join('', 'Tasks', 'Capture.md')`) in a second writer,
  // and it was found the same way: a test appended a daily note and left one
  // in the checkout. Null rather than a throw, because a daily-note append is
  // bookkeeping on the back of real work — losing the note must not fail the
  // thing that caused it.
  // Returns null rather than throwing, unlike its siblings: a daily-note
  // append is bookkeeping on the back of real work, and losing the note must
  // not fail the thing that caused it.
  if (!getVaultPath()) {
    console.warn('[Obsidian] OBSIDIAN_VAULT_PATH is not set — daily note not written');
    return null;
  }
  const dir = path.join(requireVaultPath(), 'Daily');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const notePath = path.join(dir, `${todayDateString()}.md`);
  const existing = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf-8') : '';
  fs.writeFileSync(notePath, existing + '\n' + content, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(notePath, 'daily-append'); } catch {}
  return notePath;
}

// Standup
function readStandup() {
  const vaultPath = getVaultPath();
  // Check multiple possible locations
  const candidates = [
    path.join(vaultPath, 'STANDUP.md'),
    path.join(vaultPath, 'Templates', 'STANDUP.md'),
    path.join(vaultPath, 'Standup.md'),
    path.join(vaultPath, 'Templates', 'Standup.md')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  }
  return null;
}

function writeStandup(content) {
  // Unset, this wrote STANDUP.md into the working directory.
  const vaultPath = requireVaultPath();
  // Write to first found location, or default to root
  const candidates = [
    path.join(vaultPath, 'STANDUP.md'),
    path.join(vaultPath, 'Templates', 'STANDUP.md')
  ];
  let target = candidates[0];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      target = p;
      break;
    }
  }
  fs.writeFileSync(target, content, 'utf-8');
  return target;
}

// People notes
function readPersonNote(name) {
  const notePath = path.join(getVaultPath(), 'People', `${name}.md`);
  if (!fs.existsSync(notePath)) return null;
  return fs.readFileSync(notePath, 'utf-8');
}

// Update a person note: set frontmatter fields and optionally append a dated notes block
function updatePersonNote(name, updates) {
  const notePath = path.join(requireVaultPath(), 'People', `${name}.md`);
  if (!fs.existsSync(notePath)) return null;

  let content = fs.readFileSync(notePath, 'utf-8');

  // Update frontmatter fields
  if (updates.last121 || updates.next121Due !== undefined || updates.booked121 !== undefined ||
      updates.employmentStatus || updates.cadence) {
    if (!content.startsWith('---')) {
      content = `---\n---\n` + content;
    }
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      let fm = content.substring(0, endIdx + 3);
      const rest = content.substring(endIdx + 3);
      const setField = (key, value) => {
        const re = new RegExp(`${key}:.*`);
        if (re.test(fm)) {
          fm = fm.replace(re, `${key}: ${value}`);
        } else {
          fm = fm.replace(/---\s*$/, `${key}: ${value}\n---`);
        }
      };
      if (updates.last121) setField('last-1-2-1', updates.last121);
      // An empty string CLEARS the due date — taking someone off cadence has to
      // remove it, or a stale date keeps them reading as overdue forever.
      if (updates.next121Due !== undefined && updates.next121Due !== null) {
        setField('next-1-2-1-due', updates.next121Due);
      }
      // The date of the 1-2-1 currently IN THE DIARY — deliberately its own
      // field. It used to be written into `next-1-2-1-due`, which meant every
      // booking nagged Nick to make the booking he had just made. Empty string
      // clears it, same convention as above: a booking is spent once the
      // meeting note lands.
      if (updates.booked121 !== undefined && updates.booked121 !== null) {
        setField('1-2-1-booked', updates.booked121);
      }
      if (updates.employmentStatus) setField('employment-status', updates.employmentStatus);
      // `cadence` is what decides whether someone is scheduled at all — `n/a`
      // takes them out of the rota (maternity, long-term sick), so it must be
      // settable, not just the recurring values.
      if (updates.cadence) setField('cadence', updates.cadence);
      content = fm + rest;
    }
  }

  // Append a dated notes block
  if (updates.notes && updates.notes.trim()) {
    const dateStr = todayDateString();
    content += `\n\n## 1-2-1 Notes — ${dateStr}\n${updates.notes.trim()}\n`;
  }

  fs.writeFileSync(notePath, content, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(notePath, 'person-note'); } catch {}
  return notePath;
}

// Find the latest "1-1 {name} Prep.md" note under Meetings/ (any subfolder).
// Files follow the pattern: YYYY-MM-DD \u2013 1-1 {Full Name} Prep.md
function findLatest121Prep(personName) {
  const meetingsDir = path.join(getVaultPath(), 'Meetings');
  if (!fs.existsSync(meetingsDir)) return null;
  const nameLower = personName.toLowerCase();
  const results = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const lower = entry.name.toLowerCase();
      // Match "1-1 {name} prep" or "1-2-1 {name} prep"
      if (!/1-(?:2-)?1 .+ prep\.md$/.test(lower)) continue;
      if (!lower.includes(nameLower)) continue;
      // Extract leading date (YYYY-MM-DD) for sorting
      const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})/);
      const date = match ? match[1] : '0000-00-00';
      results.push({ path: full, filename: entry.name, date });
    }
  };
  walk(meetingsDir, 0);
  if (!results.length) return null;
  results.sort((a, b) => b.date.localeCompare(a.date));
  const latest = results[0];
  const content = fs.readFileSync(latest.path, 'utf-8');
  const relativePath = path.relative(getVaultPath(), latest.path).replace(/\\/g, '/');
  return { path: relativePath, filename: latest.filename, date: latest.date, content };
}

// Write a person note's full raw content (used by the vault note editor)
function writePersonNoteRaw(name, content) {
  const peopleDir = path.join(requireVaultPath(), 'People');
  if (!fs.existsSync(peopleDir)) fs.mkdirSync(peopleDir, { recursive: true });
  const notePath = path.join(peopleDir, `${name}.md`);
  fs.writeFileSync(notePath, content, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(notePath, 'person-note'); } catch {}
  return notePath;
}

function listPeopleNotes() {
  const dir = path.join(getVaultPath(), 'People');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
}

// Decision log
function appendDecision(decisionText) {
  const dir = path.join(requireVaultPath(), 'Decision Log');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'decisions.md');
  const rawEntry = `\n## ${todayDateString()}\n- ${decisionText}\n`;
  const entry = autoLink(rawEntry);
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '# Decision Log\n';
  fs.writeFileSync(logPath, existing + entry, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(logPath, 'decision'); } catch {}
  return logPath;
}

// Parse frontmatter from a note
function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return {};
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return {};
  const fm = content.substring(3, endIdx).trim();
  const result = {};
  for (const line of fm.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

// Extract tags from content
function extractTags(content) {
  if (!content) return [];
  const tagRegex = /#([a-zA-Z0-9_-]+)/g;
  const tags = [];
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    tags.push(match[1]);
  }
  return tags;
}

// Is the DB the sole owner of tasks yet? Set once the import is proven (step 6 of
// the migration) — after that, Master Todo.md is history and stops being parsed.
function masterTodoRetired() {
  try {
    return require('../db/database').getState('tasks.master_todo_retired') === 'true';
  } catch {
    return false;
  }
}

// Vault todo parser — the READER for every task NEURO knows about.
//
// As of the 13 Aug 2026 migration the `tasks` table is the source of truth: DB rows are
// merged in here and win any collision with a vault line, so every existing consumer
// (todos routes, nudges, working memory, briefings) sees them without changing.
// Master Todo.md is still parsed as a fallback until it retires; Microsoft Tasks and
// daily notes stay file-backed because Microsoft and the daily note own that data.
//
// options.dbTasks: false — vault only, which is what the importer needs so it does not
// read its own output back in.
function parseVaultTodos(options = {}) {
  if (!isConfigured()) return { active: [], done: [] };

  const includeDbTasks = options.dbTasks !== false;
  const vaultPath = getVaultPath();
  const allTasks = [];
  const priorityOrder = { high: 0, normal: 1, low: 2 };
  const mergePriority = (existing, fallback) => {
    if (!existing) return fallback || 'normal';
    if (!fallback) return existing;
    return (priorityOrder[existing] ?? 1) <= (priorityOrder[fallback] ?? 1) ? existing : fallback;
  };

  // 1. Parse Master Todo (fallback only — the DB owns tasks; see masterTodoRetired)
  const masterPath = path.join(vaultPath, 'Tasks', 'Master Todo.md');
  if (fs.existsSync(masterPath) && !masterTodoRetired()) {
    const content = fs.readFileSync(masterPath, 'utf-8');
    const lines = content.split('\n');
    let currentPriority = 'normal';
    let currentSection = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Detect section headers for priority mapping
      if (line.startsWith('## ')) {
        if (line.includes('🔴') || line.includes('Now')) { currentPriority = 'high'; currentSection = 'Now'; }
        else if (line.includes('🟡') || line.includes('Soon')) { currentPriority = 'normal'; currentSection = 'Soon'; }
        else if (line.includes('🟢') || line.includes('Later')) { currentPriority = 'low'; currentSection = 'Later'; }
        else if (line.includes('⏸') || line.includes('Waiting')) { currentPriority = 'low'; currentSection = 'Waiting'; }
        else if (line.includes('📥') || line.includes('Inbox')) { currentPriority = 'normal'; currentSection = 'Inbox'; }
        continue;
      }

      const task = parseTaskLine(line);
      if (task) {
        task.priority = mergePriority(task.priority, currentPriority);
        task.source = `Master (${currentSection})`;
        task.filePath = masterPath;
        task.lineNumber = i;
        allTasks.push(task);
      }
    }
  }

  // 2. Parse Microsoft Tasks
  //
  // Microsoft still owns these, so they are file-backed and merged in whole — with
  // one exception. Where Nick has confirmed a Microsoft task and a NEURO task are
  // the same work, the NEURO row holds the ms_id and the Microsoft line is skipped
  // below. Without that, the pair he just reviewed would carry on showing twice,
  // which is the entire complaint. Read once, outside the loop.
  //
  // Only consulted when DB tasks are in play: with `dbTasks: false` the importer is
  // reading the vault alone, and suppressing a line against a row it cannot see
  // would silently drop a task from its input.
  // A MAP, not a Set — it answers "suppress this line" AND "whose row swallowed
  // it", and the second is what lets the surviving card go on naming the
  // Microsoft half it now stands for. Derived live from the mirror rather than
  // copied onto the NEURO row at link time, so a Planner rename shows up on the
  // next sync instead of the card quoting wording nobody uses any more.
  const linkedMs = includeDbTasks
    ? (() => {
        try { return require('./task-dedupe').linkedMsMap(); }
        catch (e) {
          console.error('[Obsidian] Could not read task links:', e.message);
          return new Map();
        }
      })()
    : new Map();
  // taskId -> what Microsoft still says about it.
  const msCounterparts = new Map();
  const msPath = path.join(vaultPath, 'Tasks', 'Microsoft Tasks.md');
  if (fs.existsSync(msPath)) {
    const content = fs.readFileSync(msPath, 'utf-8');
    const lines = content.split('\n');
    let msSection = 'Planner';
    // The Planner board / To Do list the following tasks belong to, from the
    // `### ` heading above them. Null until one is seen, and reset by every `## `
    // — a plan name leaking across the Planner/ToDo boundary would file a task
    // under a board it is not on.
    let msPlan = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('### ')) {
        const heading = line.slice(4).trim();
        msPlan = heading && heading !== PLAN_UNKNOWN_HEADING ? heading : null;
        continue;
      }
      if (line.startsWith('## ')) {
        if (line.includes('Planner')) msSection = 'MS Planner';
        else if (line.includes('ToDo')) msSection = 'MS ToDo';
        msPlan = null;
        continue;
      }

      const task = parseTaskLine(line);
      if (task) {
        // A Microsoft task Nick has confirmed IS a NEURO task is dropped here, so
        // the pair shows once — under NEURO's wording, which is the fuller one and
        // the one carrying MoSCoW, estimate and provenance. The Microsoft task is
        // not deleted; NEURO now completes it (routes/tasks.js) when the task is
        // ticked off. Unlinking in the review screen brings this line straight back.
        if (task.ms_id && linkedMs.has(task.ms_id)) {
          msCounterparts.set(linkedMs.get(task.ms_id), {
            text: task.text,
            dueDate: task.due_date || null,
            plan: msPlan,
            source: msSection,
          });
          continue;
        }
        task.source = msSection;
        task.msPlan = msPlan;
        task.priority = mergePriority(task.priority, 'normal');
        task.filePath = msPath;
        task.lineNumber = i;
        allTasks.push(task);
      }
    }
  }

  // 3. Parse daily notes — today and recent days for carry-overs/follow-ups
  const dailyDir = path.join(vaultPath, 'Daily');
  const dailyFiles = [];
  if (fs.existsSync(dailyDir)) {
    // Get last 3 daily notes (today + 2 previous)
    const files = fs.readdirSync(dailyDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse()
      .slice(0, 3);
    dailyFiles.push(...files);
  }

  const seenDailyTexts = new Set(); // deduplicate across days
  for (const file of dailyFiles) {
    const filePath = path.join(dailyDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const dateStr = file.replace('.md', '');
    const isToday = dateStr === todayDateString();
    const lines = content.split('\n');
    let dailySection = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('## ')) {
        dailySection = line.replace(/^##\s*/, '').trim();
        continue;
      }

      // Only parse task lines from relevant sections
      const taskSections = ['Focus Today', 'Carry-Overs', 'Follow Ups For Tomorrow', '90-Day Plan'];
      const inTaskSection = taskSections.some(s => dailySection.includes(s));
      if (!inTaskSection) continue;

      const task = parseTaskLine(line);
      if (!task) continue;

      // Deduplicate by text (same task may appear across multiple days)
      const dedupeKey = task.text.substring(0, 60).toLowerCase();
      if (seenDailyTexts.has(dedupeKey)) continue;
      seenDailyTexts.add(dedupeKey);

      task.source = isToday ? `Daily (${dailySection})` : `Daily ${dateStr}`;
      if (dailySection.includes('Focus Today')) task.priority = mergePriority(task.priority, 'high');
      else if (dailySection.includes('Follow Ups')) task.priority = mergePriority(task.priority, 'normal');
      else task.priority = mergePriority(task.priority, 'normal');
      task.filePath = filePath;
      task.lineNumber = i;
      allTasks.push(task);
    }
  }

  // 4. Merge in the tasks NEURO owns. These come last but win: a Master Todo or daily
  // note line describing the same action is dropped, so the migration never shows a
  // task twice while the old file is still on disk.
  if (includeDbTasks) {
    try {
      const taskStore = require('./task-store');
      const dbTasks = [...taskStore.activeTodos(), ...taskStore.doneTodos()];
      if (dbTasks.length) {
        const owned = new Set(dbTasks.map(t => taskStore.dedupeKey(t.text)));
        const fileBacked = allTasks.filter(t => {
          const fromMergeable = t.filePath === masterPath || String(t.source || '').startsWith('Daily');
          return !(fromMergeable && owned.has(taskStore.dedupeKey(t.text)));
        });
        // The Microsoft half a linked row now stands for. Attached here because
        // this is the only point that has both — and it is REFERENCED, never
        // merged in: the pair is one task, and the second wording is provenance
        // for the card, not a second row.
        if (msCounterparts.size) {
          for (const t of dbTasks) {
            const other = msCounterparts.get(t.task_id);
            if (other) t.msCounterpart = other;
          }
        }
        allTasks.length = 0;
        allTasks.push(...fileBacked, ...dbTasks);
      }
    } catch (e) {
      // Tasks are unreadable rather than lost — say so loudly and still return the vault.
      console.error('[Obsidian] Could not merge DB tasks:', e.message);
    }
  }

  // Split into active and done
  const active = allTasks.filter(t => t.status === 'open' || t.status === 'in-progress');
  const done = allTasks.filter(t => t.status === 'done');

  // Sort active: overdue first, then by priority, then by due date
  const today = new Date(new Date().toDateString());

  active.sort((a, b) => {
    // Overdue first
    const aOverdue = a.due_date && new Date(a.due_date) < today ? 1 : 0;
    const bOverdue = b.due_date && new Date(b.due_date) < today ? 1 : 0;
    if (bOverdue !== aOverdue) return bOverdue - aOverdue;
    // Then by priority
    const pa = priorityOrder[a.priority] ?? 1;
    const pb = priorityOrder[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    // Then by due date (nulls last)
    if (a.due_date && !b.due_date) return -1;
    if (!a.due_date && b.due_date) return 1;
    if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
    return 0;
  });

  return { active, done };
}

// Scan vault for open #mustdo tasks — New ToDos.md, daily notes, and other task files
function parseVaultMustDos() {
  if (!isConfigured()) return [];

  const vaultPath = getVaultPath();
  const mustDos = [];
  const seen = new Set();

  // Helper: scan a file for open tasks tagged #mustdo
  function scanFileForMustDos(filePath, source) {
    if (!fs.existsSync(filePath)) return;
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return; }
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('#mustdo')) continue;

      // Must be a checkbox line
      const match = line.match(/^[\s]*-\s+\[([ x>\/])\]\s+(.+)$/);
      if (!match) continue;

      const statusChar = match[1];
      if (statusChar === 'x') continue; // skip done

      const rawText = match[2].trim();

      // Clean display text (same as parseTaskLine)
      let text = rawText
        .replace(/<!--.*?-->/g, '')
        .replace(/\[\[([^|]*?\|)?([^\]]*?)\]\]/g, '$2')
        .replace(/due::\d{4}-\d{2}-\d{2}/g, '')
        .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
        .replace(/🕑\s*\d{2}:\d{2}/g, '')
        .replace(/#\w+/g, '')
        .replace(/\*\(.*?\)\*/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s*—\s*$/, '')
        .trim();

      if (text.startsWith('**') && text.endsWith('**')) {
        text = text.slice(2, -2);
      }
      if (!text) continue;

      // Extract due date
      let due_date = null;
      const dueMatch = rawText.match(/(?:due::(\d{4}-\d{2}-\d{2})|📅\s*(\d{4}-\d{2}-\d{2}))/);
      if (dueMatch) due_date = dueMatch[1] || dueMatch[2];

      // Deduplicate by first 60 chars
      const dedupeKey = text.substring(0, 60).toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      mustDos.push({ text, due_date, source, filePath, lineNumber: i });
    }
  }

  // 1. Scan New ToDos.md
  scanFileForMustDos(path.join(vaultPath, 'Tasks', 'New ToDos.md'), 'New ToDos');

  // 2. Scan Master Todo.md
  scanFileForMustDos(path.join(vaultPath, 'Tasks', 'Master Todo.md'), 'Master Todo');

  // 3. Scan today's daily note
  const todayFile = path.join(vaultPath, 'Daily', `${todayDateString()}.md`);
  scanFileForMustDos(todayFile, 'Daily Note');

  // 4. Scan yesterday's daily note (for carry-overs)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const yesterdayFile = path.join(vaultPath, 'Daily', `${yesterdayStr}.md`);
  scanFileForMustDos(yesterdayFile, `Daily ${yesterdayStr}`);

  return mustDos;
}

function parseTaskLine(line) {
  // Match markdown checkboxes: - [ ], - [x], - [>], - [/]
  const match = line.match(/^[\s]*-\s+\[([ x>\/])\]\s+(.+)$/);
  if (!match) return null;

  const statusChar = match[1];
  let rawText = match[2].trim();
  const todoIntelligence = require('./todo-intelligence');
  const meta = todoIntelligence.parseEmbeddedMeta(rawText) || {};

  // Map status character
  let status;
  if (statusChar === ' ') status = 'open';
  else if (statusChar === 'x') status = 'done';
  else if (statusChar === '>') status = 'open'; // carried over = still open
  else if (statusChar === '/') status = 'in-progress';
  else status = 'open';

  // Check for #mustdo tag before stripping
  const mustdo = /#mustdo\b/.test(rawText);

  // Extract due date from due::YYYY-MM-DD or 📅 YYYY-MM-DD
  let due_date = null;
  const dueMatch = rawText.match(/(?:due::(\d{4}-\d{2}-\d{2})|📅\s*(\d{4}-\d{2}-\d{2}))/);
  if (dueMatch) {
    due_date = dueMatch[1] || dueMatch[2];
  }

  // Extract MS ID from HTML comments
  let ms_id = null;
  const msIdMatch = rawText.match(/<!--id:(.*?)-->/);
  if (msIdMatch) ms_id = msIdMatch[1];

  // How often it recurs, if it does. Null is the common case and means "does not
  // recur" — deliberately NOT the same as the `repeats` token, which means it
  // comes back on a pattern NEURO could not name. See shared/ms-task.cjs.
  const recMatch = rawText.match(/<!--rec:(.*?)-->/);
  const recurrence = recMatch ? recMatch[1].trim() || null : null;

  // Clean up display text
  let text = rawText
    .replace(/<!--nuero-meta:\{.*?\}-->/g, '')            // Remove embedded task metadata
    .replace(/<!--.*?-->/g, '')                     // Remove HTML comments
    .replace(/\[\[([^|]*?\|)?([^\]]*?)\]\]/g, '$2') // Wiki links: [[path|Name]] → Name
    .replace(/due::\d{4}-\d{2}-\d{2}/g, '')         // Remove due:: tags
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')         // Remove 📅 dates
    .replace(/🕑\s*\d{2}:\d{2}/g, '')               // Remove time tags
    .replace(/#\w+/g, '')                            // Remove hashtags
    .replace(/\*\(.*?\)\*/g, '')                     // Remove italic parenthetical refs like *(Outcome 1)*
    .replace(/\s{2,}/g, ' ')                         // Collapse whitespace
    .replace(/\s*—\s*$/, '')                         // Trailing dashes
    .trim();

  // Strip surrounding bold markers for cleaner display
  if (text.startsWith('**') && text.endsWith('**')) {
    text = text.slice(2, -2);
  }

  if (!text) return null;

  const triage = todoIntelligence.triageTodo({
    text,
    sourcePath: meta.sourcePath || null,
    dueDate: due_date,
    mustdo,
    priority: meta.priority || null,
    metadata: meta,
  });

  return {
    text,
    status,
    priority: triage.priority || null,
    due_date,
    ms_id,
    recurrence,
    mustdo,
    source: null,
    meta,
    moscow: triage.moscow,
    context: triage.context,
    needsToday: triage.needsToday,
    createdAt: meta.created || null,
  };
}

// Vault calendar parser — reads "## Calendar Today" from daily notes
function parseVaultCalendar(startDate, endDate) {
  if (!isConfigured()) return [];

  const vaultPath = getVaultPath();
  const dailyDir = path.join(vaultPath, 'Daily');
  if (!fs.existsSync(dailyDir)) return [];

  const events = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  // Iterate through each day in the range
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const filePath = path.join(dailyDir, `${dateStr}.md`);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let inCalendarSection = false;

    for (const line of lines) {
      if (line.startsWith('## ')) {
        inCalendarSection = line.includes('Calendar Today') || line.includes('Calendar');
        // Stop if we hit another section after calendar
        if (!inCalendarSection && events.length > 0) continue;
        continue;
      }

      if (!inCalendarSection) continue;

      // Skip placeholder text
      if (line.includes('[Pull from calendar') || line.includes('[No meetings')) continue;

      // Parse: - HH:MM-HH:MM **Subject** — Location
      const eventMatch = line.match(/^-\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s+\*\*(.+?)\*\*(?:\s*—\s*(.+))?$/);
      if (eventMatch) {
        const [, startTime, endTime, subject, location] = eventMatch;
        const isCancelled = subject.toLowerCase().startsWith('canceled:') || subject.toLowerCase().startsWith('cancelled:');
        events.push({
          id: `${dateStr}-${startTime}-${subject.substring(0, 20)}`,
          date: dateStr,
          start: `${dateStr}T${startTime}:00`,
          end: `${dateStr}T${endTime}:00`,
          subject: subject,
          location: location ? location.trim() : null,
          isAllDay: false,
          showAs: isCancelled ? 'cancelled' : 'busy'
        });
        continue;
      }

      // Parse all-day: - **Subject** (all day)
      const allDayMatch = line.match(/^-\s+\*\*(.+?)\*\*.*(?:all\s*day)/i);
      if (allDayMatch) {
        events.push({
          id: `${dateStr}-allday-${allDayMatch[1].substring(0, 20)}`,
          date: dateStr,
          start: `${dateStr}T00:00:00`,
          end: `${dateStr}T23:59:59`,
          subject: allDayMatch[1],
          location: null,
          isAllDay: true,
          showAs: 'busy'
        });
      }
    }
  }

  return events;
}

// ICS calendar feed — reads URL from vault's ICS plugin config and fetches live events
let icsCache = { data: null, fetchedAt: 0 };
const ICS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getIcsUrl() {
  if (!isConfigured()) return null;
  const configPath = path.join(getVaultPath(), '.obsidian', 'plugins', 'ics', 'data.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const cals = config.calendars || {};
    const first = Object.values(cals)[0];
    return first?.icsUrl || null;
  } catch { return null; }
}

function fetchUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, res => {
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

function parseIcsDate(val) {
  // Handle: 20260317T090000, 20260317T090000Z, TZID=...:20260317T090000
  const clean = val.replace(/^.*:/, ''); // strip TZID prefix
  const m = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) {
    // Date only: 20260317
    const dm = clean.match(/^(\d{4})(\d{2})(\d{2})/);
    if (dm) return { date: `${dm[1]}-${dm[2]}-${dm[3]}`, time: null, isDate: true };
    return null;
  }

  let [, y, mo, d, hh, mm, ss] = m;

  // A trailing Z means UTC, and Outlook's published feeds use it. Everything
  // downstream (display, is-it-now) treats these strings as local wall-clock,
  // so during BST an unconverted 08:15Z showed as 08:15 for a 09:15 meeting.
  if (/Z$/.test(clean)) {
    // Converted against NEURO_TIMEZONE explicitly, not the host clock — the Pi
    // may well be running in UTC, which would silently make this a no-op.
    const utc = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: process.env.NEURO_TIMEZONE || 'Europe/London',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(utc);
    const part = (type) => parts.find((p) => p.type === type).value;
    [y, mo, d] = [part('year'), part('month'), part('day')];
    [hh, mm, ss] = [part('hour'), part('minute'), part('second')];
  }

  return {
    date: `${y}-${mo}-${d}`,
    time: `${hh}:${mm}`,
    iso: `${y}-${mo}-${d}T${hh}:${mm}:${ss}`,
    isDate: false
  };
}

function parseIcsEvents(icsText, startDate, endDate) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const lines = block.split(/\r?\n/);

    // Unfold continuation lines (lines starting with space/tab)
    const unfolded = [];
    for (const line of lines) {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        if (unfolded.length > 0) unfolded[unfolded.length - 1] += line.substring(1);
      } else {
        unfolded.push(line);
      }
    }

    let summary = '', location = '', dtstart = '', dtend = '', status = '';
    for (const line of unfolded) {
      if (line.startsWith('SUMMARY:')) summary = line.substring(8);
      else if (line.startsWith('LOCATION:')) location = line.substring(9);
      else if (line.startsWith('DTSTART')) dtstart = line.split(':').slice(-1)[0] || line.substring(line.indexOf(':') + 1);
      else if (line.startsWith('DTEND')) dtend = line.split(':').slice(-1)[0] || line.substring(line.indexOf(':') + 1);
      else if (line.startsWith('STATUS:')) status = line.substring(7);
    }

    // Find raw DTSTART line for TZID parsing
    const dtstartLine = unfolded.find(l => l.startsWith('DTSTART'));
    const dtendLine = unfolded.find(l => l.startsWith('DTEND'));
    const startParsed = parseIcsDate(dtstartLine || dtstart);
    const endParsed = parseIcsDate(dtendLine || dtend);

    if (!startParsed) continue;

    // Filter to date range
    if (startParsed.date < startDate || startParsed.date > endDate) continue;

    const isAllDay = startParsed.isDate;
    const isCancelled = status.toUpperCase() === 'CANCELLED' ||
      summary.toLowerCase().startsWith('canceled:') ||
      summary.toLowerCase().startsWith('cancelled:');

    events.push({
      id: `ics-${startParsed.date}-${startParsed.time || '00:00'}-${summary.substring(0, 20)}`,
      date: startParsed.date,
      start: isAllDay ? `${startParsed.date}T00:00:00` : (startParsed.iso || `${startParsed.date}T00:00:00`),
      end: endParsed ? (isAllDay ? `${endParsed.date}T23:59:59` : (endParsed.iso || `${endParsed.date}T23:59:59`)) : `${startParsed.date}T23:59:59`,
      subject: summary.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, ' '),
      location: location ? location.replace(/\\,/g, ',').replace(/\\n/g, ' ') : null,
      isAllDay,
      showAs: isCancelled ? 'cancelled' : 'busy'
    });
  }

  return events.sort((a, b) => a.start.localeCompare(b.start));
}

async function fetchCalendarEvents(startDate, endDate) {
  // Priority 1: Microsoft Graph API or NOVA bridge
  try {
    const microsoft = require('./microsoft');
    const canUseGraph = microsoft.isConfigured() && await microsoft.isAuthenticated();
    const canUseBridge = microsoft.isBridgeConfigured();
    if (canUseGraph || canUseBridge) {
      const graphEvents = await microsoft.fetchCalendarEvents(startDate, endDate);
      if (graphEvents && graphEvents.length > 0) {
        console.log(`[Calendar] Microsoft returned ${graphEvents.length} events (${canUseGraph ? 'Graph' : 'bridge'})`);
        return graphEvents;
      }
      if (graphEvents === null) {
        console.warn('[Calendar] Microsoft API failed, falling back to ICS');
      }
    }
  } catch (e) {
    console.warn('[Calendar] Microsoft API unavailable:', e.message);
  }

  // Priority 2: ICS feed
  const icsUrl = getIcsUrl();

  // If no ICS URL, fall back to vault daily note parsing
  if (!icsUrl) {
    return parseVaultCalendar(startDate, endDate);
  }

  try {
    // Use cache if fresh
    const now = Date.now();
    if (icsCache.data && (now - icsCache.fetchedAt) < ICS_CACHE_TTL) {
      return parseIcsEvents(icsCache.data, startDate, endDate);
    }

    // Try up to 2 times with a short pause between
    let icsText = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        icsText = await fetchUrl(icsUrl, 15000);
        break;
      } catch (retryErr) {
        console.warn(`[Calendar] ICS fetch attempt ${attempt + 1} failed:`, retryErr.message);
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (icsText) {
      icsCache = { data: icsText, fetchedAt: now };
      console.log('[Calendar] Fetched ICS feed, length:', icsText.length);
      return parseIcsEvents(icsText, startDate, endDate);
    }

    // All retries failed — serve stale cache if available
    if (icsCache.data) {
      console.warn('[Calendar] Serving stale cache');
      return parseIcsEvents(icsCache.data, startDate, endDate);
    }

    throw new Error('ICS fetch failed and no cache available');
  } catch (e) {
    console.error('[Calendar] ICS fetch failed, falling back to vault:', e.message);
    return parseVaultCalendar(startDate, endDate);
  }
}

// 90-day plan parser
function parseNinetyDayPlan() {
  const planPath = path.join(getVaultPath(), 'Projects', '90 Day Plan', '90 Day Plan - Daily Tasks.md');
  if (!fs.existsSync(planPath)) return null;
  const content = fs.readFileSync(planPath, 'utf-8');

  const PLAN_DAYS = parseInt(process.env.PLAN_DURATION_DAYS || '90', 10);
  const START_DATE = new Date(process.env.PLAN_START_DATE || '2026-03-16');
  const BANK_HOLIDAYS = ['2026-04-03', '2026-04-06', '2026-05-04'];

  // Calculate current working day
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let workingDay = 0;
  const cursor = new Date(START_DATE);
  while (cursor <= today) {
    const dow = cursor.getDay();
    const iso = cursor.toISOString().split('T')[0];
    if (dow >= 1 && dow <= 5 && !BANK_HOLIDAYS.includes(iso)) {
      workingDay++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  // Working day to calendar date mapping
  function workingDayToDate(targetDay) {
    let count = 0;
    const d = new Date(START_DATE);
    while (count < targetDay) {
      const dow = d.getDay();
      const iso = d.toISOString().split('T')[0];
      if (dow >= 1 && dow <= 5 && !BANK_HOLIDAYS.includes(iso)) {
        count++;
      }
      if (count < targetDay) d.setDate(d.getDate() + 1);
    }
    return d.toISOString().split('T')[0];
  }

  const CHECKPOINTS = [
    { day: 15, label: 'Day 15', date: '2026-03-31' },
    { day: 30, label: 'Day 30', date: '2026-04-15' },
    { day: 45, label: 'Day 45', date: '2026-04-30' },
    { day: 60, label: 'Day 60', date: '2026-05-15' },
    { day: PLAN_DAYS, label: `Day ${PLAN_DAYS}`, date: '2026-06-12' }
  ];

  const OUTCOMES = {
    1: { name: 'Visibility & BI', color: '#4fc3f7' },
    2: { name: 'Tiered Model', color: '#ab47bc' },
    3: { name: 'Quality & CX', color: '#66bb6a' },
    4: { name: 'People & Culture', color: '#ffa726' },
    5: { name: 'Cross-functional', color: '#ef5350' },
    6: { name: 'Production', color: '#78909c' }
  };

  // Parse all tasks from the file
  const tasks = [];
  const taskRegex = /^- \[([ x>\/])\] \*\*Day (\d+) \(([^)]+)\)\*\* — (.+)/;
  const outcomeRegex = /\*\(Outcome (\d+)/;

  const lines = content.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineNumber = li; // 0-based — toggleTask uses 0-based indexing
    const m = line.match(taskRegex);
    if (m) {
      const status = m[1]; // ' ', 'x', '>', '/'
      const day = parseInt(m[2], 10);
      const dateLabel = m[3];
      let text = m[4];

      // Extract outcome
      const om = text.match(outcomeRegex);
      const outcome = om ? parseInt(om[1], 10) : null;

      // Clean text — remove outcome ref and trailing *
      text = text.replace(/\s*\*\(Outcome.*$/, '').replace(/\s*\*\(.*?\)\*$/, '').trim();

      tasks.push({ day, dateLabel, calendarDate: workingDayToDate(day), text, status, outcome, lineNumber });
    }

    // Also parse pre-day-1 tasks and checkpoint items
    const preMatch = line.match(/^- \[([ x>\/])\] (.+)/);
    if (preMatch && !line.match(taskRegex)) {
      const status = preMatch[1];
      let text = preMatch[2];
      const om = text.match(outcomeRegex);
      const outcome = om ? parseInt(om[1], 10) : null;

      // Checkpoint sub-items (indented) — skip
      if (line.startsWith('  ')) continue;

      // Pre-day-1 tasks
      if (text.includes('CHECKPOINT DAY')) {
        const cpMatch = text.match(/CHECKPOINT DAY (\d+)/);
        if (cpMatch) {
          tasks.push({ day: parseInt(cpMatch[1], 10), dateLabel: '', text: 'Checkpoint presentation', status, outcome: null, isCheckpoint: true, lineNumber });
        }
        continue;
      }

      // Only include pre-day-1 items (they appear before Week 1)
      if (text.includes('Outcome') || text.includes('technical') || text.includes('urgent')) {
        text = text.replace(/\s*\*\(.*?\)\*$/, '').replace(/\*\*/g, '').trim();
        tasks.push({ day: 0, dateLabel: 'Pre-Day 1', text, status, outcome, lineNumber });
      }
    }
  }

  // Build outcome stats
  const outcomeStats = {};
  for (const [id, info] of Object.entries(OUTCOMES)) {
    const outcomeTasks = tasks.filter(t => t.outcome === parseInt(id));
    const done = outcomeTasks.filter(t => t.status === 'x').length;
    const total = outcomeTasks.length;
    outcomeStats[id] = { ...info, done, total, tasks: outcomeTasks };
  }

  // This week's tasks
  const thisWeekStart = workingDay;
  const thisWeekEnd = Math.min(workingDay + (5 - new Date().getDay()), PLAN_DAYS); // rest of this work week
  const weekStart = workingDay - (new Date().getDay() - 1); // Monday of this week
  const weekEnd = weekStart + 4; // Friday
  const thisWeekTasks = tasks.filter(t => t.day >= weekStart && t.day <= weekEnd && t.status !== 'x');

  // Overdue tasks
  const overdueTasks = tasks.filter(t => t.day < workingDay && t.day > 0 && (t.status === ' ' || t.status === '>'));

  // Today's tasks
  const todayTasks = tasks.filter(t => t.day === workingDay);

  // Next checkpoint
  const nextCheckpoint = CHECKPOINTS.find(cp => cp.day > workingDay) || CHECKPOINTS[CHECKPOINTS.length - 1];
  const daysToCheckpoint = nextCheckpoint.day - workingDay;

  // Total stats
  const totalDone = tasks.filter(t => t.status === 'x').length;
  const totalTasks = tasks.filter(t => !t.isCheckpoint).length;

  return {
    currentDay: workingDay,
    totalDays: PLAN_DAYS,
    startDate: '2026-03-16',
    checkpoints: CHECKPOINTS,
    nextCheckpoint,
    daysToCheckpoint,
    outcomes: outcomeStats,
    thisWeekTasks,
    overdueTasks,
    todayTasks,
    totalDone,
    totalTasks,
    allTasks: tasks,
    filePath: planPath
  };
}

/**
 * Toggle a task's checkbox in the vault file.
 *
 * Returns `{ status, text }` rather than a bare status string. The text is what
 * the completion is WORTH RECORDING as — a vault-backed tick was invisible to
 * the wins ledger because nothing at the completion point knew what had been
 * ticked, and re-reading the file from the route to find out is two reads of a
 * line this function already has in its hand.
 *
 * ⚠ It deliberately does NOT log the win itself. `suggestion-engine`'s
 * `complete_task` toggles the mirror line for a task it has ALREADY closed
 * through task-store, which logs `task_done` on its own — logging here would
 * count that one twice. The routes own the record because the routes are where
 * the owner is known.
 */
function toggleTask(filePath, lineNumber) {
  if (!fs.existsSync(filePath)) throw new Error('File not found');

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  if (lineNumber < 0 || lineNumber >= lines.length) throw new Error('Line number out of range');

  const line = lines[lineNumber];
  const match = line.match(/^([\s]*-\s+\[)([ x>\/])(\]\s+.+)$/);
  if (!match) throw new Error('Not a task line');

  const statusChar = match[2];
  // Toggle: open/carried/in-progress → done, done → open
  const newStatus = statusChar === 'x' ? ' ' : 'x';
  lines[lineNumber] = match[1] + newStatus + match[3];

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  // Invalidate vault cache synchronously (vault-hooks debounces 2s which is too slow for UI)
  try { require('./vault-cache').invalidate('task-toggle'); } catch {}
  // Also fire the async vault-hooks for embeddings/entities (debounced is fine for these)
  try { require('./vault-hooks').onVaultWrite(filePath, 'task-toggle'); } catch {}

  // Parsed off the ORIGINAL line, before the rewrite — parseTaskLine is the one
  // place that knows how to strip the id comment, the 📅 date, the (50%) marker
  // and the wiki links, and a second cleaner here is how two of them drift.
  let text = null;
  try { text = parseTaskLine(line)?.text || null; } catch { text = null; }

  return { status: newStatus === 'x' ? 'done' : 'open', text };
}

/**
 * Rewrite the "(50%)" progress marker on one Microsoft-mirror task line.
 *
 * ⚠ Why this exists: the WIP push reached Planner correctly and the button
 * still looked broken. The lane READS from `Tasks/Microsoft Tasks.md`, which is
 * only rewritten by `syncMicrosoftTasks()` on its schedule — so Planner said
 * 50% while NEURO went on showing the old value for up to an hour, and four
 * clicks landed on Graph with nothing at all changing on screen.
 *
 * `complete-ms` had already solved the same problem the same way: toggle the
 * vault line first for instant feedback, then push. This is that, for progress.
 *
 * The marker format is NEURO's own (`syncMicrosoftTasks` writes
 * `- [ ] Title (50%) 📅 date <!--id:xxx-->`), so it is stripped and reinserted
 * immediately after the title — before the due date and the id comment, which
 * must both survive or the line stops being parseable and completion breaks.
 */
function setTaskPercent(filePath, lineNumber, percent, expectedId = null) {
  if (!fs.existsSync(filePath)) throw new Error('File not found');

  const content = fs.readFileSync(filePath, 'utf-8');
  // Vault notes are mixed CRLF/LF and this line is rewritten in place, so the
  // original ending is preserved rather than normalised across the whole file.
  const lines = content.split('\n');
  if (lineNumber < 0 || lineNumber >= lines.length) throw new Error('Line number out of range');

  const raw = lines[lineNumber];
  const cr = raw.endsWith('\r') ? '\r' : '';
  const line = cr ? raw.slice(0, -1) : raw;

  const m = line.match(/^(\s*-\s+\[[ x>\/]\]\s+)(.*)$/);
  if (!m) throw new Error('Not a task line');

  // ⚠ A line number is a POSITION and the task is an IDENTITY. This file is
  // regenerated wholesale by syncMicrosoftTasks, so a client holding a lane
  // fetched before a resync can hand back a number that now points at someone
  // else's task — and the marker would be written onto the wrong row silently.
  // Proved by accident while testing: a probe paired one task's id with another
  // task's line and put "(50%)" on a row sitting at 75%. Graph took the right
  // task, the vault took the wrong line, and only the next resync undid it.
  //
  // The line already carries the id the caller thinks it is editing, so this is
  // checkable rather than assumable. Dedupe on identity, never on a positional
  // attribute a concurrent writer controls.
  if (expectedId) {
    const onLine = /<!--id:([^>]*?)-->/.exec(line)?.[1] || null;
    if (onLine !== expectedId) {
      throw new Error(`Line ${lineNumber} holds ${onLine || 'no id'}, expected ${expectedId} — refusing to edit the wrong task`);
    }
  }

  let body = m[2];
  // Drop any existing marker wherever it sits.
  body = body.replace(/\s*\((?:\d{1,3})%\)/, '');

  // Everything from the due date or the id comment onward is the tail; the
  // marker goes before it.
  const tailAt = body.search(/\s*(?:📅|<!--rec:|<!--id:)/);
  const head = (tailAt === -1 ? body : body.slice(0, tailAt)).trimEnd();
  const tail = tailAt === -1 ? '' : body.slice(tailAt);

  // 0 and 100 carry no marker — 0 is how Planner renders "not started", and a
  // completed task leaves this file entirely on the next sync.
  const marker = percent > 0 && percent < 100 ? ` (${percent}%)` : '';
  lines[lineNumber] = `${m[1]}${head}${marker}${tail}${cr}`;

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  try { require('./vault-cache').invalidate('task-percent'); } catch {}
  try { require('./vault-hooks').onVaultWrite(filePath, 'task-percent'); } catch {}
  return percent;
}

/**
 * Rewrite the title and/or due date on one Microsoft-mirror task line.
 *
 * The sibling of `setTaskPercent`, and it exists for the same reason: Graph has
 * the edit, `Tasks/Microsoft Tasks.md` is only rewritten by `syncMicrosoftTasks`
 * on its schedule, and until then every NEURO surface reads the OLD wording. An
 * edit that lands in Planner and leaves the list unchanged is indistinguishable
 * from one that failed.
 *
 * This is a repaint, not a store. Graph is authoritative and the next sync
 * overwrites whatever is here — so it is only ever asked to reflect a write that
 * has ALREADY succeeded, and only the fields that succeeded.
 *
 * The progress marker, the ⚡ importance flag and the `<!--id:-->` comment all
 * survive: the line has to stay parseable or completion stops working on it.
 */
function setTaskFields(filePath, lineNumber, fields = {}, expectedId = null) {
  if (!fs.existsSync(filePath)) throw new Error('File not found');

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  if (lineNumber < 0 || lineNumber >= lines.length) throw new Error('Line number out of range');

  const raw = lines[lineNumber];
  const cr = raw.endsWith('\r') ? '\r' : '';
  const line = cr ? raw.slice(0, -1) : raw;

  const m = line.match(/^(\s*-\s+\[[ x>\/]\]\s+)(.*)$/);
  if (!m) throw new Error('Not a task line');

  // ⚠ A line number is a POSITION and the task is an IDENTITY — see
  // setTaskPercent. This file is regenerated wholesale, so a client holding a
  // list fetched before a resync can hand back a number pointing at someone
  // else's task, and a RENAME written onto the wrong row is far worse than a
  // stray progress marker: it would look like Nick's own edit.
  const onLine = /<!--id:([^>]*?)-->/.exec(line)?.[1] || null;
  if (expectedId && onLine !== expectedId) {
    throw new Error(`Line ${lineNumber} holds ${onLine || 'no id'}, expected ${expectedId} — refusing to edit the wrong task`);
  }

  let body = m[2];

  // Pull the parts out in the order syncMicrosoftTasks writes them:
  //   Title (50%) ⚡ 📅 2026-08-27 <!--id:xxx-->
  const idComment = /\s*<!--id:[^>]*?-->\s*$/.exec(body);
  // Fully trimmed: the parts are rejoined with a single space, so a retained
  // leading one doubles up.
  const idPart = idComment ? idComment[0].trim() : '';
  if (idComment) body = body.slice(0, idComment.index);

  // The recurrence marker survives a rename the same way the id does. It is a
  // fact about the Microsoft task, not about its wording — and `title` below
  // strips every comment, so without pulling it out first an edit would silently
  // drop it and the card would stop saying the task comes back.
  const recComment = /\s*<!--rec:[^>]*?-->\s*$/.exec(body);
  const recPart = recComment ? recComment[0].trim() : '';
  if (recComment) body = body.slice(0, recComment.index);

  const dueMatch = /\s*📅\s*\d{4}-\d{2}-\d{2}/.exec(body);
  let duePart = dueMatch ? dueMatch[0].trim() : '';
  if (dueMatch) body = body.slice(0, dueMatch.index) + body.slice(dueMatch.index + dueMatch[0].length);

  const pctMatch = /\s*\((\d{1,3})%\)/.exec(body);
  const pctPart = pctMatch ? ` (${pctMatch[1]}%)` : '';
  if (pctMatch) body = body.slice(0, pctMatch.index) + body.slice(pctMatch.index + pctMatch[0].length);

  const impMatch = /\s*⚡/.exec(body);
  const impPart = impMatch ? ' ⚡' : '';
  if (impMatch) body = body.slice(0, impMatch.index) + body.slice(impMatch.index + impMatch[0].length);

  // An ABSENT title keeps whatever is on the line; a title that was supplied and
  // is empty is a refusal, not a fallback — silently keeping the old wording
  // would report a save that did not happen.
  let title = body.trim();
  if (typeof fields.title === 'string') title = fields.title.trim();
  // Only a title reaching the line can break the format. A due date is a fixed
  // shape and the id comment is stripped above, but a pasted title carrying
  // either would produce a line that parses back as something else.
  title = title.replace(/<!--[\s\S]*?-->/g, '').replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '').trim();
  if (!title) throw new Error('Refusing to write an empty task line');

  if (fields.dueDate !== undefined) {
    duePart = fields.dueDate ? `📅 ${fields.dueDate}` : '';
  }

  const rebuilt = [title + pctPart + impPart, duePart, recPart, idPart].filter(Boolean).join(' ');
  lines[lineNumber] = `${m[1]}${rebuilt}${cr}`;

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  try { require('./vault-cache').invalidate('task-fields'); } catch {}
  try { require('./vault-hooks').onVaultWrite(filePath, 'task-fields'); } catch {}
  return { title, dueDate: fields.dueDate !== undefined ? fields.dueDate : (/(\d{4}-\d{2}-\d{2})/.exec(duePart)?.[1] || null) };
}

// Ritual state — reads Scripts/ritual-state.json from vault
function readRitualState() {
  const statePath = path.join(getVaultPath(), 'Scripts', 'ritual-state.json');
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch (e) {
    console.error('[Obsidian] Error reading ritual-state.json:', e.message);
    return null;
  }
}

// Read yesterday's (or Friday's if Monday) daily note
function readPreviousDailyNote() {
  const today = new Date();
  const prev = new Date(today);
  // Go back 1 day, or 2 days on Monday (to get Friday)
  const daysBack = today.getDay() === 1 ? 3 : 1;
  prev.setDate(prev.getDate() - daysBack);
  const dateStr = prev.toISOString().split('T')[0];
  const notePath = path.join(getVaultPath(), 'Daily', `${dateStr}.md`);
  if (!fs.existsSync(notePath)) return null;
  return { date: dateStr, content: fs.readFileSync(notePath, 'utf-8') };
}

// Search vault for a query string — returns up to maxResults matching files with excerpts
function searchVault(query, maxResults = 5) {
  if (!isConfigured() || !query || query.trim().length < 3) return [];

  const vaultPath = getVaultPath();
  const results = [];

  // Directories to skip — too noisy or not useful for chat context
  const SKIP_DIRS = new Set([
    'Daily', 'Scripts', 'Templates', '.obsidian', '.git', '.trash', 'Imports'
  ]);

  function searchDir(dirPath, depth) {
    if (depth > 4 || results.length >= maxResults) return;
    if (!fs.existsSync(dirPath)) return;

    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        searchDir(path.join(dirPath, entry.name), depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const fullPath = path.join(dirPath, entry.name);
        let content;
        try { content = fs.readFileSync(fullPath, 'utf-8'); }
        catch { continue; }

        if (!content.toLowerCase().includes(query.toLowerCase())) continue;

        // Strip frontmatter
        const body = content.replace(/^---[\s\S]*?---\n*/, '');
        const lines = body.split('\n');

        // Find matching lines and grab context around them
        const excerpts = [];
        for (let i = 0; i < lines.length && excerpts.length < 3; i++) {
          if (lines[i].toLowerCase().includes(query.toLowerCase())) {
            const start = Math.max(0, i - 1);
            const end = Math.min(lines.length - 1, i + 2);
            const excerpt = lines.slice(start, end + 1).join('\n').trim();
            if (excerpt) excerpts.push(excerpt);
          }
        }

        const relPath = path.relative(vaultPath, fullPath).replace(/\\/g, '/');
        results.push({
          path: relPath,
          name: entry.name.replace('.md', ''),
          excerpts
        });
      }
    }
  }

  searchDir(vaultPath, 0);
  return results;
}

async function searchVaultSemantic(query, maxResults = 5) {
  // Try semantic search first
  try {
    const emb = getEmbeddingsService();
    if (emb) {
      const results = await emb.semanticSearch(query, maxResults);
      if (results && results.length > 0) {
        console.log(`[Search] Semantic: ${results.length} results for "${query}"`);
        return results;
      }
    }
  } catch (e) {
    console.warn('[Search] Semantic search failed, falling back:', e.message);
  }
  // Fall back to keyword search
  return searchVault(query, maxResults);
}

// Get meeting prep context for upcoming meetings (next N hours)
// Returns array of { subject, start, people, prepNotes }
function getMeetingPrepContext(hoursAhead = 3) {
  if (!isConfigured()) return [];

  const vaultPath = getVaultPath();
  const now = new Date();
  const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  // Get today's calendar events
  const todayStr = todayDateString();
  const dailyNote = readTodayDailyNote();
  if (!dailyNote) return [];

  // Parse calendar entries from daily note
  const lines = dailyNote.split('\n');
  let inCalendar = false;
  const upcomingMeetings = [];

  for (const line of lines) {
    if (line.startsWith('## Calendar') || line.startsWith('## Meetings')) {
      inCalendar = true; continue;
    }
    if (line.startsWith('## ') && inCalendar) { inCalendar = false; continue; }
    if (!inCalendar) continue;

    // Parse: - HH:MM-HH:MM **Subject**
    const m = line.match(/^-\s+(\d{2}):(\d{2})-\d{2}:\d{2}\s+\*\*(.+?)\*\*/);
    if (!m) continue;

    const meetingTime = new Date(now);
    meetingTime.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);

    if (meetingTime > now && meetingTime <= cutoff) {
      upcomingMeetings.push({ time: `${m[1]}:${m[2]}`, subject: m[3] });
    }
  }

  if (upcomingMeetings.length === 0) return [];

  // For each meeting, find relevant People notes by matching names
  const peopleDir = path.join(vaultPath, 'People');
  const peopleFiles = fs.existsSync(peopleDir)
    ? fs.readdirSync(peopleDir).filter(f => f.endsWith('.md'))
    : [];

  const prepContexts = [];

  for (const meeting of upcomingMeetings) {
    const matchedPeople = [];

    for (const file of peopleFiles) {
      const name = file.replace('.md', '');
      // Check if name appears in meeting subject
      const nameParts = name.split(' ');
      const firstOrLast = nameParts.some(part =>
        part.length > 2 && meeting.subject.toLowerCase().includes(part.toLowerCase())
      );
      if (firstOrLast) {
        const content = fs.readFileSync(path.join(peopleDir, file), 'utf-8');
        const fm = parseFrontmatter(content);
        const body = content.replace(/^---[\s\S]*?---\n*/, '')
          .replace(/```dataview[\s\S]*?```/g, '') // strip dataview blocks
          .split('\n')
          .filter(l => l.trim() && !l.startsWith('#'))
          .slice(0, 5)
          .join('\n');

        matchedPeople.push({
          name,
          role: fm.role || '',
          lastMeeting: fm['last-1-2-1'] || fm['last-contact'] || null,
          notes: body || null
        });
      }
    }

    if (matchedPeople.length > 0 || meeting.subject.toLowerCase().includes('1-2-1') || meeting.subject.toLowerCase().includes('standup')) {
      prepContexts.push({
        time: meeting.time,
        subject: meeting.subject,
        people: matchedPeople
      });
    }
  }

  return prepContexts;
}

// 1-2-1s that need something from Nick, from the People notes.
//
// The classification is NOT done here — it's `one-to-one-detect.cadenceState()`,
// so this and the Team board cannot drift apart on what "overdue" means. In
// particular a 1-2-1 already in the diary (`1-2-1-booked`) comes back `booked`
// and is filtered out: chasing Nick to book a meeting he has booked is what this
// whole path used to do.
function getUpcoming121s(daysAhead = 2) {
  if (!isConfigured()) return [];
  const vaultPath = getVaultPath();
  const peopleDir = path.join(vaultPath, 'People');
  if (!fs.existsSync(peopleDir)) return [];
  const { cadenceState, CADENCES } = require('./one-to-one-detect');
  const upcoming = [];
  const files = fs.readdirSync(peopleDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(peopleDir, file), 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm['direct-report'] !== 'true') continue;
    // `cadence: n/a` is how someone comes off the rota (maternity, long-term
    // sick). They keep their note; they are never chased.
    const cadence = String(fm.cadence || 'fortnightly').toLowerCase().trim();
    const bookable = String(fm.archived || '').toLowerCase() !== 'true' &&
      CADENCES.some(c => c.match.test(cadence));

    const name = file.replace('.md', '');
    // Detected, not declared: the frontmatter stamp only catches up at 22:00, so
    // reading it alone nags Nick to write up a note that is already on disk.
    const fields = require('./one-to-one-detect').effectiveCadenceFields(name, fm);
    const s = cadenceState({ ...fields, bookable }, null, { soonDays: daysAhead });

    if (s.state === 'ok' || s.state === 'booked') continue;
    upcoming.push({
      name,
      state: s.state,
      dueDate: s.nextDue || null,
      bookedDate: s.booked || null,
      daysUntil: s.daysUntil !== undefined ? s.daysUntil : -(s.daysOverdue ?? s.daysSince ?? 0),
      overdue: s.state === 'overdue',
      unwritten: s.state === 'unwritten',
      lastMeeting: fields.lastHeld,
    });
  }
  return upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
}

// Get recent decisions from the Decision Log
function getRecentDecisions(daysBack = 14) {
  if (!isConfigured()) return [];
  const filePath = path.join(getVaultPath(), 'Decision Log', 'decisions.md');
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  cutoff.setHours(0, 0, 0, 0);
  const decisions = [];
  let currentDate = null;
  for (const line of content.split('\n')) {
    const dm = line.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (dm) { currentDate = dm[1]; continue; }
    if (currentDate && line.startsWith('- ') && new Date(currentDate) >= cutoff) {
      decisions.push({ date: currentDate, text: line.substring(2).trim() });
    }
  }
  return decisions.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
}

// ISO week number
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Generate a weekly review note in Reflections/ — auto-populated with data from the week
function generateWeeklyReview() {
  if (!isConfigured()) return null;
  const vaultPath = getVaultPath();

  const today = new Date();
  if (today.getDay() !== 5) return { skipped: true }; // Friday only

  // Work out this week's date range (Mon-Fri)
  const monday = new Date(today);
  monday.setDate(today.getDate() - 4);
  const weekStr = `W${getWeekNumber(today)}-${today.getFullYear()}`;
  const reviewPath = path.join(vaultPath, 'Reflections', `${weekStr}-review.md`);

  if (fs.existsSync(reviewPath)) return { skipped: true, weekStr }; // already exists

  const mondayStr = monday.toISOString().split('T')[0];
  const todayStr = today.toISOString().split('T')[0];

  // 1. Decisions from decision log
  const decisions = getRecentDecisions(7);

  // 2. Completed 90-day tasks this week
  let completedPlanTasks = [];
  try {
    const plan = parseNinetyDayPlan();
    if (plan) {
      completedPlanTasks = plan.allTasks.filter(t =>
        t.status === 'x' && t.day >= 0
      ).slice(0, 10);
    }
  } catch {}

  // 3. EOD entries from daily notes this week
  const eodEntries = [];
  for (let d = new Date(monday); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const notePath = path.join(vaultPath, 'Daily', `${dateStr}.md`);
    if (!fs.existsSync(notePath)) continue;
    const content = fs.readFileSync(notePath, 'utf-8');
    const winMatch = content.match(/Win:\s*(.+)/);
    const didntGoMatch = content.match(/Didn't go to plan:\s*(.+)/);
    if (winMatch || didntGoMatch) {
      eodEntries.push({
        date: dateStr,
        win: winMatch?.[1]?.trim() || null,
        didntGo: didntGoMatch?.[1]?.trim() || null
      });
    }
  }

  // 4. Meeting notes created this week
  const meetingNotes = [];
  const meetingsDir = path.join(vaultPath, 'Meetings');
  if (fs.existsSync(meetingsDir)) {
    const files = fs.readdirSync(meetingsDir)
      .filter(f => f.endsWith('.md') && f >= mondayStr)
      .slice(0, 8);
    meetingNotes.push(...files.map(f => f.replace('.md', '')));
  }

  // Build the populated review note
  const sections = [];

  sections.push(`---\ntype: reflection\nsubtype: weekly-review\nweek: ${weekStr}\ndate: ${todayStr}\n---`);
  sections.push(`# Weekly Review — ${weekStr}\n\n*Auto-populated ${new Date().toLocaleString('en-GB')} — edit freely*`);

  // Wins from EOD
  const wins = eodEntries.filter(e => e.win).map(e => `- ${e.date}: ${e.win}`);
  sections.push(`## Wins This Week\n${wins.length > 0 ? wins.join('\n') : '- *(add your wins here)*'}`);

  // Challenges from EOD
  const challenges = eodEntries.filter(e => e.didntGo).map(e => `- ${e.date}: ${e.didntGo}`);
  sections.push(`## Challenges / What Didn't Go To Plan\n${challenges.length > 0 ? challenges.join('\n') : '- *(add challenges here)*'}`);

  // 90-day plan progress
  if (completedPlanTasks.length > 0) {
    const taskLines = completedPlanTasks.map(t => `- [x] Day ${t.day}: ${t.text}`).join('\n');
    sections.push(`## 90-Day Plan — Completed This Week\n${taskLines}`);
  }

  // Decisions
  if (decisions.length > 0) {
    const decLines = decisions.map(d => `- ${d.date}: ${d.text}`).join('\n');
    sections.push(`## Decisions Made\n${decLines}`);
  }

  // Meeting notes
  if (meetingNotes.length > 0) {
    sections.push(`## Meetings / Conversations\n${meetingNotes.map(n => `- [[${n}]]`).join('\n')}`);
  }

  // Orphaned notes
  try {
    const orphans = findOrphanedNotes(8);
    if (orphans.length > 0) {
      sections.push(`## Disconnected Notes (no links)\n*These notes have no connections — worth linking or archiving:*\n${orphans.map(o => `- [[${o.path}|${o.name}]]`).join('\n')}`);
    }
  } catch {}

  // Did the system help? Facts, above the reflective sections, because they
  // should inform the reflection rather than be coloured by it.
  try {
    sections.push(require('./outcomes-report').buildSection());
  } catch (e) {
    console.warn('[Obsidian] Outcomes section failed:', e.message);
  }

  // Energy / reflection (always manual)
  sections.push(`## Energy & Wellbeing\n*(How were your energy levels this week? Any patterns?)*`);
  sections.push(`## Looking Ahead — Next Week\n*(Top 3 priorities for next week)*\n1. \n2. \n3. `);

  const content = sections.join('\n\n');
  const reviewDir = path.join(vaultPath, 'Reflections');
  if (!fs.existsSync(reviewDir)) fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(reviewPath, content, 'utf-8');

  console.log(`[Obsidian] Weekly review generated: ${reviewPath}`);
  return { weekStr, path: reviewPath };
}

// Add a todo to Master Todo inbox via chat command.
//
// ⚠ This passed `{ trigger: 'todo-from-chat' }` while `addTodoToMasterList` reads
// `options.origin`, so the key never matched and every task the model created
// through the `[ADD TODO: ...]` marker landed stamped `source: 'manual'` — AI
// output attributed to Nick, indistinguishable in the data from something he
// typed into the task list himself. `trigger` is kept because it is what the log
// line and any future caller-side reader mean by it; `origin` is what the store
// actually reads.
//
// ⚠ The parameter is NAMED `origin` and feeds the `source` COLUMN — the `origin`
// column is a different thing (commitment vs continual improvement) and is left
// null here deliberately. That is `inferOrigin`'s documented answer for every
// route INTO the store: knowing this was not typed by a human is not the same as
// knowing who wanted the work, and null is a first-class value for exactly that.
function addTodoFromChat(text) {
  addTodoToMasterList(text, { origin: 'chat-marker', trigger: 'todo-from-chat' });
  console.log(`[Chat] Added todo: ${text.trim()}`);
  return true;
}

function toWikiLink(relativePath) {
  const clean = String(relativePath || '').replace(/\\/g, '/').replace(/\.md$/i, '');
  if (!clean) return null;
  const label = clean.split('/').pop() || clean;
  return `[[${clean}|${label}]]`;
}

// Kept for its callers (capture route, chat, SARA suggestion approval) but it no
// longer appends markdown: since 13 Aug 2026 every capture path writes to the tasks
// table and the vault gets a regenerated export note. That also retires the `📥 Inbox`
// heading fragility — the 28 items that landed under `## Links` came from this
// function guessing where to insert — and the `#mustdo` tag, dead since 10 July.
//
// MoSCoW and priority are left unset unless the caller is explicit. An auto-classifier
// that buckets everything is what produced the noise the migration is cleaning up;
// untriaged is the honest state, and the review UI exists to resolve it.
function addTodoToMasterList(text, options = {}) {
  const taskStore = require('./task-store');
  const explicitMoscow = options.metadata?.moscow || (options.mustdo ? 'must' : null);

  const { id, created, task } = taskStore.createTask({
    text,
    moscow: explicitMoscow,
    priority: options.metadata?.priority || null,
    due_date: options.dueDate || null,
    // Passed through unset rather than defaulted here: `task-store.createTask`
    // is the ONE place that decides what an unnamed writer is called, and a
    // second copy of that default is how the two come to disagree. It used to
    // read `|| 'manual'`, which is the claim this change exists to stop making.
    source: options.origin || undefined,
    origin_path: options.sourcePath || null,
  });

  console.log(`[Tasks] ${created ? 'Created' : 'Folded into'} task #${id} (${options.trigger || 'capture'}): ${task.text}`);
  return {
    ok: true,
    taskId: id,
    created,
    text: task.text,
    sourceLink: options.sourcePath ? toWikiLink(options.sourcePath) : null,
    triage: { moscow: task.moscow, context: task.context },
  };
}

// Save a meeting note from chat
function saveMeetingNoteFromChat(title, conversationSummary) {
  const vaultPath = requireVaultPath();
  const meetingsDir = path.join(vaultPath, 'Meetings');
  if (!fs.existsSync(meetingsDir)) fs.mkdirSync(meetingsDir, { recursive: true });

  const today = todayDateString();
  const safeTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
  const filename = `${today}-${safeTitle}.md`;
  const filePath = path.join(meetingsDir, filename);

  const rawContent = `---\ntype: meeting\ndate: ${today}\ntitle: "${title}"\nsource: neuro-chat\n---\n# ${title}\n\n*${today} — captured via NEURO chat*\n\n${conversationSummary}\n`;
  const content = autoLink(rawContent);
  fs.writeFileSync(filePath, content, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(filePath, 'meeting-note'); } catch {}
  console.log(`[Chat] Meeting note saved: ${filename}`);
  return `Meetings/${filename}`;
}

// Sync Microsoft Planner + ToDo tasks into vault file Tasks/Microsoft Tasks.md
async function syncMicrosoftTasks() {
  if (!isConfigured()) return { ok: false, error: 'Vault not configured' };

  const microsoft = require('./microsoft');
  const vaultPath = getVaultPath();
  const tasksDir = path.join(vaultPath, 'Tasks');
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });

  const msTasksPath = path.join(tasksDir, 'Microsoft Tasks.md');
  let plannerCount = 0;
  let todoCount = 0;
  // Track whether Graph actually answered. A failed/unauthenticated fetch returns
  // null rather than throwing, which used to look identical to "you have no tasks"
  // and overwrote the file with an empty header — see the guard before the write.
  let plannerOk = false;
  let todoOk = false;

  const lines = ['# Microsoft Tasks', '', `*Last synced: ${new Date().toLocaleString('en-GB')}*`, ''];

  // Tasks Nick has already ticked whose completion Microsoft would not take.
  // This file is regenerated wholesale from Graph, so without this a held
  // completion is handed straight back to him as an open task within half an
  // hour — the retry lands eventually and he has already ticked it a second
  // time. Suppression lasts only while the push is `pending`: once the queue
  // gives up, the task comes BACK, because hiding real work is the worse
  // failure. Never allowed to throw — an unreadable queue suppresses nothing
  // rather than taking the whole sync down.
  let heldIds = new Set();
  try { heldIds = require('./ms-push-queue').pendingIds(); } catch { heldIds = new Set(); }
  let heldSkipped = 0;

  // --- Planner ---
  try {
    const plannerTasks = await microsoft.fetchPlannerTasks();
    if (Array.isArray(plannerTasks)) plannerOk = true;
    if (plannerTasks && plannerTasks.length > 0) {
      lines.push('## Planner', '');
      // Filter to incomplete tasks only
      const active = plannerTasks.filter(t => !t.completedDateTime && t.percentComplete < 100);
      // Sort by due date (soonest first), then by title
      active.sort((a, b) => {
        if (a.dueDateTime && b.dueDateTime) return a.dueDateTime.localeCompare(b.dueDateTime);
        if (a.dueDateTime) return -1;
        if (b.dueDateTime) return 1;
        return (a.title || '').localeCompare(b.title || '');
      });

      // Which board each task lives on. Grouped under a `### <plan>` heading
      // rather than appended to the line, so the plan survives the parse without
      // any of it landing in the task's own text.
      const planTitles = await microsoft.fetchPlannerPlanNames(active.map(t => t.planId));
      const byPlan = new Map();
      for (const t of active) {
        // A plan whose title could not be read groups under PLAN_UNKNOWN_HEADING
        // — the parser reads that back as null. Never the raw planId: a GUID is
        // not a board name, and printing one asserts a plan Nick cannot identify.
        const heading = planTitles.get(t.planId) || PLAN_UNKNOWN_HEADING;
        if (!byPlan.has(heading)) byPlan.set(heading, []);
        byPlan.get(heading).push(t);
      }
      // Named plans first, alphabetically; the unattributed pile last.
      const headings = [...byPlan.keys()].sort((a, b) => {
        if (a === PLAN_UNKNOWN_HEADING) return 1;
        if (b === PLAN_UNKNOWN_HEADING) return -1;
        return a.localeCompare(b);
      });
      for (const heading of headings) {
        lines.push(`### ${heading}`, '');
        for (const t of byPlan.get(heading)) {
          if (heldIds.has(t.id)) { heldSkipped++; continue; }
          const due = t.dueDateTime ? ` 📅 ${t.dueDateTime.split('T')[0]}` : '';
          const pct = t.percentComplete > 0 ? ` (${t.percentComplete}%)` : '';
          lines.push(`- [ ] ${t.title}${pct}${due}${recComment(t.recurrence)} <!--id:${t.id}-->`);
          plannerCount++;
        }
        lines.push('');
      }
    }
  } catch (e) {
    console.error('[Sync] Planner fetch failed:', e.message);
    lines.push('## Planner', '', '*Failed to fetch — see logs*', '');
  }

  // --- To-Do ---
  try {
    const todoLists = await microsoft.fetchTodoLists();
    if (Array.isArray(todoLists)) todoOk = true;
    if (todoLists && todoLists.length > 0) {
      lines.push('## ToDo', '');
      for (const list of todoLists) {
        // Skip flagged emails list — that's handled by inbox scanner
        if (list.wellknownListName === 'flaggedEmails') continue;
        const tasks = await microsoft.fetchTodoTasks(list.id);
        if (tasks && tasks.length > 0) {
          // Always name the list, including the default "Tasks". It used to be
          // omitted as noise, which left every task in it with no list at all —
          // and "which list is this in" is exactly the question being answered.
          lines.push(`### ${list.displayName || PLAN_UNKNOWN_HEADING}`, '');
          const active = tasks.filter(t => t.status !== 'completed');
          active.sort((a, b) => {
            const aDue = a.dueDateTime?.dateTime || '';
            const bDue = b.dueDateTime?.dateTime || '';
            if (aDue && bDue) return aDue.localeCompare(bDue);
            if (aDue) return -1;
            if (bDue) return 1;
            return (a.title || '').localeCompare(b.title || '');
          });
          for (const t of active) {
            if (heldIds.has(t.id)) { heldSkipped++; continue; }
            const due = t.dueDateTime?.dateTime ? ` 📅 ${t.dueDateTime.dateTime.split('T')[0]}` : '';
            const imp = t.importance === 'high' ? ' ⚡' : '';
            lines.push(`- [ ] ${t.title}${imp}${due}${recComment(t.recurrence)} <!--id:${t.id}-->`);
            todoCount++;
          }
          lines.push('');
        }
      }
    }
  } catch (e) {
    console.error('[Sync] ToDo fetch failed:', e.message);
    lines.push('## ToDo', '', '*Failed to fetch — see logs*', '');
  }

  // NEVER overwrite a populated file with nothing. Graph auth expiring (AADSTS65001)
  // silently returned null here for weeks, so every scheduled run rewrote this file
  // as a bare header — destroying ~26 real tasks and, because the vault is synced,
  // spawning a Syncthing conflict copy every single morning.
  //
  // Only write when Graph actually answered. A genuine "you have zero tasks" still
  // writes (both fetches OK), but a failed fetch now leaves the last good file alone.
  if (!plannerOk && !todoOk) {
    console.warn('[Sync] Microsoft Tasks NOT written — Graph returned nothing (auth expired?). Keeping existing file.');
    return { ok: false, skipped: true, reason: 'graph-unavailable' };
  }

  if (plannerCount + todoCount === 0 && fs.existsSync(msTasksPath)) {
    const existing = fs.readFileSync(msTasksPath, 'utf-8');
    if (/^- \[[ x]\] /m.test(existing)) {
      console.warn('[Sync] Microsoft Tasks NOT written — fetch returned 0 tasks but the file has some. Keeping existing file.');
      return { ok: false, skipped: true, reason: 'refusing-to-empty' };
    }
  }

  fs.writeFileSync(msTasksPath, lines.join('\n'), 'utf-8');
  // heldSkipped is logged rather than left silent: a task missing from the
  // mirror must always have a stated reason, or this becomes indistinguishable
  // from the sync losing work.
  console.log(
    `[Sync] Microsoft Tasks written: ${plannerCount} planner, ${todoCount} todo` +
    (heldSkipped ? ` (${heldSkipped} held — completion queued for retry)` : '')
  );
  return { ok: true, planner: plannerCount, todo: todoCount, held: heldSkipped };
}

// Auto-link: scan content for known People and Project names, add wiki-links
function autoLink(content) {
  if (!isConfigured()) return content;
  const vaultPath = getVaultPath();

  const linkables = new Map();

  const peopleDir = path.join(vaultPath, 'People');
  if (fs.existsSync(peopleDir)) {
    fs.readdirSync(peopleDir).filter(f => f.endsWith('.md')).forEach(f => {
      const name = f.replace('.md', '');
      linkables.set(name, name);
      const parts = name.split(' ');
      if (parts.length > 1) linkables.set(parts[parts.length - 1], name);
    });
  }

  const projectsDir = path.join(vaultPath, 'Projects');
  if (fs.existsSync(projectsDir)) {
    fs.readdirSync(projectsDir).filter(f => f.endsWith('.md')).forEach(f => {
      const name = f.replace('.md', '');
      linkables.set(name, `Projects/${name}`);
    });
  }

  if (linkables.size === 0) return content;

  const [frontmatter, body] = content.startsWith('---')
    ? (() => {
        const end = content.indexOf('---', 3);
        if (end === -1) return ['', content];
        return [content.substring(0, end + 3), content.substring(end + 3)];
      })()
    : ['', content];

  const sorted = [...linkables.entries()].sort((a, b) => b[0].length - a[0].length);

  let linked = body;
  const alreadyLinked = new Set();

  for (const [name, target] of sorted) {
    if (name.length < 3) continue;
    if (alreadyLinked.has(target)) continue;

    const regex = new RegExp(`(?<!\\[\\[)\\b(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b(?!\\]\\])`, 'g');
    if (regex.test(linked)) {
      regex.lastIndex = 0;
      linked = linked.replace(regex, `[[${target}|$1]]`);
      alreadyLinked.add(target);
    }
  }

  return frontmatter + linked;
}

// Find orphaned notes — notes with no outbound wiki-links to other notes
function findOrphanedNotes(maxResults = 10) {
  if (!isConfigured()) return [];
  const vaultPath = getVaultPath();

  const SKIP_DIRS = new Set(['Daily', 'Scripts', 'Templates', '.obsidian', '.git', '.trash', 'Imports', 'Exports']);
  const WIKI_LINK_REGEX = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  const orphans = [];

  function walk(dir, depth) {
    if (depth > 4) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const body = content.replace(/^---[\s\S]*?---\n*/, '');
        const links = [];
        let m;
        WIKI_LINK_REGEX.lastIndex = 0;
        while ((m = WIKI_LINK_REGEX.exec(body)) !== null) links.push(m[1]);
        if (links.length === 0) {
          const relPath = path.relative(vaultPath, fullPath).replace(/\\/g, '/');
          orphans.push({ path: relPath, name: entry.name.replace('.md', '') });
        }
      }
    }
  }

  walk(vaultPath, 0);
  return orphans.slice(0, maxResults);
}

module.exports = {
  requireVaultPath,
  isConfigured,
  readTodayDailyNote,
  writeTodayDailyNote,
  appendToDailyNote,
  readStandup,
  writeStandup,
  readPersonNote,
  listPeopleNotes,
  updatePersonNote,
  writePersonNoteRaw,
  findLatest121Prep,
  appendDecision,
  parseFrontmatter,
  extractTags,
  todayDateString,
  parseVaultTodos,
  parseVaultMustDos,
  parseVaultCalendar,
  fetchCalendarEvents,
  parseNinetyDayPlan,
  toggleTask,
  setTaskPercent,
  setTaskFields,
  readRitualState,
  readPreviousDailyNote,
  searchVault,
  searchVaultSemantic,
  addTodoToMasterList,
  addTodoFromChat,
  saveMeetingNoteFromChat,
  getMeetingPrepContext,
  getUpcoming121s,
  getRecentDecisions,
  generateWeeklyReview,
  syncMicrosoftTasks,
  autoLink,
  findOrphanedNotes
};
