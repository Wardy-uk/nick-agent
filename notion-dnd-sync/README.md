# D&D Notion Export

This exports one shared Notion D&D parent page and all of its child pages to
`/mnt/data/nuero-vault/Projects/D&D/Notion` on the Pi. It is deliberately
one-way: Notion is the source and this exporter never deletes vault files.

## Setup

1. Create a Notion internal connection called `NEURO D&D Sync`, with content
   read access only, and share only the D&D parent page with that connection.
2. Put its token and the parent page ID in `/mnt/data/nuero/notion-dnd-sync/.env`.
   This file must remain local to the Pi and have permissions `600`.
3. Install and enable `notion-dnd-sync.service` and `notion-dnd-sync.timer` as
   user services. Run the service once manually before enabling the timer.

The service intentionally does not start until the local `.env` exists.
