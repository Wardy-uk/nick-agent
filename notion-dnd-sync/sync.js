#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const NOTION_API_VERSION = process.env.NOTION_API_VERSION || '2026-03-11';
const VAULT_PATH = process.env.OBSIDAN_VAULT_PATH || '/mnt/data/nuero-vault';
const OUTPUT_ROOT = process.env.NOTION_DND_OUTPUT_ROOT || path.join(VAULT_PATH, 'Projects', 'D&D', 'Notion');
const dryRun = process.argv.includes('--dry-run');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cleanName(value) {
  const name = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().replace(/\s+/g, ' ');
  return name || 'Untitled';
}

function richText(items = []) {
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
}

function escapeMarkdown(value) {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function blockText(block) {
  const data = block[block.type] || {};
  return richText(data.rich_text || []);
}

function blockToMarkdown(block, indent = '') {
  const text = blockText(block);
  switch (block.type) {
    case 'paragraph': return text ? `${indent}${text}\n\n` : '\n';
    case 'heading_1': return `# ${text}\n\n`;
    case 'heading_2': return `## ${text}\n\n`;
    case 'heading_3': return `### ${text}\n\n`;
    case 'bulleted_list_item': return `${indent}- ${text}\n`;
    case 'numbered_list_item': return `${indent}1. ${text}\n`;
    case 'to_do': return `${indent}- [${block.to_do.checked ? 'x' : ' '}] ${text}\n`;
    case 'quote': return `> ${text}\n\n`;
    case 'callout': return `> ${text}\n\n`;
    case 'code': return `\`\`\`${block.code.language || ''}\n${text}\n\`\`\`\n\n`;
    case 'divider': return '---\n\n';
    case 'bookmark': return block.bookmark?.url ? `[Bookmark](${block.bookmark.url})\n\n` : '';
    case 'child_page': return `- [[${cleanName(block.child_page.title)}]]\n`;
    default: return '';
  }
}

async function notionFetch(token, requestPath) {
  const response = await fetch(`https://api.notion.com/v1${requestPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_API_VERSION,
    },
  });
  if (!response.ok) throw new Error(`Notion API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function allChildren(token, blockId) {
  const blocks = [];
  let cursor = '';
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) query.set('start_cursor', cursor);
    const page = await notionFetch(token, `/blocks/${blockId}/children?${query}`);
    blocks.push(...page.results);
    cursor = page.has_more ? page.next_cursor : '';
  } while (cursor);
  return blocks;
}

async function renderBlocks(token, blocks, indent = '') {
  let markdown = '';
  for (const block of blocks) {
    markdown += blockToMarkdown(block, indent);
    if (block.has_children && block.type !== 'child_page') {
      markdown += await renderBlocks(token, await allChildren(token, block.id), `${indent}  `);
      if (['bulleted_list_item', 'numbered_list_item', 'to_do'].includes(block.type)) markdown += '\n';
    }
  }
  return markdown;
}

async function exportPage(token, pageId, outputDirectory, seen) {
  if (seen.has(pageId)) return 0;
  seen.add(pageId);
  const page = await notionFetch(token, `/pages/${pageId}`);
  const blocks = await allChildren(token, pageId);
  const childPages = blocks.filter((block) => block.type === 'child_page');
  const title = page.properties
    ? Object.values(page.properties).find((property) => property.type === 'title')?.title?.map((item) => item.plain_text).join('')
    : undefined;
  const pageTitle = cleanName(title || pageId);
  const markdown = [
    '---',
    'source: notion',
    `notion_page_id: ${pageId}`,
    `notion_last_edited: ${page.last_edited_time}`,
    '---',
    '',
    `# ${pageTitle}`,
    '',
    (await renderBlocks(token, blocks)).trim(),
    '',
  ].join('\n');

  const target = path.join(outputDirectory, `${pageTitle}.md`);
  if (dryRun) console.log(`[dry run] Would write ${target}`);
  else {
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(target, markdown, 'utf8');
    console.log(`Wrote ${target}`);
  }

  for (const child of childPages) {
    await exportPage(token, child.id, path.join(outputDirectory, pageTitle), seen);
  }
  return 1;
}

async function main() {
  const token = required('NOTION_DND_TOKEN');
  const rootPageId = required('NOTION_DND_ROOT_PAGE_ID');
  const count = await exportPage(token, rootPageId, OUTPUT_ROOT, new Set());
  console.log(`${dryRun ? 'Validated' : 'Exported'} ${count} Notion page(s). No files were deleted.`);
}

module.exports = { blockToMarkdown, cleanName, richText };

if (require.main === module) {
  main().catch((error) => {
    console.error(`Notion D&D sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}
