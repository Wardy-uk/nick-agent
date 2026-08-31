'use strict';

// Notion blocks <-> markdown, BOTH directions, pure. No fs, no network, no clock.
//
// This is the file the whole bidirectional sync stands on, and the property that
// matters is not "does it render nicely" — it is ROUND-TRIP STABILITY:
//
//     toMarkdown(toBlocks(toMarkdown(blocks))) === toMarkdown(blocks)
//
// If that does not hold, a note whose vault copy and Notion copy are semantically
// identical still hashes differently every pass, so the reconciler sees a change
// that nobody made and the note churns between the two systems forever, burning
// API quota and rewriting Nick's file every two minutes. A lossy converter is
// survivable; an UNSTABLE one is not, and the failure looks like "the sync is
// broken" rather than "bold got dropped". Hence round-trip.test.js.
//
// ── The supported set is CLOSED, on purpose ─────────────────────────────────
// Notion has ~30 block types; markdown maps cleanly to nine of them. The obvious
// implementation renders the other twenty-one as best it can (or as nothing) and
// pushes that back — which DELETES a database view, a synced block or an embed
// from a real Notion page the first time Nick edits the note in Obsidian.
//
// So anything outside the supported set is not converted at all. It is emitted as
// a `<!-- notion:keep:N -->` marker and its raw JSON is stashed in the sync state,
// to be put back verbatim on push. The marker is an HTML comment, so Obsidian
// renders nothing where it sits.
//
// ⚠ An unresolvable marker (state lost, hand-edited number) FAILS CLOSED — the
// push is refused for that note. The alternative is silently dropping a block we
// explicitly promised to preserve, which is the exact damage the mechanism exists
// to prevent, arriving later and with less warning.

const KEEP_RE = /^<!--\s*notion:keep:(\d+)\s*-->$/;

// Block types we convert. Everything else is preserved verbatim via a keep marker.
const SUPPORTED = new Set([
  'paragraph', 'heading_1', 'heading_2', 'heading_3',
  'bulleted_list_item', 'numbered_list_item', 'to_do',
  'quote', 'code', 'divider',
]);

const LIST_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do']);

// ── Rich text ───────────────────────────────────────────────────────────────
//
// Colour is deliberately DROPPED rather than preserved. Preserving it would mean
// a keep-marker per span, which turns every coloured paragraph into an opaque
// comment in the file Nick reads — the cure being worse than the disease for a
// purely cosmetic annotation. The loss is bounded by when a push happens at all:
// a note is only ever pushed if Nick EDITED it in Obsidian, so nothing is lost on
// a note he merely read. See README, "What does not survive a round trip".

