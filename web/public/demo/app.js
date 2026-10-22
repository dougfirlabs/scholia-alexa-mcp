const $ = (id) => document.getElementById(id);
let token = '', household = '', version = '', sequence = 0, busy = false, connected = false;
const session = crypto.randomUUID();
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;
let listening = false;

async function rpc(method, params, notification = false) {
  const id = ++sequence;
  const response = await fetch('/mcp', {
    method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', ...(version ? {'MCP-Protocol-Version': version} : {})},
    body: JSON.stringify({jsonrpc: '2.0', ...(notification ? {} : {id}), method, params}),
  });
  if (!response.ok) throw new Error(`MCP request failed (${response.status}). Check your token, allowed origin and local database.`);
  if (notification && response.status === 202) { await response.text(); return; }
  const message = await response.json();
  if (message.id !== id || message.jsonrpc !== '2.0') throw new Error('Invalid MCP response.');
  if (message.error) throw new Error(message.error.message);
  return message.result;
}
async function tool(name, args) {
  const result = await rpc('tools/call', {name, arguments: {household_id: household, ...args}});
  if (result.isError) throw new Error(result.content?.[0]?.text || 'Tool failed.');
  return result.structuredContent;
}
function controls() {
  for (const id of ['send', 'prompt']) $(id).disabled = !connected || busy || listening;
  $('mic').disabled = !connected || busy || !recognition;
  $('connect').disabled = busy || listening;
  for (const button of document.querySelectorAll('[data-prompt]')) button.disabled = !connected || busy || listening;
}
function say(text) {
  if ($('speak').checked && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}
function card(text, user = false) {
  const article = document.createElement('article');
  if (user) article.className = 'user';
  const p = document.createElement('p'); p.textContent = text; article.append(p);
  $('messages').append(article); article.scrollIntoView({block: 'nearest'});
  return article;
}
function trail(article, trace, approver) {
  const label = document.createElement('span'); label.className = 'trace';
  label.textContent = `Recorded approver: ${approver} · ${trace}`; article.append(label);
  const link = document.createElement('a'); link.href = `#${trace}`; link.textContent = 'Verify decision trail →';
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true; controls();
    try {
      const result = await tool('get_trace', {trace_id: trace});
      if (result.verified !== true) throw new Error('Chain verification failed.');
      let details = article.querySelector('details');
      if (!details) { details = document.createElement('details'); article.append(details); }
      details.replaceChildren();
      const summary = document.createElement('summary'); summary.textContent = `Verified by server · ${result.chain.length} linked decisions`;
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(result, null, 2);
      details.append(summary, pre); details.open = true;
      $('status').textContent = 'Retained chain verified. This is not proof of authorship.';
    } catch (error) { $('status').textContent = error.message; }
    finally { busy = false; controls(); }
  });
  article.append(link);
}
const actions = [
  {match: /\b(reorder|order)\b.*\bcoffee\b/i, action: 'reorder coffee', reason: 'You requested a coffee refill for the demo pantry.', inputs: {item: 'coffee', quantity: 1, simulated: true}, result: 'Coffee refill added to the simulated order.'},
  {match: /\b(change|set|update)\b.*\b(routine|lights)\b/i, action: 'change evening routine', reason: 'You requested a quieter evening routine with lights dimmed at 8 pm.', inputs: {time: '20:00', brightness: 20, simulated: true}, result: 'Simulated evening routine set: lights at 20% at 8 pm.'},
  {match: /\bbook\b.*\b(cleaner|cleaning)\b/i, action: 'book cleaner', reason: 'You requested a demo cleaning visit for Friday at 10 am.', inputs: {day: 'Friday', time: '10:00', simulated: true}, result: 'Simulated cleaner visit booked for Friday at 10 am.'},
];
async function submit(text) {
  if (!connected || busy || listening || !text.trim()) return;
  busy = true; controls(); card(text, true); $('prompt').value = '';
  $('status').textContent = 'Checking the decision trail…';
  try {
    let answer;
    if (/\bwhy\b/i.test(text)) {
      const result = await tool('explain_why', {question: text});
      answer = result.answer;
      trail(card(answer), result.trace_id, result.trail.approver);
    } else if (/\bwhat(?:'s| is)?\s+changed\b|\bthis week\b/i.test(text)) {
      const result = await tool('whats_changed', {since: new Date(Date.now() - 7 * 86400000).toISOString()});
      answer = result.decisions.length ? `${result.decisions.length} recorded changes in the last seven days: ${result.decisions.map(row => row.action).join(', ')}.` : 'No recorded changes in the last seven days.';
      const article = card(answer);
      for (const row of result.decisions) trail(article, row.trace_id, row.approver);
    } else {
      const action = actions.find(item => item.match.test(text));
      if (!action) { answer = 'Try “Reorder coffee”, “Change the evening routine”, “Book a cleaner”, or ask why or what changed this week.'; card(answer); }
      else {
        const result = await tool('record_decision', {session_id: session, action: action.action, reason: action.reason, inputs: action.inputs, approver: 'Demo user'});
        answer = action.result;
        trail(card(answer), result.trace_id, result.approver);
        if (!$('activity').dataset.started) { $('activity').replaceChildren(); $('activity').dataset.started = 'true'; }
        const li = document.createElement('li'); li.textContent = answer; $('activity').append(li);
      }
    }
    $('status').textContent = 'Ready for your next question.'; say(answer);
  } catch (error) { card(`Could not complete the request: ${error.message}`); $('status').textContent = 'Request failed. No successful action is claimed; check the trail before retrying.'; }
  finally { busy = false; controls(); $('prompt').focus(); }
}
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  busy = true; connected = false; controls();
  token = $('token').value; household = $('household').value; version = '';
  $('connection').textContent = 'Connecting…';
  try {
    const result = await rpc('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'alexa-why-demo', version: '1.0.0'}});
    if (result.protocolVersion !== '2025-11-25') throw new Error('Unsupported negotiated protocol.');
    version = result.protocolVersion;
    await rpc('notifications/initialized', {}, true);
    connected = true; $('token').value = '';
    $('messages').replaceChildren(); $('activity').replaceChildren(); delete $('activity').dataset.started;
    card('Connected. Try a simulated household action, then ask why.');
    $('connection').textContent = 'Connected · MCP';
    $('status').textContent = recognition ? 'Ready. Type a request or tap Mic to speak.' : 'Voice input is unavailable in this browser. Type a request below.';
  } catch (error) { token = ''; $('connection').textContent = 'Not connected'; $('status').textContent = error.message; }
  finally { busy = false; controls(); }
});
$('ask-form').addEventListener('submit', event => { event.preventDefault(); submit($('prompt').value); });
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => submit(button.dataset.prompt));
$('stop').addEventListener('click', () => window.speechSynthesis?.cancel());
if (recognition) {
  recognition.lang = 'en-US'; recognition.continuous = false; recognition.interimResults = false;
  recognition.onresult = event => { $('prompt').value = event.results[0][0].transcript; $('status').textContent = 'Review the transcript, then press Send.'; };
  recognition.onerror = event => { $('status').textContent = `Microphone unavailable (${event.error}). You can type instead.`; };
  recognition.onend = () => { listening = false; $('mic').textContent = 'Mic'; $('mic').setAttribute('aria-label', 'Start voice input'); controls(); };
  $('mic').addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }
    window.speechSynthesis?.cancel();
    try { recognition.start(); listening = true; $('mic').textContent = 'Stop'; $('mic').setAttribute('aria-label', 'Stop voice input'); $('status').textContent = 'Listening… tap Stop when finished.'; controls(); }
    catch { $('status').textContent = 'Could not start the microphone. Type instead.'; }
  });
}
controls();
