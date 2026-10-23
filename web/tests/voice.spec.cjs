const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../public/demo');

async function demo(page) {
  await page.route('https://demo.test/**', route => {
    const filename = route.request().url().split('/').pop();
    if (filename === 'app.js') return route.fulfill({contentType: 'text/javascript', body: fs.readFileSync(path.join(root, filename), 'utf8') + '\nObject.assign(window, {say, bestVoice, stopSpeaking});'});
    if (filename === 'style.css') return route.fulfill({path: path.join(root, filename)});
    if (route.request().url().endsWith('/demo/')) return route.fulfill({path: path.join(root, 'index.html')});
    return route.fulfill({status: 503, json: {error: 'voice unavailable'}});
  });
  await page.addInitScript(() => {
    window.primed = []; window.audioCount = 0; window.spoken = []; window.played = []; window.paused = 0; window.revoked = [];
    window.speechSynthesis.getVoices = () => [
      {name: 'Robot', lang: 'en-US', default: true},
      {name: 'English', lang: 'en-GB', default: false},
      {name: 'Google US English', lang: 'en-US', default: false},
    ];
    window.speechSynthesis.speak = u => {
      if (u.volume === 0) window.primed.push(navigator.userActivation.isActive);
      else window.spoken.push({text: u.text, voice: u.voice.name});
    };
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    URL.createObjectURL = () => 'blob:demo-audio';
    URL.revokeObjectURL = url => window.revoked.push(url);
    window.Audio = class {
      constructor(url) { this.src = url; window.audioInstance = this; window.audioCount++; }
      async play() {
        if (this.src.startsWith('data:')) { this.unlocked = navigator.userActivation.isActive; return; }
        window.played.push(this.src);
        if (window.rejectPlayback || (window.requireUnlock && !this.unlocked)) throw new Error('autoplay');
      }
      pause() { window.paused++; }
    };
  });
  await page.goto('https://demo.test/demo/');
}

for (const width of [1440, 390]) {
  test(`voice fallback and controls at ${width}px`, async ({page}, testInfo) => {
    const errors = [], failedRequests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('503')) errors.push(m.text()); });
    page.on('requestfailed', r => failedRequests.push(r.url()));
    await page.setViewportSize({width, height: 900});
    await demo(page);
    await page.evaluate(() => say('Recorded reason.'));
    expect(await page.evaluate(() => window.spoken)).toEqual([{text: 'Recorded reason.', voice: 'Google US English'}]);
    expect(await page.evaluate(() => bestVoice([{name: 'Robot', lang: 'en-US', default: true}]))).toBeUndefined();
    expect(await page.evaluate(() => bestVoice([{name: 'Siri', lang: 'fr-FR'}, {name: 'English', lang: 'en-US'}]).name)).toBe('English');
    await page.route('**/tts', route => route.fulfill({status: 200, contentType: 'audio/mpeg', body: 'mock-mp3'}));
    await page.evaluate(() => say('Polly answer.'));
    expect(await page.evaluate(() => window.played)).toEqual(['blob:demo-audio']);
    await page.locator('#stop').click();
    expect(await page.evaluate(() => window.revoked)).toEqual(['blob:demo-audio']);
    await page.evaluate(() => { window.rejectPlayback = true; return say('Playback rejected.'); });
    expect(await page.evaluate(() => window.spoken.at(-1).text)).toBe('Playback rejected.');
    await page.locator('#speak').uncheck();
    const count = await page.evaluate(() => window.played.length);
    await page.evaluate(() => say('Silent.'));
    expect(await page.evaluate(() => window.played.length)).toBe(count);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); expect(failedRequests).toEqual([]);
    await page.screenshot({path: testInfo.outputPath('voice.png'), fullPage: true});
    fs.writeFileSync(testInfo.outputPath('evidence.json'), JSON.stringify({url: page.url(), viewport: {width, height: 900}, errors, failedRequests, assertions: ['explicit quality voice', 'robot excluded', 'mp3 playback', 'stop cleanup', 'playback failure fallback', 'speech disabled', 'no overflow']}));
  });
}

test('stop suppresses delayed fallback and voices load asynchronously', async ({page}) => {
  await demo(page);
  await page.evaluate(async () => {
    speechSynthesis.getVoices = () => [];
    const pending = say('Late voices');
    setTimeout(() => {
      speechSynthesis.getVoices = () => [{name: 'Siri', lang: 'en-US'}];
      speechSynthesis.dispatchEvent(new Event('voiceschanged'));
    }, 30);
    await pending;
  });
  expect(await page.evaluate(() => window.spoken.at(-1).voice)).toBe('Siri');
  await page.evaluate(async () => {
    window.fetch = () => new Promise(resolve => setTimeout(() => resolve({ok: false, arrayBuffer: async () => new ArrayBuffer(0)}), 30));
    const pending = say('Cancelled'); stopSpeaking(); await pending;
  });
  expect(await page.evaluate(() => window.spoken.map(u => u.text))).toEqual(['Late voices']);
});

test('Connect and Send unlock a single reused audio element before network responses', async ({page}) => {
  await demo(page);
  await page.evaluate(() => { window.requireUnlock = true; });
  await page.route('**/oauth/judge', route => route.fulfill({json: {access_token: 'test', session_id: 'session'}}));
  await page.route('**/mcp', async route => {
    const m = route.request().postDataJSON();
    if (!m.id) return route.fulfill({status: 202});
    const result = m.method === 'initialize' ? {protocolVersion: '2025-11-25'} :
      {isError: false, structuredContent: {answer: 'Recorded reason.', trace_id: 'sha256:1234', trail: {approver: 'Demo user'}}};
    await route.fulfill({json: {jsonrpc: '2.0', id: m.id, result}});
  });
  await page.route('**/tts', route => route.fulfill({contentType: 'audio/mpeg', body: 'mock-mp3'}));
  await page.locator('#token').fill('test');
  await page.locator('#connect').click();
  await expect(page.locator('#connection')).toHaveText('Connected · MCP');
  expect(await page.evaluate(() => window.primed)).toEqual([true]);
  for (let i = 0; i < 2; i++) {
    await page.locator('#prompt').fill('Why did you dim the lights?');
    await page.locator('#send').click();
    await expect.poll(() => page.evaluate(() => window.played.length)).toBe(i + 1);
    await page.locator('#stop').click();
  }
  expect(await page.evaluate(() => window.audioCount)).toBe(1);
  expect(await page.evaluate(() => window.primed)).toEqual([true, true, true]);
  expect(await page.evaluate(() => window.spoken)).toEqual([]);
  expect(await page.evaluate(() => window.revoked.length)).toBe(2);
});

test('sends full raw speech text so the server counts after sanitizing', async ({page}) => {
  await demo(page);
  const text = '<b>' + 'x'.repeat(300) + '</b>';
  let received;
  await page.route('**/tts', route => {
    received = route.request().postDataJSON().text;
    return route.fulfill({contentType: 'audio/mpeg', body: 'mock-mp3'});
  });
  await page.evaluate(text => say(text), text);
  expect(received).toBe(text);
});
