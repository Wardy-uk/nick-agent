#!/usr/bin/env bash
set -euo pipefail

config_dir=/mnt/data/nuero/notion-dnd-sync
config_file="$config_dir/.env"
page_id=3ca97da9ae7380f08aa8e4d528e250ba

install -d -m 700 "$config_dir"
read -r -s -p 'Paste Notion token: ' token
printf '\n'

if [[ -z "$token" ]]; then
  echo 'No token entered; configuration was not changed.' >&2
  exit 1
fi

umask 077
printf 'NOTION_DND_TOKEN=%s\nNOTION_DND_ROOT_PAGE_ID=%s\n' "$token" "$page_id" > "$config_file"
chmod 600 "$config_file"
unset token

echo 'Notion D&D Sync is configured. The token was stored only on this Pi.'
