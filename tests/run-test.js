const fs = require('fs');
const path = require('path');
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
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = fetch; // node's native fetch
  window.confirm = () => true;
  window.alert = (msg) => { console.log('[alert]', msg); };
  window.APP_CONFIG = { APPS_SCRIPT_URL: API };

  const appJs = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');
  window.eval(appJs);

  const doc = window.document;

  // 1. wait for events to render (4 cards expected, all statuses public)
  await waitFor(() => doc.getElementById('eventsGrid').querySelectorAll('.card').length === 4);
  console.log('PASS: 4 cards rendered');

  // 2. filter chips populated dynamically from data
  const cityChips = Array.from(doc.getElementById('cityChips').querySelectorAll('.chip')).map(c => c.textContent);
  const formatChips = Array.from(doc.getElementById('formatChips').querySelectorAll('.chip')).map(c => c.textContent);
  if (!cityChips.includes('Москва') || !cityChips.includes('Санкт-Петербург')) throw new Error('city chips missing: ' + cityChips);
  if (!formatChips.includes('НРИ') || !formatChips.includes('Настольная игра')) throw new Error('format chips missing: ' + formatChips);
  console.log('PASS: filter chips =', cityChips, formatChips);

  // 3. click city filter "Санкт-Петербург" -> should show only 1 card
  const spbChip = Array.from(doc.getElementById('cityChips').querySelectorAll('.chip')).find(c => c.textContent === 'Санкт-Петербург');
  spbChip.click();
  await waitFor(() => doc.getElementById('eventsGrid').querySelectorAll('.card').length === 1);
  const cardGame = doc.querySelector('.card .card-game').textContent;
  if (cardGame !== 'Брасс Бирмингем') throw new Error('wrong card after filter: ' + cardGame);
  console.log('PASS: city filter narrows to 1 card (Брасс Бирмингем)');

  // reset filter back to "Все"
  Array.from(doc.getElementById('cityChips').querySelectorAll('.chip')).find(c => c.textContent === 'Все').click();
  await waitFor(() => doc.getElementById('eventsGrid').querySelectorAll('.card').length === 4);

  // 4. cancelled event shows disabled "Отменено" button, no signup possible
  const cards = Array.from(doc.querySelectorAll('.card'));
  const cancelledCard = cards.find(c => c.querySelector('.card-game').textContent === 'Descent');
  if (!cancelledCard.classList.contains('is-cancelled')) throw new Error('cancelled card missing is-cancelled class');
  const cancelledBtn = cancelledCard.querySelector('button');
  if (!cancelledBtn.disabled || cancelledBtn.textContent !== 'Отменено') throw new Error('cancelled card button wrong: ' + cancelledBtn.textContent);
  console.log('PASS: cancelled event rendered correctly, no signup possible');

  // 5. full event (Набрано) shows disabled "Мест нет"
  const fullCard = cards.find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
  const fullBtn = fullCard.querySelector('button');
  if (!fullBtn.disabled || fullBtn.textContent !== 'Мест нет') throw new Error('full card button wrong: ' + fullBtn.textContent);
  console.log('PASS: full event shows disabled "Мест нет"');

  // 5b. difficulty tag, max-duration line, and Тесера/BGG links render for the event that has them
  const openCardCheck = cards.find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  const tagTexts = Array.from(openCardCheck.querySelectorAll('.card-tags .tag')).map(t => t.textContent);
  if (!tagTexts.includes('Средняя')) throw new Error('difficulty tag missing, got tags: ' + tagTexts);
  if (!openCardCheck.querySelector('.card-meta').textContent.includes('90 мин')) throw new Error('max duration line missing');
  const linkTexts = Array.from(openCardCheck.querySelectorAll('.card-link')).map(l => l.textContent);
  const linkHrefs = Array.from(openCardCheck.querySelectorAll('.card-link')).map(l => l.getAttribute('href'));
  if (!linkTexts.some(t => t.startsWith('Тесера')) || !linkTexts.some(t => t.startsWith('BGG'))) {
    throw new Error('tesera/bgg links missing, got: ' + linkTexts);
  }
  if (!linkHrefs.includes('https://tesera.ru/game/tavern/')) throw new Error('tesera href wrong: ' + linkHrefs);
  console.log('PASS: difficulty tag, max-duration line, and Тесера/BGG links render correctly');

  // setting keywords ("фэнтези, таверна") must split into separate tag chips
  if (!tagTexts.includes('фэнтези') || !tagTexts.includes('таверна')) {
    throw new Error('setting keywords should render as separate tags, got: ' + tagTexts);
  }
  console.log('PASS: setting keywords render as separate tag chips ->', tagTexts);

  // image renders as an <img class="card-image"> when imageUrl is set
  const cardImg = openCardCheck.querySelector('.card-image');
  if (!cardImg || cardImg.getAttribute('src') !== 'https://example.com/tavern.jpg') {
    throw new Error('card image missing or wrong src: ' + (cardImg && cardImg.getAttribute('src')));
  }
  console.log('PASS: card image renders with correct src ->', cardImg.getAttribute('src'));

  // event with none of the optional fields set (Descent) must render with none of this, no crash
  const noExtrasCard = cards.find(c => c.querySelector('.card-game').textContent === 'Descent');
  if (noExtrasCard.querySelector('.card-link')) throw new Error('Descent should have no links, since teseraUrl/bggUrl are empty');
  if (noExtrasCard.querySelector('.card-image')) throw new Error('Descent should have no image, since imageUrl is empty');
  console.log('PASS: event without difficulty/duration/links renders cleanly (no stray elements)');

  // 6. sign up for the open event (Таверна Красный дракон, max 2)
  const openCard = cards.find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  const signBtn = openCard.querySelector('button');
  if (signBtn.disabled) throw new Error('open event button should not be disabled');
  signBtn.click();
  await waitFor(() => !doc.getElementById('signupOverlay').hidden);
  doc.getElementById('signupName').value = 'Тестовый Игрок';
  doc.getElementById('signupEmail').value = 'test.player@beeline.ru';
  doc.getElementById('confirmSignup').click();

  await waitFor(() => doc.getElementById('signupOverlay').hidden === true, 5000);
  console.log('PASS: signup modal submitted and closed');

  // the "это вы" button must reflect the identity just saved during signup, not keep
  // showing the generic "указать имя и почту" label forever -- and must show the email too
  if (doc.getElementById('whoAmIBtn').textContent !== 'Тестовый Игрок · test.player@beeline.ru') {
    throw new Error('whoAmIBtn should show the saved name+email after signup, got: ' + doc.getElementById('whoAmIBtn').textContent);
  }
  console.log('PASS: "это вы" button shows saved name+email after signup ->', doc.getElementById('whoAmIBtn').textContent);

  // after refresh, participant count should be 1 of 2, and button should now be "Отменить запись" for this browser's saved identity
  await waitFor(() => {
    const grid = doc.getElementById('eventsGrid');
    const card = Array.from(grid.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
    return card && card.querySelector('.card-participants b').textContent === '1 из 2';
  });
  const updatedCard = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  const updatedBtn = updatedCard.querySelector('button');
  if (updatedBtn.textContent !== 'Отменить запись') throw new Error('expected cancel button after signup, got: ' + updatedBtn.textContent);
  console.log('PASS: after signup -> count 1 из 2, button = "Отменить запись"');

  // 7. cancel the signup
  updatedBtn.click();
  await waitFor(() => {
    const grid = doc.getElementById('eventsGrid');
    const card = Array.from(grid.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
    return card && card.querySelector('.card-participants b').textContent === '0 из 2';
  });
  console.log('PASS: cancel works, count back to 0 из 2');

  // 8. localStorage persisted identity
  const saved = JSON.parse(window.localStorage.getItem('nastolki_me'));
  if (saved.email !== 'test.player@beeline.ru') throw new Error('localStorage identity not saved correctly');
  console.log('PASS: identity persisted in localStorage:', saved);

  // 9. stats row rendered with 3 kpi cards
  const statCards = doc.getElementById('statsRow').querySelectorAll('.card-s');
  if (statCards.length !== 3) throw new Error('expected 3 stat cards, got ' + statCards.length);
  const statTexts = Array.from(statCards).map(c => c.querySelector('.n').textContent);
  if (statTexts[0] !== '4') throw new Error('expected total events stat = 4, got ' + statTexts[0]);
  console.log('PASS: stats row rendered ->', statTexts);

  // 10. a past-dated event (2026-07-20, before the sandbox's "today" 2026-07-31) is marked
  // past even though its own status is "Набор открыт", is disabled, and floats to the bottom
  const pastCard = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Корона из пепла');
  if (!pastCard.classList.contains('is-past')) throw new Error('past card missing is-past class');
  const pastBadge = pastCard.querySelector('.badge');
  if (!pastBadge.classList.contains('badge-past') || pastBadge.textContent !== 'Уже прошло') {
    throw new Error('past card badge wrong: class=' + pastBadge.className + ' text=' + pastBadge.textContent);
  }
  const pastBtn = pastCard.querySelector('button');
  if (!pastBtn.disabled || pastBtn.textContent !== 'Уже прошло') throw new Error('past card button wrong: ' + pastBtn.textContent);
  console.log('PASS: past event (still "Набор открыт" in the data) shown as "Уже прошло" and disabled');

  const gridOrder = Array.from(doc.querySelectorAll('.card')).map(c => c.querySelector('.card-game').textContent);
  if (gridOrder[gridOrder.length - 1] !== 'Корона из пепла') throw new Error('past event should sort to the bottom, order was: ' + gridOrder);
  console.log('PASS: past event sorts to the bottom of the list ->', gridOrder);

  // nearest-event stat must skip the past event and still point at the actual next upcoming one
  if (!statTexts[2].includes('7 августа')) throw new Error('nearest-event stat should skip the past event, got: ' + statTexts[2]);
  console.log('PASS: "ближайшее" stat correctly skips the past event');

  // 11. sign up once more, then simulate a fresh page load with a saved identity: confirm
  // events + registeredIds now arrive in a single request instead of a second action=myStatus call
  const openCard2 = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  openCard2.querySelector('button').click();
  await waitFor(() => !doc.getElementById('signupOverlay').hidden);
  doc.getElementById('signupName').value = 'Тестовый Игрок';
  doc.getElementById('signupEmail').value = 'test.player@beeline.ru';
  doc.getElementById('confirmSignup').click();
  await waitFor(() => doc.getElementById('signupOverlay').hidden === true, 5000);

  const dom3 = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  dom3.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Тестовый Игрок', email: 'test.player@beeline.ru' }));
  let fetchCount = 0;
  dom3.window.fetch = function () { fetchCount++; return fetch.apply(null, arguments); };
  dom3.window.confirm = () => true;
  dom3.window.alert = () => {};
  dom3.window.APP_CONFIG = { APPS_SCRIPT_URL: API };
  dom3.window.eval(appJs);
  const doc3 = dom3.window.document;
  await waitFor(() => doc3.getElementById('eventsGrid').querySelectorAll('.card').length === 4);
  const draconCard3 = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  if (draconCard3.querySelector('button').textContent !== 'Отменить запись') {
    throw new Error('fresh load with saved identity should immediately show "Отменить запись" via bundled registeredIds');
  }
  if (fetchCount !== 1) throw new Error('expected exactly 1 network request for an identity-aware initial load, got ' + fetchCount);
  console.log('PASS: fresh load with saved identity resolves registration status in a single request (fetchCount=1)');

  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