/** Escape the characters that would otherwise re-parse as markup. */
function escapeInline(text) {
  return String(text)
    .replace(/([\\`*[\]~<])/g, '\\$1')
    // `_` only where it could actually open emphasis. Escaping it unconditionally
    // mangles every snake_case identifier in the vault for no gain.
    .replace(/(^|[^\w\\])_/g, '$1\\_');
}

function escapeLineStart(line) {
  return line.replace(/^(\s*)([-+>#]|\d+\.)(\s)/, '$1\\$2$3');
}

/** Notion rich_text[] -> markdown string. */
function richTextToMarkdown(items = []) {
  return items.map((item) => {
    const raw = item.plain_text ?? item.text?.content ?? '';
    if (!raw) return '';
    const a = item.annotations || {};
    const href = item.href || item.text?.link?.url || null;

    // Code spans do not nest other markup in markdown, so code wins and the other
    // annotations on that span are dropped. Stable under round trip: re-parsing
    // yields code alone, which is what we emitted.
    let out = a.code ? `\`${raw}\`` : escapeInline(raw);
    if (!a.code) {
      if (a.bold) out = `**${out}**`;
      if (a.italic) out = `*${out}*`;
      if (a.strikethrough) out = `~~${out}~~`;
      if (a.underline) out = `<u>${out}</u>`;
    }
    if (href) out = `[${out}](${href})`;
    return out;
  }).join('');
}

function span(content, annotations = {}, link = null) {
  const ann = {
    bold: false, italic: false, strikethrough: false,
    underline: false, code: false, color: 'default', ...annotations,
  };
  const item = { type: 'text', text: { content, link: link ? { url: link } : null }, annotations };
  item.annotations = ann;
  item.plain_text = content;
  item.href = link || null;
  return item;
}

// Ordered so the longest/most specific delimiter is tried first — `**` before `*`,
// or every bold span parses as two empty italics.
const INLINE_RULES = [
  { re: /^`([^`]+)`/, make: (m) => span(m[1], { code: true }) },
  { re: /^\[(.+?)\]\((\S*?)\)/, link: true },
  // ⚠ `***both***` MUST be tried before `**`, or the bold rule matches `**` and
  // captures `*both`, leaving a stray asterisk that gets escaped — so a
  // bold-italic span is rewritten on every pass and the note churns forever.
  // Caught by the round-trip test, which is exactly what it is there for.
  { re: /^\*\*\*(.+?)\*\*\*/, ann: { bold: true, italic: true } },
  { re: /^\*\*(.+?)\*\*/, ann: { bold: true } },
  { re: /^~~(.+?)~~/, ann: { strikethrough: true } },
  { re: /^<u>(.+?)<\/u>/, ann: { underline: true } },
  { re: /^\*(.+?)\*/, ann: { italic: true } },
  { re: /^_(.+?)_(?![\w])/, ann: { italic: true } },
];

/** markdown string -> Notion rich_text[]. */
function markdownToRichText(text) {
  const out = [];
  let buffer = '';
  let rest = String(text);

  const flush = () => { if (buffer) { out.push(span(buffer)); buffer = ''; } };

  while (rest.length) {
    if (rest[0] === '\\' && rest.length > 1) { buffer += rest[1]; rest = rest.slice(2); continue; }

    let matched = false;
    for (const rule of INLINE_RULES) {
      const m = rest.match(rule.re);
      if (!m) continue;
      // `_italic_` must not fire inside a word (snake_case), matching escapeInline.
      if (rule.re.source.startsWith('^_')) {
        const prev = out.length || buffer ? (buffer.slice(-1) || ' ') : ' ';
        if (/\w/.test(prev)) continue;
      }
      flush();
      if (rule.link) {
        // Link text may itself carry markup: [**bold**](url).
        const inner = markdownToRichText(m[1]);
        for (const part of (inner.length ? inner : [span(m[1])])) {
          out.push(span(part.plain_text, part.annotations, m[2]));
        }
      } else if (rule.make) {
        out.push(rule.make(m));
      } else {
        const inner = markdownToRichText(m[1]);
        for (const part of (inner.length ? inner : [span(m[1])])) {
          out.push(span(part.plain_text, { ...part.annotations, ...rule.ann }, part.href));
        }
      }
      rest = rest.slice(m[0].length);
      matched = true;
      break;
    }
    if (matched) continue;

    buffer += rest[0];
    rest = rest.slice(1);
  }
  flush();
  return out;
}

// ── Blocks -> markdown ──────────────────────────────────────────────────────

// ⚠ A child page is a NOTE, not content of its parent, and must never enter the
// keep stash.
//
// Found by probing real pages rather than by a unit test: the D&D root page has
// seven of these, and they were being preserved like any other unsupported
// block. That breaks on the first PUSH — `replaceChildren` re-appends whatever
// the stash holds, and Notion REJECTS `child_page` on the append endpoint (a
// page is created, never appended as a block). So every parent page with
// children — which is most of them — would have failed to push, with a 400 that
// named a block type rather than the problem.
//
// Skipped outright instead: `readNotionTree` already walks these into their own
// notes in a subfolder, and `replaceChildren` deliberately leaves existing
// child pages alone in Notion, so both halves are handled without the parent's
// markdown mentioning them. Emitting a `[[wikilink]]` instead was the tempting
// alternative and is worse: it re-parses as an ordinary bullet, so every push
// would add a duplicate list item to the Notion page.
const NOT_CONTENT = new Set(['child_page', 'child_database']);

function blockToMarkdown(block, indent, keep) {
  const type = block.type;

  if (NOT_CONTENT.has(type)) return '';

  if (!SUPPORTED.has(type)) {
    // Preserved verbatim. `keep` is the caller's stash; the index is its length,
    // so markers are numbered in document order and stay stable across a pass.
    const index = keep.length;
    keep.push(block);
    return `${indent}<!-- notion:keep:${index} -->\n\n`;
  }

  const data = block[type] || {};
  const text = richTextToMarkdown(data.rich_text || []);

  switch (type) {
    case 'paragraph':
      return text ? `${indent}${escapeLineStart(text)}\n\n` : '';
    case 'heading_1': return `${indent}# ${text}\n\n`;
    case 'heading_2': return `${indent}## ${text}\n\n`;
    case 'heading_3': return `${indent}### ${text}\n\n`;
    case 'bulleted_list_item': return `${indent}- ${text}\n`;
    case 'numbered_list_item': return `${indent}1. ${text}\n`;
    case 'to_do': return `${indent}- [${data.checked ? 'x' : ' '}] ${text}\n`;
    case 'quote':
      return `${text.split('\n').map((l) => `${indent}> ${l}`).join('\n')}\n\n`;
    case 'code':
      return `${indent}\`\`\`${data.language && data.language !== 'plain text' ? data.language : ''}\n${
        (data.rich_text || []).map((i) => i.plain_text ?? i.text?.content ?? '').join('')
      }\n${indent}\`\`\`\n\n`;
    case 'divider': return `${indent}---\n\n`;
    default: return '';
  }
}

