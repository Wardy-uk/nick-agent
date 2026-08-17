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

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, l] = await Promise.all([
        fetch(apiUrl('/api/weekly-risk')).then(res => res.json()),
        fetch(apiUrl('/api/weekly-risk/log')).then(res => res.json()),
      ]);
      if (r.error) throw new Error(r.error);
      setReport(r);
      setLog(l);
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
      setNotice({ tone: 'ok', text: 'Saved.' });
      load();
    }
  }

  async function doPublish() {
    const out = await post('/api/weekly-risk/publish', {}, 'publish');
    if (out?.ok) {
      setNotice({ tone: 'ok', text: `Published to ${out.path}` });
      load();
    }
  }

  async function doTestSend() {
    const out = await post('/api/weekly-risk/test-send', {}, 'test');
    if (out?.ok) setNotice({ tone: 'ok', text: `${out.note} (${out.to})` });
  }

  async function doQueueSend() {
    const out = await post('/api/weekly-risk/queue-send', {}, 'send');
    if (out?.ok) {
      setNotice({
        tone: 'ok',
        text: `Queued for ${out.recipient?.email}. Nothing has been sent — approve it in Actions.`,
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

      {notice && (
        <div className={`wr-notice wr-notice-${notice.tone}`}>
          {notice.text}
          {notice.blockers?.length > 0 && (
            <ul>{notice.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
          )}
        </div>
      )}

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
          <button type="button" onClick={saveManual} disabled={busy === 'save'}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={doPublish} disabled={!ready || busy === 'publish'} title={ready ? '' : 'Finish your sections first'}>
            {busy === 'publish' ? 'Publishing…' : 'Publish to vault'}
          </button>
          <button
            type="button" className="wr-send"
            onClick={doQueueSend} disabled={!ready || busy === 'send'}
            title={ready ? 'Queues for approval — sends nothing' : 'Finish your sections first'}
          >
            {busy === 'send' ? 'Queueing…' : 'Queue send to Chris'}
          </button>
          {/* Not gated on `ready` — seeing an unfinished report in an inbox is
              the point, and the mail itself says which sections are missing. */}
          <button type="button" onClick={doTestSend} disabled={busy === 'test'}>
            {busy === 'test' ? 'Sending…' : 'Test send to me'}
          </button>
          <button type="button" onClick={loadPreview} disabled={busy === 'preview'}>
            {busy === 'preview' ? 'Loading…' : preview !== null ? 'Hide preview' : 'Preview note'}
          </button>
        </div>
        <p className="wr-hint">
          Queueing sends nothing. It creates an approval card in <strong>Actions</strong> showing the full report and the exact address.
        </p>

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
            <div className="wr-stats">
              <Stat label="Open tasks" value={report.tasks.open} />
              <Stat
                label="Overdue" value={report.tasks.overdue}
                tone={report.tasks.open && report.tasks.overdue / report.tasks.open > 0.25 ? 'bad' : report.tasks.overdue ? 'warn' : 'good'}
                sub={report.tasks.open ? `${Math.round((report.tasks.overdue / report.tasks.open) * 100)}% of open` : null}
              />
              <Stat
                label="Closed last week" value={report.tasks.closedLastWeek}
                tone={report.tasks.closedLastWeek ? 'good' : 'neutral'}
                sub={report.tasks.droppedLastWeek ? `${report.tasks.droppedLastWeek} dropped` : null}
              />
              <Stat label="No due date" value={report.tasks.undated} tone="neutral" sub="cannot be chased" />
            </div>
            <p className="wr-hint" style={{ marginTop: 12, marginBottom: 0 }}>
              Closed counts the previous full week ({fmtUk(report.tasks.lastWeek.from)} to {fmtUk(report.tasks.lastWeek.to)}), not a rolling seven days.
              Dropped is counted separately — both leave the list, only one is work finished.
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
                {log.hrGap.length} conversations/concerns not marked as logged in People HR.
              </p>
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
