import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './BrainHealthPanel.css';

/**
 * Brain Health — vault-graph maintenance, moved out of SARA (31 Aug 2026).
 *
 * ── Why it lives here now ───────────────────────────────────────────────────
 * NEURO is the brain and the NEURO app is Nick's DIRECT access to it; SARA is
 * the layer that comes to him. Vault maintenance is neither ambient nor
 * something SARA should raise — it is a deliberate desk job you go and do,
 * with reports to read and consequences to weigh. It was on the phone as a
 * `brain` tab where the reports were unreadable and a button that rewrites
 * forty notes looked exactly like one that previews them.
 *
 * ── The two things the SARA version got wrong ───────────────────────────────
 * 1. ⚠ **Read and WRITE were the same grey "Run" button.** `Plan links` is
 *    read-only; `Connect orphans` and `Apply links` edit real notes in the
 *    vault, and `PLAUD repull` re-downloads recordings. One undifferentiated
 *    list is how a preview gets confused for a dry run of nothing.
 * 2. ⚠ **Nothing said what an action would actually do.** "Preview contextual
 *    links (read-only)" does not tell you it appends a `## Mentioned` block
 *    under a marker, backs every touched file up first, and is idempotent.
 *    Without that you either never press it or press it blind.
 *
 * So: every option states what it READS, what it CHANGES, what it will NOT do,
 * and how to get back. Anything that writes is TWO-STEP — preview, then a
 * confirm that quotes the real number — which is the same shape as
 * `event-parser`, `one-to-one-booking` and `task-blocks`.
 */

const basename = (p) => String(p || '').split('/').pop().replace(/\.md$/, '');

