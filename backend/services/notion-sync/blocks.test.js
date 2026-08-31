'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  blocksToMarkdown, markdownToBlocks, richTextToMarkdown, markdownToRichText,
} = require('./blocks');

// Shorthand for a Notion rich_text span.
const rt = (content, annotations = {}, href = null) => ({
  type: 'text',
  text: { content, link: href ? { url: href } : null },
  annotations: {
    bold: false, italic: false, strikethrough: false,
    underline: false, code: false, color: 'default', ...annotations,
  },
  plain_text: content,
  href,
});

const block = (type, payload) => ({ object: 'block', type, [type]: payload });
const para = (...spans) => block('paragraph', { rich_text: spans });

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip stability — the property the sync stands on.
//
// Not "the markdown looks right" but "converting twice changes nothing". If this
// fails, a note with no real edits still hashes differently every pass and churns
// between the two systems forever.
// ─────────────────────────────────────────────────────────────────────────────

function assertStable(blocks, label) {
  const first = blocksToMarkdown(blocks);
  const reparsed = markdownToBlocks(first.markdown, { keep: first.keep });
  const second = blocksToMarkdown(reparsed);
  assert.equal(second.markdown, first.markdown, `${label}: markdown is not stable across a round trip`);
}

test('round trip is stable for every supported block type', () => {
  const cases = {
    paragraph: [para(rt('Plain sentence.'))],
    headings: [
      block('heading_1', { rich_text: [rt('One')] }),
      block('heading_2', { rich_text: [rt('Two')] }),
      block('heading_3', { rich_text: [rt('Three')] }),
    ],
    bullets: [
      block('bulleted_list_item', { rich_text: [rt('First')] }),
      block('bulleted_list_item', { rich_text: [rt('Second')] }),
    ],
    numbered: [
      block('numbered_list_item', { rich_text: [rt('Step one')] }),
      block('numbered_list_item', { rich_text: [rt('Step two')] }),
    ],
    todo: [
      block('to_do', { rich_text: [rt('Done thing')], checked: true }),
      block('to_do', { rich_text: [rt('Open thing')], checked: false }),
    ],
    quote: [block('quote', { rich_text: [rt('Something said')] })],
    code: [block('code', { rich_text: [rt('const x = 1;')], language: 'javascript' })],
    divider: [block('divider', {})],
    mixed: [
      block('heading_2', { rich_text: [rt('Notes')] }),
      para(rt('Intro line.')),
      block('bulleted_list_item', { rich_text: [rt('a point')] }),
      block('divider', {}),
      para(rt('After.')),
    ],
  };
  for (const [label, blocks] of Object.entries(cases)) assertStable(blocks, label);
});

test('round trip is stable for every inline annotation', () => {
  assertStable([para(rt('bold', { bold: true }))], 'bold');
  assertStable([para(rt('italic', { italic: true }))], 'italic');
  assertStable([para(rt('struck', { strikethrough: true }))], 'strikethrough');
  assertStable([para(rt('under', { underline: true }))], 'underline');
  assertStable([para(rt('code()', { code: true }))], 'code');
  assertStable([para(rt('NEURO', {}, 'https://example.com'))], 'link');
  assertStable([para(rt('both', { bold: true, italic: true }))], 'bold+italic');
  assertStable([para(rt('Read '), rt('the docs', { bold: true }, 'https://x.dev'), rt(' first.'))], 'mixed spans');
});

test('a nested list survives the round trip at its own depth', () => {
  const blocks = [
    { ...block('bulleted_list_item', { rich_text: [rt('parent')] }),
      has_children: true,
      children: [block('bulleted_list_item', { rich_text: [rt('child')] })] },
  ];
  const { markdown } = blocksToMarkdown(blocks);
  assert.match(markdown, /^- parent\n {2}- child\n$/);

  const reparsed = markdownToBlocks(markdown);
  assert.equal(reparsed.length, 1);
  assert.equal(reparsed[0].bulleted_list_item.children.length, 1);
  assert.equal(reparsed[0].bulleted_list_item.children[0].bulleted_list_item.rich_text[0].plain_text, 'child');
});

