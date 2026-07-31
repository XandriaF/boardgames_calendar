const fs = require('fs');
const path_ = require('path');
const path = path_;
const { JSDOM } = require('/tmp/node_modules/jsdom');

const SITE = '/sessions/keen-relaxed-thompson/mnt/boardgames_calendar';
const API = 'http://localhost:8930';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(cond, timeout = 5000, step = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await cond()) return true;
    await wait(step);
  }
  throw new Error('waitFor timed out');
}

(async () => {
  const html = fs.readFileSync(path.join(SITE, 'organizer.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/organizer.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = fetch;
  window.APP_CONFIG = { APPS_SCRIPT_URL: API };
  let copiedText = null;
  window.navigator.clipboard = { writeText: (t) => { copiedText = t; return Promise.resolve(); } };
  // jsdom doesn't implement scrollIntoView
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const appJs = fs.readFileSync(path.join(SITE, 'organizer.js'), 'utf8');
  window.eval(appJs);

  const doc = window.document;

  await waitFor(() => doc.getElementById('cityList').children.length >= 2);
  console.log('PASS: city suggestions loaded from existing events ->', Array.from(doc.getElementById('cityList').children).map(o => o.value));

  // fill the form
  doc.getElementById('fDate').value = '2026-09-15';
  doc.getElementById('fTime').value = '19:30';
  doc.getElementById('fCity').value = 'Казань';
  doc.getElementById('fFormat').value = 'НРИ';
  doc.getElementById('fGame').value = 'Зов Ктулху';
  doc.getElementById('fPlace').value = 'Клуб настолок';
  doc.getElementById('fOrganizer').value = 'Игорь';
  doc.getElementById('fMax').value = '6';
  doc.getElementById('fNote').value = 'для новичков';
  doc.getElementById('fDifficulty').value = 'Сложная';
  doc.getElementById('fMaxDuration').value = '180';
  doc.getElementById('fSetting').value = 'ужасы, детектив';
  doc.getElementById('fImage').value = 'https://example.com/cthulhu.jpg';
  doc.getElementById('fTesera').value = 'https://tesera.ru/game/cthulhu/';
  doc.getElementById('fBgg').value = 'https://boardgamegeek.com/boardgame/cthulhu';

  const submitEvent = () => {
    const ev = new window.Event('submit', { bubbles: true, cancelable: true });
    doc.getElementById('eventForm').dispatchEvent(ev);
  };
  submitEvent();

  await waitFor(() => doc.getElementById('resultCard').hidden === false);
  console.log('PASS: submitted -> result card shown, form hidden =', doc.getElementById('eventForm').hidden);

  const text = doc.getElementById('postText').value;
  const checks = [
    ['game name in post text', text.includes('Зов Ктулху')],
    ['city in post text', text.includes('Казань')],
    ['organizer in post text', text.includes('Игорь')],
    ['max participants in post text', text.includes('6')],
    ['note in post text', text.includes('для новичков')],
    ['difficulty in post text', text.includes('Сложность: Сложная')],
    ['max duration in post text', text.includes('180 мин')],
    ['setting in post text', text.includes('Сеттинг: ужасы, детектив')],
    ['image link in post text', text.includes('https://example.com/cthulhu.jpg')],
    ['tesera link in post text', text.includes('https://tesera.ru/game/cthulhu/')],
    ['bgg link in post text', text.includes('https://boardgamegeek.com/boardgame/cthulhu')],
  ];
  checks.forEach(([label, ok]) => {
    if (!ok) throw new Error('FAIL: ' + label + ' -- text was:\n' + text);
    console.log('PASS:', label);
  });

  const linkLine = text.split('\n').find(l => l.startsWith('Записаться: '));
  const link = linkLine.replace('Записаться: ', '');
  const hashPart = link.split('#')[1];
  const decodedSlug = decodeURIComponent(hashPart);
  if (decodedSlug !== 'ev-2026-09-15-19-30-зов-ктулху') {
    throw new Error('unexpected slug after decoding: ' + decodedSlug);
  }
  console.log('PASS: generated link decodes to expected slug ->', decodedSlug, '(raw link:', link + ')');

  // ---- cross-page check: does the link actually resolve & highlight the right card on index.html? ----
  const indexHtml = fs.readFileSync(path_.join(SITE, 'index.html'), 'utf8');
  const dom2 = new JSDOM(indexHtml, { url: link, runScripts: 'outside-only', pretendToBeVisual: true });
  dom2.window.fetch = fetch;
  dom2.window.APP_CONFIG = { APPS_SCRIPT_URL: API };
  dom2.window.HTMLElement.prototype.scrollIntoView = function () { this.__scrolledIntoView = true; };
  dom2.window.eval(fs.readFileSync(path_.join(SITE, 'app.js'), 'utf8'));
  const doc2 = dom2.window.document;
  await waitFor(() => doc2.getElementById('eventsGrid').querySelectorAll('.card').length > 0);
  await waitFor(() => {
    const el = doc2.getElementById('ev-2026-09-15-19-30-зов-ктулху');
    return el && el.classList.contains('is-highlighted');
  }, 4000);
  console.log('PASS: opening the announcement link on index.html scrolls to and highlights the right card');

  const createdCard = doc2.getElementById('ev-2026-09-15-19-30-зов-ктулху');
  const createdTags = Array.from(createdCard.querySelectorAll('.card-tags .tag')).map(t => t.textContent);
  if (!createdTags.includes('Сложная')) throw new Error('created event missing difficulty tag on index.html, got: ' + createdTags);
  if (!createdCard.querySelector('.card-meta').textContent.includes('180 мин')) throw new Error('created event missing max duration line on index.html');
  if (!createdTags.includes('ужасы') || !createdTags.includes('детектив')) {
    throw new Error('created event missing setting keyword tags on index.html, got: ' + createdTags);
  }
  const createdImg = createdCard.querySelector('.card-image');
  if (!createdImg || createdImg.getAttribute('src') !== 'https://example.com/cthulhu.jpg') {
    throw new Error('created event missing correct image on index.html, got: ' + (createdImg && createdImg.getAttribute('src')));
  }
  const createdLinkHrefs = Array.from(createdCard.querySelectorAll('.card-link')).map(l => l.getAttribute('href'));
  if (!createdLinkHrefs.includes('https://tesera.ru/game/cthulhu/') || !createdLinkHrefs.includes('https://boardgamegeek.com/boardgame/cthulhu')) {
    throw new Error('created event missing tesera/bgg links on index.html, got: ' + createdLinkHrefs);
  }
  console.log('PASS: new event created via organizer form renders difficulty/duration/links correctly on index.html');

  // copy button
  doc.getElementById('copyBtn').click();
  await waitFor(() => copiedText !== null);
  if (copiedText !== text) throw new Error('copied text does not match textarea content');
  console.log('PASS: copy button copied exact post text to clipboard stub');

  // reset and resubmit identical event -> should be rejected as duplicate
  doc.getElementById('resetBtn').click();
  await waitFor(() => doc.getElementById('eventForm').hidden === false);
  doc.getElementById('fDate').value = '2026-09-15';
  doc.getElementById('fTime').value = '19:30';
  doc.getElementById('fCity').value = 'Казань';
  doc.getElementById('fGame').value = 'Зов Ктулху';
  doc.getElementById('fOrganizer').value = 'Игорь';
  submitEvent();

  await waitFor(() => doc.getElementById('formError').hidden === false);
  const errText = doc.getElementById('formError').textContent;
  if (!errText.includes('уже есть')) throw new Error('expected duplicate error message, got: ' + errText);
  console.log('PASS: duplicate submission rejected with message:', errText);

  console.log('\nALL ORGANIZER TESTS PASSED');
  process.exit(0);
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
