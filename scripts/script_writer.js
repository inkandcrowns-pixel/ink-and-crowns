// Humanized script writer: draft → banned-phrase check → human-editor rewrite pass.
// Usage: node scripts/script_writer.js "<topic>" <out.json> [targetWords]
import fs from 'node:fs';
import { aiJson, log } from './lib.js';

// Phrases that make a script sound machine-written. Checked in code, not just in the prompt.
export const BANNED = [
  'delve', 'tapestry', 'testament to', 'in conclusion', 'in summary', 'it is important to note', "it's worth noting",
  'a rich history', 'stands as a', 'in the annals', 'little did they know', 'buckle up', 'join us', 'journey through',
  'fascinating', 'intriguing', 'captivating', 'the stage was set', 'shrouded in mystery', 'unravel', 'embark',
  'navigate the', 'in today\'s video', 'without further ado', 'let\'s dive', 'dive into', 'realm', 'pivotal',
  'ever-evolving', 'game-changer', 'paved the way', 'a reminder that', 'echoes through', 'beacon', 'meticulous',
];

export const NARRATOR = `You are the writer and narrator of "Ink & Crowns", an American YouTube history channel.
Voice: a dry-witted, curious American storyteller in his 40s who reads old newspapers for fun. He talks to one
viewer like a friend at a bar, not a lecture hall. He has opinions and says them ("Honestly? That was a terrible
plan."), admits when sources disagree, and notices small human details (a name, a smell, the weather that day).
Rules:
- US English spelling and idioms. Contractions everywhere. Mix very short sentences with longer ones.
- Concrete facts only: real names, dates, numbers, places. Never invent quotes or numbers; if unsure, leave it out.
- No list-like structure, no "firstly/secondly", no rhetorical question in every paragraph, no cliffhanger clichés.
- Never use these words/phrases: ${BANNED.join('; ')}.
- Spell numbers the way a person says them aloud ("nineteen nineteen", "two point three million gallons").
- Never lean on one verbal tic: an aside like "Honestly?" may appear at most once in the whole video; vary how
  scenes and chapters open.`;

function wordCount(s) { return String(s).trim().split(/\s+/).filter(Boolean).length; }
export function bannedHits(text) {
  const t = text.toLowerCase();
  return BANNED.filter(b => t.includes(b));
}

function normalise(d) {
  const scenes = (d.scenes || d.segments || d.beats || []).map(s => ({
    text: String(s.text || s.narration || s.line || '').trim(),
    visual: String(s.visual || s.visual_type || s.type || 'ink').toLowerCase().includes('map') ? 'map' : 'ink',
    prompt: String(s.prompt || s.image_prompt || s.image || '').trim(),
    place: s.place || s.map_place || null,
  })).filter(s => s.text);
  if (!scenes.length) throw new Error('no scenes in AI reply');
  return { title: String(d.title || '').trim(), scenes };
}

export async function writeScript(topic, targetWords = 160) {
  const shape = `Return JSON: {"title": "...", "scenes": [{"text": "narration for this beat, 1-3 sentences",
"visual": "ink" or "map", "prompt": "for ink: a detailed scene description for a black-ink engraving illustration on
aged parchment (no text, no letters, no numbers, no recognizable real faces); for map: what the map should show",
"place": "for map beats only: the real place name"}]}`;
  log('draft…');
  const draft = await aiJson(
    `${NARRATOR}\n\nWrite the OPENING of a long-form video about: ${topic}.\nAbout ${targetWords} words of narration total, ` +
    `6 to 9 scenes, one of them a map beat. Open in the middle of the moment with a specific detail, not with a ` +
    `question or "Imagine". End this opening on a line that makes the viewer need the rest.\n${shape}`,
    { check: normalise },
  );
  log('draft by', draft.model, 'words', wordCount(draft.data.scenes.map(s => s.text).join(' ')));

  log('human editor pass…');
  const edited = await aiJson(
    `${NARRATOR}\n\nYou are now the channel's human script editor. Rewrite this draft so it sounds like a real ` +
    `person talking, not an AI: vary rhythm, cut filler and generic adjectives, add one personal aside or opinion, ` +
    `keep every fact accurate, keep the same scenes/visuals. Banned phrases must not appear.\n` +
    `DRAFT JSON:\n${JSON.stringify(draft.data)}\n${shape}`,
    { check: normalise, temperature: 0.8 },
  );
  let script = edited.data;
  let hits = bannedHits(script.scenes.map(s => s.text).join(' '));
  for (let i = 0; hits.length && i < 2; i++) {
    log('banned phrases found, rewriting:', hits.join(', '));
    script = (await aiJson(
      `Rewrite only the narration lines that contain these phrases, in the same voice, keeping facts: ${hits.join(', ')}.\n` +
      `JSON:\n${JSON.stringify(script)}\n${shape}`, { check: normalise, temperature: 0.7 })).data;
    hits = bannedHits(script.scenes.map(s => s.text).join(' '));
  }
  return { ...script, editor_model: edited.model, banned_left: hits, words: wordCount(script.scenes.map(s => s.text).join(' ')) };
}

if (process.argv[1]?.endsWith('script_writer.js')) {
  const [topic, out, words] = process.argv.slice(2);
  const s = await writeScript(topic, Number(words) || 160);
  fs.writeFileSync(out, JSON.stringify(s, null, 2));
  log('saved', out, 'words', s.words, 'banned_left', s.banned_left.length);
}
