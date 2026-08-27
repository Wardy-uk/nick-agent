'use strict';

/**
 * The MS task editor's routes actually resolve.
 *
 * A green service suite says nothing about routing: Express matches in
 * REGISTRATION order, and a literal path registered after a sibling
 * parameterised one is parsed as that parameter instead — which is how
 * `/triage/feedback` came to be read as an email id (#70). This asserts the
 * first layer to match `/ms/<id>` is the one meant to handle it, so a route
 * added above it later fails here rather than silently swallowing edits.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// The route module pulls in the DB on require.
process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-msroute-')), 'a.db');

const router = require('./todos');

const layersFor = (url, method) => router.stack
  .filter(l => l.route && l.regexp.test(url) && l.route.methods[method]);

test('GET /ms/:msId is reachable and is the first match', () => {
  const hits = layersFor('/ms/AAkALgAAA', 'get');
  assert.ok(hits.length > 0, 'no GET layer matches /ms/<id>');
  assert.equal(hits[0].route.path, '/ms/:msId');
});

test('PATCH /ms/:msId is reachable and is the first match', () => {
  const hits = layersFor('/ms/AAkALgAAA', 'patch');
  assert.ok(hits.length > 0, 'no PATCH layer matches /ms/<id>');
  assert.equal(hits[0].route.path, '/ms/:msId');
});

test('the editor did not shadow the routes already on this router', () => {
  // /ms/:msId is a two-segment literal-prefixed path, so it cannot capture
  // /focus or /complete-ms — but only a test keeps that true.
  for (const [url, method, expected] of [
    ['/focus', 'get', '/focus'],
    ['/complete-ms', 'post', '/complete-ms'],
    ['/wip-ms', 'post', '/wip-ms'],
    ['/moscow/review', 'get', '/moscow/review'],
  ]) {
    const hits = layersFor(url, method);
    assert.ok(hits.length > 0, `${method.toUpperCase()} ${url} matches nothing`);
    assert.equal(hits[0].route.path, expected, `${url} is being handled by ${hits[0].route.path}`);
  }
});
