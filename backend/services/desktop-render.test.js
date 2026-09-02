'use strict';

/**
 * Do the desktop panels RENDER?
 *
 * A vite build proves these files COMPILE. It does not run them, and the three
 * most expensive mistakes in this frontend all compile perfectly:
 *
 *   - a `useEffect` dependency array naming a `const` declared further DOWN the
 *     component: a temporal-dead-zone ReferenceError on EVERY render (caught by
 *     this harness while the change it guards was being written);
 *   - a hook called behind a condition;
 *   - reading a field off a payload that is null on first paint.
 *
 * Each takes the whole panel out. Since 30 Aug the ErrorBoundary catches it and
 * names it, which is a good safety net and still a broken screen. The desktop
 * has no test runner of its own, so this bundles each panel with esbuild, stubs
 * the transport, and mounts it.
 *
 * WHAT THIS DOES NOT PROVE. `renderToString` does not run effects, so a panel
 * that fetches in a `useEffect` renders its LOADING state here. Still worth
 * having - the component body, every hook call and every dependency array all
 * execute - but it is not a test of the post-fetch branches. Where a panel
 * takes its data as a PROP (TodoPanel's pin) the real branch is reached, and
 * that is where the content assertions are.
 *
 * Lives in backend/services because `node --test` is only run from backend/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const COMPONENTS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');

// Two rows, so "it showed the right one" is a real claim rather than "it showed
// the only one".
const TODOS = {
  todos: [
    { id: 't41', task_id: 41, ms_id: null, source: 'NEURO', text: 'Sign off the risk assessment', priority: 'high', done: 0 },
    { id: 't12', task_id: 12, ms_id: null, source: 'NEURO', text: 'Reply to Adele', priority: 'normal', done: 0 },
  ],
  suggested: [],
  todayLane: [],
};

const STUBS = {
  api: [
    'export const apiUrl = (p) => p;',
    "export const apiFetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({}) });",
    'export default { apiUrl, apiFetch };',
  ].join('\n'),
  cached: [
    'const TODOS = ' + JSON.stringify(TODOS) + ';',
    'export default function useCachedFetch(p) {',
    "  return { data: String(p || '').startsWith('/api/todos') ? TODOS : null,",
    "           refresh: () => {}, status: 'ok', cacheAge: null };",
    '}',
  ].join('\n'),
  // The list has not arrived yet - used by the loading-state test below.
  loading: "export default function () { return { data: null, refresh: () => {}, status: 'ok', cacheAge: null }; }",
  attention: [
    'export default function useAttention() {',
    '  return { loading: false, error: null, primary: null, secondary: [], dropped: [], gaps: [],',
    '           contextCard: null, poolAvailable: true, act: async () => {}, refresh: () => {} };',
    '}',
  ].join('\n'),
};

function stubPlugin(cachedStub) {
  return {
    name: 'stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      build.onResolve({ filter: /useCachedFetch$/ }, () => ({ path: cachedStub, namespace: 'stub' }));
      build.onResolve({ filter: /useAttention$/ }, () => ({ path: 'attention', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
    },
  };
}

async function render(componentFile, props, cachedStub) {
  const out = await esbuild.build({
    entryPoints: [path.join(COMPONENTS, componentFile + '.jsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'idb'],
    plugins: [stubPlugin(cachedStub || 'cached')],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return renderToString(React.createElement(mod.exports.default, props));
}

// Browser globals these panels touch during a first render.
const prevWindow = global.window;
test.before(() => {
  global.window = { confirm: () => false, location: { search: '' }, addEventListener() {}, removeEventListener() {} };
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
});
test.after(() => { global.window = prevWindow; });

// -- Every touched panel mounts ----------------------------------------------

const PANELS = [
  ['AdhdPanel', { onNavigate() {} }],
  ['TimeFitCard', { onStarted() {}, onCompleted() {} }],
  ['FrictionSection', { onNavigate() {} }],
  ['Dashboard', { onNavigate() {} }],
  ['TodoPanel', { focusContext: null, onClearContext() {} }],
];

for (const [name, props] of PANELS) {
  test(name + ' renders without throwing', async () => {
    const html = await render(name, props);
    assert.equal(typeof html, 'string');
  });
}

// -- "Open it" lands on the row, and says so ---------------------------------

test('a pinned TodoPanel shows that task and only that task', async () => {
  const html = await render('TodoPanel', { focusContext: { taskId: 41 }, onClearContext() {} });
  assert.match(html, /Showing the one task/, 'the one-row list must explain itself');
  assert.match(html, /Sign off the risk assessment/, 'the pinned task must be the one shown');
  assert.doesNotMatch(html, /Reply to Adele/, 'the rest of the list must be out of the way');
  // The escape hatch is not optional. A screen that can only ever show one row
  // is a worse dead end than the one this replaced.
  assert.match(html, /Show all tasks/, 'there must always be a way back to the full list');
});

test('an unpinned TodoPanel is the ordinary list, with no banner', async () => {
  const html = await render('TodoPanel', { focusContext: null, onClearContext() {} });
  assert.doesNotMatch(html, /todo-pin-banner/, 'no banner when nothing was pinned');
  assert.match(html, /Sign off the risk assessment/);
  assert.match(html, /Reply to Adele/, 'positive control: the full list really is rendering');
});

test('a pin that matches nothing says so rather than showing an empty list', async () => {
  const html = await render('TodoPanel', { focusContext: { taskId: 9999 }, onClearContext() {} });
  assert.match(html, /not confirmation/, 'a miss must not read as "this task does not exist"');
  assert.match(html, /Show all tasks/);
});

test('a pin arriving before the list does NOT claim the task is missing', async () => {
  // Found by this harness. The miss message is a STATEMENT of fact, and showing
  // it for the moment before the fetch lands makes it wrong every single time -
  // the same species as reading an unread source as a zero.
  const html = await render('TodoPanel', { focusContext: { taskId: 41 }, onClearContext() {} }, 'loading');
  assert.doesNotMatch(html, /not confirmation/, 'must not state a miss while still loading');
  assert.match(html, /Finding it/, 'it should say it is still looking');
});
