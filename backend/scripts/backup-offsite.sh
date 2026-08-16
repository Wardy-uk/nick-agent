#!/bin/bash
# Off-site copy of the things that cannot be regenerated (#59).
#
# Deployed to /usr/local/bin/backup-offsite.sh on pi5.
#
# WHY THIS EXISTS
#   backup-data.sh makes excellent local backups — consistent SQLite copies,
#   hardlinked snapshots, 56 generations. All of them live on a USB stick
#   plugged into the same Pi as the data. That covers disk failure and fat
#   fingers and nothing else: one fire, theft or power event takes the vault,
#   the Home Assistant history and the NEURO database together.
#
# WHAT IT COPIES, AND WHAT IT DELIBERATELY DOES NOT
#   Source is the LATEST LOCAL SNAPSHOT, not /mnt/data. That snapshot already
#   contains a `sqlite3 .backup` taken before the rsync, so the database copy is
#   consistent — reading the live DB here would risk a torn file and re-solve a
#   problem that is already solved one layer down.
#
#   Measured on 16 Aug, the snapshot is ~5GB, and 2.1GB of that is `backups/` —
#   28 rotated copies of agent.db. That is DERIVED data: pushing 28 historical
#   copies of the same database off-site would more than double the payload to
#   protect nothing, and it grows every day the health backfill runs. So the
#   off-site set is the irreplaceable half only:
#
#     nuero-vault/    ~910M  the vault. The one thing with no other copy that
#                            isn't also in this house.
#     homeassistant/  ~965M  years of history, not reconstructable.
#     agent.db        ~250M  ONE current copy, pulled from the snapshot's
#                            rotation — the newest, integrity already checked.
#     syncthing/       ~11M  config, so a rebuild doesn't start from nothing.
#
#   Excluded and why: `nuero/` is a git checkout (GitHub has it, and most of the
#   689M is node_modules); `backups/` is derived; ollama models are a download;
#   quest/, freereps-eval/ and vault-dedup-quarantine/ are working scratch.
#
#   That comes to ~2.15GB against Backblaze B2's 10GB free tier, which is what
#   makes the retention below affordable rather than a compromise.
#
# ENCRYPTION IS NOT OPTIONAL
#   The vault is 1-2-1 notes, performance conversations and personal data about
#   named colleagues. It goes through an rclone `crypt` remote with filename
#   encryption on — a filename is as disclosive as a body here ("Nathan Rutland
#   career progression" needs no opening).
#
# FAILURE DIRECTION
#   The classic off-site failure is silent: it stops in March and is discovered
#   in November. So every run writes a status file that NEURO's watchdog reads,
#   a failure is recorded rather than swallowed, and "never configured" is a
#   DISTINCT state from "ran and failed" — an unconfigured remote is a normal
#   state on day one and must not look like a broken job.

set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SNAPSHOT=/mnt/backup/snapshots/latest
REMOTE="${OFFSITE_REMOTE:-b2crypt:pi5}"
STATUS=/mnt/data/backups/offsite-status.json
LOG=/mnt/backup/offsite.log
STAGE=/mnt/backup/.offsite-stage

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# Status is written on EVERY exit path, success or not — a run that dies without
# leaving a trace is exactly the silence this is built to prevent.
write_status() {
  local state="$1" detail="$2" bytes="${3:-0}"
  mkdir -p "$(dirname "$STATUS")"
  cat > "$STATUS" <<JSON
{
  "state": "$state",
  "detail": "$(echo "$detail" | sed 's/"/\\"/g' | tr -d '\n')",
  "bytes": $bytes,
  "remote": "$REMOTE",
  "finishedAt": "$(date -Iseconds)"
}
JSON
}

fail() { log "FAILED: $*"; write_status "failed" "$*"; exit 1; }

log "=== offsite start ==="