async function callJson(path, options) {
  const res = await apiFetch(path, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

const post = (path, body) => callJson(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

/**
 * The options, described.
 *
 * `effect` is the safety model on screen: `read` touches nothing, `write` edits
 * notes in the vault, `fetch` reaches an external service. `confirm` means the
 * action refuses to run until a preview has been seen — and the preview's own
 * numbers are what the confirmation quotes.
 */
const OPTIONS = [
  {
    key: 'lint',
    title: 'Scan the graph',
    effect: 'read',
    what: 'Walks every note and works out which links are broken, which notes nothing links to, which people are mentioned in prose but never linked, and which notes have gone stale.',
    changes: 'Nothing in your notes. It writes one dated report into Documents/System/Vault Audit/.',
    wont: 'It never edits, moves or deletes a note, and it never follows up on what it finds.',
    note: 'A link into Archive/ is NOT counted as broken — archiving is correct behaviour, and counting it buried the real breaks under three times as many false ones.',
    run: () => callJson('/api/vault-hygiene/lint'),
    summarise: (r) => `${r.scanned} notes scanned · ${r.counts.broken} broken links · ${r.counts.orphans} orphans`,
  },
  {
    key: 'plan',
    title: 'Preview contextual links',
    effect: 'read',
    what: 'Finds places where a person or project is named in the text of a note but never linked to, and proposes the links that would connect them.',
    changes: 'Nothing. It produces a list of proposed links and a report you can read first.',
    wont: 'It writes no links. Matching is on FULL names only, and a name that maps to more than one person is skipped rather than guessed at.',
    note: 'This is the preview half of "Apply contextual links" below. Run it first — the apply step quotes these numbers back to you.',
    run: () => post('/api/vault-hygiene/contextual-link/plan'),
    summarise: (r) => `${r.total} link${r.total === 1 ? '' : 's'} proposed across ${r.notesTouched} note${r.notesTouched === 1 ? '' : 's'}`,
    feeds: 'apply',
  },
  {
    key: 'apply',
    title: 'Apply contextual links',
    effect: 'write',
    confirm: true,
    requires: 'plan',
    what: 'Adds the links the preview proposed, as an appended "## Mentioned" block at the end of each note.',
    changes: 'Edits real notes in your vault. Every touched file is copied to Scripts/.lint-backups/<timestamp>/ first, and a changelog records exactly what was written.',
    wont: 'It never rewrites your prose, never reorders a note, and never touches anything outside the block it owns. Running it twice adds nothing the second time — the block is marked and updated in place.',
    note: 'The touched notes are re-indexed afterwards, so embeddings and entity extraction stay in step. That is the reason this lives in NEURO rather than a script.',
    run: () => post('/api/vault-hygiene/contextual-link/apply'),
    summarise: (r) => `${r.totalLinks} link${r.totalLinks === 1 ? '' : 's'} written into ${r.notesDone} note${r.notesDone === 1 ? '' : 's'}`,
    extra: (r) => (r.backupDir ? `Backup: ${r.backupDir}` : null),
  },
  {
    key: 'alias',
    title: 'Suggest people aliases',
    effect: 'read',
    what: 'Looks for name variants that are probably the same person — a shortened first name, or a PLAUD mis-transcription like "Naomi Winkworth" for Naomi Wentworth.',
    changes: 'Nothing. It writes a report of suggestions for you to accept by hand in Obsidian.',
    wont: 'It adds no aliases. A name two people could claim, a first name the roster already finds ambiguous, and anyone else’s full name are all rejected rather than offered.',
    note: 'Adding an alias is deliberately a human step: an alias that points at the wrong person silently misfiles everything they are mentioned in.',
    run: () => callJson('/api/vault-hygiene/alias-suggest?threshold=0.82'),
    summarise: (r) => `${r.count} suggestion${r.count === 1 ? '' : 's'}`,
  },
  {
    key: 'orphans',
    title: 'Connect orphan notes',
    effect: 'write',
    confirm: true,
    what: 'Takes notes nothing links to and connects them into the graph — NOVA notes to their hub, daily notes into their date chain.',
    changes: 'Edits real notes, appending a link under a marker it owns. Backed up to Scripts/.lint-backups/ first, with a changelog.',
    wont: 'It never invents a link to a person or a project. This is the fallback for notes no contextual match could reach, so the links it adds are structural, not semantic.',
    note: 'Run "Scan the graph" first if you want to see which notes are orphaned and why.',
    run: () => post('/api/vault-hygiene/connect-orphans'),
    summarise: (r) => `${r.nova} linked to NOVA · ${r.daily} daily notes chained`,
  },
  {
    key: 'reconcile',
    title: 'Find PLAUD recordings with no note',
    effect: 'read',
    what: 'Lists every recording in PLAUD and finds the ones with no matching note in the vault, by recording id or by date and title.',
    changes: 'Nothing at all. It only reports.',
    wont: 'It pulls nothing and writes nothing. Archived notes are deliberately ignored, so a recording whose note you archived on purpose still counts as unmatched.',
    note: 'This is how the nine days of meetings NEURO could not see in August were found. Worth running after any PLAUD outage.',
    run: () => post('/api/plaud/reconcile'),
    summarise: (r) => `${r.reconciled} recording${r.reconciled === 1 ? '' : 's'} with no active note`,
    feeds: 'repull',
  },
  {
    key: 'repull',
    title: 'Re-pull unmatched recordings',
    effect: 'fetch',
    confirm: true,
    requires: 'reconcile',
    what: 'Downloads the recordings the reconcile step found, freshly, and writes their transcript and summary notes into the vault.',
    changes: 'Creates new notes in your vault and calls PLAUD. Capped at 10 recordings per run, throttled to stay inside PLAUD’s rate limit.',
    wont: 'It never restores from Archive — a re-pull is a fresh download, so a note you archived deliberately is not resurrected from the bin. It is resumable: if it dies halfway it continues from where it stopped rather than starting over.',
    note: 'Slow by design. Ten recordings is minutes, not seconds.',
    run: () => post('/api/plaud/repull', { limit: 10 }),
    summarise: (r) => `${r.pulled} pulled · ${r.failed} failed`,
  },
];

const EFFECT_LABEL = {
  read: 'Reads only',
  write: 'Changes your vault',
  fetch: 'Downloads from PLAUD',
};

export default function BrainHealthPanel() {
  const [lint, setLint] = useState({ loading: true, error: null, data: null });
  const [runs, setRuns] = useState({});      // key -> { running, result, error, at }
  const [expanded, setExpanded] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const loadLint = useCallback(async () => {
    setLint({ loading: true, error: null, data: null });
    try {
      setLint({ loading: false, error: null, data: await callJson('/api/vault-hygiene/lint') });
    } catch (error) {
      setLint({ loading: false, error: error.message, data: null });
    }
  }, []);

  useEffect(() => { loadLint(); }, [loadLint]);

  async function run(option) {
    setConfirming(null);
    setRuns(r => ({ ...r, [option.key]: { running: true, result: null, error: null } }));
    try {
      const result = await option.run();
      setRuns(r => ({ ...r, [option.key]: { running: false, result, error: null, at: new Date() } }));
      // A write changes what the scan would say, so the counts are refreshed
      // rather than left showing a picture from before the change.
      if (option.effect !== 'read') loadLint();
    } catch (error) {
      setRuns(r => ({ ...r, [option.key]: { running: false, result: null, error: error.message } }));
    }
  }

  const counts = lint.data && lint.data.counts;

  return (
    <div className="brain">
      <div className="brain__head">
        <h2 className="brain__title">Brain Health</h2>
        <p className="brain__lede">
          The shape of the vault graph, and the jobs that tidy it. Everything here is
          deliberate — nothing on this screen runs on a schedule.
        </p>
      </div>

      {/* ── What the graph looks like right now ──────────────────────────── */}
      {lint.loading && <div className="brain__note">Scanning the vault…</div>}

      {lint.error && (
        <div className="brain__note brain__note--err">
          Couldn’t scan the vault: {lint.error}.
          <br />
          The counts below are missing, not zero — this is not a clean bill of health.
        </div>
      )}

      {counts && (
        <>
          <div className="brain__counts">
            <Count n={counts.broken} label="broken links" hint="Point at a note that does not exist." />
            <Count n={counts.orphans} label="orphans" hint="Nothing anywhere links to them." />
            <Count n={counts.underlinkedPeople} label="underlinked" hint="Named in prose, never linked." />
            <Count n={counts.stale} label="stale" hint="Untouched long enough to be worth a look." />
            <Count n={counts.archivedTargets} label="into Archive" hint="Not broken — archiving is correct. Shown so the broken count stays honest." muted />
          </div>
          <div className="brain__scanned">
            {lint.data.scanned} notes scanned
            {lint.data.reportPath && <> · report written to <code>{lint.data.reportPath}</code></>}
          </div>
        </>
      )}

      {lint.data && lint.data.orphans && lint.data.orphans.length > 0 && (
        <div className="brain__orphans">
          <div className="brain__h">
            Orphans <span className="brain__h-note">— often a recording still called “Speaker 1”. Naming them happens in Obsidian.</span>
          </div>
          <div className="brain__orphan-list">
            {lint.data.orphans.slice(0, 15).map(o => (
              <span className="brain__orphan" key={o} title={o}>{basename(o)}</span>
            ))}
            {lint.data.orphans.length > 15 && (
              <span className="brain__orphan brain__orphan--more">+{lint.data.orphans.length - 15} more</span>
            )}
          </div>
        </div>
      )}

      {/* ── The jobs ─────────────────────────────────────────────────────── */}
      <div className="brain__h brain__h--section">Jobs</div>

      {OPTIONS.map(option => {
        const state = runs[option.key] || {};
        const isOpen = expanded === option.key;
        const prereq = option.requires ? runs[option.requires] : null;
        const prereqDone = !option.requires || Boolean(prereq && prereq.result);
        const prereqTitle = option.requires
          ? (OPTIONS.find(o => o.key === option.requires) || {}).title
          : null;

        return (
          <div className={`brain__job brain__job--${option.effect}`} key={option.key}>
            <div className="brain__job-head">
              <button
                type="button"
                className="brain__job-name"
                onClick={() => setExpanded(isOpen ? null : option.key)}
                aria-expanded={isOpen}
              >
                <span className="brain__job-caret">{isOpen ? '▾' : '▸'}</span>
                {option.title}
              </button>
              <span className={`brain__effect brain__effect--${option.effect}`}>
                {EFFECT_LABEL[option.effect]}
              </span>
              <button
                type="button"
                className="brain__run"
                disabled={state.running || (option.confirm && !prereqDone)}
                onClick={() => (option.confirm ? setConfirming(option.key) : run(option))}
              >
                {state.running ? 'Running…' : option.confirm ? 'Run…' : 'Run'}
              </button>
            </div>

            <p className="brain__job-what">{option.what}</p>

            {option.confirm && !prereqDone && (
              <p className="brain__job-block">
                Run <strong>{prereqTitle}</strong> first — this step is confirmed against what that preview found.
              </p>
            )}

            {isOpen && (
              <dl className="brain__detail">
                <dt>What it changes</dt><dd>{option.changes}</dd>
                <dt>What it will not do</dt><dd>{option.wont}</dd>
                {option.note && <><dt>Worth knowing</dt><dd>{option.note}</dd></>}
              </dl>
            )}

            {confirming === option.key && (
              <div className="brain__confirm">
                <div className="brain__confirm-line">
                  {option.effect === 'write'
                    ? 'This edits notes in your vault.'
                    : 'This downloads from PLAUD and creates notes.'}
                  {prereq && prereq.result && (
                    <> The last preview found <strong>{(OPTIONS.find(o => o.key === option.requires)).summarise(prereq.result)}</strong>.</>
                  )}
                </div>
                <div className="brain__confirm-changes">{option.changes}</div>
                <div className="brain__confirm-actions">
                  <button type="button" className="brain__confirm-go" onClick={() => run(option)}>
                    Yes, run it
                  </button>
                  <button type="button" className="brain__confirm-no" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {state.result && (
              <div className="brain__result">
                ✓ {option.summarise(state.result)}
                {option.extra && option.extra(state.result) && (
                  <span className="brain__result-extra">{option.extra(state.result)}</span>
                )}
                {state.result.reportPath && (
                  <span className="brain__result-extra">Report: {state.result.reportPath}</span>
                )}
              </div>
            )}

            {state.error && (
              <div className="brain__result brain__result--err">
                ✕ {state.error}
                <span className="brain__result-extra">Nothing was changed.</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Count({ n, label, hint, muted }) {
  return (
    <div className={`brain__count${muted ? ' brain__count--muted' : ''}`} title={hint}>
      <span className="brain__n">{n}</span>
      <span className="brain__l">{label}</span>
      <span className="brain__hint">{hint}</span>
    </div>
  );
}
