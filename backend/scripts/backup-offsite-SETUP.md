# Off-site backup — the one-time setup (#59)

Everything is built, deployed and scheduled. It runs nightly at **02:20** and
currently **no-ops** with `state: unconfigured`, because the B2 remote does not
exist yet. That is the intended state, not a fault — the watchdog reports it as
`info`, never as a warning.

The steps below are the part that needs Nick's account. About ten minutes.

## What is already done

- `/usr/local/bin/backup-offsite.sh` deployed and syntax-checked.
- `rclone v1.60.1` installed (`apt`, raspbian 13.5 arm64).
- Root cron entry at `20 2 * * *`, after the 00:00 local snapshot.
- `watchdog.checkOffsiteBackup()` reads `/mnt/data/backups/offsite-status.json`
  and distinguishes `unconfigured` (info) / `failed` (critical) / stale.

## 1. Backblaze account and bucket

1. Sign up at backblaze.com → B2 Cloud Storage.
   **The free tier is 10 GB stored.** The payload below is ~2.15 GB, so this
   sits inside it — but it is a tier, not free-forever, and versions count
   toward it. Step 4 is what keeps it there.
2. Create a **private** bucket. Suggested name `pi5-neuro-offsite` (bucket names
   are globally unique, so you may need a suffix).
3. **Application Keys → Add a New Application Key**, scoped to *that bucket
   only*, read+write. Copy the `keyID` and `applicationKey` — the secret is
   shown once.

## 2. The two rclone remotes

Encryption is not optional here: the vault holds 1-2-1 notes, performance
conversations and personal data about named colleagues. Filenames are encrypted
too, because a filename is as disclosive as a body in this vault.

Run on pi5 (`ssh nickw@100.100.28.58`):

```bash
rclone config
```

**Remote 1 — the bucket.** `n` → name `b2raw` → storage `b2` →
`account` = keyID, `key` = applicationKey → defaults for the rest.

**Remote 2 — the encryption layer.** `n` → name `b2crypt` → storage `crypt` →
`remote` = `b2raw:pi5-neuro-offsite` (your bucket name) →
`filename_encryption` = `standard` → `directory_name_encryption` = `true` →
choose **`g`** to generate a password, and again for the salt.

> ⚠ **Write both generated passwords down somewhere off this machine.**
> They are in `/root/.config/rclone/rclone.conf`, which is itself inside the
> thing being backed up. Losing them means the off-site copy is unrecoverable
> ciphertext — the backup would exist and be useless, which is worse than not
> having one, because you would stop worrying about it.
> Put them in a password manager, not in the vault.

The script runs as root from cron, so configure it as **root**
(`sudo rclone config`) or the remote will be invisible to it.

## 3. First run

```bash
sudo /usr/local/bin/backup-offsite.sh
cat /mnt/data/backups/offsite-status.json
```

The first upload is ~2.15 GB and will take a while on domestic upstream; later
runs ship only deltas. Expect `"state": "ok"` and `bytes` around 2.3e9.

## 4. Bucket lifecycle — do not skip this

In the bucket settings choose **"Keep only the last version of the file"**, or
set a rule keeping prior versions for ~7 days.

The script syncs with `--b2-hard-delete`, but B2's default lifecycle keeps every
version forever. Without this, each nightly run of a 250 MB database file adds a
new 250 MB version and the 10 GB tier is gone inside six weeks — silently, since
the script's own size check only looks at current files.

## 5. Prove a restore, once

An untested backup is a hypothesis. Cheap version:

```bash
mkdir -p /tmp/restore-test
rclone copy b2crypt:pi5/neuro-db /tmp/restore-test
sqlite3 /tmp/restore-test/agent.db "PRAGMA integrity_check;"   # expect: ok
rclone cat b2crypt:pi5/nuero-vault/CLAUDE.md | head            # readable text
rm -rf /tmp/restore-test
```

If `integrity_check` says `ok` and the vault file reads as plain text, the
encryption round-trips and the copy is real.

## What is copied, and what is not

| Path | Size | Why |
|---|---|---|
| `nuero-vault/` | ~910M | The vault. No other copy that isn't in this house. |
| `homeassistant/` | ~965M | Years of history, not reconstructable. |
| `neuro-db/agent.db` | ~250M | ONE current copy, taken from the snapshot's integrity-checked rotation. |
| `syncthing/` | ~11M | Config, so a rebuild doesn't start from nothing. |

Deliberately excluded: `backups/` (2.1 GB of 28 rotated copies of the same
database — derived data, and it grows daily as the health backfill lands),
`nuero/` (a git checkout; GitHub has it and most of the 689 MB is
`node_modules`), ollama models (a download, and `ollama-models.txt` records
which), and the `quest/`, `freereps-eval/`, `vault-dedup-quarantine/` scratch.

## Recovering the whole lot

```bash
sudo rclone config          # recreate b2raw + b2crypt with the saved passwords
rclone copy b2crypt:pi5/nuero-vault   /mnt/data/nuero-vault
rclone copy b2crypt:pi5/homeassistant /mnt/data/homeassistant
rclone copy b2crypt:pi5/neuro-db/agent.db /mnt/data/nuero/backend/db/agent.db
```
