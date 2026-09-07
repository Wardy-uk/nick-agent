import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './WeeklyRiskPanel.css';

/**
 * The Weekly Risk & Anomaly Summary, and the management log beside it.
 *
 * This is the surface for two PIP deliverables: the report Nick owes Chris by
 * midday every Monday (competency 2) and the actions/conversations log
 * (competencies 3 and 4). The backend already ranks and judges — `assess()`
 * returns findings in the order they should be read — so this component renders
 * that order rather than re-deciding it. Same split as StateOfPlay.
 *
 * The three manual sections are the reason this screen has to exist. NOVA
 * cannot answer them, `publish()` refuses while they are blank, and the
 * blockers are written server-side as the sentence the silence would otherwise
 * claim — so they are rendered as the prompts they already are, at the top,
 * rather than buried under the numbers they gate.
 */

const SEVERITY_LABEL = {
  blocked: 'No data',
  escalate: 'Escalate',
  warn: 'Watch',
  info: 'Note',
};

function fmtUk(date) {
  if (!date) return '—';
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y) return String(date);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Stat({ label, value, sub, tone = 'neutral' }) {
  return (
    <div className={`wr-stat wr-tone-${tone}`}>
      <span className="wr-stat-value">{value}</span>
      <span className="wr-stat-label">{label}</span>
      {sub && <span className="wr-stat-sub">{sub}</span>}
    </div>
  );
}

/**
 * What Nick owes Chris, and what exists. A TRACKER, not a burn-down.
 *
 * All the judgement is in `services/pip-deliverables.js`; this renders it and
 * adds nothing. Three rules survive into the markup:
 *
 *  - No percentage, no bar, no RAG. Chris assesses the PIP; a score here is a
 *    number to argue with instead of a list to act on.
 *  - "Written" and "sent" stay visibly apart — a draft on disk is not something
 *    Chris has received, and conflating them is the expensive mistake.
 *  - A failed read says so and never renders as a clean record. "I couldn't
 *    look" and "you didn't do it" are opposite facts and only one accuses him.
 */
function DeliverableTracker({ data, onMarkSent, busy }) {
  if (!data) return null;
  const { window: win, weekly, log, gaps = [], known } = data;

  const currentLabel = {
    sent: 'recorded as sent',
    'written-no-send-record': 'written — NEURO has no record of it going',
    due: `due by midday on ${fmtUk(weekly?.current?.dueDay)}`,
    late: 'not written yet',
  }[weekly?.current?.state] || 'unknown';

  return (
    <section className="wr-section wr-deliverables">
      <h3>What you owe Chris</h3>
      <p className="wr-hint">
        {win.daysToReview > 0
          ? `${win.daysToReview} days to the review on ${fmtUk(win.review)}, ${win.daysToEnd} to ${fmtUk(win.end)}.`
          : `Review passed ${fmtUk(win.review)} — ${win.daysToEnd} days to ${fmtUk(win.end)}.`}
      </p>

      <div className="wr-deliv-row">
        <span className="wr-deliv-item">
          <strong>This week:</strong> {currentLabel}
        </span>
        <span className="wr-deliv-item">
          <strong>{weekly.built}</strong> of {weekly.owed} written
          {/* Counted from the cadence agreed on 12 Aug, not from the PIP start —
              weeks before the standard existed were never owed. */}
          <em className="wr-deliv-note"> since {fmtUk(weekly.owedFrom)}</em>
        </span>
      </div>

      {/*
        ⚠ "No send recorded", never "not sent". NEURO only learns about a send it
        made itself through the approve-in-Actions flow — a report emailed from
        Outlook is invisible here for ever. Saying "not sent" would state as fact
        something nothing measured, about the one deliverable his job depends on.
      */}
      {weekly.noSendRecord.length > 0 && (
        <div className="wr-deliv-warn">
          <p>Written, but NEURO has no record of {weekly.noSendRecord.length === 1 ? 'it' : 'them'} going:</p>
          <ul className="wr-deliv-unsent">
            {weekly.noSendRecord.map(week => (
              <li key={week}>
                w/c {fmtUk(week)}
                <button
                  type="button"
                  className="wr-deliv-mark"
                  disabled={busy === `mark-${week}`}
                  onClick={() => onMarkSent(week)}
                >
                  {busy === `mark-${week}` ? 'Recording…' : 'I sent this'}
                </button>
              </li>
            ))}
          </ul>
          <p className="wr-deliv-note">
            NEURO only sees sends it made itself, so this is not a claim you didn’t send them.
          </p>
        </div>
      )}
      {weekly.notBuilt.length > 0 && (
        <p className="wr-deliv-warn">
          No report was built for: {weekly.notBuilt.map(fmtUk).join(', ')}.
        </p>
      )}

      {log && (
        <ul className="wr-deliv-log">
          <li>
            <strong>{log.baselineStillOpen}</strong> of {log.baselineCount} baseline items still open
            <em className="wr-deliv-note"> — target zero by {fmtUk(log.baselineTargetDate)}</em>
          </li>
          <li><strong>{log.lateLogged}</strong> logged later than two working days</li>
          <li><strong>{log.missingOwner + log.missingDue}</strong> open items missing an owner or a due date</li>
          {log.hrUnknown > 0 && (
            <li className="wr-deliv-note">
              {log.hrUnknown} item(s) where People HR has not been answered either way — not a gap, a question for you.
            </li>
          )}
        </ul>
      )}

      {!known && (
        <p className="wr-deliv-warn">
          Couldn’t read {gaps.map(g => g.source).join(', ')} — this is not a record of nothing done.
        </p>
      )}
    </section>
  );
}

