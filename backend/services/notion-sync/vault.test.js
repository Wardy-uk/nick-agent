'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const path = require('path');
const vault = require('./vault');

// ─────────────────────────────────────────────────────────────────────────────
// The anti-loop property.
//
// A pull writes `notion_last_edited` and `notion_synced` INTO the note. If the
// hash covered those, every pull would change the hash, the next pass would read
// that as a vault edit and push it straight back — two systems rewriting one
// note every 15 minutes, forever, with nobody having typed anything.
// ─────────────────────────────────────────────────────────────────────────────

test('the hash ignores the frontmatter this sync writes, so a pull does not look like an edit', () => {
  const body = '# Heading\n\nSome content.';
  const first = vault.serialiseNote({ frontmatterLines: [], body }, {
    source: 'notion-sync',
    notion_page_id: 'page-1',
    notion_last_edited: '2026-08-29T10:00:00.000Z',
    notion_synced: '2026-08-29T10:00:01.000Z',
  });
  // A later pull with an identical body but new stamps.
  const second = vault.serialiseNote({ frontmatterLines: [], body }, {
    source: 'notion-sync',
    notion_page_id: 'page-1',
    notion_last_edited: '2026-08-29T11:00:00.000Z',
    notion_synced: '2026-08-29T11:00:02.000Z',
  });

  assert.notEqual(first, second, 'the files should differ — the stamps moved');
  assert.equal(
    vault.parseNote(first).hash ?? vault.contentHash(vault.parseNote(first).body),
    vault.contentHash(vault.parseNote(second).body),
    'but the CONTENT hash must not move, or the note churns forever',
  );
});

test('the hash a pull records matches the hash the next read computes', () => {
  // pullPage stores contentHash(markdown); the next pass reads the file back and
  // hashes the parsed body. Those two must agree or every note pushes once.
  const markdown = '## Notes\n\n- one\n- two';
  const file = vault.serialiseNote({ frontmatterLines: [], body: markdown }, {
    source: 'notion-sync', notion_page_id: 'p', notion_last_edited: 't', notion_synced: 's',
  });
  assert.equal(vault.contentHash(vault.parseNote(file).body), vault.contentHash(markdown));
});

