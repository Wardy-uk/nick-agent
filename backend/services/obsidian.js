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

function todayDateString() {
  const d = new Date();
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Daily notes
function readTodayDailyNote() {
  const notePath = path.join(getVaultPath(), 'Daily', `${todayDateString()}.md`);
  if (!fs.existsSync(notePath)) return null;
  return fs.readFileSync(notePath, 'utf-8');
}

function writeTodayDailyNote(content) {
  const dir = path.join(getVaultPath(), 'Daily');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const notePath = path.join(dir, `${todayDateString()}.md`);
  fs.writeFileSync(notePath, content, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(notePath, 'daily-note'); } catch {}
  return notePath;
}

function appendToDailyNote(content) {
  const dir = path.join(getVaultPath(), 'Daily');
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
  const vaultPath = getVaultPath();
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
  const notePath = path.join(getVaultPath(), 'People', `${name}.md`);
  if (!fs.existsSync(notePath)) return null;

  let content = fs.readFileSync(notePath, 'utf-8');

  // Update frontmatter fields
  if (updates.last121 || updates.next121Due || updates.employmentStatus) {
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
      if (updates.next121Due) setField('next-1-2-1-due', updates.next121Due);
      if (updates.employmentStatus) setField('employment-status', updates.employmentStatus);
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
  const peopleDir = path.join(getVaultPath(), 'People');
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
  const dir = path.join(getVaultPath(), 'Decision Log');
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
  const msPath = path.join(vaultPath, 'Tasks', 'Microsoft Tasks.md');
  if (fs.existsSync(msPath)) {
    const content = fs.readFileSync(msPath, 'utf-8');
    const lines = content.split('\n');
    let msSection = 'Planner';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('## ')) {
        if (line.includes('Planner')) msSection = 'MS Planner';
        else if (line.includes('ToDo')) msSection = 'MS ToDo';
        continue;
      }

      const task = parseTaskLine(line);
      if (task) {
        task.source = msSection;
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
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: `${m[4]}:${m[5]}`,
    iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`,
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

// Toggle a task's checkbox in the vault file
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
  return newStatus === 'x' ? 'done' : 'open';
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

// Get upcoming 1-2-1s from People notes — checks direct-report frontmatter and next-1-2-1-due date
function getUpcoming121s(daysAhead = 2) {
  if (!isConfigured()) return [];
  const vaultPath = getVaultPath();
  const peopleDir = path.join(vaultPath, 'People');
  if (!fs.existsSync(peopleDir)) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = [];
  const files = fs.readdirSync(peopleDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(peopleDir, file), 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm['direct-report'] !== 'true') continue;
    const dueStr = fm['next-1-2-1-due'];
    if (!dueStr) continue;
    const due = new Date(dueStr);
    due.setHours(0, 0, 0, 0);
    const daysUntil = Math.round((due - today) / (1000 * 60 * 60 * 24));
    if (daysUntil <= daysAhead) {
      upcoming.push({
        name: file.replace('.md', ''),
        dueDate: dueStr,
        daysUntil,
        overdue: daysUntil < 0,
        lastMeeting: fm['last-1-2-1'] || null
      });
    }
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

// Add a todo to Master Todo inbox via chat command
function addTodoFromChat(text) {
  addTodoToMasterList(text, { trigger: 'todo-from-chat' });
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
    source: options.origin || 'manual',
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
  const vaultPath = getVaultPath();
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
      for (const t of active) {
        const due = t.dueDateTime ? ` 📅 ${t.dueDateTime.split('T')[0]}` : '';
        const pct = t.percentComplete > 0 ? ` (${t.percentComplete}%)` : '';
        lines.push(`- [ ] ${t.title}${pct}${due} <!--id:${t.id}-->`);
        plannerCount++;
      }
      lines.push('');
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
          if (list.displayName !== 'Tasks') lines.push(`### ${list.displayName}`, '');
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
            const due = t.dueDateTime?.dateTime ? ` 📅 ${t.dueDateTime.dateTime.split('T')[0]}` : '';
            const imp = t.importance === 'high' ? ' ⚡' : '';
            lines.push(`- [ ] ${t.title}${imp}${due} <!--id:${t.id}-->`);
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
  console.log(`[Sync] Microsoft Tasks written: ${plannerCount} planner, ${todoCount} todo`);
  return { ok: true, planner: plannerCount, todo: todoCount };
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
  findOrphanedNotes,
  writeReviewToVault
};

// Write a performance review MD file to vault Documents/HR/ folder
function writeReviewToVault(agentName, fileName, content) {
  const vaultPath = getVaultPath();
  if (!vaultPath) throw new Error('Vault path not configured');
  const reviewDir = path.join(vaultPath, 'Documents', 'HR');
  if (!fs.existsSync(reviewDir)) fs.mkdirSync(reviewDir, { recursive: true });
  const filePath = path.join(reviewDir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
