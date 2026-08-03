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

function freshDom(html) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.fetch = fetch;
  dom.window.confirm = () => true;
  dom.window.alert = (msg) => { console.log('[alert]', msg); };
  dom.window.APP_CONFIG = { APPS_SCRIPT_URL: API };
  return dom;
}

// simulates identifying as name/email/pin via the "это вы" modal -- assumes it's already open
async function identifyVia(doc, name, email, pin) {
  doc.getElementById('inputName').value = name;
  doc.getElementById('inputEmail').value = email;
  doc.getElementById('inputPin').value = pin;
  doc.getElementById('saveWhoAmI').click();
  await waitFor(() => doc.getElementById('whoAmIOverlay').hidden === true, 5000);
}

(async () => {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const dom = freshDom(html);
  const { window } = dom;

  const appJs = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');
  window.eval(appJs);

  const doc = window.document;

  // 1. wait for events to render -- 3 cards expected: the past-dated 4th event
  // (Корона из пепла) is hidden by default now, until "показать прошедшие" is clicked.
  // The scheduled ("Тайный проект") and closed ("Секретный клуб") events stay hidden from
  // this anonymous visitor entirely, so they don't count here either.
  await waitFor(() => doc.getElementById('eventsGrid').querySelectorAll('.card').length === 3);
  console.log('PASS: 3 cards rendered (past event hidden by default)');

  // 2. filter chips populated dynamically from data
  const cityChips = Array.from(doc.getElementById('cityChips').querySelectorAll('.chip')).map(c => c.textContent);
  const formatChips = Array.from(doc.getElementById('formatChips').querySelectorAll('.chip')).map(c => c.textContent);
  if (!cityChips.includes('Москва') || !cityChips.includes('Санкт-Петербург')) throw new Error('city chips missing: ' + cityChips);
  // «Жанр» can hold several comma-separated values per event (e.g. Таверна = "Стратегия, Евро")
  // -- the filter chips must be the union of individual genres, not the raw multi-value strings
  if (!formatChips.includes('НРИ') || !formatChips.includes('Стратегия') || !formatChips.includes('Евро')) {
    throw new Error('format chips missing: ' + formatChips);
  }
  console.log('PASS: filter chips (multi-genre split into individual chips) =', cityChips, formatChips);

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
  // multi-value «Жанр» ("Стратегия, Евро") must render as two separate tag chips
  if (!tagTexts.includes('Стратегия') || !tagTexts.includes('Евро')) throw new Error('multi-genre tags missing, got: ' + tagTexts);
  const linkTexts = Array.from(openCardCheck.querySelectorAll('.card-link')).map(l => l.textContent);
  const linkHrefs = Array.from(openCardCheck.querySelectorAll('.card-link')).map(l => l.getAttribute('href'));
  if (!linkTexts.some(t => t.startsWith('Тесера')) || !linkTexts.some(t => t.startsWith('Об игре подробнее'))) {
    throw new Error('tesera/bgg links missing, got: ' + linkTexts);
  }
  if (!linkHrefs.includes('https://tesera.ru/game/tavern/')) throw new Error('tesera href wrong: ' + linkHrefs);
  console.log('PASS: difficulty tag, multi-genre tags, max-duration line, and Тесера/BGG (relabeled) links render correctly');

  // organizer name shows their corporate email as a hover tooltip (native title attribute)
  const organizerEl = openCardCheck.querySelector('.card-meta .hoverable-email');
  if (!organizerEl || organizerEl.title !== 'dasha@beeline.ru') {
    throw new Error('organizer hover-email missing or wrong: ' + (organizerEl && organizerEl.title));
  }
  console.log('PASS: organizer name carries corporate email as a hover tooltip ->', organizerEl.title);

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

  // 6. no identity set yet -- clicking "Записаться" must redirect to the "это вы" modal
  // instead of a free-text signup form (identity is now set exactly once, via PIN)
  const openCard = cards.find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  const signBtn = openCard.querySelector('button');
  if (signBtn.disabled) throw new Error('open event button should not be disabled');
  signBtn.click();
  await waitFor(() => !doc.getElementById('whoAmIOverlay').hidden);
  if (!doc.getElementById('signupOverlay').hidden) throw new Error('signup modal should not open before identity is set');
  console.log('PASS: signing up with no saved identity opens "это вы" first');

  // first time this email is seen -- any 4-digit PIN is accepted and the account is created
  await identifyVia(doc, 'Тестовый Игрок', 'test.player@beeline.ru', '1234');
  if (doc.getElementById('whoAmIBtn').textContent !== 'Тестовый Игрок · test.player@beeline.ru') {
    throw new Error('whoAmIBtn should show the saved name+email after identify, got: ' + doc.getElementById('whoAmIBtn').textContent);
  }
  console.log('PASS: first-time identify with a fresh PIN creates the account and sets identity');

  // now that identity is set, "Записаться" opens the real signup modal, showing who we are
  signBtn.click();
  await waitFor(() => !doc.getElementById('signupOverlay').hidden);
  const asWhomText = doc.getElementById('signupAsWhom').textContent;
  if (!asWhomText.includes('Тестовый Игрок') || !asWhomText.includes('test.player@beeline.ru')) {
    throw new Error('signup modal should show the already-identified user, got: ' + asWhomText);
  }
  doc.getElementById('confirmSignup').click();
  await waitFor(() => doc.getElementById('signupOverlay').hidden === true, 5000);
  console.log('PASS: signup modal (no free-text fields) submits using the already-identified user');

  // after refresh, participant count should be 1 of 2, and button should now be "Отменить запись" for this browser's saved identity
  await waitFor(() => {
    const grid = doc.getElementById('eventsGrid');
    const card = Array.from(grid.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
    return card && card.querySelector('.card-participants b').textContent === '1 из 2 (свободно: 1)';
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
    return card && card.querySelector('.card-participants b').textContent === '0 из 2 (свободно: 2)';
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
  const statSub = statCards[0].querySelector('.cap.mut').textContent;
  if (statSub !== 'сейчас доступны') throw new Error('stat subtitle should read "сейчас доступны", got: ' + statSub);
  console.log('PASS: stats row rendered ->', statTexts, '/', statSub);

  // 10. "показать прошедшие" now lives below the cards grid, not in the sticky filter bar
  const togglePastBtn = doc.getElementById('togglePastBtn');
  if (doc.getElementById('filters').contains(togglePastBtn)) {
    throw new Error('togglePastBtn should have moved out of the filter bar, below the grid');
  }
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

  // 11. sign up once more (identity already set, so no whoAmI redirect this time), then
  // simulate a fresh page load with a saved identity: confirm events + registeredIds now
  // arrive in a single request instead of a second action=myStatus call
  const openCard2 = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  openCard2.querySelector('button').click();
  await waitFor(() => !doc.getElementById('signupOverlay').hidden);
  doc.getElementById('confirmSignup').click();
  await waitFor(() => doc.getElementById('signupOverlay').hidden === true, 5000);

  const dom3 = freshDom(html);
  dom3.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Тестовый Игрок', email: 'test.player@beeline.ru' }));
  let fetchCount = 0;
  dom3.window.fetch = function () { fetchCount++; return fetch.apply(null, arguments); };
  dom3.window.eval(appJs);
  const doc3 = dom3.window.document;
  await waitFor(() => doc3.getElementById('eventsGrid').querySelectorAll('.card').length === 3);
  const draconCard3 = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  if (draconCard3.querySelector('button').textContent !== 'Отменить запись') {
    throw new Error('fresh load with saved identity should immediately show "Отменить запись" via bundled registeredIds');
  }
  if (fetchCount !== 1) throw new Error('expected exactly 1 network request for an identity-aware initial load, got ' + fetchCount);
  console.log('PASS: fresh load with saved identity resolves registration status in a single request (fetchCount=1)');

  // 12. guests (+1/+2): free the event back to 0/2, switch to a fresh identity via "это вы"
  // (since the signup modal no longer accepts free-text name/email), then confirm the guest
  // dropdown caps itself to remaining capacity and that a guest signup consumes multiple seats
  draconCard3.querySelector('button').click(); // "Отменить запись"
  await waitFor(() => {
    const card = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
    return card && card.querySelector('.card-participants b').textContent === '0 из 2 (свободно: 2)';
  });
  console.log('PASS: cancel frees the event back to 0 из 2');

  doc3.getElementById('whoAmIBtn').click();
  await waitFor(() => !doc3.getElementById('whoAmIOverlay').hidden);
  await identifyVia(doc3, 'Гость Тестов', 'guest.test@beeline.ru', '4321');
  console.log('PASS: switched identity via "это вы" to a second account');

  const draconCard4 = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  draconCard4.querySelector('button').click(); // "Записаться"
  await waitFor(() => !doc3.getElementById('signupOverlay').hidden);
  const guestOptions = Array.from(doc3.getElementById('signupGuests').options).map(o => o.value);
  if (JSON.stringify(guestOptions) !== JSON.stringify(['0', '1'])) {
    throw new Error('guest dropdown should offer only 0 and +1 (2 seats remaining), got: ' + guestOptions);
  }
  console.log('PASS: guest dropdown limited to remaining capacity ->', guestOptions);

  doc3.getElementById('signupGuests').value = '1';
  doc3.getElementById('confirmSignup').click();
  await waitFor(() => doc3.getElementById('signupOverlay').hidden === true, 5000);

  await waitFor(() => {
    const card = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
    return card && card.querySelector('.card-participants b').textContent === '2 из 2 (свободно: 0)';
  });
  const draconCard5 = Array.from(doc3.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Таверна Красный дракон');
  const guestNamesText = draconCard5.querySelector('.card-participants .names').textContent;
  if (!guestNamesText.includes('Гость Тестов +1')) throw new Error('participant names should show guest count, got: ' + guestNamesText);
  console.log('PASS: signup with +1 guest occupies 2 seats and shows "Имя +1" in participant list ->', guestNamesText);

  // the currently-identified user (guest.test@beeline.ru) is registered, so the button
  // shows "Отменить запись" for them even though the event is now full for anyone else
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

  // switch `doc`'s identity before expressing interest on a different game, so the "запись"
  // and "интерес" identities are clearly distinct people
  doc.getElementById('whoAmIBtn').click();
  await waitFor(() => !doc.getElementById('whoAmIOverlay').hidden);
  await identifyVia(doc, 'Интересующийся Игрок', 'interested.player@beeline.ru', '5555');

  const fullCardForInterest = Array.from(doc.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
  const interestBtn = Array.from(fullCardForInterest.querySelectorAll('button')).find(b => b.textContent === 'Проявить интерес');
  if (!interestBtn) throw new Error('interest button missing on a full, not-registered event');
  interestBtn.click();
  await waitFor(() => !doc.getElementById('interestOverlay').hidden);
  const interestAsWhomText = doc.getElementById('interestAsWhom').textContent;
  if (!interestAsWhomText.includes('Интересующийся Игрок') || !interestAsWhomText.includes('interested.player@beeline.ru')) {
    throw new Error('interest modal should show the already-identified user, got: ' + interestAsWhomText);
  }
  doc.getElementById('confirmInterest').click();
  await waitFor(() => doc.getElementById('interestOverlay').hidden === true, 5000);
  console.log('PASS: interest modal (no free-text fields) submits using the already-identified user');

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

  // 14. «Запланировано» ("Тайный проект", owned by olya@beeline.ru): hidden from the general
  // public by default, visible to its creator by email, hidden from a regular identified
  // visitor without the ambassador role, and visible (plus publishable) once that visitor's
  // account is granted the "Амбассадор" role -- which can only ever be done by editing the
  // «Аккаунты» sheet directly (simulated here via the test-only test_setRole backdoor).
  const dom4 = freshDom(html);
  dom4.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Оля', email: 'olya@beeline.ru' }));
  dom4.window.eval(appJs);
  const doc4 = dom4.window.document;
  await waitFor(() => Array.from(doc4.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Тайный проект'));
  const creatorCard = Array.from(doc4.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Тайный проект');
  const creatorBadge = creatorCard.querySelector('.badge');
  if (!creatorBadge.classList.contains('badge-planned') || creatorBadge.textContent !== 'Запланировано') {
    throw new Error('scheduled event badge wrong: ' + creatorBadge.className + ' / ' + creatorBadge.textContent);
  }
  console.log('PASS: creator sees their own scheduled (unpublished) event by email, with a "Запланировано" badge');

  // she's also the organizer of the closed event fixture ("Секретный клуб") -- she should
  // see it too, tagged "Закрытое", even though she never added herself as a participant
  const closedCardForOrganizer = Array.from(doc4.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Секретный клуб');
  if (!closedCardForOrganizer) throw new Error('organizer should see their own closed event');
  const closedTagsForOrganizer = Array.from(closedCardForOrganizer.querySelectorAll('.card-tags .tag')).map(t => t.textContent);
  if (!closedTagsForOrganizer.includes('Закрытое')) throw new Error('closed event should carry a "Закрытое" tag, got: ' + closedTagsForOrganizer);
  console.log('PASS: organizer sees their own closed event, tagged "Закрытое"');

  // not visible to a random logged-in visitor without the ambassador role (current identity
  // on `doc` is interested.player@beeline.ru from the interest test above)
  if (Array.from(doc.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Тайный проект')) {
    throw new Error('scheduled event should not be visible to a non-creator without the ambassador role');
  }
  if (Array.from(doc.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Секретный клуб')) {
    throw new Error('closed event should not be visible to someone who is neither its organizer, an ambassador, nor a listed participant');
  }
  console.log('PASS: scheduled and closed events both hidden from a regular visitor without the ambassador role');

  // the pre-seeded participant ("Петя") of the closed event fixture should see it among his
  // own events, with a working "Отменить запись" (he's an active signup, same as any other)
  const dom4p = freshDom(html);
  dom4p.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Петя', email: 'petya@beeline.ru' }));
  dom4p.window.eval(appJs);
  const doc4p = dom4p.window.document;
  await waitFor(() => Array.from(doc4p.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Секретный клуб'));
  const closedCardForParticipant = Array.from(doc4p.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Секретный клуб');
  const participantBtn = closedCardForParticipant.querySelector('button');
  if (participantBtn.textContent !== 'Отменить запись') throw new Error('a participant added to a closed event should see "Отменить запись", got: ' + participantBtn.textContent);
  console.log('PASS: a participant added to a closed event at creation sees it among their own events');

  // granting the "Амбассадор" role (simulating a manual edit of the «Аккаунты» sheet --
  // there is no way to do this from the site itself)
  await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'test_setRole', email: 'interested.player@beeline.ru', role: 'Амбассадор' })
  });

  const dom4b = freshDom(html);
  dom4b.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Интересующийся Игрок', email: 'interested.player@beeline.ru' }));
  dom4b.window.eval(appJs);
  const doc4b = dom4b.window.document;
  await waitFor(() => Array.from(doc4b.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Тайный проект'));
  const ambassadorCard = Array.from(doc4b.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Тайный проект');
  const publishBtn = Array.from(ambassadorCard.querySelectorAll('button')).find(b => b.textContent === 'Опубликовать');
  if (!publishBtn) throw new Error('ambassador should see a "Опубликовать" button on a scheduled event');
  console.log('PASS: an account with the ambassador role (set only via the sheet) reveals the scheduled event with a publish button, even though not its creator');

  const closedCardForAmbassador = Array.from(doc4b.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Секретный клуб');
  if (!closedCardForAmbassador) throw new Error('ambassador should also see closed events, even without being their organizer or a listed participant');
  console.log('PASS: ambassador role also reveals closed events');

  // publishing (as ambassador, not the creator) makes it public for everyone
  publishBtn.click();
  await waitFor(() => {
    const card = Array.from(doc4b.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Тайный проект');
    return card && card.querySelector('.badge').textContent !== 'Запланировано';
  }, 5000);
  console.log('PASS: ambassador can publish a scheduled event they did not create');

  const dom5 = freshDom(html);
  dom5.window.eval(appJs);
  const doc5 = dom5.window.document;
  await waitFor(() => Array.from(doc5.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Тайный проект'));
  if (Array.from(doc5.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Секретный клуб')) {
    throw new Error('closed event should still be hidden from a completely anonymous visitor after an unrelated event got published');
  }
  console.log('PASS: published event is now visible to a completely anonymous fresh visitor, closed event remains hidden from them');

  // 15. PIN identify flow in isolation: wrong PIN on a known email is rejected (with a
  // pointer to the ambassador's contact), the correct PIN then succeeds
  const dom6 = freshDom(html);
  dom6.window.eval(appJs);
  const doc6 = dom6.window.document;
  doc6.getElementById('whoAmIBtn').click();
  await waitFor(() => !doc6.getElementById('whoAmIOverlay').hidden);
  doc6.getElementById('inputName').value = 'Новый Пользователь';
  doc6.getElementById('inputEmail').value = 'pin.test@beeline.ru';
  doc6.getElementById('inputPin').value = '7777';
  doc6.getElementById('saveWhoAmI').click();
  await waitFor(() => doc6.getElementById('whoAmIOverlay').hidden === true, 5000);
  console.log('PASS: brand-new email + any 4-digit PIN creates the account');

  const dom7 = freshDom(html);
  dom7.window.eval(appJs);
  const doc7 = dom7.window.document;
  doc7.getElementById('whoAmIBtn').click();
  await waitFor(() => !doc7.getElementById('whoAmIOverlay').hidden);
  doc7.getElementById('inputName').value = 'Новый Пользователь';
  doc7.getElementById('inputEmail').value = 'pin.test@beeline.ru';
  doc7.getElementById('inputPin').value = '0000'; // wrong
  doc7.getElementById('saveWhoAmI').click();
  await waitFor(() => !doc7.getElementById('whoAmIError').hidden, 5000);
  const wrongPinMsg = doc7.getElementById('whoAmIError').textContent;
  if (!wrongPinMsg.includes('ddkolesnik@beeline.ru')) throw new Error('wrong-PIN error should point to the ambassador contact, got: ' + wrongPinMsg);
  if (doc7.getElementById('whoAmIOverlay').hidden) throw new Error('modal should stay open after a wrong PIN');
  if (JSON.parse(dom7.window.localStorage.getItem('nastolki_me') || 'null')) throw new Error('identity must not be saved after a wrong PIN');
  console.log('PASS: wrong PIN on a known email is rejected with a message pointing to the ambassador, identity not saved');

  doc7.getElementById('inputPin').value = '7777'; // correct this time
  doc7.getElementById('saveWhoAmI').click();
  await waitFor(() => doc7.getElementById('whoAmIOverlay').hidden === true, 5000);
  if (doc7.getElementById('whoAmIBtn').textContent !== 'Новый Пользователь · pin.test@beeline.ru') {
    throw new Error('correct PIN on a known email should set identity, got: ' + doc7.getElementById('whoAmIBtn').textContent);
  }
  console.log('PASS: correct PIN on a known email succeeds');

  // 16. organizer-only "+/-" stepper for manually reserving seats without a name/email
  const dom8 = freshDom(html);
  dom8.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Даша', email: 'dasha@beeline.ru' }));
  dom8.window.eval(appJs);
  const doc8 = dom8.window.document;
  await waitFor(() => Array.from(doc8.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем'));

  const brassCard = Array.from(doc8.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
  const reservedRow = brassCard.querySelector('.card-reserved');
  if (!reservedRow) throw new Error('organizer should see the "Занято без записи" stepper on their own event');
  if (!reservedRow.textContent.includes('Занято без записи: 0')) throw new Error('reserved stepper should start at 0, got: ' + reservedRow.textContent);
  const minusBtn = Array.from(reservedRow.querySelectorAll('button')).find(b => b.textContent === '−');
  if (!minusBtn.disabled) throw new Error('minus button should be disabled when reserved count is 0');
  console.log('PASS: organizer sees the reserved-seats stepper on their own event, starting at 0, "−" disabled');

  const plusBtn = Array.from(reservedRow.querySelectorAll('button')).find(b => b.textContent === '+');
  plusBtn.click();
  await waitFor(() => {
    const card = Array.from(doc8.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
    const row = card && card.querySelector('.card-reserved');
    return row && row.textContent.includes('Занято без записи: 1');
  });
  console.log('PASS: clicking "+" increments the reserved count and re-renders');

  const brassCardAfter = Array.from(doc8.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
  if (brassCardAfter.querySelector('.card-participants b').textContent !== '1 записалось') {
    throw new Error('reserved seats should count toward participantsCount even without maxParticipants, got: ' + brassCardAfter.querySelector('.card-participants b').textContent);
  }
  console.log('PASS: reserved count is included in the participants-count display');

  const minusBtnAfter = Array.from(brassCardAfter.querySelector('.card-reserved').querySelectorAll('button')).find(b => b.textContent === '−');
  minusBtnAfter.click();
  await waitFor(() => {
    const card = Array.from(doc8.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
    const row = card && card.querySelector('.card-reserved');
    return row && row.textContent.includes('Занято без записи: 0');
  });
  console.log('PASS: clicking "−" decrements the reserved count back to 0');

  // a non-organizer must never see the stepper, even when logged in
  const dom9 = freshDom(html);
  dom9.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Кто-то', email: 'someone-else@beeline.ru' }));
  dom9.window.eval(appJs);
  const doc9 = dom9.window.document;
  await waitFor(() => Array.from(doc9.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем'));
  const brassCardForStranger = Array.from(doc9.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Брасс Бирмингем');
  if (brassCardForStranger.querySelector('.card-reserved')) throw new Error('non-organizer should not see the reserved-seats stepper');
  console.log('PASS: the reserved-seats stepper is hidden from a non-organizer visitor');

  // capacity is respected: a dedicated event with maxParticipants=1 rejects a second reservation
  const ceForReserved = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'createEvent', date: '2026-12-01', time: '18:00', city: 'Москва', organizer: 'Даша', organizerEmail: 'dasha@beeline.ru', game: 'Тест счётчика', maxParticipants: 1 })
  }).then(r => r.json());
  if (!ceForReserved.ok) throw new Error('setup: failed to create the dedicated capacity-test event');

  const dom10 = freshDom(html);
  dom10.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Даша', email: 'dasha@beeline.ru' }));
  dom10.window.eval(appJs);
  const doc10 = dom10.window.document;
  await waitFor(() => Array.from(doc10.querySelectorAll('.card')).some(c => c.querySelector('.card-game').textContent === 'Тест счётчика'));

  const testCard = Array.from(doc10.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Тест счётчика');
  const testPlusBtn = Array.from(testCard.querySelector('.card-reserved').querySelectorAll('button')).find(b => b.textContent === '+');
  testPlusBtn.click();
  await waitFor(() => {
    const card = Array.from(doc10.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Тест счётчика');
    return card.querySelector('.card-reserved').textContent.includes('Занято без записи: 1');
  });
  const testCardFull = Array.from(doc10.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Тест счётчика');
  if (testCardFull.querySelector('.card-participants b').textContent !== '1 из 1 (свободно: 0)') {
    throw new Error('"из"/"свободно" text wrong after reserving the only seat, got: ' + testCardFull.querySelector('.card-participants b').textContent);
  }
  console.log('PASS: reserving the last seat fills the event and shows "свободно: 0"');

  const testPlusBtnAgain = Array.from(testCardFull.querySelector('.card-reserved').querySelectorAll('button')).find(b => b.textContent === '+');
  testPlusBtnAgain.click();
  await wait(400);
  const testCardStill1 = Array.from(doc10.querySelectorAll('.card')).find(c => c.querySelector('.card-game').textContent === 'Тест счётчика');
  if (!testCardStill1.querySelector('.card-reserved').textContent.includes('Занято без записи: 1')) {
    throw new Error('reserving beyond maxParticipants should be rejected, reserved count should stay at 1, got: ' + testCardStill1.querySelector('.card-reserved').textContent);
  }
  console.log('PASS: reserving beyond maxParticipants is rejected server-side, count stays capped');

  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