test('CRLF is not an edit', () => {
  assert.equal(vault.contentHash('a\r\nb'), vault.contentHash('a\nb'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter preservation — the reason this is not obsidian.updateFrontmatter.
// ─────────────────────────────────────────────────────────────────────────────

test('a YAML LIST value written by something else survives a pull', () => {
  // updateFrontmatter's line-based reserialise drops these (the reason
  // restampMeetingPeople hand-writes its block). A synced note routinely carries
  // tags: or people: from the import pipeline, and losing them would be silent.
  const original = [
    '---',
    'tags:',
    '  - project',
    '  - notion',
    'people:',
    '  - "[[People/Hope Goodall]]"',
    'notion_page_id: old-id',
    '---',
    '',
    'Body text.',
  ].join('\n');

  const parsed = vault.parseNote(original);
  const rewritten = vault.serialiseNote(parsed, {
    source: 'notion-sync',
    notion_page_id: 'new-id',
    notion_last_edited: 't2',
    notion_synced: 's2',
  });

  assert.match(rewritten, /tags:/);
  assert.match(rewritten, /- project/);
  assert.match(rewritten, /- notion/);
  assert.match(rewritten, /\[\[People\/Hope Goodall\]\]/);
  assert.match(rewritten, /notion_page_id: new-id/);
  assert.ok(!rewritten.includes('old-id'), 'the owned key must be replaced, not duplicated');
});

test('rewriting is idempotent — a second pass changes nothing', () => {
  const stamps = { source: 'notion-sync', notion_page_id: 'p', notion_last_edited: 't', notion_synced: 's' };
  const once = vault.serialiseNote(vault.parseNote('---\ntags:\n  - a\n---\n\nText.'), stamps);
  const twice = vault.serialiseNote(vault.parseNote(once), stamps);
  assert.equal(twice, once);
});

test('a note with no frontmatter gains one without losing its body', () => {
  const out = vault.serialiseNote(vault.parseNote('Just text.\n'), { notion_page_id: 'p' });
  assert.match(out, /^---\nnotion_page_id: p\n---\n\nJust text\.\n$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Naming.
// ─────────────────────────────────────────────────────────────────────────────

test('a page title becomes a filename that is legal on Windows and inert in Obsidian', () => {
  // Spaces are KEPT deliberately — this vault is full of them, and hyphenating
  // would make every synced note look unlike every hand-written one.
  assert.equal(vault.safeFileName('Q3: Plan/Review'), 'Q3- Plan-Review');
  assert.equal(vault.safeFileName('Team Handbook'), 'Team Handbook');
  // Link and tag syntax is stripped so a title cannot yield a filename that
  // re-parses as a wikilink.
  assert.equal(vault.safeFileName('[[Linked]] #tag'), 'Linked tag');
  // A backslash is illegal on Windows and must be replaced, not passed through.
  assert.equal(vault.safeFileName('a\\b'), 'a-b');
  assert.equal(vault.safeFileName('   '), 'Untitled');
  // A trailing dot makes a file unopenable on Windows.
  assert.equal(vault.safeFileName('trailing dots...'), 'trailing dots');
});

test('the conflict copy uses the infix vault-exclusions already ignores', () => {
  // `.sync-conflict-` is in GENERATED_FILE_PATTERNS, so a conflict copy stays
  // out of embeddings and entity extraction for free — and Syncthing already
  // writes this shape in this vault, so Nick has seen it before.
  const target = vault.conflictPath('Projects/Notion/Plan.md', new Date('2026-08-29T14:32:00'));
  assert.match(target, /\.sync-conflict-notion-20260829-1432\.md$/);
  assert.match(target, /\.sync-conflict-/, 'must match the existing exclusion pattern');

  const { GENERATED_FILE_PATTERNS } = require('../vault-exclusions');
  assert.ok(
    GENERATED_FILE_PATTERNS.some((re) => re.test(target.split('/').pop())),
    'a conflict copy must already be excluded from the retrieval index',
  );
});

test('a conflict copy is not re-synced as if it were a note', () => {
  // listNotes must skip them, or the copy becomes a new page in Notion.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-sync-vault-'));
  try {
    fs.mkdirSync(path.join(root, 'Notes'));
    fs.writeFileSync(path.join(root, 'Notes', 'Plan.md'), 'x');
    fs.writeFileSync(path.join(root, 'Notes', 'Plan.sync-conflict-notion-20260829-1432.md'), 'y');
    const found = vault.listNotes(root, 'Notes');
    assert.deepEqual(found, ['Notes/Plan.md']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('_about.md is not published — it describes the folder, not the subject', () => {
  // This vault uses _about.md as a folder description (Areas/, MOCs/, Tasks/).
  // MOCs/_about.md reached Notion as "Navigation hubs that link related notes
  // across folders" — noise in a tree meant to answer "who I am and what I do".
  const fs2 = require('fs');
  const os2 = require('os');
  const path2 = require('path');
  const root2 = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'notion-about-'));
  try {
    fs2.mkdirSync(path2.join(root2, 'MOCs'));
    fs2.writeFileSync(path2.join(root2, 'MOCs', '_about.md'), 'folder description');
    fs2.writeFileSync(path2.join(root2, 'MOCs', 'MOC - NOVA.md'), 'real content');
    assert.deepEqual(vault.listNotes(root2, 'MOCs'), ['MOCs/MOC - NOVA.md']);
  } finally { fs2.rmSync(root2, { recursive: true, force: true }); }
});

// A pulled page is not an orphan (7 Sep 2026).
//
// A page mirrored from Notion arrived linked to nothing: its parent lives in
// Notion and nothing wrote that into the vault, so 13 of the vault's 58 orphans
// were Notion mirrors.

test('the hub is created once and never rewritten', () => {
  const fs = require('fs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-hub-'));

  const first = vault.ensureHubNote(root);
  assert.equal(first.created, true);
  assert.equal(first.relPath, vault.NOTION_HUB_PATH);

  // ⚠ It is a map of content Nick may edit. Rewriting it on every sync would
  // make it the sync's file rather than his.
  const edited = '# Mine now';
  fs.writeFileSync(path.join(root, vault.NOTION_HUB_PATH), edited, 'utf8');
  const second = vault.ensureHubNote(root);
  assert.equal(second.created, false);
  assert.equal(fs.readFileSync(path.join(root, vault.NOTION_HUB_PATH), 'utf8'), edited);
});

test('the hub link is frontmatter, so it never enters the body hash', () => {
  // ⚠ The load-bearing rule. Change detection hashes the BODY; a link appended
  // there would read as a vault edit on the next pass and push straight back to
  // Notion — a two-system loop nobody typed into.
  const body = 'Just the page content.';
  const content = vault.serialiseNote({ frontmatterLines: [], body }, {
    notion_page_id: 'abc',
    notion_hub: '"[[' + vault.NOTION_HUB + ']]"',
  });

  const parsed = vault.parseNote(content);
  assert.equal(parsed.body.trim(), body, 'the body must be untouched by the hub stamp');
  assert.equal(vault.contentHash(parsed.body), vault.contentHash(body));
  assert.ok(content.includes('[[' + vault.NOTION_HUB + ']]'), 'and the link must actually be there');
});

test('notion_hub is one of OUR keys, so a re-pull replaces it rather than stacking', () => {
  assert.ok(vault.OWNED_KEYS.includes('notion_hub'));
  const once = vault.serialiseNote({ frontmatterLines: [], body: 'x' }, { notion_hub: '"[[H]]"' });
  const twice = vault.serialiseNote(vault.parseNote(once), { notion_hub: '"[[H]]"' });
  assert.equal(twice.split('notion_hub:').length - 1, 1, 'a second sync must not add a second stamp');
});

test('the PULL WRITER actually stamps the hub', () => {
  // ⚠ Written because the first cut of this feature shipped the hub defined,
  // exported and tested here — and nothing in `index.js` calling it. A helper
  // with no caller is the reader-with-no-writer shape, and every test above
  // passes happily while not one real note gets linked.
  //
  // A source scan rather than a mocked pull: `pullPage` needs the Notion API,
  // and the thing worth pinning is only that the writer reaches for the hub.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

  const pull = src.slice(src.indexOf('async function pullPage('));
  assert.ok(pull.length > 0, 'positive control: pullPage must still exist under this name');

  const body = pull.slice(0, pull.indexOf('\nasync function ', 1));
  assert.match(body, /ensureHubNote\(/, 'the pull must ensure the hub exists');
  assert.match(body, /notion_hub:/, 'and must stamp the link onto the note');
  // ⚠ Frontmatter only. If the stamp ever moves into the body it starts a
  // push-back loop with Notion, so the marker must sit in the updates object.
  assert.ok(body.indexOf('notion_hub:') < body.indexOf('vault.writeNote('),
    'the stamp belongs in the serialise updates, not appended after the write');
});
