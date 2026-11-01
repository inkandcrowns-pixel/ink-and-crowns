// Trend research → one fresh topic. Reads what history videos get the most views per day right now (US),
// what worked on our own channel (state/learnings.json), and skips every topic we already made.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, aiJson, log } from './lib.js';
import { topRecent } from './yt.js';

const QUERIES = ['history documentary', 'dark history', 'history mystery unsolved', 'ancient history',
  'world war 2 history', 'medieval history', 'american history', 'weird history facts'];
const STATE = path.join(ROOT, 'state');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return d; } };

export async function researchTrends() {
  const seen = new Map();
  // 4 random queries per run keeps quota low (≈400 units) and rotates the angles we look at
  for (const q of QUERIES.sort(() => Math.random() - 0.5).slice(0, 4)) {
    try { for (const v of await topRecent(q)) seen.set(v.id, v); } catch (e) { log('search failed', q, e.message.slice(0, 120)); }
  }
  const list = [...seen.values()].sort((a, b) => b.perDay - a.perDay).slice(0, 40);
  fs.writeFileSync(path.join(STATE, 'trends.json'), JSON.stringify({ at: new Date().toISOString(), list }, null, 2));
  log('trending videos', list.length, 'top', list[0]?.perDay, '/day');
  return list;
}

export async function pickTopic(trending) {
  const used = readJson('topics.json', []);
  const learn = readJson('learnings.json', {});
  const { data, model } = await aiJson(
    `You plan videos for "Ink & Crowns", an American history storytelling YouTube channel (8-12 min, US/UK audience).\n` +
    `Demand signal: these history videos get the most views per day right now (title | views/day):\n` +
    trending.map(v => `- ${v.title} | ${v.perDay}`).join('\n') +
    `\n\nWhat worked / didn't on OUR channel so far: ${JSON.stringify(learn.summary || 'no data yet')}\n` +
    `Topics we already made (never repeat): ${used.map(u => u.topic).join('; ') || 'none'}\n\n` +
    `Propose 5 ORIGINAL topics in the same demand space (same eras/themes people are clicking now), but each must be ` +
    `a specific true story that is NOT the subject of any title above, with a fresh angle. Real, well-documented ` +
    `events only (we fact-check). Prefer stories with a human drama, a twist and a clear place on a map. ` +
    `Avoid graphic violence, sexual content, hate, and current politics. Rank them by expected US views.\n` +
    `Return JSON {"topics":[{"topic":"specific story, place, year","angle":"the hook in one line","why":"why it will get views",` +
    `"title":"YouTube title, max 60 chars, curiosity without clickbait lies","map_place":"main real place name"}]}`,
    { check: d => { if (!d.topics?.length) throw new Error('no topics'); return d; }, temperature: 1.0 },
  );
  const usedSet = new Set(used.map(u => u.topic.toLowerCase()));
  const pick = data.topics.find(t => !usedSet.has(String(t.topic).toLowerCase())) || data.topics[0];
  log('topic by', model, '→', pick.topic);
  return { ...pick, candidates: data.topics };
}

if (process.argv[1]?.endsWith('trends.js')) {
  const t = await researchTrends();
  const p = await pickTopic(t);
  console.log(JSON.stringify(p, null, 2));
}
