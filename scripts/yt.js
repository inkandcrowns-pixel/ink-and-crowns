// YouTube Data + Analytics API helpers (OAuth refresh token from .env / GitHub secret).
import fs from 'node:fs';
import { env, httpJson } from './lib.js';

let cached;
export async function accessToken() {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const t = await httpJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET,
      refresh_token: env.YT_REFRESH_TOKEN, grant_type: 'refresh_token',
    }),
  });
  cached = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
  return cached.token;
}
const auth = async () => ({ authorization: `Bearer ${await accessToken()}` });
export const api = async (p, opts = {}) =>
  httpJson(`https://www.googleapis.com/youtube/v3/${p}`, { ...opts, headers: { ...(await auth()), ...(opts.headers || {}) } });

// Most-viewed recent videos for a query (search = 100 quota units, videos.list = 1).
export async function topRecent(q, days = 30, max = 25) {
  const after = new Date(Date.now() - days * 864e5).toISOString();
  const s = await api(`search?part=snippet&type=video&order=viewCount&maxResults=${max}&regionCode=US&relevanceLanguage=en` +
    `&videoDuration=long&publishedAfter=${after}&q=${encodeURIComponent(q)}`);
  const ids = s.items.map(i => i.id.videoId).join(',');
  if (!ids) return [];
  const v = await api(`videos?part=statistics,snippet,contentDetails&id=${ids}`);
  return v.items.map(x => {
    const ageDays = Math.max(1, (Date.now() - Date.parse(x.snippet.publishedAt)) / 864e5);
    const views = Number(x.statistics.viewCount || 0);
    return { id: x.id, title: x.snippet.title, channel: x.snippet.channelTitle, views, perDay: Math.round(views / ageDays), duration: x.contentDetails.duration };
  });
}

// Resumable upload; scheduled videos go up private with publishAt (they go public by themselves).
export async function upload(file, { title, description, tags, categoryId = '27', publishAt, privacy = 'private', synthetic = false }) {
  const size = fs.statSync(file).size;
  const status = { privacyStatus: publishAt ? 'private' : privacy, selfDeclaredMadeForKids: false, containsSyntheticMedia: synthetic };
  if (publishAt) status.publishAt = publishAt;
  const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { ...(await auth()), 'content-type': 'application/json', 'x-upload-content-length': String(size), 'x-upload-content-type': 'video/mp4' },
    body: JSON.stringify({ snippet: { title, description, tags, categoryId, defaultLanguage: 'en', defaultAudioLanguage: 'en' }, status }),
  });
  const loc = start.headers.get('location');
  if (!loc) throw new Error(`upload start ${start.status}: ${(await start.text()).slice(0, 300)}`);
  // same bytes to the same session URL is safe to retry; the publish is the PUT finishing
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(loc, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: fs.readFileSync(file), signal: AbortSignal.timeout(30 * 60000) });
      const j = await r.json();
      if (j.id) return j;
      throw new Error(JSON.stringify(j.error || j).slice(0, 300));
    } catch (e) {
      // after a dropped connection, ask the session whether the upload already finished before retrying
      const st = await fetch(loc, { method: 'PUT', headers: { 'content-range': `bytes */${size}` } }).catch(() => null);
      if (st && (st.status === 200 || st.status === 201)) return st.json();
      if (i === 2) throw e;
    }
  }
}

export async function setThumbnail(videoId, jpg) {
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: 'POST', headers: { ...(await auth()), 'content-type': 'image/jpeg' }, body: fs.readFileSync(jpg),
  });
  if (!r.ok) throw new Error(`thumbnail ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export async function updateTitle(videoId, title) {
  const v = await api(`videos?part=snippet&id=${videoId}`);
  const sn = v.items[0].snippet;
  return api('videos?part=snippet', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: videoId, snippet: { title, description: sn.description, tags: sn.tags, categoryId: sn.categoryId } }) });
}

// Per-video analytics for our own channel.
export async function videoStats(startDate, endDate) {
  const q = new URLSearchParams({ ids: 'channel==MINE', startDate, endDate, dimensions: 'video', sort: '-views', maxResults: '50',
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes' });
  const r = await httpJson(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, { headers: await auth() });
  const cols = r.columnHeaders.map(c => c.name);
  return (r.rows || []).map(row => Object.fromEntries(row.map((v, i) => [cols[i], v])));
}
