import { useState } from 'react';
import { useSaraState } from '../../state/saraState';

export default function SettingsView() {
  const { status, error, model, chatBridge, neuroAuth, setNeuroPin } = useSaraState();
  const [pinDraft, setPinDraft] = useState('');
  const [pinStatus, setPinStatus] = useState(null);

  if (status === 'connecting') return <section className="product"><p className="product__summary">Waking SARA…</p></section>;
  if (status === 'disconnected' || !model) {
    return <section className="product"><p className="product__summary">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p></section>;
  }

  return (
    <section className="product" aria-label="Settings">
      <header className="product__hero">
        <p className="product__eyebrow">Settings</p>
        <h2 className="product__title">Runtime and source status</h2>
        <p className="product__summary">Operator-facing settings surface while the full product settings stack is still being built.</p>
      </header>

      <div className="product__grid">
        <section className="product__section product__section--span-6">
          <p className="product__section-title">Runtime</p>
          <div className="product__rows">
            <div className="product__row">
              <div>
                <p className="product__row-title">State engine</p>
                <p className="product__row-detail">{model.runtime}</p>
              </div>
              <span className="product__row-right">{model.contract} · v{model.schemaVersion}</span>
            </div>
            <div className="product__row">
              <div>
                <p className="product__row-title">Location source</p>
                <p className="product__row-detail">{model.location?.label}</p>
              </div>
              <span className="product__row-right">{model.location?.source}</span>
            </div>
            <div className="product__row">
              <div>
                <p className="product__row-title">Inference</p>
                <p className="product__row-detail">{model.inference?.summary}</p>
              </div>
              <span className="product__row-right">{model.inference?.confidence?.level}</span>
            </div>
          </div>
        </section>
        <section className="product__section product__section--span-6">
          <p className="product__section-title">Connections</p>
          <div className="product__rows">
            <div className="product__row">
              <div>
                <p className="product__row-title">Home Assistant</p>
                <p className="product__row-detail">{model.telemetry?.detail || model.telemetry?.reason || 'Live telemetry available.'}</p>
              </div>
              <span className="product__row-right">{model.telemetry?.available ? 'live' : 'fallback'}</span>
            </div>
            {/* ⚠ "fallback" used to be the right word here and no longer is — there
                IS no fallback. What is on screen is live, stale, or absent, and this
                row names which, using the same provenance string the banner reads. */}
            <div className="product__row">
              <div>
                <p className="product__row-title">NEURO data</p>
                <p className="product__row-detail">{model.provenance?.message}</p>
              </div>
              <span className="product__row-right">{model.provenance?.state}</span>
            </div>
            <div className="product__row">
              <div>
                <p className="product__row-title">NEURO connection</p>
                {/* Non-sensitive: where NEURO is and WHETHER a credential is set.
                    Never the credential. */}
                <p className="product__row-detail">
                  {model.provenance?.neuro?.problems?.length
                    ? model.provenance.neuro.problems.join(' ')
                    : `${model.provenance?.neuro?.baseUrl} · auth: ${model.provenance?.neuro?.credentialKind}`}
                </p>
              </div>
              <span className="product__row-right">{model.provenance?.neuro?.ready ? 'configured' : 'not configured'}</span>
            </div>
            <div className="product__row">
              <div>
                <p className="product__row-title">NEURO auth</p>
                <p className="product__row-detail">{neuroAuth.detail || 'Session bridge ready.'}</p>
              </div>
              <span className="product__row-right">{neuroAuth.source}</span>
            </div>
            <div className="product__row">
              <div>
                <p className="product__row-title">NEURO chat bridge</p>
                <p className="product__row-detail">{chatBridge.detail || 'Conversation bridge available.'}</p>
              </div>
              <span className="product__row-right">{chatBridge.status}</span>
            </div>
            <div className="product__row">
              <div>
                <p className="product__row-title">Confidence</p>
                <p className="product__row-detail">{model.confidence?.rationale}</p>
              </div>
              <span className="product__row-right">{model.confidence?.score}</span>
            </div>
          </div>
          <div className="product__actions">
            <input
              type="password"
              className="product__input"
              value={pinDraft}
              onChange={(event) => setPinDraft(event.target.value)}
              placeholder="Enter NEURO PIN for live data"
            />
            <button
              type="button"
              className="product__button"
              onClick={async () => {
                const result = await setNeuroPin(pinDraft);
                setPinStatus(result.ok ? 'NEURO PIN accepted' : result.error);
                if (result.ok) setPinDraft('');
              }}
            >
              Unlock live data
            </button>
            {pinStatus && <span className="product__pill">{pinStatus}</span>}
          </div>
        </section>
      </div>
    </section>
  );
}