# Setup-not-finished is NOT failure. Both of the checks below are states this
# job legitimately sits in between being deployed and the B2 key existing, and
# reporting them as failures would light a critical alert on day one — which is
# how an alert gets muted before it ever means anything.
if ! command -v rclone >/dev/null 2>&1; then
  log "rclone is not installed — nothing to do yet"
  write_status "unconfigured" "rclone is not installed"
  exit 0
fi

REMOTE_NAME="${REMOTE%%:*}"
if ! rclone listremotes 2>/dev/null | grep -q "^${REMOTE_NAME}:"; then
  log "remote '$REMOTE_NAME' is not configured — nothing to do yet"
  write_status "unconfigured" "rclone remote '$REMOTE_NAME' does not exist; run rclone config"
  exit 0
fi

[ -d "$SNAPSHOT" ] || fail "$SNAPSHOT does not exist — has backup-data.sh ever run?"

# --- Stage the one DB copy we want ------------------------------------------
# The snapshot holds 28 rotated copies; take the newest and give it a stable
# name, so the off-site copy is "the database" rather than a dated pile that
# would accumulate in the bucket forever.
rm -rf "$STAGE"; mkdir -p "$STAGE"
NEWEST_DB=$(ls -t "$SNAPSHOT"/backups/nuero-db/agent-*.db 2>/dev/null | head -1)
if [ -n "$NEWEST_DB" ] && [ -s "$NEWEST_DB" ]; then
  cp "$NEWEST_DB" "$STAGE/agent.db"
  echo "$(basename "$NEWEST_DB")" > "$STAGE/agent.db.source"
  log "staged database: $(basename "$NEWEST_DB") ($(du -h "$STAGE/agent.db" | cut -f1))"
else
  # Not fatal — the vault is the irreplaceable part and must still go. But it
  # is loud, because a missing DB copy means backup-data.sh's step 1 is broken.
  log "WARNING: no usable agent-*.db in the snapshot — continuing WITHOUT the database"
fi

# --- Push --------------------------------------------------------------------
# `sync` mirrors, so a deletion here is a deletion there. That is the intent —
# the off-site copy tracks the current state, and the 56 local generations are
# what covers "I deleted it last week". Bucket lifecycle keeps one prior version
# as a backstop against a corrupted push; see the setup notes.
RC_TOTAL=0
push() {
  local src="$1" dest="$2"
  [ -e "$src" ] || { log "skip $dest — not in the snapshot"; return 0; }
  log "pushing $dest"
  rclone sync "$src" "$REMOTE/$dest" \
    --transfers 4 --checkers 8 \
    --b2-hard-delete \
    --stats-one-line --stats 5m \
    --log-file "$LOG" --log-level INFO
  local rc=$?
  [ $rc -ne 0 ] && { log "  $dest FAILED (rc=$rc)"; RC_TOTAL=$((RC_TOTAL + 1)); }
  return 0
}

push "$SNAPSHOT/nuero-vault"   "nuero-vault"
push "$SNAPSHOT/homeassistant" "homeassistant"
push "$SNAPSHOT/syncthing"     "syncthing"
push "$STAGE"                  "neuro-db"

rm -rf "$STAGE"

if [ "$RC_TOTAL" -ne 0 ]; then
  fail "$RC_TOTAL of 4 paths failed to sync"
fi

# --- Verify, rather than assume ----------------------------------------------
# `rclone size` reads the REMOTE. A push that reports success but leaves an
# empty bucket is the failure worth catching, and it costs one API call.
SIZE_JSON=$(rclone size "$REMOTE" --json 2>>"$LOG")
BYTES=$(echo "$SIZE_JSON" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
BYTES=${BYTES:-0}

if [ "$BYTES" -lt 100000000 ]; then
  fail "remote holds only $BYTES bytes — expected ~2GB, treating as a failed push"
fi

HUMAN=$(echo "$BYTES" | awk '{printf "%.2fGB", $1/1073741824}')
log "=== offsite done — remote holds $HUMAN ==="
write_status "ok" "synced to $REMOTE" "$BYTES"
