import React, { useState, useEffect } from 'react';
import { apiUrl, setPin as storePin } from '../api';
import useCachedFetch from '../useCachedFetch';
import './AdminPanel.css';

/**
 * Change the NEURO PIN.
 *
 * Until this existed the only way to rotate was editing backend/.env over SSH
 * and restarting — which is why, when the PIN turned out to have been in a
 * public repo since 15 July (#123), rotating it stayed outstanding for days.
 *
 * Two things this has to get right or it does more harm than the manual route.
 * On success it MUST write the new PIN into localStorage, because the global
 * fetch interceptor signs every request with it — miss that and the app logs
 * itself out the instant the change lands, on the very screen that changed it.
 * And it has to say plainly what else breaks: the change is instant and every
 * other client keeps sending the old PIN until Nick goes and updates it.
 */
function ChangePinSection() {
  const [status, setStatus] = useState(null);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  const load = () => {
    fetch(apiUrl('/api/pin'))
      .then(r => r.json())
      .then(d => { if (d?.ok) setStatus(d); })
      .catch(() => {});
  };
  useEffect(load, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    // Checked here as well as server-side so the mismatch is caught before a
    // request that would otherwise succeed with a PIN Nick mistyped twice.
    if (newPin !== confirmPin) { setError('The two new PINs do not match.'); return; }

    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/pin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPin, newPin }),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.error || 'Could not change the PIN.'); setBusy(false); return; }

      // Before anything else: keep this browser signed in. The interceptor
      // reads localStorage on every request and the old PIN is already dead.
      storePin(newPin);
      setDone(data);
      setCurrentPin(''); setNewPin(''); setConfirmPin('');
      load();
    } catch (err) {
      setError(err.message || 'Could not reach the server.');
    }
    setBusy(false);
  };

  if (done) {
    return (
      <div className="admin-pin">
        <div className="admin-pin-done">
          PIN changed — {done.length} digits, live now. This browser has been updated
          automatically.
        </div>
        <div className="admin-pin-warn-title">Everything else still sends the old PIN:</div>
        <ul className="admin-pin-consumers">
          {(done.consumers || []).filter(c => !c.automatic).map(c => (
            <li key={c.id}><strong>{c.label}</strong> — {c.action}</li>
          ))}
        </ul>
        <button className="admin-ms-connect-btn" onClick={() => setDone(null)}>Done</button>
      </div>
    );
  }

  return (
    <form className="admin-pin" onSubmit={submit}>
      <div className="admin-ms-desc">
        Guards every <code>/api</code> route. Changing it takes effect immediately —
        no restart — and signs out every other device until you update it there too.
        {status?.lastChanged && (
          <> Last changed {new Date(status.lastChanged).toLocaleString('en-GB')}.</>
        )}
      </div>

      <label className="admin-pin-label">
        Current PIN
        <input
          className="admin-pin-input" type="password" inputMode="numeric" autoComplete="current-password"
          value={currentPin} onChange={e => setCurrentPin(e.target.value)} required
        />
      </label>
      <label className="admin-pin-label">
        New PIN
        <input
          className="admin-pin-input" type="password" inputMode="numeric" autoComplete="new-password"
          value={newPin} onChange={e => setNewPin(e.target.value)}
          minLength={status?.minLength || 4} maxLength={status?.maxLength || 12} required
        />
      </label>
      <label className="admin-pin-label">
        Confirm new PIN
        <input
          className="admin-pin-input" type="password" inputMode="numeric" autoComplete="new-password"
          value={confirmPin} onChange={e => setConfirmPin(e.target.value)} required
        />
      </label>

      {error && <div className="admin-error">{error}</div>}

      <button className="admin-ms-connect-btn" type="submit" disabled={busy}>
        {busy ? 'Changing…' : 'Change PIN'}
      </button>

      <div className="admin-pin-warn-title">This will need re-entering on:</div>
      <ul className="admin-pin-consumers">
        {(status?.consumers || []).filter(c => !c.automatic).map(c => (
          <li key={c.id}><strong>{c.label}</strong> — {c.action}</li>
        ))}
      </ul>
    </form>
  );
}

