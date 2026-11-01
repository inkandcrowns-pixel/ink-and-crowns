// Shared helpers: env, HTTP with retries, Gemini/Groq JSON with fallback chain, Gemini TTS.
// Secrets are read from .env (or process.env on GitHub) and never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const f = path.join(ROOT, '.env');
  const out = {};
  if (fs.existsSync(f)) {
    // Strip a UTF-8 BOM: PowerShell 5.1 `Set-Content -Encoding utf8` adds one and it hid the first key.
    for (const l of fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const i = l.indexOf('=');
      if (i > 0 && /^\w+$/.test(l.slice(0, i))) out[l.slice(0, i)] = l.slice(i + 1).trim();
    }
  }
  // process.env only fills keys .env lacks (GitHub Actions); on the laptop it could hold other projects' keys.
  for (const [k, v] of Object.entries(process.env)) if (v && !(k in out)) out[k] = v.trim();
  return out;
}
export const env = loadEnv();

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Retries network errors, 429 and 5xx with backoff (honours Retry-After).
export async function httpJson(url, opts = {}, { tries = 3, timeoutMs = 120000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      const text = await r.text();
      if (r.ok) return JSON.parse(text);
      last = new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      if (r.status !== 429 && r.status < 500) throw last;
      const ra = Number(r.headers.get('retry-after'));
      await sleep((ra > 0 ? ra * 1000 : 4000 * (i + 1)));
    } catch (e) {
      last = e;
      if (/^HTTP 4(?!29)/.test(e.message)) throw e;
      await sleep(4000 * (i + 1));
    }
  }
  throw last;
}

const GEMINI_TEXT = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
const GROQ_TEXT = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];

function parseJson(s) {
  const t = String(s || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}

// Ask for a JSON object; tries each Gemini model, then Groq. `check` validates/normalises the reply.
export async function aiJson(prompt, { check = x => x, temperature = 0.9, system } = {}) {
  const errors = [];
  for (const model of GEMINI_TEXT) {
    try {
      const d = await httpJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature, responseMimeType: 'application/json' },
        }),
      }, { tries: 2, timeoutMs: 150000 });
      return { model, data: check(parseJson(d.candidates?.[0]?.content?.parts?.map(p => p.text).join(''))) };
    } catch (e) { errors.push(`${model}: ${e.message.slice(0, 120)}`); }
  }
  for (const model of GROQ_TEXT) {
    try {
      const d = await httpJson('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model, temperature, response_format: { type: 'json_object' },
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
        }),
      }, { tries: 2 });
      return { model, data: check(parseJson(d.choices?.[0]?.message?.content)) };
    } catch (e) { errors.push(`${model}: ${e.message.slice(0, 120)}`); }
  }
  throw new Error('All AI models failed:\n' + errors.join('\n'));
}

// Gemini TTS → 24 kHz mono WAV. Only the spoken text is sent (style lines would be read aloud).
export async function tts(text, wavPath, { voice = 'Charon', models = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'] } = {}) {
  let last;
  for (const model of models) {
    try {
      const d = await httpJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        }),
      }, { tries: 2, timeoutMs: 180000 });
      const pcm = Buffer.from(d.candidates[0].content.parts[0].inlineData.data, 'base64');
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
      h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
      h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
      fs.writeFileSync(wavPath, Buffer.concat([h, pcm]));
      return { model, seconds: pcm.length / 48000 };
    } catch (e) { last = e; }
  }
  throw last;
}

// Channel look: hand-coloured antique lithograph (ink line work + warm watercolour tints). Added to every image prompt.
// Pure black-and-white looked too colourless (feedback 2026-11-01): keep vintage, but in rich warm colour.
export const INK_STYLE = 'hand-colored antique lithograph illustration, fine ink line work with rich watercolor tints, ' +
  'warm vivid vintage palette of deep reds, ochre, teal, golden light and blue sky, evenly colored across the whole ' +
  'image, on aged cream paper, 19th-century storybook print, high detail, no text, no letters, no words, no numbers';

// Model-written prompts sometimes carry words that trip the safety filter (code 3030) or fight our style.
const stripStyle = p => p.replace(/,?\s*\b(hyper)?realistic( style)?|photo\w*|cinematic|4k|8k/gi, '').trim();
const softPrompt = p => p.replace(/\b(blood\w*|dead|death|die\w*|kill\w*|corpse|bod(y|ies)|crush\w*|drown\w*|gore|weapon|gun|violence|violent)\b/gi, '')
  .replace(/\s{2,}/g, ' ');

// Cloudflare Workers AI: FLUX.2 klein 4B (Apache-2.0, multipart), FLUX.1 schnell as fallback → JPG/PNG file.
export async function fluxImage(prompt, outPath, { width = 1344, height = 768 } = {}) {
  const base = stripStyle(prompt);
  const tries = [base, softPrompt(base), 'an old harbor street with brick warehouses and horse carts'];
  let last;
  for (const [i, p] of tries.entries()) {
    try {
      const fd = new FormData();
      fd.append('prompt', `${p}. ${INK_STYLE}`); fd.append('width', String(width)); fd.append('height', String(height));
      const d = await httpJson(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`,
        { method: 'POST', headers: { authorization: `Bearer ${env.CF_API_TOKEN}` }, body: fd }, { tries: 2, timeoutMs: 180000 });
      if (!d.result?.image) throw new Error('no image');
      fs.writeFileSync(outPath, Buffer.from(d.result.image, 'base64'));
      return { model: 'flux-2-klein-4b', attempt: i + 1 };
    } catch (e) { last = e; }
  }
  const d = await httpJson(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: JSON.stringify({ prompt: `${softPrompt(base)}. ${INK_STYLE}`, steps: 6 }),
  }, { tries: 2, timeoutMs: 90000 }).catch(e => { throw new Error(`klein: ${last?.message} | schnell: ${e.message}`); });
  fs.writeFileSync(outPath, Buffer.from(d.result.image, 'base64'));
  return { model: 'flux-1-schnell', attempt: 4 };
}
