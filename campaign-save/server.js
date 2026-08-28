'use strict';

const crypto = require('crypto');
const http = require('http');

const host = process.env.CAMPAIGN_SAVE_HOST || '127.0.0.1';
const port = Number(process.env.CAMPAIGN_SAVE_PORT || 3003);
const pin = process.env.NEURO_PIN || '';
const apiKey = process.env.DND_VAULT_API_KEY || '';

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function fileStem(value) {
  const fallback = `ChatGPT Session ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const cleaned = String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

function sessionNote(title, update) {
  const now = new Date().toISOString();
  return `---\ntype: dnd-session\nsource: chatgpt\ncreated: ${now}\n---\n\n# ${title}\n\n${update.trim()}\n`;
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#19352d"><title>Campaign Save</title><style>
:root{--ink:#17342c;--moss:#2e6855;--paper:#f6f0df;--gold:#dfa94b;--line:#cbbf9f}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 92% 0,#d9c689 0,transparent 34%),linear-gradient(135deg,#17342c,#275b4c);font-family:Georgia,serif;color:var(--ink)}main{max-width:680px;margin:auto;padding:28px 18px 52px}.mark{color:#fff1ca;letter-spacing:.14em;text-transform:uppercase;font:700 12px system-ui;margin-bottom:14px}h1{margin:0 0 9px;color:#fff7e4;font-size:42px;line-height:1}p{line-height:1.45}.card{margin-top:24px;background:var(--paper);border:1px solid #fff3cf;border-radius:18px;padding:22px;box-shadow:0 18px 45px #091a1566}label{display:block;font:700 12px system-ui;letter-spacing:.08em;text-transform:uppercase;margin:17px 0 7px}input,textarea{width:100%;border:1px solid var(--line);border-radius:9px;background:#fffdf5;padding:12px;font:16px Georgia;color:var(--ink)}textarea{min-height:260px;resize:vertical}button{width:100%;margin-top:20px;border:0;border-radius:9px;padding:14px;background:var(--moss);color:#fff;font:700 16px system-ui;cursor:pointer}button:disabled{opacity:.6}.hint{font-size:14px;color:#5a604c}.status{min-height:24px;margin:14px 0 0;font:600 14px system-ui}.ok{color:#17613f}.error{color:#9e2b20}code{background:#e9dfc6;padding:2px 4px;border-radius:3px;font-size:.9em}</style></head>
<body><main><div class="mark">NEURO / D&D</div><h1>Save the session.</h1><p style="color:#ecdfbd">Paste ChatGPT's end-of-session update. It becomes a dated note in your campaign vault and syncs to Obsidian.</p><section class="card"><p class="hint">Ask ChatGPT: <code>Create a concise session save with events, NPC changes, loot, open threads, and the immediate next scene.</code></p><form id="save"><label>NEURO PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" required><label>Session title</label><input id="title" placeholder="Optional - defaults to date and time"><label>ChatGPT session update</label><textarea id="update" required placeholder="Paste the session save here..."></textarea><button>Save to campaign</button><div id="status" class="status" role="status"></div></form></section></main><script>
const form=document.querySelector('#save'),status=document.querySelector('#status');form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;status.className='status';status.textContent='Saving...';try{const res=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:document.querySelector('#pin').value,title:document.querySelector('#title').value,update:document.querySelector('#update').value})});const body=await res.json();if(!res.ok)throw new Error(body.error||'Save failed');status.className='status ok';status.textContent='Saved: '+body.path;document.querySelector('#update').value=''}catch(err){status.className='status error';status.textContent=err.message}finally{button.disabled=false}});
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || host}`);
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page);
  if (req.method !== 'POST' || url.pathname !== '/api/save') return send(res, 404, JSON.stringify({ error: 'Not found' }), 'application/json');

  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 30000) req.destroy();
  });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw);
      if (!pin || !apiKey) throw new Error('Campaign save is not configured');
      if (!safeEqual(body.pin, pin)) return send(res, 401, JSON.stringify({ error: 'Incorrect NEURO PIN' }), 'application/json');
      if (typeof body.update !== 'string' || !body.update.trim()) return send(res, 400, JSON.stringify({ error: 'A session update is required' }), 'application/json');

      const title = fileStem(body.title);
      const response = await fetch('http://127.0.0.1:3001/api/vault-dnd/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ path: `Sessions/${title}.md`, content: sessionNote(title, body.update) }),
      });
      if (!response.ok) throw new Error('NEURO could not save the campaign note');
      const result = await response.json();
      return send(res, 200, JSON.stringify({ path: result.path }), 'application/json');
    } catch (error) {
      return send(res, 500, JSON.stringify({ error: error.message || 'Save failed' }), 'application/json');
    }
  });
});

server.listen(port, host, () => console.log(`Campaign save page listening on http://${host}:${port}`));