// ─────────────────────────────────────────────────────────────────────────────
// Escaping. The round trip is what these protect, so each is asserted as a
// property (parses back to the same TEXT), not as an exact output string.
// ─────────────────────────────────────────────────────────────────────────────

test('markup characters in plain prose survive rather than becoming markup', () => {
  for (const text of [
    'a * b * c', 'use the [brackets] here', '2 ~ 3', 'file_name_with_underscores.md',
    'literal `backtick`? no', 'a\\b', '<u> not underline',
  ]) {
    const { markdown, keep } = blocksToMarkdown([para(rt(text))]);
    const back = markdownToBlocks(markdown, { keep });
    assert.equal(back[0].paragraph.rich_text.map((s) => s.plain_text).join(''), text,
      `plain text was mangled: ${text}`);
  }
});

test('snake_case is not italicised — the underscore rule is word-boundary aware', () => {
  const { markdown } = blocksToMarkdown([para(rt('call parse_leading_json now'))]);
  const back = markdownToBlocks(markdown);
  assert.equal(back[0].paragraph.rich_text.map((s) => s.plain_text).join(''), 'call parse_leading_json now');
});

test('a paragraph that starts with a list marker does not become a list', () => {
  const { markdown, keep } = blocksToMarkdown([para(rt('- not a bullet'))]);
  const back = markdownToBlocks(markdown, { keep });
  assert.equal(back[0].type, 'paragraph');
  assert.equal(back[0].paragraph.rich_text[0].plain_text, '- not a bullet');
});

test('markdown inside a code fence is not parsed as markup', () => {
  const blocks = [block('code', { rich_text: [rt('# not a heading\n- not a bullet')], language: 'markdown' })];
  const { markdown } = blocksToMarkdown(blocks);
  const back = markdownToBlocks(markdown);
  assert.equal(back.length, 1);
  assert.equal(back[0].type, 'code');
  assert.equal(back[0].code.rich_text[0].plain_text, '# not a heading\n- not a bullet');
});

// ─────────────────────────────────────────────────────────────────────────────
// Unsupported blocks — the preservation mechanism.
// ─────────────────────────────────────────────────────────────────────────────

test('an unsupported block is preserved verbatim, not rendered and not dropped', () => {
  const embed = { object: 'block', id: 'abc', type: 'embed', embed: { url: 'https://figma.com/x' } };
  const blocks = [para(rt('Before.')), embed, para(rt('After.'))];

  const { markdown, keep } = blocksToMarkdown(blocks);
  assert.match(markdown, /<!-- notion:keep:0 -->/);
  assert.equal(keep.length, 1);
  assert.equal(keep[0], embed, 'the raw block itself must be stashed');

  const back = markdownToBlocks(markdown, { keep });
  assert.deepEqual(back[1], embed, 'the embed must come back byte-identical');
});

test('an unresolvable keep marker REFUSES the push rather than dropping the block', () => {
  assert.throws(
    () => markdownToBlocks('Text\n\n<!-- notion:keep:7 -->\n', { keep: [] }),
    /Refusing to push/,
    'a lost stash must fail closed — silently dropping is the damage this prevents',
  );
});

test('a child page is SKIPPED, never preserved — it is a note, not content', () => {
  // ⚠ Found by probing a real page, not by reasoning. Stashing these breaks the
  // first push: replaceChildren re-appends the stash and Notion REJECTS
  // child_page on the append endpoint, so every parent page with children —
  // most of them — would have failed with a 400 naming a block type.
  const child = {
    object: 'block', id: 'c1', type: 'child_page', child_page: { title: 'Sessions' },
  };
  const { markdown, keep } = blocksToMarkdown([para(rt('Intro.')), child]);

  assert.equal(keep.length, 0, 'a child page must not enter the keep stash');
  assert.ok(!markdown.includes('notion:keep'), 'and must not leave a marker');
  // Nor a wikilink: that re-parses as an ordinary bullet, so every push would
  // append a duplicate list item to the Notion page.
  assert.ok(!markdown.includes('[['), 'and must not become a link');
  assert.equal(markdown.trim(), 'Intro.');
});

test('a child database is skipped for the same reason', () => {
  const db = { object: 'block', id: 'd1', type: 'child_database', child_database: { title: 'Tasks' } };
  const { markdown, keep } = blocksToMarkdown([db]);
  assert.equal(keep.length, 0);
  assert.equal(markdown.trim(), '');
});