/**
 * Notion block tree -> markdown body.
 *
 * Returns `{ markdown, keep }` — `keep` is the ordered stash of unsupported
 * blocks that the `notion:keep:N` markers refer to. The caller persists it
 * alongside the note's sync state; without it a later push cannot be honest and
 * will refuse (see markdownToBlocks).
 */
function blocksToMarkdown(blocks, { indent = '', keep = [] } = {}) {
  let markdown = '';
  let previousWasList = false;

  for (const block of blocks) {
    const isList = LIST_TYPES.has(block.type);
    // A list that follows a non-list needs no separator; a non-list following a
    // list needs the blank line, or the paragraph is swallowed into the item.
    if (previousWasList && !isList && markdown && !markdown.endsWith('\n\n')) markdown += '\n';

    markdown += blockToMarkdown(block, indent, keep);

    if (block.has_children && block.children && SUPPORTED.has(block.type)) {
      const nested = blocksToMarkdown(block.children, { indent: `${indent}  `, keep });
      markdown += nested.markdown;
    }
    previousWasList = isList;
  }
  return { markdown, keep };
}

// ── Markdown -> blocks ──────────────────────────────────────────────────────

function makeBlock(type, payload) {
  return { object: 'block', type, [type]: payload };
}

function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return Math.floor(m[1].replace(/\t/g, '  ').length / 2);
}

/**
 * markdown body -> Notion block tree.
 *
 * `keep` is the stash recorded by the matching blocksToMarkdown call. A marker
 * with no entry in it throws: pushing would silently delete a block we said we
 * would preserve, so the note is refused instead. `strict:false` is available for
 * tests and for a deliberate one-way rebuild.
 */
function markdownToBlocks(markdown, { keep = [], strict = true } = {}) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const root = [];
  // Stack of open list levels, so `  - child` attaches to the item above it.
  const stack = [{ level: -1, children: root }];

  const push = (block, level) => {
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].children.push(block);
    return block;
  };

  let paragraph = [];
  let paragraphIndent = 0;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join('\n');
    push(makeBlock('paragraph', { rich_text: markdownToRichText(text) }), paragraphIndent);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    const level = indentOf(raw);

    if (!line) { flushParagraph(); continue; }

    const keepMatch = line.match(KEEP_RE);
    if (keepMatch) {
      flushParagraph();
      const index = Number(keepMatch[1]);
      const stashed = keep[index];
      if (!stashed) {
        if (strict) {
          throw new Error(
            `notion:keep:${index} has no preserved block. Refusing to push this note — `
            + 'pushing would delete a Notion block the sync promised to keep. '
            + 'Re-pull the note to rebuild its preserved set.',
          );
        }
        continue;
      }
      push(stashed, level);
      continue;
    }

    // Fenced code. Consumed whole here so nothing inside it is parsed as markup.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      push(makeBlock('code', {
        rich_text: [span(body.join('\n'))],
        language: fence[1] || 'plain text',
      }), level);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      push(makeBlock(`heading_${heading[1].length}`, {
        rich_text: markdownToRichText(heading[2]),
      }), level);
      continue;
    }

    if (/^(---|\*\*\*|___)$/.test(line)) {
      flushParagraph();
      push(makeBlock('divider', {}), level);
      continue;
    }

    // Consecutive `> ` lines are ONE quote block, matching how we emit them.
    if (/^>\s?/.test(line)) {
      flushParagraph();
      const body = [line.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) {
        i += 1;
        body.push(lines[i].trim().replace(/^>\s?/, ''));
      }
      push(makeBlock('quote', { rich_text: markdownToRichText(body.join('\n')) }), level);
      continue;
    }

    const todo = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      flushParagraph();
      const block = push(makeBlock('to_do', {
        rich_text: markdownToRichText(todo[2]),
        checked: todo[1].toLowerCase() === 'x',
      }), level);
      stack.push({ level, children: (block.to_do.children = []) });
      continue;
    }

    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      const block = push(makeBlock('bulleted_list_item', {
        rich_text: markdownToRichText(bullet[1]),
      }), level);
      stack.push({ level, children: (block.bulleted_list_item.children = []) });
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      const block = push(makeBlock('numbered_list_item', {
        rich_text: markdownToRichText(numbered[1]),
      }), level);
      stack.push({ level, children: (block.numbered_list_item.children = []) });
      continue;
    }

    if (!paragraph.length) paragraphIndent = level;
    paragraph.push(line);
  }
  flushParagraph();

  return prune(root);
}

/** Drop the empty `children: []` we speculatively attached — Notion rejects them. */
function prune(blocks) {
  for (const block of blocks) {
    const data = block[block.type];
    if (data && Array.isArray(data.children)) {
      if (!data.children.length) delete data.children;
      else prune(data.children);
    }
  }
  return blocks;
}

module.exports = {
  SUPPORTED,
  blocksToMarkdown,
  markdownToBlocks,
  richTextToMarkdown,
  markdownToRichText,
  escapeInline,
  KEEP_RE,
};
