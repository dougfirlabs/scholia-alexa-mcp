const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const baseURL = process.env.DEMO_URL || 'http://127.0.0.1:8787';
const token = process.env.DEMO_TOKEN;
if (!token) throw new Error('Set DEMO_TOKEN to a local judge token for browser tests.');
const evidenceDir = process.env.DEMO_EVIDENCE_DIR || 'docs';
fs.mkdirSync(evidenceDir, {recursive: true});
const turns = ['Reorder coffee', 'Why did you reorder coffee?', 'Change the evening routine', 'Why did you change the evening routine?', 'Book a cleaner', 'Why did you book a cleaner?', 'What changed this week?'];

for (const viewport of [{width: 1920, height: 1080}, {width: 1440, height: 1100}, {width: 390, height: 844}]) {
  test(`seven turns and verification at ${viewport.width}px`, async ({page}) => {
    const errors = [], failedRequests = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('requestfailed', request => failedRequests.push({url: request.url(), failure: request.failure(), method: request.postDataJSON()?.method}));
    page.on('request', request => {
      if (request.url().endsWith('/mcp')) {
        const body = request.postDataJSON();
        calls.push({method: body.method, tool: body.params?.name});
        expect(request.headers().accept).toBe('application/json, text/event-stream');
        if (body.method !== 'initialize') expect(request.headers()['mcp-protocol-version']).toBe('2025-11-25');
      }
    });
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/demo`);
    await page.locator('#speak').uncheck();
    await page.getByLabel('MCP access token').fill(token);
    await page.getByLabel('Demo household', {exact: true}).fill(`test-${viewport.width}-${Date.now()}`);
    await page.getByRole('button', {name: 'Connect securely'}).click();
    await expect(page.locator('#connection')).toHaveText('Connected · MCP');
    await expect(page.locator('#token')).toHaveValue('');
    for (const turn of turns) {
      await page.getByLabel('Ask your demo assistant').fill(turn);
      await page.getByRole('button', {name: 'Send', exact: true}).click();
      await expect(page.locator('#status')).toHaveText('Ready for your next question.');
    }
    await expect(page.locator('#messages')).toContainText('3 recorded changes');
    await expect(page.locator('#activity li')).toHaveCount(3);
    await page.getByRole('link', {name: 'Verify decision trail →'}).last().click();
    await expect(page.getByText('Verified by server · 3 linked decisions')).toBeVisible();
    await page.getByText('Verified by server · 3 linked decisions').click();
    await expect(page.locator('pre')).toContainText('"verified": true');
    await page.route('**/mcp', route => {
      const body = route.request().postDataJSON();
      if (body.params?.name !== 'get_trace') return route.continue();
      return route.fulfill({json: {jsonrpc: '2.0', id: body.id, result: {
        isError: true, content: [{type: 'text', text: 'Chain broken at record #3'}],
        structuredContent: {verified: false, broken_record: {index: 3, action: 'book cleaner'}},
      }}});
    });
    await page.getByRole('link', {name: 'Verify decision trail →'}).last().click();
    const alert = page.locator('article[role="alert"]');
    await expect(alert).toContainText('Tampered — chain broken at record #3: book cleaner');
    await expect(alert).toBeInViewport();
    await expect(page.getByText('Verified by server · 3 linked decisions')).toHaveCount(0);
    await page.screenshot({path: `${evidenceDir}/demo-${viewport.width}-tampered.png`, fullPage: true});
    await page.unroute('**/mcp');
    await page.getByRole('link', {name: 'Verify decision trail →'}).last().click();
    const verified = page.locator('article[role="status"]');
    await expect(verified).toContainText('Verified — 3 linked decisions, chain intact');
    await expect(verified).toContainText('This is not proof of authorship.');
    await expect(verified).toBeInViewport();
    await expect(alert).toHaveCount(0);
    await expect(page.locator('.verification')).toHaveCount(1);
    expect(calls.slice(0, 2).map(call => call.method)).toEqual(['initialize', 'notifications/initialized']);
    expect(calls.filter(call => call.tool === 'record_decision')).toHaveLength(3);
    expect(calls.filter(call => call.tool === 'explain_why')).toHaveLength(3);
    expect(calls.some(call => call.tool === 'whats_changed')).toBe(true);
    expect(calls.some(call => call.tool === 'get_trace')).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); expect(failedRequests).toEqual([]);
    await page.screenshot({path: `${evidenceDir}/demo-${viewport.width}.png`, fullPage: true});
    fs.writeFileSync(`${evidenceDir}/demo-${viewport.width}-evidence.json`, JSON.stringify({viewport, path: '/demo', turns: turns.length, calls, consoleErrors: errors, failedRequests, assertions: ['three simulated actions persisted', 'three explanations', 'weekly changes', 'retained chain verified', 'tampered alert visible', 'restored status visible', 'stale result replaced', 'no horizontal overflow']}, null, 2));
  });
}

test('unavailable microphone and storage errors remain usable', async ({page}) => {
  await page.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
  await page.goto(`${baseURL}/demo/`);
  await page.locator('#speak').uncheck();
  await page.getByLabel('MCP access token').fill(token);
  await page.getByRole('button', {name: 'Connect securely'}).click();
  await expect(page.locator('#status')).toContainText('Voice input is unavailable');
  await expect(page.locator('#mic')).toBeDisabled();
  await page.route('**/mcp', route => route.fulfill({status: 503, contentType: 'application/json', body: '{}'}));
  await page.getByLabel('Ask your demo assistant').fill('Reorder coffee');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('#messages')).toContainText('Could not complete the request');
  await expect(page.locator('#activity')).not.toContainText('Coffee refill added');
  await expect(page.locator('#send')).toBeEnabled();
});

test('voice transcript is reviewed before recording and keyboard submits', async ({page}) => {
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() { this.onresult({results: [[{transcript: 'Reorder coffee'}]]}); setTimeout(() => this.onend(), 0); }
      stop() { this.onend(); }
    };
    window.spoken = [];
    window.speechSynthesis.speak = utterance => window.spoken.push(utterance.text);
  });
  await page.goto(`${baseURL}/demo/`);
  await page.getByLabel('MCP access token').fill(token);
  await page.getByLabel('Demo household', {exact: true}).fill(`voice-${Date.now()}`);
  await page.getByRole('button', {name: 'Connect securely'}).click();
  await expect(page.locator('#connection')).toHaveText('Connected · MCP');
  await page.getByRole('button', {name: 'Start voice input'}).click();
  await expect(page.locator('#prompt')).toHaveValue('Reorder coffee');
  await expect(page.locator('#activity')).not.toContainText('Coffee refill added');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('#activity')).toContainText('Coffee refill added');
  expect(await page.evaluate(() => window.spoken)).toEqual(['Coffee refill added to the simulated order.']);
});

test('demo assets are public while MCP and private paths remain protected', async ({request}) => {
  expect((await request.get(`${baseURL}/demo/`)).status()).toBe(200);
  expect((await request.post(`${baseURL}/demo/`)).status()).toBe(405);
  expect((await request.post(`${baseURL}/mcp`, {data: {jsonrpc: '2.0', id: 1, method: 'initialize'}})).status()).toBe(401);
  for (const path of ['/.dev.vars', '/wrangler.local.toml', '/web/tests/demo.spec.cjs']) {
    expect((await request.get(`${baseURL}${path}`)).status()).toBe(404);
  }
});
