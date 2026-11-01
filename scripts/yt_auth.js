// One-time YouTube OAuth: opens a local loopback server, prints the consent URL,
// exchanges the code and writes YT_REFRESH_TOKEN into .env (never printed).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter(l => /^\w+=/.test(l))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
].join(' ');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const code = url.searchParams.get('code');
  if (!code) { res.end('Waiting for Google...'); return; }
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET,
      redirect_uri: redirect, grant_type: 'authorization_code',
    }),
  });
  const tok = await r.json();
  if (!tok.refresh_token) {
    res.end('No refresh token received: ' + (tok.error || 'unknown'));
    console.log('FAILED:', tok.error, tok.error_description);
    process.exit(1);
  }
  const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { authorization: `Bearer ${tok.access_token}` },
  }).then(x => x.json());
  const c = ch.items?.[0];
  let text = fs.readFileSync(envPath, 'utf8').replace(/^YT_REFRESH_TOKEN=.*\r?\n?/m, '');
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(envPath, text + `YT_REFRESH_TOKEN=${tok.refresh_token}\n`);
  res.end(`Connected: ${c?.snippet?.title || '?'} (${c?.id || '?'}). You can close this tab.`);
  console.log(`CONNECTED channel="${c?.snippet?.title}" id=${c?.id}; refresh token saved to .env`);
  process.exit(0);
});

server.listen(0, '127.0.0.1', () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: env.YT_CLIENT_ID, redirect_uri: redirect, response_type: 'code',
    scope: SCOPES, access_type: 'offline', prompt: 'consent', login_hint: 'inkandcrowns@gmail.com',
  });
  console.log('AUTH_URL ' + auth);
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 15 * 60 * 1000);
