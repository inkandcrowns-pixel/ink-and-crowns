// Full 8-12 min script: outline → chapter by chapter (draft + human-editor pass) → banned-phrase sweep →
// web fact-check (Groq browser_search) → packaging (title, description, tags, thumbnail text).
import fs from 'node:fs';
import { aiJson, env, httpJson, log } from './lib.js';
import { NARRATOR, BANNED, bannedHits } from './script_writer.js';

const words = s => String(s).trim().split(/\s+/).filter(Boolean).length;
const SCENE_SHAPE = `"scenes":[{"text":"narration, 2-3 sentences, about 25-35 words","visual":"ink" or "map",
"prompt":"for ink: a detailed scene for a hand-colored antique lithograph; name every substance's color; anonymous
people only, never a real person's face or name; no text/letters/numbers in the image. For map: what to show",
"place":"map beats only: real place name"}]`;

function normScenes(d) {
  const scenes = (d.scenes || []).map(s => ({
    text: String(s.text || s.narration || '').trim(),
    visual: String(s.visual || '').toLowerCase().includes('map') ? 'map' : 'ink',
    prompt: String(s.prompt || s.image_prompt || '').trim(),
    place: s.place || null,
  })).filter(s => s.text);
  if (scenes.length < 3) throw new Error('too few scenes');
  return { ...d, scenes };
}

export async function outline(topic) {
  const { data } = await aiJson(
    `${NARRATOR}\n\nPlan a 17-19 minute video about: ${topic.topic}\nHook angle: ${topic.angle}\n` +
    `Structure like a great documentary storyteller, not a textbook: a cold open in the middle of the action, ` +
    `then 9-10 chapters that build tension (the world before, the people, the stakes, rising trouble, the turn, ` +
    `the race/climax, the aftermath, what it changed, the forgotten detail), one ` +
    `surprising turn, and an ending that pays off the opening. ` +
    `List only facts you are confident are documented.\n` +
    `Return JSON {"cold_open":"what happens in the first 30 seconds","chapters":[{"name":"short chapter title",` +
    `"beats":["beat 1","beat 2","..."],"key_facts":["specific fact with date/number"]}],"ending":"the final line idea"}`,
    { check: d => { if (!d.chapters?.length) throw new Error('no chapters'); return d; } },
  );
  return data;
}

async function writeChapter(topic, plan, i, prevTail) {
  const ch = i < 0 ? { name: 'Cold open', beats: [plan.cold_open], key_facts: [] } : plan.chapters[i];
  // 15-21 min at ~145 wpm ≈ 2,200-3,000 words; aim ~2,700 because drafts come out ~10% short (asked 2026-11-01)
  const target = i < 0 ? 150 : Math.round(2550 / plan.chapters.length);
  const isLast = i === plan.chapters.length - 1;
  const what = i < 0
    ? 'the COLD OPEN (start mid-action with a vivid specific detail; no "Imagine", no question as the first line; ' +
      'end on a line that makes leaving impossible)'
    : `chapter "${ch.name}"`;
  const ask = `${NARRATOR}\n\nVideo: ${topic.topic}. Full plan: ${JSON.stringify(plan)}\n` +
    `Write ${what} — about ${target} words, ${Math.max(3, Math.round(target / 30))} scenes. ` +
    (prevTail ? `It continues right after: "${prevTail}". Flow on naturally, don't recap. ` : '') +
    (isLast ? `This is the final chapter: land the ending (${plan.ending}), then one short honest line asking viewers ` +
      `which story we should dig into next. ` : '') +
    `Include a map beat only where the place matters.\nReturn JSON {${SCENE_SHAPE}}`;
  const draft = await aiJson(ask, { check: normScenes });
  const edited = await aiJson(
    `${NARRATOR}\n\nYou are the human script editor. Make this sound like a real person talking: vary rhythm, ` +
    `cut filler and stock adjectives, keep his dry humor and opinions, keep every fact, keep scenes/visuals. ` +
    `No banned phrases.\nDRAFT: ${JSON.stringify(draft.data)}\nReturn JSON {${SCENE_SHAPE}}`,
    { check: normScenes, temperature: 0.8 },
  );
  return { name: ch.name, scenes: edited.data.scenes, model: edited.model };
}

// Groq gpt-oss with built-in web search checks the claims and returns corrections.
async function factCheck(chapters) {
  const text = chapters.map((c, ci) => c.scenes.map((s, si) => `[${ci}.${si}] ${s.text}`).join('\n')).join('\n');
  for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
    try {
      const d = await httpJson('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model, temperature: 0.2, tools: [{ type: 'browser_search' }],
          messages: [{ role: 'user', content:
            `Fact-check this history narration with web search. For every line with a wrong or doubtful name, date, ` +
            `number or claim, give a corrected line in the same casual voice (or remove the claim). Ignore opinions.\n` +
            `${text}\n\nAnswer ONLY JSON: {"fixes":[{"id":"chapter.scene","text":"corrected narration","why":"short reason"}]}` }],
        }),
      }, { tries: 2, timeoutMs: 180000 });
      const raw = d.choices?.[0]?.message?.content || '';
      const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      return { model, fixes: Array.isArray(j.fixes) ? j.fixes : [] };
    } catch (e) { log('fact-check', model, 'failed:', e.message.slice(0, 120)); }
  }
  return { model: null, fixes: [] };
}

