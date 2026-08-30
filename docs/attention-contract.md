# The attention contract

**One NEURO-owned attention decision.** Neuro Mobile, the Scriptable widget, the
SARA kiosk and every push notification CONSUME this. None of them rerank work,
invent urgency, or phrase the same state differently.

Version `v1`. Phase 3, Gate 1 — 30 Aug 2026.

---

## Why this exists

Before it, an attention item was a value that lived for one HTTP request.
`decision-engine.evaluate()` recomputed the pool on every call, `attention.gate()`
ranked it, and the answer was rendered and thrown away. Three things followed
from that, and all three are what this contract fixes:

1. **Nothing could be acknowledged.** The only durable state was
   `decision-engine`'s suppression map — id → `until` — which is a *timer*, not a
   lifecycle. "I have seen this" and "hide it for 30 minutes" were the same
   gesture, and neither could be told from "this is finished".

2. **A notification had no idea what it was about.** All 30 `webpush.sendToAll`
   call sites pass free text, and the governor deduped on a fingerprint of that
   text. So a meeting alert counting down — "in 25 min", "in 10 min" — produced a
   different fingerprint each time and passed the dedupe cleanly. The rule "the
   same card must not repeatedly notify Nick across widget, push, kiosk and
   mobile without a meaningful state change" was not merely unenforced, it was
   unexpressible.

3. **Item ids were not stable.** `collectOverdueTodos` emits `todo-overdue-top`
   when one task is overdue and `todo-overdue-summary` when two are. The identity
   of the card flips as the pile grows, so a dismissal recorded against one id
   silently stopped applying the moment a second task went overdue.

## What this does NOT change

`decision-engine` stays **the single place something becomes worth surfacing**,
with the scoring, overrides and category suppression it has already learned.
`attention.gate()` stays the single place the context re-ranks and gates it.

This layer sits underneath both and does exactly one new thing: it gives each
surfaced thing a **durable identity and a lifecycle**. It adds no candidates, it
changes no ranking, and it must never be the reason something is hidden that the
gate would have shown.

---

## The record

Every attention item is persisted as one `attention_records` row. The fields the
brief requires, and where each comes from:

| Field | Meaning | Source |
|---|---|---|
| `id` | canonical id, stable for the life of the record | assigned here |
| `dedupe_key` | identity of the *thing*, stable across evaluations | `dedupeKeyFor(item)` — pure |
| `type` | `todo` / `meeting` / `escalation` / `email` / `nudge` / … | decision-engine |
| `state` | lifecycle, below | this layer |
| `title`, `say`, `reason` | user-facing wording | composed by NEURO, never by a client |
| `tab` | where tapping it goes | `resolveSaraLiteTab` — the one resolver |
| `urgency`, `tier`, `score` | priority | decision-engine |
| `confidence` | `{level, why}` — explicit uncertainty | `context-state`, capped by coverage |
| `evidence` | `[{source, ref, observedAt, detail}]` | `evidenceFor(item)` — pure, never invented |
| `actions` | bounded action set | `actionsFor(item)` — pure |
| `first_seen_at`, `last_seen_at` | when NEURO first and last had evidence | this layer |
| `surfaced_at`, `notified_at` | when it reached a screen / interrupted | this layer |
| `notify_signature` | what was true when it last interrupted | this layer |

`evidence` is the load-bearing one. **It is never invented.** Where an item
carries nothing structured enough to cite, `evidence` is `[]` — and that is not
cosmetic, because of the asymmetry in the next section.

### Showing is safe; interrupting requires evidence

Two different powers, two different bars — the same split `attention.gate()`
already draws between quieting and dropping.

* **Surfacing** an item with no evidence is allowed. Refusing to show work
  because NEURO cannot cite it would hide real work on a bookkeeping failure,
  which is the failure that ends the feature.
* **Notifying** about an item with no evidence is refused. An interruption is a
  claim that something is true and worth stopping for; if we cannot say what
  makes it true, we have not earned the interruption.

## Lifecycle

```
                    ┌──────────────► resolved   (acted, or left the pool)
                    │
   (generated) → active ──► acknowledged ──► resolved
                    │  │
                    │  └──► deferred ──(defer_until passes)──► active
                    │
                    ├──► suppressed  (dismissed — teaches suppression)
                    └──► expired     (its moment passed)
```

Six states, and the distinctions are the product:

* **`active`** — NEURO has evidence, and it is eligible to surface and to notify.
* **`acknowledged`** — Nick has seen it. It **stays visible** and **never
  notifies again**. This is the state the old suppression map could not express:
  acknowledging is not hiding.