function StravaActivities({ onDisconnect }) {
  const [activities, setActivities] = useState(null);
  const [loading, setLoading] = useState(false);

  const pull = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/strava/activities/today'));
      const data = await res.json();
      setActivities(data.activities || []);
    } catch {
      setActivities([]);
    }
    setLoading(false);
  };

  const formatDuration = (secs) => {
    if (!secs) return '';
    const m = Math.round(secs / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };

  return (
    <>
      <div className="admin-ms-connected">
        <span className="admin-ms-connected-dot" />
        Connected
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
        <button
          className="admin-ms-connect-btn"
          style={{ background: 'rgba(252,76,2,0.1)', borderColor: '#fc4c02', color: '#fc4c02' }}
          onClick={pull}
          disabled={loading}
        >
          {loading ? 'Pulling...' : 'Pull Today\'s Activities'}
        </button>
        <button
          className="admin-ms-connect-btn"
          style={{ background: 'rgba(252,76,2,0.05)', borderColor: 'var(--border)', color: 'var(--text-muted)', fontSize: '11px' }}
          onClick={onDisconnect}
        >
          Disconnect
        </button>
      </div>
      {activities !== null && (
        <div style={{ marginTop: '12px' }}>
          {activities.length === 0 ? (
            <div className="admin-card-detail">No activities recorded today.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {activities.map((a, i) => (
                <div key={i} className="admin-card" style={{ borderLeft: '3px solid #fc4c02' }}>
                  <div className="admin-card-header">
                    <span className="admin-card-name">{a.name}</span>
                    <span className="admin-status-badge connected" style={{ background: 'rgba(252,76,2,0.1)', color: '#fc4c02' }}>
                      {a.type}
                    </span>
                  </div>
                  <div className="admin-card-detail">
                    {a.distance ? `${(a.distance / 1000).toFixed(1)}km` : ''}
                    {a.moving_time ? ` · ${formatDuration(a.moving_time)}` : ''}
                    {a.total_elevation_gain > 10 ? ` · ${Math.round(a.total_elevation_gain)}m elev` : ''}
                    {a.average_heartrate ? ` · avg HR ${Math.round(a.average_heartrate)}bpm` : ''}
                    {a.suffer_score ? ` · suffer ${a.suffer_score}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function VaultSyncCard({ vaultSync }) {
  const [triggering, setTriggering] = useState(false);
  const [result, setResult] = useState(null);

  if (!vaultSync) return null;

  const triggerSync = async () => {
    setTriggering(true);
    setResult(null);
    try {
      const res = await fetch(apiUrl('/api/activity/vault-sync'), { method: 'POST' });
      const data = await res.json();
      setResult(data);
    } catch (e) {
      setResult({ ok: false, error: e.message });
    }
    setTriggering(false);
  };

  const badge = vaultSync.enabled ? 'connected' : !vaultSync.vaultPath ? 'unconfigured' : 'disconnected';
  const badgeLabel = vaultSync.enabled ? 'watching' : !vaultSync.vaultPath ? 'no vault path' : 'disabled';

  const timeAgo = (iso) => {
    if (!iso) return 'never';
    const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
  };

  return (
    <div className="admin-section">
      <div className="admin-section-title">Vault Git Sync</div>
      <div className="admin-ms-section">
        <div className="admin-card" style={{ marginBottom: '12px' }}>
          <div className="admin-card-header">
            <span className="admin-card-name">File Watcher</span>
            <span className={`admin-status-badge ${badge}`}>{badgeLabel}</span>
          </div>
          <div className="admin-card-detail">
            {vaultSync.vaultPath || 'OBSIDIAN_VAULT_PATH not set'}
          </div>
        </div>
        {vaultSync.enabled && (
          <>
            <div className="admin-card-detail" style={{ marginBottom: '4px' }}>
              Last sync: <strong>{timeAgo(vaultSync.lastSync)}</strong> ·
              Last commit: <strong>{timeAgo(vaultSync.lastCommit)}</strong> ·
              Total syncs: <strong>{vaultSync.totalSyncs}</strong>
            </div>
            {vaultSync.lastError && (
              <div className="admin-error" style={{ marginBottom: '8px' }}>
                Last error ({timeAgo(vaultSync.lastError.time)}): {vaultSync.lastError.message}
              </div>
            )}
            <button
              className="admin-ms-connect-btn"
              onClick={triggerSync}
              disabled={triggering || vaultSync.syncing}
            >
              {triggering || vaultSync.syncing ? 'Syncing...' : 'Sync Now'}
            </button>
            {result && (
              <div className="admin-card-detail" style={{ marginTop: '6px', color: result.ok ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>
                {result.ok ? `Synced${result.changed ? ' — new commit pushed' : ' — no changes'}` : result.error || 'Failed'}
              </div>
            )}
          </>
        )}
        {!vaultSync.enabled && vaultSync.vaultPath && (
          <div className="admin-card-detail" style={{ color: 'var(--accent-warn, #f59e0b)' }}>
            Vault path set but watcher not running — check that the path exists and is a git repo
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Notion — the credential and the automatic-sync switch, in Settings.
 *
 * Both used to require an SSH session, an .env edit and a pm2 restart. They live
 * in the DB now (following the OpenRouter key in routes/ai-settings.js), so this
 * is a paste and a checkbox.
 *
 * The FOLDER MAPPINGS deliberately stay on the Notion Sync screen. A mapping
 * table with a folder picker, direction per row and a dry-run report is a
 * working surface, not a setting — putting it here would bury it, and Settings
 * is where you come to connect a thing, not to operate it.
 */
function NotionConnectCard({ notion, onRefresh }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const post = async (path, body, method = 'POST') => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(apiUrl(`/api/notion-sync${path}`), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json();
      if (data.ok === false) setError(data.error || 'That did not work.');
      else { setToken(''); onRefresh(); }
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="admin-section">
      <div className="admin-section-title">Notion</div>
      <div className="admin-ms-section">
        {!notion?.configured ? (
          <>
            <p className="admin-hint">
              Create an integration at{' '}
              <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">
                notion.so/my-integrations
              </a>{' '}
              with read, update and insert content capabilities, then paste its token here.
              Afterwards, share each parent page with it in Notion (⋯ → Connections) — the
              token on its own grants access to nothing.
            </p>
            <div className="admin-inline-form">
              <input
                type="password"
                value={token}
                placeholder="ntn_…"
                autoComplete="off"
                spellCheck="false"
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && token && post('/token', { token })}
              />
              <button
                className="admin-btn"
                disabled={!token || busy}
                onClick={() => post('/token', { token })}
              >
                {busy ? 'Connecting…' : 'Connect Notion'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="admin-hint">
              {notion.mappings > 0
                ? `${notion.mappings} folder${notion.mappings === 1 ? '' : 's'} mapped.`
                : 'Connected, but no folders are mapped yet — nothing will sync until one is.'}
              {' '}Map folders on the Notion Sync screen.
            </p>
            <label className="admin-toggle">
              <input
                type="checkbox"
                checked={Boolean(notion.autoSync)}
                disabled={busy}
                onChange={(e) => post('/auto', { enabled: e.target.checked })}
              />
              <span>Sync automatically every 15 minutes</span>
            </label>
            {/* An env-set token cannot be changed from here, so no button is
                offered rather than one that silently does nothing. */}
            {notion.credentialSource === 'stored' && (
              <button className="admin-btn" disabled={busy} onClick={() => post('/token', null, 'DELETE')}>
                Disconnect
              </button>
            )}
            {notion.credentialSource === 'env' && (
              <p className="admin-hint">Token is set in the environment, so it can’t be changed here.</p>
            )}
          </>
        )}
        {error && <div className="admin-error">{error}</div>}
      </div>
    </div>
  );
}

function PlaudSyncCard({ plaud, onRefresh }) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);

  if (!plaud) return null;

  const triggerSync = async (incremental = true) => {
    setSyncing(true);
    setResult(null);
    try {
      const res = await fetch(apiUrl('/api/plaud/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incremental })
      });
      const data = await res.json();
      setResult(data);
      onRefresh?.();
    } catch (e) {
      setResult({ error: e.message });
    }
    setSyncing(false);
  };

  const formatTime = (iso) => {
    if (!iso) return 'never';
    return new Date(iso).toLocaleString();
  };

  const statusClass = plaud.running ? 'connected' : plaud.configured ? 'connected' : 'unconfigured';
  const statusLabel = plaud.running ? 'syncing' : plaud.configured ? 'ready' : 'not configured';

  return (
    <div className="admin-section">
      <div className="admin-section-title">Plaud MCP</div>
      <div className="admin-ms-section">
        <div className="admin-card" style={{ marginBottom: '12px' }}>
          <div className="admin-card-header">
            <span className="admin-card-name">Recorder Import</span>
            <span className={`admin-status-badge ${statusClass}`}>{statusLabel}</span>
          </div>
          <div className="admin-card-detail">
            {plaud.configured
              ? `${plaud.summaryFolder} + ${plaud.transcriptFolder}`
              : 'OBSIDIAN_VAULT_PATH not set'}
          </div>
        </div>

        {plaud.configured && (
          <>
            <div className="admin-card-detail" style={{ marginBottom: '8px' }}>
              Synced: <strong>{plaud.syncedCount || 0}</strong> · Failed: <strong>{plaud.failedCount || 0}</strong>
            </div>
            <div className="admin-card-detail" style={{ marginBottom: '12px' }}>
              Last run: <strong>{formatTime(plaud.lastRunAt)}</strong> · Last success: <strong>{formatTime(plaud.lastSuccessfulSyncAt)}</strong>
            </div>
            {plaud.lastError && (
              <div className="admin-error" style={{ marginBottom: '8px' }}>
                Last error: {plaud.lastError}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                className="admin-ms-connect-btn"
                onClick={() => triggerSync(true)}
                disabled={syncing || plaud.running}
              >
                {syncing || plaud.running ? 'Syncing...' : 'Sync New Recordings'}
              </button>
              <button
                className="admin-ms-connect-btn"
                style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-muted)' }}
                onClick={() => triggerSync(false)}
                disabled={syncing || plaud.running}
              >
                Full Resync
              </button>
            </div>
            {result && (
              <div className="admin-card-detail" style={{ marginTop: '8px' }}>
                {result.error
                  ? `Sync failed: ${result.error}`
                  : `Imported ${result.imported || 0}, updated ${result.updated || 0}, skipped ${result.skipped || 0}, failed ${result.failed || 0}`}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AiSettingsSection() {
  const [settings, setSettings] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);

  const fetchSettings = () => {
    fetch(apiUrl('/api/ai/settings'))
      .then(r => r.json())
      .then(d => { setSettings(d.settings); setAiStatus(d.status); })
      .catch(() => {});
  };

  useEffect(() => { fetchSettings(); }, []);

  const updateSetting = async (key, value) => {
    setSaving(true);
    try {
      const r = await fetch(apiUrl('/api/ai/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      const result = await r.json();
      if (result.ok) {
        setSaved(key);
        setTimeout(() => setSaved(null), 2000);
        fetchSettings();
      }
    } catch {}
    setSaving(false);
  };

  if (!settings) return <div className="admin-card-detail">Loading AI settings...</div>;

  return (
    <div className="admin-ms-section">
      {/* AI Mode */}
      <div className="ai-setting-row">
        <div className="ai-setting-label">AI Mode</div>
        <select
          className="ai-setting-select"
          value={settings.ai_mode?.value || 'ollama-only'}
          onChange={e => updateSetting('ai_mode', e.target.value)}
          disabled={saving}
        >
          <option value="off">Off (rules only)</option>
          <option value="ollama-only">Ollama only</option>
          <option value="hybrid">Hybrid (Ollama + OpenRouter)</option>
          <option value="critical-only">Critical only (OpenRouter for critical tasks)</option>
        </select>
        {saved === 'ai_mode' && <span className="ai-setting-saved">✓</span>}
      </div>

      {/* SARA Mode */}
      <div className="ai-setting-row">
        <div className="ai-setting-label">SARA Suggestions</div>
        <select
          className="ai-setting-select"
          value={settings.sara_mode?.value || 'suggest'}
          onChange={e => updateSetting('sara_mode', e.target.value)}
          disabled={saving}
        >
          <option value="suggest">Enabled</option>
          <option value="off">Off</option>
        </select>
        {saved === 'sara_mode' && <span className="ai-setting-saved">✓</span>}
      </div>

      {/* Anthropic */}
      <div className="ai-setting-group">
        <div className="ai-setting-group-title">Anthropic</div>
        <div className="ai-setting-row">
          <div className="ai-setting-label">Enabled</div>
          <select
            className="ai-setting-select"
            value={settings.anthropic_enabled?.value || 'true'}
            onChange={e => updateSetting('anthropic_enabled', e.target.value)}
            disabled={saving}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
          {saved === 'anthropic_enabled' && <span className="ai-setting-saved">✓</span>}
        </div>
      </div>

      {/* OpenRouter */}
      <div className="ai-setting-group">
        <div className="ai-setting-group-title">OpenRouter</div>

        <div className="ai-setting-row">
          <div className="ai-setting-label">Enabled</div>
          <select
            className="ai-setting-select"
            value={settings.openrouter_enabled?.value || 'false'}
            onChange={e => updateSetting('openrouter_enabled', e.target.value)}
            disabled={saving}
          >
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
          {saved === 'openrouter_enabled' && <span className="ai-setting-saved">✓</span>}
        </div>

        <div className="ai-setting-row">
          <div className="ai-setting-label">API Key</div>
          <input
            className="ai-setting-input"
            type="password"
            placeholder={settings.openrouter_api_key?.hasValue ? '••••••' : 'Not set'}
            onBlur={e => { if (e.target.value) updateSetting('openrouter_api_key', e.target.value); }}
            disabled={saving}
          />
          {saved === 'openrouter_api_key' && <span className="ai-setting-saved">✓</span>}
        </div>

        <div className="ai-setting-row">
          <div className="ai-setting-label">Model</div>
          <input
            className="ai-setting-input"
            defaultValue={settings.openrouter_model?.value || 'anthropic/claude-haiku-4.5'}
            onBlur={e => updateSetting('openrouter_model', e.target.value)}
            disabled={saving}
          />
          {saved === 'openrouter_model' && <span className="ai-setting-saved">✓</span>}
        </div>

        <div className="ai-setting-row">
          <div className="ai-setting-label">Daily call limit</div>
          <input
            className="ai-setting-input ai-setting-input-sm"
            type="number"
            defaultValue={settings.openrouter_daily_call_limit?.value || 100}
            onBlur={e => updateSetting('openrouter_daily_call_limit', e.target.value)}
            disabled={saving}
          />
          {saved === 'openrouter_daily_call_limit' && <span className="ai-setting-saved">✓</span>}
        </div>

        <div className="ai-setting-row">
          <div className="ai-setting-label">Daily token limit</div>
          <input
            className="ai-setting-input ai-setting-input-sm"
            type="number"
            defaultValue={settings.openrouter_daily_token_limit?.value || 100000}
            onBlur={e => updateSetting('openrouter_daily_token_limit', e.target.value)}
            disabled={saving}
          />
          {saved === 'openrouter_daily_token_limit' && <span className="ai-setting-saved">✓</span>}
        </div>
      </div>

      {/* Pi 4 Worker */}
      <div className="ai-setting-group">
        <div className="ai-setting-group-title">Pi 4 Worker</div>
        <div className="ai-setting-row">
          <div className="ai-setting-label">Enabled</div>
          <select
            className="ai-setting-select"
            value={settings.pi4_worker_enabled?.value || 'false'}
            onChange={e => updateSetting('pi4_worker_enabled', e.target.value)}
            disabled={saving}
          >
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
          {saved === 'pi4_worker_enabled' && <span className="ai-setting-saved">✓</span>}
        </div>
        <div className="ai-setting-row">
          <div className="ai-setting-label">URL</div>
          <input
            className="ai-setting-input"
            defaultValue={settings.pi4_worker_url?.value || ''}
            onBlur={e => updateSetting('pi4_worker_url', e.target.value)}
            disabled={saving}
          />
          {saved === 'pi4_worker_url' && <span className="ai-setting-saved">✓</span>}
        </div>
      </div>

      {/* Live Status */}
      {aiStatus && (
        <div className="ai-setting-group">
          <div className="ai-setting-group-title">Live Status</div>
          <div className="ai-status-grid">
            <div>Ollama: <span className="ai-status-val">{aiStatus.ollamaModel}</span></div>
            <div>Light model: <span className="ai-status-val">{aiStatus.ollamaLightModel}</span></div>
            <div>Queue: <span className="ai-status-val">{aiStatus.ollamaQueueDepth} {aiStatus.ollamaInUse ? '(active)' : '(idle)'}</span></div>
            {aiStatus.openrouterModel && (
              <div>OpenRouter: <span className="ai-status-val">{aiStatus.openrouterModel}</span></div>
            )}
            {aiStatus.openrouterCallsToday > 0 && (
              <div>OpenRouter today: <span className="ai-status-val">{aiStatus.openrouterCallsToday} calls, {aiStatus.openrouterTokensToday} tokens</span></div>
            )}
            {aiStatus.openrouterThrottled && <div className="ai-status-warn">OpenRouter throttled</div>}
            {aiStatus.pi4Enabled && (
              <div>Pi 4: <span className="ai-status-val">{aiStatus.pi4Healthy ? 'healthy' : 'unreachable'}</span></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminPanel({ pushState = {} }) {
  const { supported: pushSupported, subscribed: pushSubscribed, error: pushError, manualSubscribe } = pushState;
  const { data: status, refresh: fetchStatus } = useCachedFetch('/api/status');
  const [deviceCode, setDeviceCode] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [connecting, setConnecting] = useState(false);

  // Poll for auth completion when device code is active
  useEffect(() => {
    if (!deviceCode) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(apiUrl('/api/microsoft/status'));
        const data = await res.json();
        if (data.authenticated) {
          setDeviceCode(null);
          setConnecting(false);
          fetchStatus();
        }
      } catch (e) { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [deviceCode, fetchStatus]);

  const startAuth = async () => {
    setConnecting(true);
    setAuthError(null);
    try {
      const res = await fetch(apiUrl('/api/microsoft/auth'), { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        setAuthError(data.error);
        setConnecting(false);
      } else {
        setDeviceCode(data);
      }
    } catch (e) {
      setAuthError(e.message);
      setConnecting(false);
    }
  };

  if (!status) return <div className="admin-container">Loading...</div>;

  const integrations = [
    {
      // Ollama handles the light and scheduled work under the 14 Aug routing
      // policy, so its tile says so rather than implying it serves everything.
      name: 'AI (Ollama)',
      status: status.ollamaReachable ? 'connected' : 'disconnected',
      detail: status.ollamaReachable
        ? `Local · ${status.ai?.ollama?.model || '?'} · scheduled + light tasks`
        : 'Ollama not reachable'
    },
    {
      // OpenRouter is the default for anything Nick waits on (chat, standup,
      // drafts). The key is stored in the DB via the AI settings panel, NOT in
      // .env — a blank .env line here means nothing.
      name: 'AI (OpenRouter)',
      status: !status.ai?.openrouter?.configured ? 'unconfigured'
        : !status.ai?.openrouter?.enabled ? 'disconnected'
        : status.ai?.openrouter?.throttled ? 'disconnected'
        : 'connected',
      detail: !status.ai?.openrouter?.configured
        ? 'No API key — set it in AI Settings below'
        : !status.ai?.openrouter?.enabled
          ? 'Key set but disabled — enable in AI Settings'
          : status.ai?.openrouter?.throttled
            ? `Daily limit reached (${status.ai.openrouter.callsToday}/${status.ai.openrouter.dailyCallLimit} calls)`
            : `${status.ai.openrouter.model} · chat + rituals · ${status.ai.openrouter.callsToday}/${status.ai.openrouter.dailyCallLimit} calls today`
    },
    {
      name: 'Jira',
      status: status.jira?.configured
        ? (status.jira.status === 'ok' ? 'connected' : 'disconnected')
        : 'unconfigured',
      detail: status.jira?.configured
        ? `Status: ${status.jira.status}${status.jira.last_sync ? ' · Last sync: ' + new Date(status.jira.last_sync).toLocaleTimeString() : ''}`
        : 'JIRA_* env vars not set'
    },
    {
      name: 'Obsidian',
      status: status.obsidian?.configured ? 'connected' : 'unconfigured',
      detail: status.obsidian?.configured ? 'Vault path configured' : 'OBSIDIAN_VAULT_PATH not set'
    },
    {
      name: 'Microsoft 365',
      status: status.microsoft?.source === 'msal' ? 'connected' :
              status.microsoft?.source === 'nova-bridge' ? 'connected' : 'disconnected',
      detail: status.microsoft?.source === 'msal' ? 'Graph API authenticated (MSAL)' :
              status.microsoft?.source === 'nova-bridge' ? 'Connected via NOVA bridge' :
              'Not authenticated'
    },
    {
      name: 'Plaud MCP',
      status: status.plaud?.running ? 'connected' :
              status.plaud?.configured ? 'connected' : 'unconfigured',
      detail: status.plaud?.configured
        ? `${status.plaud.syncedCount || 0} synced · ${status.plaud.failedCount || 0} failed`
        : 'Vault path not configured for Plaud import'
    },
    {
      name: 'n8n',
      status: status.n8n?.configured ? 'connected' : 'unconfigured',
      detail: status.n8n?.configured ? 'API key set — workflows available' : 'N8N_API_KEY not set'
    },
    {
      name: 'Strava',
      status: status.strava?.authenticated ? 'connected'
        : status.strava?.configured ? 'disconnected'
        : 'unconfigured',
      detail: status.strava?.authenticated ? 'Activity data available'
        : status.strava?.configured ? 'Not authenticated — connect below'
        : 'STRAVA_CLIENT_ID not set'
    },
    {
      name: 'Apple Health (Shortcut)',
      status: status.health?.hasToday ? 'connected'
        : status.health?.latestDate ? 'disconnected'
        : 'unconfigured',
      detail: status.health?.hasToday
        ? 'Data received today'
        : status.health?.latestDate
        ? `Last data: ${status.health.latestDate} — Shortcut may not have run today`
        : 'No data received — set up the iOS Shortcut (see below)'
    },
    {
      name: 'OwnTracks (Location)',
      status: status.location?.configured ? 'connected' : 'unconfigured',
      detail: status.location?.configured
        ? `Recorder at ${status.location.recorderUrl}`
        : 'OWNTRACKS_RECORDER_URL not set — see setup guide'
    },
    {
      // ⚠ "Connected" is NOT the same claim as "syncing". A token with no folder
      // mapped does no work at all, and a card reading connected over that would
      // be the half-truth this file already avoids for Strava.
      name: 'Notion',
      status: !status.notion?.configured ? 'unconfigured'
        : status.notion.mappings > 0 ? 'connected'
        : 'disconnected',
      detail: !status.notion?.configured
        ? 'No token — connect it on the Notion Sync screen'
        : status.notion.mappings === 0
        ? 'Token set, but no folders mapped yet — map one on the Notion Sync screen'
        : `${status.notion.mappings} folder${status.notion.mappings === 1 ? '' : 's'} mapped · `
          + `${status.notion.autoSync ? 'syncing every 15 min' : 'manual sync only'}`
    }
  ];

  return (
    <div className="admin-container">
      <div className="admin-sara">
        <span className="admin-sara-label">SARA</span>
        <span className="admin-sara-line">System configuration. Change what I connect to.</span>
      </div>

      <div className="admin-section">
        <div className="admin-section-title">Integrations</div>
        <div className="admin-cards">
          {integrations.map(int => (
            <div key={int.name} className="admin-card">
              <div className="admin-card-header">
                <span className="admin-card-name">{int.name}</span>
                <span className={`admin-status-badge ${int.status}`}>
                  {int.status}
                </span>
              </div>
              <div className="admin-card-detail">{int.detail}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="admin-section">
        <div className="admin-section-title">Security</div>
        <ChangePinSection />
      </div>

      <div className="admin-section">
        <div className="admin-section-title">AI & SARA</div>
        <AiSettingsSection />
      </div>

      <div className="admin-section">
        <div className="admin-section-title">Microsoft 365 Authentication</div>
        <div className="admin-ms-section">
          {status.microsoft?.authenticated && !deviceCode ? (
            <>
              <div className="admin-ms-connected">
                <span className="admin-ms-connected-dot" />
                Connected to Microsoft Graph (MSAL)
              </div>
              <div className="admin-ms-scopes" style={{ marginBottom: '12px' }}>
                Scopes: <span>Calendars.Read</span><span>Mail.Read</span><span>Tasks.ReadWrite</span><span>User.Read</span>
              </div>
              <button
                className="admin-ms-connect-btn"
                onClick={startAuth}
                disabled={connecting}
              >
                {connecting ? 'Starting...' : 'Re-authenticate'}
              </button>
            </>
          ) : status.microsoft?.bridge && !deviceCode ? (
            <>
              <div className="admin-ms-connected">
                <span className="admin-ms-connected-dot" style={{ background: '#f59e0b' }} />
                Connected via NOVA bridge (fallback)
              </div>
              <div className="admin-ms-scopes" style={{ marginBottom: '12px' }}>
                Calendar, Mail, Tasks available through bridge. Sign in directly for two-way sync.
              </div>
              <button
                className="admin-ms-connect-btn"
                onClick={startAuth}
                disabled={connecting}
              >
                {connecting ? 'Starting...' : 'Sign in with Microsoft'}
              </button>
            </>
          ) : deviceCode ? (
            <div className="admin-device-code">
              <div className="admin-device-code-label">Enter this code at Microsoft</div>
              <div className="admin-device-code-value">{deviceCode.userCode}</div>
              <div className="admin-device-code-link">
                <a href="https://microsoft.com/devicelogin" target="_blank" rel="noopener noreferrer">
                  microsoft.com/devicelogin
                </a>
              </div>
              <div className="admin-device-code-waiting">Waiting for you to sign in...</div>
            </div>
          ) : (
            <>
              <div className="admin-ms-desc">
                Connect your Microsoft 365 account to enable calendar sync, inbox triage, and task integration.
                Uses device code flow — click below, then enter the code at microsoft.com/devicelogin.
              </div>
              <button
                className="admin-ms-connect-btn"
                onClick={startAuth}
                disabled={connecting}
              >
                {connecting ? 'Starting...' : 'Connect Microsoft 365'}
              </button>
            </>
          )}
          {authError && <div className="admin-error">{authError}</div>}
        </div>
      </div>

      <PlaudSyncCard plaud={status.plaud} onRefresh={fetchStatus} />

      <NotionConnectCard notion={status.notion} onRefresh={fetchStatus} />

      <div className="admin-section">
        <div className="admin-section-title">Push Notifications</div>
        <div className="admin-ms-section">
          <div className="admin-card" style={{ marginBottom: '12px' }}>
            <div className="admin-card-header">
              <span className="admin-card-name">Server VAPID keys</span>
              <span className={`admin-status-badge ${status.push?.configured ? 'connected' : 'unconfigured'}`}>
                {status.push?.configured ? 'configured' : 'not configured'}
              </span>
            </div>
            {!status.push?.configured && (
              <div className="admin-card-detail" style={{ color: 'var(--accent-warn, #f59e0b)' }}>
                Run <code>npx web-push generate-vapid-keys</code> on Pi, add to .env, restart.
              </div>
            )}
          </div>
          {!pushSupported ? (
            <div className="admin-ms-desc">
              Push not supported in this browser. Install as PWA first.
            </div>
          ) : pushSubscribed ? (
            <>
              <div className="admin-ms-connected" style={{ marginBottom: '12px' }}>
                <span className="admin-ms-connected-dot" />
                This device is subscribed · {status.push?.subscriptions || 1} device{(status.push?.subscriptions || 1) !== 1 ? 's' : ''} total
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button className="admin-ms-connect-btn" onClick={async () => {
                  try {
                    const res = await fetch(apiUrl('/api/push/test'), { method: 'POST' });
                    const data = await res.json();
                    if (data.ok) alert('Test notification sent — you should receive it shortly');
                    else alert('Test failed: ' + (data.error || 'unknown error'));
                  } catch (e) { alert('Test failed: ' + e.message); }
                }}>
                  Send Test
                </button>
                <button className="admin-ms-connect-btn" onClick={async () => {
                  try {
                    // Clear all subs, then re-subscribe
                    await fetch(apiUrl('/api/push/subscriptions'), { method: 'DELETE' });
                    await manualSubscribe();
                    alert('Re-subscribed — try sending a test now');
                  } catch (e) { alert('Re-subscribe failed: ' + e.message); }
                }}>
                  Re-subscribe
                </button>
              </div>
              {pushError && (
                <div className="admin-ms-desc" style={{ marginTop: '8px', color: '#ef4444' }}>
                  Push error: {pushError}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="admin-ms-desc" style={{ marginBottom: '12px' }}>
                iOS: install as PWA first (Safari → Share → Add to Home Screen). Then tap Enable and accept the prompt.
              </div>
              <button
                className="admin-ms-connect-btn"
                onClick={manualSubscribe}
                disabled={!status.push?.configured}
                title={!status.push?.configured ? 'VAPID keys not configured on server' : ''}
              >
                Enable Notifications
              </button>
              {!status.push?.configured && (
                <div className="admin-ms-desc" style={{ marginTop: '8px', opacity: 0.6 }}>
                  Button disabled — server VAPID keys not configured yet
                </div>
              )}
            </>
          )}
          {pushError && <div className="admin-error">{pushError}</div>}
        </div>
      </div>

      {/* Strava */}
      <div className="admin-section">
        <div className="admin-section-title">Strava</div>
        <div className="admin-ms-section">
          {status.strava?.authenticated ? (
            <StravaActivities onDisconnect={() => { fetch(apiUrl('/api/strava/disconnect'), { method: 'POST' }).then(fetchStatus); }} />
          ) : status.strava?.configured ? (
            <>
              <div className="admin-ms-desc">
                Connect Strava to include today's activity in your journal prompts and
                NEURO chat context. Opens a Strava authorisation page — you'll need to
                be on your Tailscale network.
              </div>
              <button
                className="admin-ms-connect-btn"
                style={{ background: 'rgba(252,76,2,0.1)', borderColor: '#fc4c02', color: '#fc4c02' }}
                onClick={() => window.open(apiUrl('/api/strava/auth'), '_blank')}
              >
                Connect Strava
              </button>
            </>
          ) : (
            <div className="admin-ms-desc">
              Add STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, and STRAVA_REDIRECT_URI to
              the Pi's .env file to enable Strava integration.
            </div>
          )}
        </div>
      </div>

      {/* Apple Health */}
      <div className="admin-section">
        <div className="admin-section-title">Apple Health</div>
        <div className="admin-ms-section">
          {status.health?.hasToday ? (
            <div className="admin-ms-connected">
              <span className="admin-ms-connected-dot" />
              Health data received today — active in journal prompts and chat
            </div>
          ) : (
            <>
              <div className="admin-ms-desc" style={{ marginBottom: '12px' }}>
                Set up an iOS Shortcut to send Apple Health data (HRV, sleep, RHR)
                to NEURO each morning. The Shortcut runs automatically and posts to
                the Pi via Tailscale.
              </div>
              <div className="admin-ms-desc" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: '1.8', background: 'var(--bg-tertiary)', padding: '12px', borderRadius: '4px', marginBottom: '8px' }}>
                <strong>Shortcut setup (one-time):</strong><br />
                1. Open Shortcuts app on iPhone<br />
                2. Create new Shortcut with these actions:<br />
                &nbsp;&nbsp;- Get Health Sample: Heart Rate Variability (last 24h, average)<br />
                &nbsp;&nbsp;- Get Health Sample: Resting Heart Rate (last 24h, latest)<br />
                &nbsp;&nbsp;- Get Health Sample: Sleep Analysis (last 24h)<br />
                &nbsp;&nbsp;- Get Health Sample: Step Count (today, sum)<br />
                &nbsp;&nbsp;- Get Health Sample: Active Energy (today, sum)<br />
                &nbsp;&nbsp;- Get Contents of URL: POST to /api/health/ingest<br />
                &nbsp;&nbsp;- Headers: Authorization: Bearer [INGEST_SECRET]<br />
                &nbsp;&nbsp;- Body: JSON with keys: hrv, rhr, sleepDuration, steps, activeEnergy<br />
                3. Add automation: run at 07:30 daily
              </div>
              {status.health?.latestDate && (
                <div className="admin-ms-desc" style={{ color: 'var(--accent-warn, #f59e0b)' }}>
                  Last data received: {status.health.latestDate} — Shortcut hasn't run today yet
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <VaultSyncCard vaultSync={status.vaultSync} />

      <div className="admin-section">
        <div className="admin-section-title">System</div>
        <div className="admin-card">
          <div className="admin-card-header">
            <span className="admin-card-name">NEURO</span>
            <span className="admin-status-badge connected">v{status.version}</span>
          </div>
          <div className="admin-card-detail">
            Uptime: {Math.floor(status.uptime / 60)}m {Math.floor(status.uptime % 60)}s
          </div>
        </div>
      </div>
    </div>
  );
}
