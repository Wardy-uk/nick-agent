import { useSaraState } from '../state/saraState';
import './ConnectionStatus.css';

// The connection banner — the one place SARA says where what you are looking at came
// from.
//
// It exists because the failure it guards against is invisible by construction: a SARA
// showing seeded or stale data looks EXACTLY like a SARA that is working. There was no
// way, from the screen, to tell "two tickets are breaching" from "SARA has no idea and
// filled it in". Every word here comes from the backend's `provenance` block, so the
// banner cannot drift from the data it describes.
//
// Design rules:
//   * Live is SILENT. A permanent green badge is a badge nobody reads by week two, and
//     the whole point is that the abnormal states stand out.
//   * Demo is the loudest thing on the screen. It is the only state where the content
//     is fiction, and it must be impossible to mistake for a working day.
//   * Every non-live state says what SARA cannot see, never a reassuring summary.

const TONE = {
  demo: 'danger',
  unavailable: 'danger',
  'not-configured': 'danger',
  unknown: 'warn',
  'neuro-stale': 'warn',
  mixed: 'warn',
};

const LABEL = {
  demo: 'DEMO DATA',
  unavailable: 'NEURO unreachable',
  'not-configured': 'NEURO not configured',
  unknown: 'Connecting',
  'neuro-stale': 'Stale',
  mixed: 'Partial',
};

export default function ConnectionStatus() {
  const { provenance } = useSaraState();
  const state = provenance?.state || 'unknown';

  // Live and complete — say nothing. Silence here is the signal that everything is
  // normal, which is what makes the noisy states worth reading.
  if (state === 'neuro') return null;

  const tone = TONE[state] || 'warn';
  const label = LABEL[state] || 'Unverified';
  const problems = provenance?.neuro?.problems || [];

  return (
    <div className={`connstatus connstatus--${tone}`} role="status" aria-live="polite">
      <span className="connstatus__label">{label}</span>
      <span className="connstatus__message">{provenance?.message}</span>
      {/* Only shown when the fix is a configuration change — a reason Nick or an
          operator can act on, rather than "something went wrong". */}
      {problems.length > 0 && (
        <span className="connstatus__detail">{problems.join(' ')}</span>
      )}
    </div>
  );
}
