# Off-site backup — configured and verified (#59)

**Live since 16 Aug 2026.** First full copy 2.05 GB in 12 minutes; incremental
runs take about 2. Runs nightly at **02:20** from root cron.

## ⚠ Two things Nick must do

### 1. Store these somewhere off this machine — a password manager, not the vault

```
CRYPT_PASSWORD: UcFpoqxNHjNbGvryHwfDiSS1D2RscVoQ
CRYPT_SALT:     sl6UyasMtKLQphZQlyDKwqpRzTrl79KZ
```

They live in `/root/.config/rclone/rclone.conf`, which is itself inside the
thing being backed up. Lose the Pi and lose these and the off-site copy is 2 GB
of unrecoverable noise — a backup that exists and cannot be read is worse than
no backup, because you stop worrying about it.

### 2. Regenerate the B2 master application key

The master key was pasted into a chat transcript, so treat it as exposed. It is
no longer used by anything — the Pi now authenticates with a **bucket-scoped**
key (`pi5-offsite-backup`, `000bb15eb1628800000000001`, capabilities
`listBuckets listFiles readFiles writeFiles deleteFiles`, restricted to
`pi5-neuro-offsite`). Regenerating the master key in the B2 UI invalidates the
exposed one and breaks nothing here.

A master key could delete buckets and mint further keys, so it should not have
been the credential on a cron job regardless of the exposure.

## What is configured

| Piece | Value |
|---|---|
| Bucket | `pi5-neuro-offsite`, **private**, eu-central |
| Lifecycle | `daysFromHidingToDeleting: 1` — a replaced version is deleted after a day |
| Remote (raw) | `b2raw` → B2, scoped key |
| Remote (encrypted) | `b2crypt` → `b2raw:pi5-neuro-offsite`, filename **and** directory names encrypted |
| Script | `/usr/local/bin/backup-offsite.sh` (source: `backend/scripts/`) |
| Schedule | root cron, `20 2 * * *`, after the 00:00 local snapshot |
| Status file | `/mnt/data/backups/offsite-status.json` |
| Monitoring | `watchdog.checkOffsiteBackup()` |

The lifecycle rule is load-bearing. B2 keeps every version forever by default,
so without it a nightly 250 MB database would add a new 250 MB version every
night and consume the 10 GB free tier inside six weeks — invisibly, because the
script's own size check only counts current files.

## What is copied, and what is not

| Path | Size | Why |
|---|---|---|
| `nuero-vault/` | ~895M (4,369 files) | The vault. No other copy that isn't in this house. |
| `homeassistant/` | ~965M | Years of history, not reconstructable. |
| `neuro-db/agent.db` | ~235M | ONE current copy, from the snapshot's integrity-checked rotation. |
| `syncthing/` | ~11M | Config, so a rebuild doesn't start from nothing. |

Total ~2.05 GB against B2's **10 GB free tier**. It is a tier, not free forever.

Deliberately excluded: `backups/` (2.1 GB of 28 rotated copies of the same
database — derived, and growing daily as the health backfill lands), `nuero/`
(a git checkout; GitHub has it and most of the 689 MB is `node_modules`), ollama
models (a download, and `ollama-models.txt` records which), and the `quest/`,
`freereps-eval/`, `vault-dedup-quarantine/` scratch.

Source is the **local snapshot**, not `/mnt/data` — the snapshot already contains
a `sqlite3 .backup` taken before its rsync, so the database copy is consistent
rather than a possibly-torn read of a live WAL file.

## Verified restore — this was actually run, not just written down

```bash
mkdir -p /tmp/restore-test
sudo rclone copy b2crypt:pi5/neuro-db /tmp/restore-test
sqlite3 /tmp/restore-test/agent.db "PRAGMA integrity_check;"
sqlite3 /tmp/restore-test/agent.db "SELECT COUNT(*) FROM health_samples;"
sudo rclone cat "b2crypt:pi5/nuero-vault/People/Heidi Power.md" | head
rm -rf /tmp/restore-test
```

Result on 16 Aug: `integrity_check` → `ok`, 308,562 health samples / 150 tasks /
287 waiting_on, and the People note came back as plain text with its frontmatter
intact. The raw bucket (`rclone ls b2raw:pi5-neuro-offsite`) shows only ciphertext
paths, confirming the encryption layer is doing its job.

> Pick a file that definitely exists. An earlier version of this doc used
> `nuero-vault/CLAUDE.md`, which is not at the vault root — so the check returned
> empty and looked like a failed restore when nothing was wrong. A verification
> that can pass or fail by absence is not a verification.

## Recovering everything

```bash
sudo rclone config                       # recreate b2raw + b2crypt with the saved password/salt
rclone copy b2crypt:pi5/nuero-vault   /mnt/data/nuero-vault
rclone copy b2crypt:pi5/homeassistant /mnt/data/homeassistant
rclone copy b2crypt:pi5/neuro-db/agent.db /mnt/data/nuero/backend/db/agent.db
```

`sync` mirrors, so a deletion here becomes a deletion there. That is intended —
the off-site copy tracks current state, and the 56 local generations on
`/mnt/backup` are what cover "I deleted it last week".

## How it reports

`watchdog.checkOffsiteBackup()` reads the status file, which is written on every
exit path — so an absent file means the job never completed, not that it quietly
succeeded. Three distinct answers:

- `unconfigured` → **info**, not a warning. The state before the key existed.
- `failed` → **critical**. It is trying and cannot.
- `ok` but older than 50h → warn, 96h → critical.

The check returns nothing at all off-Linux, so the Windows dev box cannot
manufacture an issue.