* **`deferred`** — snoozed until `defer_until`, carrying a `defer_reason`
  (`not-now`, `no-context`, `waiting-on-someone`, `too-big`, `unspecified`).
  Returns to `active` on its own. The reason is recorded because a thing deferred
  three times for `too-big` is a different problem from one deferred for
  `not-now`, and Work Package C is built on knowing which.
* **`suppressed`** — dismissed. Teaches `decision-engine.dismiss()` so the
  existing category-suppression learning applies. **The canonical work is not
  touched**: dismissing a card about an overdue task does not complete, delete or
  reschedule the task.
* **`resolved`** — acted on, or the underlying thing left the pool (the task got
  done, the escalation got a reply).
* **`expired`** — its moment passed with no decision from Nick. A meeting that
  has started; a "leave now" that is no longer true. Distinct from `resolved`
  because **Nick decided nothing**, and the difference matters to any later
  reading of what he actually chose to do.

### Terminal states never re-match

Reconciliation matches a generated item against records in `active`,
`acknowledged` or `deferred` **only**. `resolved`, `expired` and `suppressed` are
terminal: if the same `dedupe_key` appears again, a **new record** is opened.

This is what makes a daily recurrence work without special-casing it. Yesterday's
standup nudge resolved when it left the pool; today's opens a fresh record and is
allowed to notify once. Without it, either the key has to carry a date (and then
nothing can be tracked across a day boundary) or yesterday's dismissal silences
today's.

## Notification rule

A notification is sent only when **all** of these hold. Each one is a bug that
has actually happened here.

1. **There is an attention record.** No record, no notification — enforced inside
   `webpush.sendToAll` itself, so all 30 existing call sites are covered without
   editing any of them. A caller that supplies no attention id gets an
   `operational` record opened for it (watchdog, scheduler job reports); those
   are real interruptions and belong in the history Nick reads.
2. **State is `active`.** Acknowledged, deferred, suppressed and terminal records
   never notify.
3. **There is evidence** (per the asymmetry above), for non-operational records.
4. **Either it has never notified, or the signature changed meaningfully.**
   `notify_signature` is `urgency|tier` — deliberately **not** the text. A
   countdown re-rendering is not a state change; an item going `medium` →
   `critical` is.
5. **Notifications are enabled, it is not quiet hours, and SARA is not paused.**
6. **It clears the interruption level** — see controls.

Critical items bypass 5 (quiet hours, pause, cap) and **only** by the explicit
rule in `ALWAYS_DELIVER`. They never bypass 1–4: an escalation arriving twice is
still one escalation, which is the invariant the old text fingerprint was
reaching for and missing.

## Controls

Stored in `agent_state.attention_settings`, read by the notification gate, edited
from Neuro Mobile.

| Control | Default | Note |
|---|---|---|
| `enabled` | `true` | master switch |
| `quietHours` | `22:00-07:00` | mirrors `PUSH_QUIET_HOURS`; the setting wins when present |
| `interruptionLevel` | `normal` | `all` / `normal` / `critical-only` |
| `pausedUntil` | `null` | "pause SARA for 2 hours" |
| `domains` | `{work: true, personal: true}` | uses the existing `meta.domain` split |

**Permission is never requested on first launch.** The browser prompt is raised
only when Nick explicitly enables notifications in this surface — asking on
launch is how an app gets denied permanently by someone who was busy.

## Consumer rules

* The record is the **only** source of `title`, `say`, `reason`, `tab` and
  `actions`. A client that composes its own wording is a second opinion and will
  drift — this is the same rule that already keeps `speech` server-side.
* `state` is honoured, not re-derived. A deferred record is not shown as active
  because a client thinks the time looks right.
* **A missing or unreadable pool is never rendered as an all-clear.** The
  existing `poolAvailable` / `gaps` / `dropped` fields carry that and are
  unchanged.
* Clients submit *actions* (`acknowledge` / `defer` / `dismiss` / `act`). They do
  not write state directly.

## Migration

Additive. `attention_records` and `attention_events` are new tables created by
`schema.sql`; no existing table changes and there is nothing to backfill — a
record is opened the first time its item is seen after deploy.

`GET /api/attention` keeps its existing shape exactly. Every field it returned
before is still returned and still means the same thing; `primary` and
`secondary` cards gain `recordId`, `state` and `evidence`, and the payload gains
`attention: {version, records}`. A client that ignores all of that is unaffected,
which is what lets the widget and the kiosk be migrated separately.
