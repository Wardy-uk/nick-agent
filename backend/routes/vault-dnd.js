'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const DND_ROOT = normalizeRelative(process.env.DND_VAULT_ROOT || 'Projects/D&D');

function normalizeRelative(input) {
  return String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function stripScopePrefix(relPath) {
  const normal = normalizeRelative(relPath);
  if (!DND_ROOT) return normal;
  if (normal === DND_ROOT) return '';
  if (normal.startsWith(`${DND_ROOT}/`)) return normal.slice(DND_ROOT.length + 1);
  return normal;
}

function joinScope(relPath) {
  const normal = normalizeRelative(relPath);
  if (!DND_ROOT) return normal;
  if (!normal) return DND_ROOT;
  if (normal === DND_ROOT || normal.startsWith(`${DND_ROOT}/`)) return normal;
  return `${DND_ROOT}/${normal}`;
}

function safeScopedPath(relPath) {
  const scoped = joinScope(relPath);
  const resolved = path.resolve(VAULT_PATH, scoped);
  const vaultRoot = path.resolve(VAULT_PATH);
  const dndRoot = path.resolve(VAULT_PATH, DND_ROOT);
  if (!resolved.startsWith(vaultRoot)) return null;
  if (!resolved.startsWith(dndRoot)) return null;
  return resolved;
}

function requireDndApiKey(req, res, next) {
  const expected = process.env.DND_VAULT_API_KEY;
  if (!expected) {
    console.error('[Vault:DND] DND_VAULT_API_KEY not configured — blocking all D&D vault access');
    return res.status(503).json({ error: 'D&D vault API key not configured on server' });
  }
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== expected) {
    return res.status(401).json({ error: 'Unauthorized — valid API key required' });
  }
  next();
}

router.use(requireDndApiKey);

router.get('/status', (req, res) => {
  res.json({
    configured: Boolean(VAULT_PATH && DND_ROOT && process.env.DND_VAULT_API_KEY),
    root: DND_ROOT,
    deleteEnabled: false,
  });
});

router.get('/read', (req, res) => {
  const filePath = safeScopedPath(req.query.path);
  if (!filePath) return res.status(400).json({ error: 'Invalid or missing path' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found', path: normalizeRelative(req.query.path) });
  const content = fs.readFileSync(filePath, 'utf-8');
  res.json({ path: normalizeRelative(req.query.path), content });
});

router.post('/write', (req, res) => {
  const { path: relPath, content } = req.body;
  if (!relPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
  const filePath = safeScopedPath(relPath);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  if (!String(filePath).endsWith('.md')) return res.status(400).json({ error: 'Only markdown files are supported' });

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  try { require('../services/vault-hooks').onVaultWrite(filePath, 'dnd-vault-api-write'); } catch {}
  res.json({ success: true, path: normalizeRelative(relPath) });
});

router.post('/append', (req, res) => {
  const { path: relPath, content } = req.body;
  if (!relPath || !content) return res.status(400).json({ error: 'path and content required' });
  const filePath = safeScopedPath(relPath);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  if (!String(filePath).endsWith('.md')) return res.status(400).json({ error: 'Only markdown files are supported' });

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  fs.writeFileSync(filePath, existing + content, 'utf-8');
  try { require('../services/vault-hooks').onVaultWrite(filePath, 'dnd-vault-api-append'); } catch {}
  res.json({ success: true, path: normalizeRelative(relPath) });
});

router.get('/list', (req, res) => {
  const dirPath = safeScopedPath(req.query.dir || '');
  if (!dirPath) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Directory not found' });

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = entries
    .filter(e => !e.name.startsWith('.'))
    .map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file'
    }));
  res.json({ dir: normalizeRelative(req.query.dir || ''), files });
});

router.get('/search', (req, res) => {
  const query = String(req.query.query || '');
  if (!query) return res.status(400).json({ error: 'query required' });

  const searchDir = safeScopedPath(req.query.dir || '');
  if (!searchDir) return res.status(400).json({ error: 'Invalid path' });

  const results = [];
  const maxResults = 20;
  const lowered = query.toLowerCase();

  function searchRecursive(dirPath, depth) {
    if (depth > 4 || results.length >= maxResults) return;
    if (!fs.existsSync(dirPath)) return;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        searchRecursive(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.toLowerCase().includes(lowered)) continue;

        const relPath = stripScopePrefix(path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/'));
        const lines = content.split('\n');
        const matches = [];
        for (let i = 0; i < lines.length && matches.length < 3; i++) {
          if (lines[i].toLowerCase().includes(lowered)) {
            matches.push({ line: i + 1, text: lines[i].substring(0, 200) });
          }
        }
        results.push({ path: relPath, name: entry.name.replace('.md', ''), matches });
      }
    }
  }

  searchRecursive(searchDir, 0);
  res.json({ query, results });
});

router.get('/search/temporal', (req, res) => {
  const query = String(req.query.query || '');
  if (!query) return res.status(400).json({ error: 'query required' });

  const fromDate = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = req.query.to ? new Date(req.query.to) : new Date();
  const limit = parseInt(req.query.limit, 10) || 5;
  const results = [];
  const lowered = query.toLowerCase();

  function walk(dirPath, depth) {
    if (depth > 4 || results.length >= limit * 3) return;
    if (!fs.existsSync(dirPath)) return;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const stat = fs.statSync(fullPath);
        const modified = new Date(stat.mtime);
        if (modified < fromDate || modified > toDate) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.toLowerCase().includes(lowered)) continue;

        const relPath = stripScopePrefix(path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/'));
        const body = content.replace(/^---[\s\S]*?---\n*/, '');
        const lines = body.split('\n');
        const excerpts = [];
        for (let i = 0; i < lines.length && excerpts.length < 2; i++) {
          if (lines[i].toLowerCase().includes(lowered)) excerpts.push(lines[i].substring(0, 200));
        }

        results.push({
          path: relPath,
          name: entry.name.replace('.md', ''),
          modified: stat.mtime,
          excerpts
        });
      }
    }
  }

  walk(path.resolve(VAULT_PATH, DND_ROOT), 0);
  results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  res.json({ results: results.slice(0, limit), from: fromDate, to: toDate });
});

router.get('/backlinks', (req, res) => {
  try {
    const relPath = normalizeRelative(req.query.path || '');
    if (!relPath) return res.status(400).json({ error: 'path required' });

    const vaultRelPath = joinScope(relPath);
    const db = require('../db/database');
    const backlinks = db.getBacklinks(vaultRelPath);
    const noteName = path.basename(vaultRelPath, '.md');
    const entityMentions = db.getEntitiesByValue(noteName);

    const seen = new Set();
    const combined = [];

    for (const link of backlinks) {
      if (!link.source_path.startsWith(`${DND_ROOT}/`)) continue;
      if (seen.has(link.source_path)) continue;
      seen.add(link.source_path);
      combined.push({ path: stripScopePrefix(link.source_path), type: link.link_type });
    }

    for (const entity of entityMentions) {
      if (!entity.source_path.startsWith(`${DND_ROOT}/`)) continue;
      if (seen.has(entity.source_path)) continue;
      seen.add(entity.source_path);
      combined.push({ path: stripScopePrefix(entity.source_path), type: 'mention' });
    }

    const enriched = combined.slice(0, 10).map(item => ({
      ...item,
      name: path.basename(item.path, '.md')
    }));

    res.json({ backlinks: enriched, total: combined.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports._internals = {
  normalizeRelative,
  stripScopePrefix,
  joinScope,
  safeScopedPath,
};
