'use strict';

/**
 * The assigned-ticket routes (item 3).
 *
 * Real HTTP, because a green service suite says nothing about routing — and
 * this router already has `/escalations` siblings, so the literal path could
 * easily be swallowed by a parameterised one.
 *
 * The load-bearing assertion is the GET: it must be a DRY RUN. A "show me what
 * this would do" that quietly does it is the worst possible version of a route
 * whose job is to put things in Nick's task list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-jira-')), 'a.db');
process.env.JIRA_ASSIGNED_SYNC_ENABLED = 'true';
process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
process.env.JIRA_EMAIL = 'nick@example.com';
process.env.JIRA_API_TOKEN = 'token';

const db = require('../db/database');
const jira = require('../services/jira');
const jiraTasks = require('../services/jira-tasks');
const router = require('./jira');

let server;
let base;

const ISSUE = {
  key: 'NT-777', summary: 'Portal contacts unbranded', status: 'In Progress',
  statusCategory: 'indeterminate', resolved: false, priority: 'Major',
  dueDate: null, created: '2026-08-01T09:00:00Z', updated: '2026-09-01T09:00:00Z',
  url: 'https://example.atlassian.net/browse/NT-777',
};

test.before(async () => {
  await db.init();
  jira.fetchAssignedToMe = async () => ({ issues: [ISSUE], complete: true });
  jira.fetchIssueStates = async () => ({ issues: [ISSUE], complete: true });
  const app = express();
  app.use(express.json());
  app.use('/api/jira', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('GET /assigned is a dry run and writes nothing', async () => {
  const res = await fetch(`${base}/api/jira/assigned`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.equal(body.created.length, 1);
  assert.equal(body.created[0].key, 'NT-777');
  assert.deepEqual(jiraTasks.readLinks(), {}, 'a dry run must link nothing');
});

test('POST /assigned/sync applies it', async () => {
  const res = await fetch(`${base}/api/jira/assigned/sync`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dryRun, false);
  assert.equal(body.created.length, 1);
  const taskId = body.created[0].taskId;
  assert.ok(taskId, 'the route must report the task it created');
  assert.equal(jiraTasks.keyForTask(taskId), 'NT-777');
});

test('the escalation routes still answer — this did not shadow them', async () => {
  // Positive control. Express matches in registration order and this repo has
  // shipped a literal path swallowed as a parameter before.
  const res = await fetch(`${base}/api/jira/escalations/unseen`);
  assert.notEqual(res.status, 404);
});