test('several unsupported blocks keep their document order', () => {
  const a = { object: 'block', type: 'embed', embed: { url: 'a' } };
  const b = { object: 'block', type: 'table_of_contents', table_of_contents: {} };
  const { markdown, keep } = blocksToMarkdown([a, para(rt('mid')), b]);
  const back = markdownToBlocks(markdown, { keep });
  assert.deepEqual([back[0], back[2]], [a, b]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rich text unit level.
// ─────────────────────────────────────────────────────────────────────────────

test('rich text renders and parses annotations symmetrically', () => {
  assert.equal(richTextToMarkdown([rt('x', { bold: true })]), '**x**');
  assert.equal(richTextToMarkdown([rt('x', { code: true })]), '`x`');
  assert.equal(richTextToMarkdown([rt('x', {}, 'https://a.b')]), '[x](https://a.b)');

  const parsed = markdownToRichText('**bold** and `code`');
  assert.equal(parsed[0].plain_text, 'bold');
  assert.equal(parsed[0].annotations.bold, true);
  assert.equal(parsed.at(-1).annotations.code, true);
});

test('a code span drops competing annotations rather than nesting them illegibly', () => {
  // Markdown cannot express bold-inside-code. Whatever we choose must be STABLE,
  // which is the only property that matters here.
  assertStable([para(rt('x', { code: true, bold: true }))], 'code+bold');
});

// ─────────────────────────────────────────────────────────────────────────────
// Notion's code-language enum.
//
// ⚠ Clamped at the API boundary (notion-api), NOT here. blocks.js's contract is
// round-trip stability, and rewriting `dataview` to `plain text` during parsing
// would make every note containing one churn between the two systems for ever.
// These tests assert BOTH halves of that split.
// ─────────────────────────────────────────────────────────────────────────────

const notionApi = require('./notion-api');

test('an Obsidian-only fence survives the markdown round trip untouched', () => {
  // `dataview` appears 811 times in this vault. The converter must not rewrite it.
  const blocks = [block('code', { rich_text: [rt('TABLE file.name')], language: 'dataview' })];
  const { markdown } = blocksToMarkdown(blocks);
  assert.match(markdown, /```dataview/);
  const back = markdownToBlocks(markdown);
  assert.equal(back[0].code.language, 'dataview', 'the converter must preserve it verbatim');
  assertStable(blocks, 'dataview fence');
});

test('the API boundary clamps an unknown language rather than failing the publish', () => {
  // Notion 400s on anything outside its enum — it does not fall back. Four MOCs
  // failed to publish on the first real run for exactly this.
  assert.equal(notionApi.notionLanguage('dataview'), 'plain text');
  assert.equal(notionApi.notionLanguage('tasks'), 'plain text');
  assert.equal(notionApi.notionLanguage(''), 'plain text');
});

test('common aliases are kept rather than flattened', () => {
  assert.equal(notionApi.notionLanguage('ts'), 'typescript');
  assert.equal(notionApi.notionLanguage('tsx'), 'typescript');
  assert.equal(notionApi.notionLanguage('js'), 'javascript');
  assert.equal(notionApi.notionLanguage('sh'), 'shell');
  assert.equal(notionApi.notionLanguage('yml'), 'yaml');
});

test('a language Notion does support is passed through unchanged', () => {
  for (const lang of ['sql', 'bash', 'json', 'mermaid', 'powershell', 'typescript', 'markdown']) {
    assert.equal(notionApi.notionLanguage(lang), lang);
  }
});

test('sanitiseForNotion recurses into children and does not mutate the input', () => {
  const original = [
    { object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [rt('parent')],
        children: [block('code', { rich_text: [rt('x')], language: 'dataview' })],
      } },
  ];
  const cleaned = notionApi.sanitiseForNotion(original);
  assert.equal(cleaned[0].bulleted_list_item.children[0].code.language, 'plain text');
  // The caller's tree is re-read by the state stash; rewriting it there would
  // change what a later push restores.
  assert.equal(original[0].bulleted_list_item.children[0].code.language, 'dataview');
});
