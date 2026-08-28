'use strict';

const assert = require('node:assert/strict');
const { blockToMarkdown, cleanName, richText } = require('./sync');

assert.equal(cleanName('A/B: C'), 'A-B- C');
assert.equal(richText([{ plain_text: 'The ' }, { plain_text: 'story' }]), 'The story');
assert.equal(blockToMarkdown({ type: 'to_do', to_do: { checked: true, rich_text: [{ plain_text: 'Find the relic' }] } }), '- [x] Find the relic\n');
assert.equal(blockToMarkdown({ type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Session 1' }] } }), '## Session 1\n\n');
console.log('notion-dnd-sync tests passed');