// cacheFile: outline + finished chapters are saved as they're made, so a restart continues instead of starting over
export async function writeLongScript(topic, cacheFile) {
  const cache = (() => { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return {}; } })();
  const keep = () => cacheFile && fs.writeFileSync(cacheFile, JSON.stringify(cache));
  log('outline…');
  const plan = cache.plan || (cache.plan = await outline(topic));
  keep();
  const chapters = cache.chapters || (cache.chapters = []);
  let tail = chapters.at(-1)?.scenes.at(-1).text || '';
  for (let i = chapters.length - 1; i < plan.chapters.length; i++) {
    const c = await writeChapter(topic, plan, i, tail);
    chapters.push(c); keep();
    tail = c.scenes.at(-1).text;
    log(`chapter ${i + 1}/${plan.chapters.length}: ${c.name} (${words(c.scenes.map(s => s.text).join(' '))} words, ${c.model})`);
  }
  // too short for 15 min (~2,250 words)? expand the shortest chapters with more real detail, not padding
  for (let pass = 0; pass < 3; pass++) {
    const total = words(chapters.flatMap(c => c.scenes.map(s => s.text)).join(' '));
    if (total >= 2300) break;
    const ci = chapters.map((c, k) => [k, words(c.scenes.map(s => s.text).join(' '))]).filter(([k]) => k > 0)
      .sort((a, b) => a[1] - b[1])[0][0];
    const c = chapters[ci];
    log(`script ${total} words < 2300 → expanding "${c.name}"`);
    const r = await aiJson(`${NARRATOR}\n\nThis chapter of a video about ${topic.topic} is too thin. Expand it by about ` +
      `60% with more true, specific detail (people, places, what it felt like, consequences) — no padding, no repeats ` +
      `of other chapters. Keep the voice.\nCHAPTER: ${JSON.stringify(c.scenes)}\nReturn JSON {${SCENE_SHAPE}}`,
      { check: normScenes, temperature: 0.8 }).catch(() => null);
    if (r) c.scenes = r.data.scenes; else break;
  }

  // banned phrases: rewrite only the offending scenes
  for (const c of chapters) {
    for (const s of c.scenes) {
      const hits = bannedHits(s.text);
      if (!hits.length) continue;
      const r = await aiJson(`Rewrite this narration line without the phrases ${hits.join(', ')}, same voice and facts. ` +
        `Line: "${s.text}"\nReturn JSON {"text":"..."}`, { check: d => { if (!d.text) throw new Error('empty'); return d; } });
      s.text = r.data.text;
    }
  }
  log('style sweeps (length, tics, banned phrases)…');
  // repeated tics across chapters ("Honestly?" in every chapter sounded robotic in the first test)
  const tics = ['honestly?', 'classic ', 'here\'s the thing', 'spoiler', 'buckle'];
  for (const tic of tics) {
    const hits = chapters.flatMap(c => c.scenes).filter(s => s.text.toLowerCase().includes(tic));
    for (const s of hits.slice(1)) {
      const r = await aiJson(`${NARRATOR}\nRewrite this line without "${tic.trim()}", same meaning and voice: "${s.text}"\nReturn JSON {"text":"..."}`,
        { check: d => { if (!d.text) throw new Error('empty'); return d; } });
      s.text = r.data.text;
    }
  }

  // fact-check, then put each correction back into the narrator's own voice (raw fixes read like footnotes)
  log('fact-check…');
  const fc = await factCheck(chapters);
  const clean = t => String(t).replace(/【[^】]*】/g, '').replace(/ | /g, ' ').replace(/\s{2,}/g, ' ').trim();
  for (const f of fc.fixes) {
    const [ci, si] = String(f.id).split('.').map(Number);
    const sc = chapters[ci]?.scenes[si];
    if (!sc || !f.text) continue;
    try {
      const r = await aiJson(`${NARRATOR}\nThis narration line has a factual error.\nLine: "${sc.text}"\n` +
        `Correct fact: ${clean(f.why)} ${clean(f.text)}\nRewrite the line as natural spoken narration with the correct ` +
        `fact (or drop the doubtful claim). No sources, no brackets, no "not X" corrections. Return JSON {"text":"..."}`,
        { check: d => { if (!d.text) throw new Error('empty'); return d; }, temperature: 0.6 });
      sc.text = clean(r.data.text); sc.factFixed = clean(f.why);
    } catch { /* keep the original line rather than a footnote-style fix */ }
  }
  log('fact-check by', fc.model, 'fixes', fc.fixes.length);

  const all = chapters.flatMap(c => c.scenes.map(s => s.text)).join(' ');
  const { data: pack } = await aiJson(
    `${NARRATOR}\n\nPackage this video for YouTube US. Script: ${all.slice(0, 6000)}\n` +
    `Return JSON {"title":"max 60 chars, curiosity, honest, Title Case","thumb_text":"2-4 punchy words for the thumbnail, ` +
    `different from the title","thumb_prompt":"one striking scene for the thumbnail image (lithograph style, one clear ` +
    `subject, dramatic, no text)","description":"2 short human paragraphs, no hashtags spam, no emojis","tags":["8-12 tags"]}`,
    { check: d => { if (!d.title || !d.description) throw new Error('no package'); return d; } },
  );
  return { topic, plan, chapters, pack, words: words(all), banned_left: bannedHits(all), fact_fixes: fc.fixes };
}
