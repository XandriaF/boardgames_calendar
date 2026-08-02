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

function fireEvent(win, el, type) {
  el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
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

  // fixed city dropdown renders immediately, including the trailing "Другой" catch-all option
  const cityOptions = Array.from(doc.getElementById('fCity').options).map(o => o.value);
  if (!cityOptions.includes('Онлайн') || !cityOptions.includes('Ростов-на-Дону') || cityOptions[cityOptions.length - 1] !== 'Другой') {
    throw new Error('fixed city dropdown wrong, got: ' + cityOptions);
  }
  console.log('PASS: fixed city dropdown renders immediately ->', cityOptions);

  // жанр renders as a group of multi-select chips (checkbox-like pills), not a text field
  const genreChipLabels = Array.from(doc.getElementById('fFormatGroup').querySelectorAll('.chip')).map(c => c.textContent);
  if (!genreChipLabels.includes('Стратегия') || !genreChipLabels.includes('Абстрактная') || !genreChipLabels.includes('Контроль территории')) {
    throw new Error('expanded genre taxonomy missing (area control / abstract / strategy), got: ' + genreChipLabels);
  }
  console.log('PASS: genre renders as a multi-select chip group with an expanded taxonomy ->', genreChipLabels);

  function selectGenres(...labels) {
    Array.from(doc.getElementById('fFormatGroup').querySelectorAll('.chip'))
      .filter(c => labels.includes(c.textContent))
      .forEach(c => c.click());
  }

  function pickCity(value, otherText) {
    const select = doc.getElementById('fCity');
    select.value = value;
    fireEvent(window, select, 'change');
    if (value === 'Другой') doc.getElementById('fCityOther').value = otherText;
  }

  // fill the form -- "Казань" isn't in the fixed list, so exercises the "Другой" free-text path
  doc.getElementById('fDate').value = '2026-09-15';
  doc.getElementById('fTime').value = '19:30';
  pickCity('Другой', 'Казань');
  if (doc.getElementById('fCityOtherWrap').hidden) throw new Error('"Другой" should reveal the free-text city field');
  selectGenres('НРИ', 'Приключение');
  doc.getElementById('fGame').value = 'Зов Ктулху';
  doc.getElementById('fPlace').value = 'Клуб настолок';
  doc.getElementById('fOrganizer').value = 'Игорь';
  doc.getElementById('fOrganizerEmail').value = 'igor@beeline.ru';
  doc.getElementById('fMax').value = '6';
  doc.getElementById('fNote').value = 'для новичков';
  doc.getElementById('fDifficulty').value = 'Сложная';
  doc.getElementById('fMaxDuration').value = '180';
  doc.getElementById('fSetting').value = 'ужасы, детектив';
  doc.getElementById('fImage').value = 'https://example.com/cthulhu.jpg';
  doc.getElementById('fTesera').value = 'https://tesera.ru/game/cthulhu/';
  doc.getElementById('fBgg').value = 'https://boardgamegeek.com/boardgame/cthulhu';

  const submitEvent = () => fireEvent(window, doc.getElementById('eventForm'), 'submit');
  submitEvent(); // triggers "Опубликовать сейчас" (the form's default submit button)

  await waitFor(() => doc.getElementById('resultCard').hidden === false);
  console.log('PASS: submitted -> result card shown, form hidden =', doc.getElementById('eventForm').hidden);

  if (doc.getElementById('scheduledNote').hidden !== true || doc.getElementById('publishedNote').hidden !== false) {
    throw new Error('publish-now should show the published note, not the scheduled one');
  }
  if (doc.getElementById('postText').hidden !== false) throw new Error('publish-now should show the post text');
  console.log('PASS: "Опубликовать сейчас" shows the published note and post text');

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
  if (!createdTags.includes('НРИ') || !createdTags.includes('Приключение')) {
    throw new Error('created event missing its multi-select genre tags on index.html, got: ' + createdTags);
  }
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
  const createdOrganizerEl = createdCard.querySelector('.card-meta .hoverable-email');
  if (!createdOrganizerEl || createdOrganizerEl.title !== 'igor@beeline.ru') {
    throw new Error('created event missing organizer hover-email on index.html, got: ' + (createdOrganizerEl && createdOrganizerEl.title));
  }
  console.log('PASS: new event created via organizer form renders genre/difficulty/duration/links/organizer-email correctly on index.html');

  // copy button
  doc.getElementById('copyBtn').click();
  await waitFor(() => copiedText !== null);
  if (copiedText !== text) throw new Error('copied text does not match textarea content');
  console.log('PASS: copy button copied exact post text to clipboard stub');

  // reset and resubmit identical event -> should be rejected as duplicate
  doc.getElementById('resetBtn').click();
  await waitFor(() => doc.getElementById('eventForm').hidden === false);
  if (!doc.getElementById('fCityOtherWrap').hidden) throw new Error('reset should hide the "Другой" city field again');
  if (doc.getElementById('fFormatGroup').querySelectorAll('.chip.active').length !== 0) throw new Error('reset should clear selected genre chips');
  doc.getElementById('fDate').value = '2026-09-15';
  doc.getElementById('fTime').value = '19:30';
  pickCity('Другой', 'Казань');
  doc.getElementById('fGame').value = 'Зов Ктулху';
  doc.getElementById('fOrganizer').value = 'Игорь';
  doc.getElementById('fOrganizerEmail').value = 'igor@beeline.ru';
  submitEvent();

  await waitFor(() => doc.getElementById('formError').hidden === false);
  const errText = doc.getElementById('formError').textContent;
  if (!errText.includes('уже есть')) throw new Error('expected duplicate error message, got: ' + errText);
  console.log('PASS: duplicate submission rejected with message:', errText);

  // ---- «Запланировать»: saved privately, no post-text/copy UI, not in the public list ----
  doc.getElementById('resetBtn').click();
  await waitFor(() => doc.getElementById('eventForm').hidden === false);
  doc.getElementById('fDate').value = '2026-10-20';
  doc.getElementById('fTime').value = '18:00';
  pickCity('Москва');
  selectGenres('Кооперативная');
  doc.getElementById('fGame').value = 'Секретная игра организатора';
  doc.getElementById('fOrganizer').value = 'Игорь';
  doc.getElementById('fOrganizerEmail').value = 'igor@beeline.ru';

  doc.getElementById('submitScheduleBtn').click();
  await waitFor(() => doc.getElementById('resultCard').hidden === false);
  if (doc.getElementById('scheduledNote').hidden !== false || doc.getElementById('publishedNote').hidden !== true) {
    throw new Error('"Запланировать" should show the scheduled note, not the published one');
  }
  if (doc.getElementById('postText').hidden !== true || doc.getElementById('resultActionsRow').hidden !== true) {
    throw new Error('"Запланировать" should hide the post-text/copy UI -- nothing to share yet');
  }
  const scheduledNoteText = doc.getElementById('scheduledNote').textContent;
  if (!scheduledNoteText.includes('Секретная игра организатора') || !scheduledNoteText.includes('igor@beeline.ru')) {
    throw new Error('scheduled note should mention the game and the organizer email, got: ' + scheduledNoteText);
  }
  console.log('PASS: "Запланировать" saves privately and shows the scheduled note instead of post text ->', scheduledNoteText);

  const rawEvents = await fetch(API + '?action=events').then(r => r.json());
  if (rawEvents.events.some(e => e.game === 'Секретная игра организатора')) {
    throw new Error('a scheduled event must not appear in the public events list');
  }
  console.log('PASS: scheduled event is absent from the public action=events list');

  const rawEventsAsCreator = await fetch(API + '?action=events&email=igor@beeline.ru').then(r => r.json());
  const scheduledEv = rawEventsAsCreator.events.find(e => e.game === 'Секретная игра организатора');
  if (!scheduledEv || scheduledEv.status !== 'Запланировано') {
    throw new Error('scheduled event should be visible to its creator via email, with status Запланировано');
  }
  console.log('PASS: scheduled event is visible to its creator via ?email=');

  console.log('\nALL ORGANIZER TESTS PASSED');
  process.exit(0);
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
