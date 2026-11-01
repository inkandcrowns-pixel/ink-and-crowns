// Trend research → one fresh topic. Reads what history videos get the most views per day right now (US),
// what worked on our own channel (state/learnings.json), and skips every topic we already made.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, aiJson, log } from './lib.js';
import { topRecent } from './yt.js';

// Owner's formats (2026-11-01): the channel only makes these kinds of history / geopolitics explainers.
// Each run focuses on the format used least recently, so the channel rotates through all of them.
export const FORMATS = [
  { id: 'versus', name: 'Country vs country: why one pulled ahead and the other fell behind (e.g. why Ukraine fell behind Russia)',
    queries: ['why country fell behind', 'country comparison history explained', 'why rich country poor country history'] },
  { id: 'rise', name: 'How a nation or empire became a superpower (e.g. how America became a superpower)',
    queries: ['how america became superpower', 'rise of empire explained', 'how country became rich history'] },
  { id: 'war', name: 'A war explained: why it started, who won, how and why — the strategy, technology and turning points',
    queries: ['war explained documentary', 'how they won the war strategy', 'military history battle explained'] },
  { id: 'mocked', name: 'A great person mocked by the world who succeeded anyway (inventions, discoveries, bold work)',
    queries: ['inventor everyone laughed at', 'genius ridiculed history', 'invention that changed the world story'] },
  { id: 'cause', name: 'The real causes of a war or conflict between two countries, explained (including ongoing ones)',
    queries: ['real reason for war explained', 'conflict explained geopolitics', 'why are they fighting explained'] },
  { id: 'risegroup', name: 'How a small group or movement grew into a major force (e.g. how the Houthis went from a small tribe to attacking a state)',
    queries: ['houthis explained', 'how group became powerful explained', 'rise of militia explained'] },
  { id: 'secretop', name: 'A secret military or intelligence operation, how it was planned and pulled off (e.g. the bin Laden raid)',
    queries: ['secret military operation explained', 'special forces raid documentary', 'intelligence operation history'] },
  { id: 'mystery', name: 'A big historical mystery or controversy examined with the evidence (e.g. the COVID-19 origins debate)',
    queries: ['history mystery explained evidence', 'origins debate explained', 'unsolved history mystery'] },
];
const STATE = path.join(ROOT, 'state');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return d; } };

// the format we used least recently (never-used first)
export function nextFormat() {
  const used = readJson('topics.json', []);
  const last = Object.fromEntries(FORMATS.map(f => [f.id, -1]));
  used.forEach((u, i) => { if (u.format in last) last[u.format] = i; });
  return FORMATS.slice().sort((a, b) => last[a.id] - last[b.id])[0];
}

export async function researchTrends(format = nextFormat()) {
  const seen = new Map();
  // the format's 3 queries + 1 general one ≈ 400 quota units per run
  for (const q of [...format.queries, 'history documentary']) {
    try { for (const v of await topRecent(q)) seen.set(v.id, v); } catch (e) { log('search failed', q, e.message.slice(0, 120)); }
  }
  const list = [...seen.values()].sort((a, b) => b.perDay - a.perDay).slice(0, 40);
  fs.writeFileSync(path.join(STATE, 'trends.json'), JSON.stringify({ at: new Date().toISOString(), list }, null, 2));
  log('trending videos', list.length, 'top', list[0]?.perDay, '/day');
  return list;
}

// code-side guard: the reply must say which owner format it belongs to and be a real, dated event
const fits = t => FORMATS.some(f => f.id === t.format) && Number(t.year) > 0;

export async function pickTopic(trending, format = nextFormat()) {
  const used = readJson('topics.json', []);
  const learn = readJson('learnings.json', {});
  const { data, model } = await aiJson(
    `You plan videos for "Ink & Crowns", an American history & geopolitics storytelling YouTube channel ` +
    `(15-21 min, US/UK audience).\nThis video's FORMAT: ${format.name} (format id "${format.id}").\n` +
    `Demand signal: these videos get the most views per day right now (title | views/day):\n` +
    trending.map(v => `- ${v.title} | ${v.perDay}`).join('\n') +
    `\n\nWhat worked / didn't on OUR channel so far: ${JSON.stringify(learn.summary || 'no data yet')}\n` +
    `Topics we already made (never repeat): ${used.map(u => u.topic).join('; ') || 'none'}\n\n` +
    `Propose 5 ORIGINAL topics for THIS FORMAT with the highest US demand right now. Each must be a specific, real, ` +
    `well-documented story (we fact-check) with a fresh angle — not a copy of any title above. Recent events ` +
    `(e.g. the bin Laden raid, the Houthis, ongoing wars) are fine when explained historically and neutrally. ` +
    `Prefer human drama, a twist and a clear place on a map. Rules that keep the channel monetized: no graphic ` +
    `violence or gore, never glorify terrorists or armed groups, no partisan US domestic politics, no hate; ` +
    `contested claims (e.g. COVID-19 origins) are framed as an evidence-based debate presenting the main ` +
    `hypotheses and what official/intelligence assessments say — never "the hidden truth" or medical ` +
    `misinformation. Rank them by expected US views (demand signal above + our own channel results).\n` +
    `Return JSON {"topics":[{"topic":"specific story, place, year","angle":"the hook in one line","why":"why it will get views",` +
    `"title":"YouTube title, max 60 chars, curiosity without clickbait lies","map_place":"main real place name",` +
    `"year":"main year as a number","format":"${format.id}"}]}`,
    // a reply without any usable topic for the format counts as bad, so aiJson asks again / tries the next model
    { check: d => { (d.topics || []).forEach(t => { t.format ||= format.id; }); if (!d.topics?.some(fits)) throw new Error('no topics for the format'); return d; }, temperature: 1.0 },
  );
  const usedSet = new Set(used.map(u => u.topic.toLowerCase()));
  const pick = data.topics.find(t => fits(t) && !usedSet.has(String(t.topic).toLowerCase()));
  if (!pick) throw new Error('no fresh topic for the format in the AI reply');
  log('topic by', model, '→', pick.topic);
  return { ...pick, candidates: data.topics };
}

if (process.argv[1]?.endsWith('trends.js')) {
  const f = nextFormat();
  const t = await researchTrends(f);
  const p = await pickTopic(t, f);
  console.log(JSON.stringify(p, null, 2));
}