/** A delta that says which way is good. Compliance is higher-is-better. */
function Delta({ value }) {
  if (value === null || value === undefined) return <span className="wr-delta wr-delta-none">—</span>;
  if (value === 0) return <span className="wr-delta wr-delta-flat">no change</span>;
  const up = value > 0;
  return (
    <span className={`wr-delta ${up ? 'wr-delta-up' : 'wr-delta-down'}`}>
      {up ? '▲' : '▼'} {up ? '+' : ''}{value}
    </span>
  );
}

export default function WeeklyRiskPanel() {
  const [report, setReport] = useState(null);
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [preview, setPreview] = useState(null);
  const [copied, setCopied] = useState(false);
  // Per-button confirmation. The notice alone was not enough: it renders at the
  // top of the panel and the buttons sit near the bottom, so a click produced a
  // message off-screen above and looked like nothing had happened.
  const [done, setDone] = useState(null);
  // The queued send, and whether this week is finished. Kept separate from
  // `report` because it moves on its own: approving does not rebuild the
  // report, and reopening does not re-fetch the queue.
  const [sendState, setSendState] = useState(null);
  const [deliverables, setDeliverables] = useState(null);
  const [showApproval, setShowApproval] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);

  function confirmOn(key, text) {
    setDone({ key, text });
    setTimeout(() => setDone(d => (d?.key === key ? null : d)), 4000);
  }
  const labelFor = (key, idle) => (done?.key === key ? `✓ ${done.text}` : idle);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, l, ss, dl] = await Promise.all([
        fetch(apiUrl('/api/weekly-risk')).then(res => res.json()),
        fetch(apiUrl('/api/weekly-risk/log')).then(res => res.json()),
        fetch(apiUrl('/api/weekly-risk/send-status')).then(res => res.json()).catch(() => null),
        // Never allowed to fail the panel: this is a summary of the two reads
        // above, so a page that refused to render without it would take the
        // report itself down for a tracker.
        fetch(apiUrl('/api/weekly-risk/deliverables')).then(res => res.json()).catch(() => null),
      ]);
      if (r.error) throw new Error(r.error);
      setReport(r);
      setLog(l);
      setSendState(ss && !ss.error ? ss : null);
      setDeliverables(dl && !dl.error ? dl : null);
      // Seed the form from what is stored, so a half-finished week reopens
      // where it was left rather than blank.
      setDraft({
        overtimeHours: r.manual?.overtime?.hours ?? '',
        overtimeApprovals: r.manual?.overtime?.approvalsOutstanding ?? '',
        overtimeNote: r.manual?.overtime?.note ?? '',
        headline: r.manual?.headline ?? '',
        escalate: (r.manual?.escalateToChris ?? []).join('\n'),
        escalateConfirmed: r.manual?.escalateToChris !== null,
        dataQuality: (r.manual?.dataQuality ?? []).join('\n'),
        dataQualityConfirmed: r.manual?.dataQuality !== null,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function post(path, body, label) {
    setBusy(label);
    setNotice(null);
    try {
      const res = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ tone: 'bad', text: data.error || 'Failed', blockers: data.blockers || [] });
        return null;
      }
      return data;
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function saveManual() {
    const patch = {
      overtime: {
        // '' means not answered; 0 means nil. Coercing '' to 0 here is exactly
        // the collapse the backend refuses to make.
        hours: draft.overtimeHours === '' ? null : Number(draft.overtimeHours),
        approvalsOutstanding: draft.overtimeApprovals === '' ? null : Number(draft.overtimeApprovals),
        note: draft.overtimeNote,
      },
      headline: draft.headline,
      escalateToChris: draft.escalateConfirmed
        ? draft.escalate.split('\n').map(s => s.trim()).filter(Boolean)
        : null,
      dataQuality: draft.dataQualityConfirmed
        ? draft.dataQuality.split('\n').map(s => s.trim()).filter(Boolean)
        : null,
    };
    const out = await post('/api/weekly-risk/manual', patch, 'save');
    if (out) {
      confirmOn('save', 'Saved');
      setNotice({ tone: 'ok', text: `Saved. ${out.blockers.length ? `${out.blockers.length} section(s) still needed before this can be sent.` : 'All sections complete — ready to publish and send.'}` });
      load();
    }
  }

  async function doPublish() {
    const out = await post('/api/weekly-risk/publish', {}, 'publish');
    if (out?.ok) {
      confirmOn('publish', 'Published');
      setNotice({ tone: 'ok', text: `Published to the vault: ${out.path}` });
      load();
    }
  }

  async function setHr(id, inPeopleHr) {
    setBusy(`hr${id}`);
    try {
      const res = await fetch(apiUrl(`/api/weekly-risk/log/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hrLogged: inPeopleHr }),
      });
      if (!res.ok) throw new Error('Could not save');
      setNotice({ tone: 'ok', text: `Recorded: ${inPeopleHr ? 'in People HR' : 'NOT in People HR — this will go in the report'}.` });
      load();
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function doTestSend() {
    const out = await post('/api/weekly-risk/test-send', {}, 'test');
    if (out?.ok) {
      confirmOn('test', 'Sent to you');
      setNotice({ tone: 'ok', text: `${out.note} (${out.to})` });
    }
  }

  /**
   * Approve the queued send from here.
   *
   * ⚠ This is NOT a second way to send. It posts to the same
   * /api/actions/:id/approve the Actions queue posts to, running the same
   * executor — all that has moved is WHERE the second gate is shown. The card
   * above it renders `presentation` built by the server, so the two screens
   * cannot describe the same send differently, and the full body is on screen
   * before the button can be pressed.
   */
  async function approveSend() {
    const id = sendState?.queued?.actionId;
    if (!id) return;
    const out = await post(`/api/actions/${id}/approve`, {}, 'approve');
    if (!out) return;
    // The executor reports what actually happened; an `ok:false` here is a send
    // that did not leave, and must not read as one that did.
    if (out.ok === false || out.result?.ok === false) {
      setNotice({ tone: 'bad', text: out.result?.detail || out.error || 'The send did not go through.' });
      await load();
      return;
    }
    confirmOn('approve', 'Sent to Chris');
    setNotice({ tone: 'ok', text: out.result?.detail || 'Sent to Chris.' });
    setShowApproval(false);
    await load();
  }

  async function rejectSend() {
    const id = sendState?.queued?.actionId;
    if (!id) return;
    const out = await post(`/api/actions/${id}/reject`, {}, 'reject');
    if (out) {
      setNotice({ tone: 'ok', text: 'Send cancelled — nothing was sent. Queue it again when you are ready.' });
      setShowApproval(false);
      await load();
    }
  }

  async function doReopen() {
    const out = await post('/api/weekly-risk/reopen', {}, 'reopen');
    if (out?.ok) {
      setConfirmReopen(false);
      setNotice({
        tone: 'ok',
        text: 'Reopened. The figures below are live again and may no longer match what Chris received.',
      });
      await load();
    }
  }

  async function doQueueSend() {
    const out = await post('/api/weekly-risk/queue-send', {}, 'send');
    if (out?.ok) {
      confirmOn('send', 'Queued');
      setShowApproval(true);
      setNotice({
        tone: 'ok',
        text: `Queued for ${out.recipient?.email}. NOTHING HAS BEEN SENT — check it below and approve to send.`,
      });
    }
  }

  /**
   * The note itself.
   *
   * Deliberately fetched and rendered here rather than linked. `apiUrl()` only
   * builds a path — the PIN is attached by the global fetch interceptor in
   * api.js, which a plain <a href> navigation never goes through, so the link
   * form returned "Authentication required". The obvious repair is `?pin=` on
   * the href, and it is the wrong one: it writes the PIN into browser history,
   * the URL bar and any proxy log, to save a fetch.
   */
  async function loadPreview() {
    if (preview !== null) { setPreview(null); return; }
    setBusy('preview');
    try {
      const res = await fetch(apiUrl('/api/weekly-risk/markdown'));
      if (!res.ok) throw new Error(`Preview failed (${res.status})`);
      setPreview(await res.text());
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function copyPreview() {
    try {
      await navigator.clipboard.writeText(preview || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice({ tone: 'bad', text: 'Could not copy — select the text and copy manually.' });
    }
  }

  if (loading) return <div className="wr-panel wr-loading">Building this week's report…</div>;
  if (error) return <div className="wr-panel wr-error">Could not build the report: {error}</div>;

  const blockers = report.blockers || [];
  const findings = report.findings || [];
  const trend = (report.trend || []).filter(t => /compliance/i.test(t.kpi));
  // Durable facts, read back from the server rather than inferred from a click.
  const locked = Boolean(sendState?.locked);
  const queued = sendState?.queued || null;
  const published = Boolean(sendState?.published || report?.published);
  const sentWhen = sendState?.sent?.sentAt
    ? new Date(sendState.sent.sentAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : 'an earlier date';

  const ready = blockers.length === 0;

  return (
    <div className="wr-panel">
      <header className="wr-header">
        <div>
          <h2>Weekly Risk &amp; Anomaly Summary</h2>
          <p className="wr-sub">
            w/c {fmtUk(report.week)} · due to Chris by midday Monday ·
            {report.snapshotDate
              ? ` data as at ${fmtUk(report.snapshotDate)}${report.snapshotAgeDays > 0 ? ` (${report.snapshotAgeDays}d old)` : ''}`
              : ' no KPI data'}
          </p>
        </div>
        <button className="wr-refresh" onClick={load} type="button">Rebuild</button>
      </header>

      <DeliverableTracker
        data={deliverables}
        busy={busy}
        onMarkSent={async (week) => {
          // Records only — nothing leaves NEURO here. The confirm is because a
          // send record is evidence about a deliverable his job depends on, and
          // a mis-tap that quietly asserts one is worse than an extra click.
          if (!window.confirm(`Record w/c ${fmtUk(week)} as sent to Chris?\n\nThis records it in NEURO. It does not send anything.`)) return;
          const r = await post('/api/weekly-risk/mark-sent', { week }, `mark-${week}`);
          if (r?.ok) {
            setNotice({ tone: 'good', text: `Recorded w/c ${fmtUk(week)} as sent.` });
            load();
          }
        }}
      />

      {/* The gate, first. These block publication, so they are not a footnote. */}
      {blockers.length > 0 && (
        <section className="wr-section wr-blockers">
          <h3>{blockers.length} section{blockers.length === 1 ? '' : 's'} still need you</h3>
          <ul>{blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </section>
      )}

      <section className="wr-section wr-manual">
        <h3>Your sections</h3>
        <p className="wr-hint">NOVA cannot answer these. Blank is not nil — leaving one empty stops the report publishing.</p>

        <div className="wr-field-row">
          <label>
            Overtime hours this cycle
            <input
              type="number" min="0" placeholder="not entered"
              value={draft.overtimeHours}
              onChange={e => setDraft({ ...draft, overtimeHours: e.target.value })}
            />
          </label>
          <label>
            Approvals outstanding
            <input
              type="number" min="0" placeholder="not entered"
              value={draft.overtimeApprovals}
              onChange={e => setDraft({ ...draft, overtimeApprovals: e.target.value })}
            />
          </label>
        </div>
        <label className="wr-field">
          Overtime note (optional)
          <textarea
            rows={2} value={draft.overtimeNote}
            onChange={e => setDraft({ ...draft, overtimeNote: e.target.value })}
          />
        </label>

        <label className="wr-field">
          Headline (optional — NEURO writes one if you leave it blank)
          <textarea
            rows={2} value={draft.headline}
            onChange={e => setDraft({ ...draft, headline: e.target.value })}
          />
        </label>

        <div className="wr-field">
          <label className="wr-check">
            <input
              type="checkbox" checked={draft.escalateConfirmed}
              onChange={e => setDraft({ ...draft, escalateConfirmed: e.target.checked })}
            />
            I have reviewed what goes to Chris {draft.escalate.trim() === '' && draft.escalateConfirmed && <em> — confirming nothing to escalate</em>}
          </label>
          <textarea
            rows={3} placeholder="One per line. Leave empty and tick above to confirm nothing to escalate."
            value={draft.escalate}
            onChange={e => setDraft({ ...draft, escalate: e.target.value })}
          />
          {findings.filter(f => f.severity === 'escalate').length > 0 && (
            <details className="wr-proposed">
              <summary>NEURO proposes {findings.filter(f => f.severity === 'escalate').length}</summary>
              <ul>
                {findings.filter(f => f.severity === 'escalate').map((f, i) => (
                  <li key={i}>
                    {f.title}
                    <button
                      type="button" className="wr-use"
                      onClick={() => setDraft({
                        ...draft,
                        escalate: `${draft.escalate ? `${draft.escalate}\n` : ''}${f.title} — ${f.detail}`,
                      })}
                    >use</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="wr-field">
          <label className="wr-check">
            <input
              type="checkbox" checked={draft.dataQualityConfirmed}
              onChange={e => setDraft({ ...draft, dataQualityConfirmed: e.target.checked })}
            />
            I have reviewed the data-quality exceptions
          </label>
          <textarea
            rows={3} placeholder="One per line. NEURO flags candidates below; whether each is real or a reporting artefact is your call."
            value={draft.dataQuality}
            onChange={e => setDraft({ ...draft, dataQuality: e.target.value })}
          />
        </div>

        <div className="wr-actions">
          <button type="button" className={done?.key === 'save' ? 'wr-confirmed' : undefined} onClick={saveManual} disabled={busy === 'save' || locked} title={locked ? 'This week has been sent — reopen it to make changes' : ''}>
            {busy === 'save' ? 'Saving…' : labelFor('save', 'Save')}
          </button>
          {/* ⚠ A completed step reads as COMPLETE, not merely as pressed.
              `done` is a four-second flash after a click; `published` and
              `locked` are durable facts read back from the server, so the
              answer survives a reload — which is the whole point of asking. */}
          <button
            type="button"
            className={published || done?.key === 'publish' ? 'wr-confirmed' : undefined}
            onClick={doPublish}
            disabled={!ready || busy === 'publish' || locked}
            title={locked ? 'This week has been sent — reopen it to publish again' : (ready ? '' : 'Finish your sections first')}
          >
            {busy === 'publish' ? 'Publishing…' : published ? '✓ Published to vault' : labelFor('publish', 'Publish to vault')}
          </button>
          {locked ? (
            <button type="button" className="wr-send wr-confirmed" disabled title={`Sent ${sentWhen}`}>
              ✓ Sent to Chris
            </button>
          ) : (
            <button
              type="button" className={`wr-send${done?.key === 'send' ? ' wr-confirmed' : ''}`}
              onClick={queued ? () => setShowApproval(v => !v) : doQueueSend}
              disabled={!ready || busy === 'send'}
              title={ready ? 'Queues for approval — sends nothing' : 'Finish your sections first'}
            >
              {busy === 'send' ? 'Queueing…' : queued ? (showApproval ? 'Hide the send' : 'Review & send to Chris') : labelFor('send', 'Queue send to Chris')}
            </button>
          )}
          {/* Not gated on `ready` — seeing an unfinished report in an inbox is
              the point, and the mail itself says which sections are missing. */}
          <button type="button" className={done?.key === 'test' ? 'wr-confirmed' : undefined} onClick={doTestSend} disabled={busy === 'test'}>
            {busy === 'test' ? 'Sending…' : labelFor('test', 'Test send to me')}
          </button>
          <button type="button" onClick={loadPreview} disabled={busy === 'preview'}>
            {busy === 'preview' ? 'Loading…' : preview !== null ? 'Hide preview' : 'Preview note'}
          </button>
          {/* The way back. A finished week that could not be reopened would
              mean a correction after sending had nowhere to go. */}
          {locked && (
            <button type="button" className="wr-reopen" onClick={() => setConfirmReopen(true)} disabled={busy === 'reopen'}>
              Reopen this week
            </button>
          )}
        </div>

        {confirmReopen && (
          <div className="wr-notice wr-notice-warn">
            <strong>Reopen w/c {report.week}?</strong> The report goes back to rebuilding from live data, so
            the figures on this screen will no longer be the ones Chris received on {sentWhen}. The record of
            that send is kept either way, and sending again will be counted as a second send.
            <div className="wr-confirm-row">
              <button type="button" onClick={doReopen} disabled={busy === 'reopen'}>
                {busy === 'reopen' ? 'Reopening…' : 'Reopen it'}
              </button>
              <button type="button" onClick={() => setConfirmReopen(false)}>Keep it closed</button>
            </div>
          </div>
        )}
        {/* The outcome renders HERE, immediately under the buttons that caused
            it. It used to sit at the top of the panel, several screens above
            the controls, so every click looked like it had done nothing. */}
        {notice && (
          <div className={`wr-notice wr-notice-${notice.tone}`}>
            {notice.text}
            {notice.blockers?.length > 0 && (
              <ul>{notice.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
            )}
          </div>
        )}

        {/* The second gate, shown where the report is. It is the SAME action
            the Actions queue holds and the same approve route — only the place
            it is displayed has moved, so nothing here is a shortcut past a
            check. Everything rendered comes from the server's `presentation`. */}
        {queued && showApproval && !locked && (
          <div className="wr-approval">
            <div className="wr-approval-head">
              <strong>{queued.presentation?.label || 'Send the weekly risk report'}</strong>
              <span className="wr-approval-kind">Nothing has been sent yet</span>
            </div>
            <dl className="wr-approval-fields">
              {(queued.presentation?.fields || []).map((f, i) => (
                <div key={i}>
                  <dt>{f.label}</dt>
                  <dd className={f.mono ? 'mono' : undefined}>{f.value ?? '—'}</dd>
                </div>
              ))}
            </dl>
            {queued.presentation?.warnings?.length > 0 && (
              <ul className="wr-approval-warn">{queued.presentation.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            )}
            {/* ⚠ Approve is DISABLED while a blocker stands, and says why —
                an approve that quietly fails is worse than one that refuses. */}
            {queued.presentation?.blockers?.length > 0 && (
              <ul className="wr-approval-block">{queued.presentation.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
            )}
            {queued.presentation?.body && (
              <details className="wr-approval-body">
                <summary>The exact words that will be sent — {queued.presentation.body.length.toLocaleString()} characters</summary>
                <pre>{queued.presentation.body}</pre>
              </details>
            )}
            {queued.presentation?.note && <p className="wr-hint">{queued.presentation.note}</p>}
            <div className="wr-confirm-row">
              <button
                type="button" className="wr-send"
                onClick={approveSend}
                disabled={busy === 'approve' || (queued.presentation?.blockers?.length > 0)}
                title={queued.presentation?.blockers?.length ? 'Fix the blocker above first' : 'This sends the report to Chris'}
              >
                {busy === 'approve' ? 'Sending…' : 'Approve and send to Chris'}
              </button>
              <button type="button" onClick={rejectSend} disabled={busy === 'reject'}>
                {busy === 'reject' ? 'Cancelling…' : 'Cancel this send'}
              </button>
            </div>
          </div>
        )}

        {locked ? (
          <p className="wr-hint">
            Sent to {(sendState?.sent?.recipients || []).map(r => r.email).join(', ') || 'Chris'} on {sentWhen}
            {sendState?.sent?.sendCount > 1 ? ` (send ${sendState.sent.sendCount})` : ''}. This week is finished:
            the figures above are the ones that were sent, frozen, not a rebuild. Reopen it if something needs changing.
          </p>
        ) : sendState?.sent?.reopenedAt ? (
          <p className="wr-hint wr-hint-warn">
            This week was already sent on {sentWhen} and has since been reopened — the figures above are live
            again and may no longer match what Chris received. Sending now counts as a second send.
          </p>
        ) : (
          <p className="wr-hint">
            Queueing sends nothing. It shows the exact report and address here for approval — the same card
            also appears in <strong>Actions</strong>.
          </p>
        )}

        {preview !== null && (
          <div className="wr-preview">
            <div className="wr-preview-bar">
              <span>The note as it would be published — {preview.length.toLocaleString()} characters</span>
              <button type="button" onClick={copyPreview}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <pre>{preview}</pre>
          </div>
        )}
      </section>

      <section className="wr-section">
        <h3>Headline</h3>
        <div className="wr-stats">
          <Stat
            label="KPIs green" tone={report.rag.greenPct === null ? 'unknown' : report.rag.greenPct >= 80 ? 'good' : 'bad'}
            value={report.rag.greenPct === null ? '—' : `${report.rag.greenPct}%`}
            sub={report.rag.greenPct === null ? 'no data' : 'target 80%'}
          />
          <Stat
            label="KPIs red" tone={report.rag.redPct === null ? 'unknown' : report.rag.redPct <= 10 ? 'good' : 'bad'}
            value={report.rag.redPct === null ? '—' : `${report.rag.redPct}%`}
            sub={report.rag.redPct === null ? 'no data' : 'target ≤10%'}
          />
          <Stat label="To escalate" value={report.escalateCount} tone={report.escalateCount ? 'bad' : 'good'} />
          <Stat
            label="Overdue actions" value={log?.overdueCount ?? '—'}
            tone={log?.breachesFiveDay?.length ? 'bad' : log?.overdueCount ? 'warn' : 'good'}
            sub={log?.breachesFiveDay?.length ? `${log.breachesFiveDay.length} past 5 working days` : null}
          />
        </div>
      </section>

      <section className="wr-section">
        <h3>My task position</h3>
        {report.tasks?.available ? (
          <>
            {/* Commitments first and alone in the headline overdue figure.
                ⚠ This panel and render() must agree: the panel is what Nick
                reads before pressing send, so a single whole-list "Overdue"
                stat here would contradict the document he is about to sign. */}
            <p className="wr-hint" style={{ marginTop: 0 }}>
              Work others asked for or are waiting on
            </p>
            <div className="wr-stats">
              <Stat label="Open commitments" value={report.tasks.commitments.open} />
              <Stat
                label="Overdue" value={report.tasks.commitments.overdue}
                tone={report.tasks.commitments.open && report.tasks.commitments.overdue / report.tasks.commitments.open > 0.25
                  ? 'bad' : report.tasks.commitments.overdue ? 'warn' : 'good'}
                sub={report.tasks.commitments.open ? `${Math.round((report.tasks.commitments.overdue / report.tasks.commitments.open) * 100)}% of open` : null}
              />
              <Stat
                label="Closed last week" value={report.tasks.commitments.closedLastWeek}
                tone={report.tasks.commitments.closedLastWeek ? 'good' : 'neutral'}
              />
              <Stat label="No due date" value={report.tasks.commitments.undated} tone="neutral" sub="cannot be chased" />
            </div>

            {/* Deliberately NOT toned as a warning at any level. These dates are
                self-imposed on work nobody is waiting for, and colouring them
                red is the report disagreeing with its own caveat. */}
            <p className="wr-hint" style={{ marginTop: 16 }}>
              Continual improvement — work I set myself
            </p>
            <div className="wr-stats">
              <Stat label="Open" value={report.tasks.improvement.open} tone="neutral" />
              <Stat label="Past target date" value={report.tasks.improvement.overdue} tone="neutral" sub="not a compliance measure" />
              <Stat label="Closed last week" value={report.tasks.improvement.closedLastWeek} tone={report.tasks.improvement.closedLastWeek ? 'good' : 'neutral'} />
              <Stat label="No target date" value={report.tasks.improvement.undated} tone="neutral" />
            </div>

            {/* ⚠ Never hidden when zero — "everything is classified" is what
                makes the commitment figure above complete, and its absence is
                the reader's only clue that it is not. */}
            <p className="wr-hint" style={{ marginTop: 16 }}>
              {report.tasks.unclassified.open > 0
                ? `${report.tasks.unclassified.open} open task${report.tasks.unclassified.open === 1 ? '' : 's'} not yet marked as either${report.tasks.unclassified.overdue ? `, ${report.tasks.unclassified.overdue} of them overdue` : ''}. These are counted in neither figure above — treat the overdue commitment count as a floor until this is zero.`
                : 'Every open task is marked as a commitment or as improvement work, so the figures above are the whole picture.'}
            </p>
            {report.tasks.proposedCount > 0 && (
              <p className="wr-hint" style={{ marginTop: 6, marginBottom: 0 }}>
                {report.tasks.proposedCount} of those classifications were proposed automatically from where the task came from and have not been confirmed.
              </p>
            )}

            <p className="wr-hint" style={{ marginTop: 12, marginBottom: 0 }}>
              Whole open list {report.tasks.open}. Closed counts the previous full week ({fmtUk(report.tasks.lastWeek.from)} to {fmtUk(report.tasks.lastWeek.to)}), not a rolling seven days.
              Dropped is counted separately{report.tasks.droppedLastWeek ? ` (${report.tasks.droppedLastWeek} dropped)` : ''} — both leave the list, only one is work finished.
            </p>
          </>
        ) : <p className="wr-empty">Task counts unavailable.</p>}
      </section>

      <section className="wr-section">
        <h3>Findings</h3>
        {findings.length === 0
          ? <p className="wr-empty">Nothing flagged. The sources answered and no rule fired.</p>
          : (
            <ul className="wr-findings">
              {findings.map((f, i) => (
                <li key={i} className={`wr-finding wr-sev-${f.severity}`}>
                  <span className="wr-sev">{SEVERITY_LABEL[f.severity] || f.severity}</span>
                  <div>
                    <strong>{f.title}</strong>
                    <p>{f.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className="wr-section">
        <h3>Week on week <span className="wr-tag">Chris asked for this, 12 Aug</span></h3>
        {trend.length === 0
          ? <p className="wr-empty">No compliance trend available — the KPI source did not answer.</p>
          : (
            <table className="wr-table">
              <thead>
                <tr><th>KPI</th><th>This week</th><th>Last week</th><th>Change</th></tr>
              </thead>
              <tbody>
                {trend.map(t => (
                  <tr key={t.kpi}>
                    <td>{t.kpi}</td>
                    <td className={t.latest?.value < 95 ? 'wr-bad' : 'wr-good'}>
                      {t.latest?.value == null ? '—' : `${Math.round(t.latest.value)}%`}
                    </td>
                    <td>{t.prior?.value == null ? '—' : `${Math.round(t.prior.value)}%`}</td>
                    <td><Delta value={t.delta} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      <section className="wr-section">
        <h3>
          Management log
          <button type="button" className="wr-toggle" onClick={() => setShowLog(s => !s)}>
            {showLog ? 'hide' : `show all ${log?.totals?.rows ?? 0}`}
          </button>
        </h3>
        {log && (
          <>
            <p className="wr-hint">
              Competency 4 baseline at {fmtUk(log.baseline.date)}: <strong>{log.baseline.count}</strong>
              {' '}({log.baseline.stillOpen} still open) · target 0 by {fmtUk(log.baseline.targetDate)}
            </p>
            {log.missingDue.length > 0 && (
              <p className="wr-warn-line">
                {log.missingDue.length} items have no due date — competency 3 needs an owner and a date on every one.
              </p>
            )}
            {log.hrGap.length > 0 && (
              <p className="wr-warn-line">
                {log.hrGap.length} conversation{log.hrGap.length === 1 ? '' : 's'}/concern{log.hrGap.length === 1 ? '' : 's'} confirmed <strong>not</strong> in People HR — this goes in the report.
              </p>
            )}
            {/* Unknown is a question, never a claim. It is asked here and does
                not appear in anything Chris receives. */}
            {log.hrUnknown?.length > 0 && (
              <div className="wr-hr-ask">
                <p className="wr-hint" style={{ marginBottom: 8 }}>
                  Is this in People HR? NEURO has never been told, so it says nothing in the report either way.
                </p>
                {log.hrUnknown.map(h => (
                  <div key={h.id} className="wr-hr-row">
                    <span>{h.person ? `${h.person} — ` : ''}{h.summary}</span>
                    <span className="wr-hr-buttons">
                      <button type="button" onClick={() => setHr(h.id, true)} disabled={busy === `hr${h.id}`}>Yes</button>
                      <button type="button" onClick={() => setHr(h.id, false)} disabled={busy === `hr${h.id}`}>No</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <table className="wr-table">
              <thead>
                <tr><th>Item</th><th>Person</th><th>Owner</th><th>Due</th><th>Status</th></tr>
              </thead>
              <tbody>
                {(showLog ? log.rows : log.overdue.slice(0, 5)).map(r => (
                  <tr key={r.id}>
                    <td>{r.summary}</td>
                    <td>{r.person || '—'}</td>
                    <td>{r.owner || <span className="wr-bad">unowned</span>}</td>
                    <td>{r.due_date || r.dueDate || <span className="wr-bad">not set</span>}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!showLog && log.overdue.length === 0 && <p className="wr-empty">Nothing overdue.</p>}
          </>
        )}
      </section>

      <section className="wr-section wr-sources">
        <h3>Data sources</h3>
        <ul>
          {(report.sources || []).map(s => (
            <li key={s.name} className={s.ok ? 'wr-src-ok' : 'wr-src-bad'}>
              <code>{s.name}</code> — {s.ok ? 'answered' : s.error}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
