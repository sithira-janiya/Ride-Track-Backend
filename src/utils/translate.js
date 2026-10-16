import { env } from '../config/env.js';

const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const CACHE_MAX = 1000;
const cache = new Map(); // `${target}\n${text}` -> translated text; oldest entries evicted first

const key = (target, text) => `${target}\n${text}`;

function remember(target, text, translated) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key(target, text), translated);
}

/** Google returns HTML-escaped text by default; we ask for plain text, but decode the few entities it may still send. */
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Translates `texts` into `target` (e.g. 'si', 'ta') with the Google Cloud Translation API, detecting the source language.
 * Never throws: without GOOGLE_TRANSLATE_API_KEY, or when Google fails, the original texts come back unchanged.
 */
export async function translateMany(texts, target) {
  if (!env.googleTranslateApiKey || !target || !texts.length) return texts;
  const missing = [...new Set(texts.filter((t) => t && !cache.has(key(target, t))))];
  if (missing.length) {
    try {
      const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(env.googleTranslateApiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: missing, target, format: 'text' }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Google Translate responded ${res.status}`);
      const { data } = await res.json();
      data.translations.forEach((t, i) => remember(target, missing[i], decode(t.translatedText)));
    } catch (e) {
      console.warn('translation failed:', e.message);
      return texts;
    }
  }
  return texts.map((t) => (t ? cache.get(key(target, t)) ?? t : t));
}

export const translate = async (text, target) => (await translateMany([text], target))[0];

/** For tests. */
export const resetTranslateCache = () => cache.clear();
