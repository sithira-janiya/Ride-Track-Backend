import { jest } from '@jest/globals';

process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
const { env } = await import('../src/config/env.js');
const { resetTranslateCache, translate, translateMany } = await import('../src/utils/translate.js');

const realFetch = global.fetch;
const reply = (translations, ok = true) => jest.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => ({ data: { translations } }) }));

beforeEach(() => {
  resetTranslateCache();
  env.googleTranslateApiKey = 'test-key';
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('translate', () => {
  it('sends the texts to Google and returns them in order, decoding entities', async () => {
    global.fetch = reply([{ translatedText: 'බස් එක &#39;10&#39; ප්‍රමාදයි' }, { translatedText: 'ගමන අවලංගුයි' }]);
    expect(await translateMany(["Bus '10' is late", 'Trip cancelled'], 'si')).toEqual(["බස් එක '10' ප්‍රමාදයි", 'ගමන අවලංගුයි']);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('key=test-key');
    expect(JSON.parse(init.body)).toEqual({ q: ["Bus '10' is late", 'Trip cancelled'], target: 'si', format: 'text' });
  });

  it('caches per language and sends each distinct text once', async () => {
    global.fetch = reply([{ translatedText: 'பேருந்து தாமதம்' }]);
    expect(await translateMany(['Bus late', 'Bus late'], 'ta')).toEqual(['பேருந்து தாமதம்', 'பேருந்து தாமதம்']);
    expect(await translate('Bus late', 'ta')).toBe('பேருந்து தாமதம்');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).q).toEqual(['Bus late']);
  });

  it('returns the original text when Google fails', async () => {
    global.fetch = reply([], false);
    expect(await translate('Bus late', 'si')).toBe('Bus late');
    global.fetch = jest.fn(async () => { throw new Error('network down'); });
    expect(await translate('Bus late', 'si')).toBe('Bus late');
  });

  it('does nothing without an API key', async () => {
    env.googleTranslateApiKey = '';
    global.fetch = jest.fn();
    expect(await translate('Bus late', 'si')).toBe('Bus late');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
