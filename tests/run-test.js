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

  // 1. wait for events to render -- 3 cards expected: the past-dated 4th event
  // (Корона из пепла) is hidden by default now, until "показать прошедшие" is clicked
  await waitFor(() => doc.getElementById('eventsGrid').querySelectorAll('.card').length === 3);
  console.log('PASS: 3 cards rendered (past event hidden by default)');

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
  await waitFor(() => doc.getElementById('eventsGrid').querySelectorAll('.card').length === 3);

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

  // 10. past events are hidden by default, revealed only via the "показать прошедшие" toggle.
  // The past-dated event (2026-07-20, before the sandbox's "today" 2026-07-31) is marked past
  // even though its own status is "Набор открыт", is disabled, and floats to the bottom once shown.
  const togglePastBtn = doc.getElementById('togglePastBtn');
  if (togglePastBtn.textContent !== 'показать прошедшие') {
    throw new Error('togglePastBtn should start as "показать прошедшие", got: ' + togglePastBtn.textContent);
  }
  if (Array.from(doc.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Корона из пепла')) {
    throw new Error('past event should not render before the toggle is clicked');
  }
  console.log('PASS: past event stays hidden until "показать прошедшие" is clicked');

  togglePastBtn.click();
  await waitFor(() => doc.getElementById('eventsGrid').querySelectorAll('.card').length === 4);
  if (togglePastBtn.textContent !== 'скрыть прошедшие') throw new Error('togglePastBtn label should flip after click: ' + togglePastBtn.textContent);
  console.log('PASS: "показать прошедшие" reveals the past event and flips the button label');

  const pastCard = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Корона из пепла');
  if (!pastCard.classList.contains('is-past')) throw new Error('past card missing is-past class');
  const pastBadge = pastCard.querySelector('.badge');
  if (!pastBadge.classList.contains('badge-past') || pastBadge.textContent !== 'Уже прошло') {
    throw new Error('past card badge wrong: class=' + pastBadge.className + ' text=' + pastBadge.textContent);
  }
  const pastBtn = pastCard.querySelector('button');
  if (!pastBtn.disabled || pastBtn.textContent !== 'Уже прошло') throw new Error('past card button wrong: ' + pastBtn.textContent);
  if (pastCard.querySelector('.card-actions').children.length !== 1) {
    throw new Error('past event should not also show an interest button, only the disabled primary button');
  }
  console.log('PASS: past event (still "Набор открыт" in the data) shown as "Уже прошло" and disabled');

  const gridOrder = Array.from(doc.querySelectorAll('.card')).map(c => c.querySelector('.card-game').textContent);
  if (gridOrder[gridOrder.length - 1] !== 'Корона из пепла') throw new Error('past event should sort to the bottom, order was: ' + gridOrder);
  console.log('PASS: past event sorts to the bottom of the list ->', gridOrder);

  // nearest-event stat must skip the past event and still point at the actual next upcoming one
  if (!statTexts[2].includes('7 августа')) throw new Error('nearest-event stat should skip the past event, got: ' + statTexts[2]);
  console.log('PASS: "ближайшее" stat correctly skips the past event');

  // toggling back off hides the past event again
  togglePastBtn.click();
  await waitFor(() => doc.getElementById('eventsGrid').querySelectorAll('.card').length === 3);
  if (togglePastBtn.textContent !== 'показать прошедшие') throw new Error('togglePastBtn label should flip back: ' + togglePastBtn.textContent);
  console.log('PASS: "скрыть прошедшие" hides the past event again');

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
  await waitFor(() => doc3.getElementById('eventsGrid').querySelectorAll('.card').length === 3);
  const draconCard3 = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  if (draconCard3.querySelector('button').textContent !== 'Отменить запись') {
    throw new Error('fresh load with saved identity should immediately show "Отменить запись" via bundled registeredIds');
  }
  if (fetchCount !== 1) throw new Error('expected exactly 1 network request for an identity-aware initial load, got ' + fetchCount);
  console.log('PASS: fresh load with saved identity resolves registration status in a single request (fetchCount=1)');

  // 12. guests (+1/+2): free the event back to 0/2, then confirm the guest dropdown caps
  // itself to remaining capacity and that a guest signup consumes multiple seats at once
  draconCard3.querySelector('button').click(); // "Отменить запись"
  await waitFor(() => {
    const card = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
    return card && card.querySelector('.card-participants b').textContent === '0 из 2';
  });
  console.log('PASS: cancel frees the event back to 0 из 2');

  const draconCard4 = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  draconCard4.querySelector('button').click(); // "Записаться"
  await waitFor(() => !doc3.getElementById('signupOverlay').hidden);
  const guestOptions = Array.from(doc3.getElementById('signupGuests').options).map(o => o.value);
  if (JSON.stringify(guestOptions) !== JSON.stringify(['0', '1'])) {
    throw new Error('guest dropdown should offer only 0 and +1 (2 seats remaining), got: ' + guestOptions);
  }
  console.log('PASS: guest dropdown limited to remaining capacity ->', guestOptions);

  doc3.getElementById('signupName').value = 'Гость Тестов';
  doc3.getElementById('signupEmail').value = 'guest.test@beeline.ru';
  doc3.getElementById('signupGuests').value = '1';
  doc3.getElementById('confirmSignup').click();
  await waitFor(() => doc3.getElementById('signupOverlay').hidden === true, 5000);

  await waitFor(() => {
    const card = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
    return card && card.querySelector('.card-participants b').textContent === '2 из 2';
  });
  const draconCard5 = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  const guestNamesText = draconCard5.querySelector('.card-participants .names').textContent;
  if (!guestNamesText.includes('Гость Тестов +1')) throw new Error('participant names should show guest count, got: ' + guestNamesText);
  console.log('PASS: signup with +1 guest occupies 2 seats and shows "Имя +1" in participant list ->', guestNamesText);

  // the signup form's identity (guest.test@beeline.ru) is now the "current user" (setMe()
  // runs on every successful signup), and they themselves are registered, so the button
  // shows "Отменить запись" for them even though the event is full for anyone else
  const draconBtnAfterGuestFill = draconCard5.querySelector('button');
  if (draconBtnAfterGuestFill.textContent !== 'Отменить запись') {
    throw new Error('registered user should see "Отменить запись" even on a now-full event, got: ' + draconBtnAfterGuestFill.textContent);
  }
  if (!draconCard5.classList.contains('is-full')) throw new Error('event should carry is-full once guests fill the remaining seats');
  console.log('PASS: event correctly marked full (is-full) once guests fill the remaining seats');

  // 13. "проявить интерес" -- a secondary way to signal wanting to play without needing an
  // open seat right now. Hidden once already registered for that exact event; otherwise
  // works even on a full/closed event, and must not affect participantsCount/isFull.
  const draconCardForInterestCheck = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  if (Array.from(draconCardForInterestCheck.querySelectorAll('button')).some(b => b.textContent === 'Проявить интерес')) {
    throw new Error('interest button should be hidden once already registered for the event');
  }
  console.log('PASS: interest button hidden for an event the current user is already registered for');

  const fullCardForInterest = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
  const interestBtn = Array.from(fullCardForInterest.querySelectorAll('button')).find(b => b.textContent === 'Проявить интерес');
  if (!interestBtn) throw new Error('interest button missing on a full, not-registered event');
  interestBtn.click();
  await waitFor(() => !doc.getElementById('interestOverlay').hidden);
  doc.getElementById('interestName').value = 'Интересующийся Игрок';
  doc.getElementById('interestEmail').value = 'interested.player@beeline.ru';
  doc.getElementById('confirmInterest').click();
  await waitFor(() => doc.getElementById('interestOverlay').hidden === true, 5000);
  console.log('PASS: interest modal submits and closes');

  await waitFor(() => {
    const card = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
    return card && card.querySelector('.card-interest');
  });
  const cardAfterInterest = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
  const interestLineText = cardAfterInterest.querySelector('.card-interest').textContent;
  if (!interestLineText.includes('ещё 1 хочет сыграть в другое время')) throw new Error('interest count line wrong: ' + interestLineText);
  console.log('PASS: interest count shown on card ->', interestLineText);

  if (cardAfterInterest.querySelector('.card-participants b').textContent !== '0 записалось') {
    throw new Error('expressing interest must not affect participantsCount, got: ' + cardAfterInterest.querySelector('.card-participants b').textContent);
  }
  console.log('PASS: expressing interest does not affect participantsCount');

  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
