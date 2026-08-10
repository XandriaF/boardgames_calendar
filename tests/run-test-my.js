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
  const dom = new JSDOM(html, { url: 'http://localhost/my.html', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.fetch = fetch;
  dom.window.confirm = () => true;
  dom.window.alert = (msg) => { console.log('[alert]', msg); };
  dom.window.APP_CONFIG = { APPS_SCRIPT_URL: API };
  return dom;
}

function cardGames(doc) {
  return Array.from(doc.querySelectorAll('#myGrid .card')).map(c => c.querySelector('.card-game').textContent);
}
function findCard(doc, game) {
  return Array.from(doc.querySelectorAll('#myGrid .card')).find(c => c.querySelector('.card-game').textContent === game);
}
function clickView(doc, view) {
  Array.from(doc.querySelectorAll('#viewToggle .chip')).find(b => b.getAttribute('data-view') === view).click();
}

(async () => {
  const html = fs.readFileSync(path.join(SITE, 'my.html'), 'utf8');
  const myJs = fs.readFileSync(path.join(SITE, 'my.js'), 'utf8');

  // ---- 1. not identified yet: prompt instead of a network call, "Мои игры" is its own
  // active nav item (it doesn't hide itself the way the OTHER pages' link to it does) ----
  const dom1 = freshDom(html);
  dom1.window.eval(myJs);
  const doc1 = dom1.window.document;

  if (doc1.getElementById('whoAmIBtn').textContent !== 'указать имя и почту') {
    throw new Error('whoAmIBtn should start unidentified');
  }
  const myNavLink = Array.from(doc1.querySelectorAll('.top-nav .chip')).find(a => a.textContent === 'Мои игры');
  if (!myNavLink || !myNavLink.classList.contains('active') || myNavLink.hidden) {
    throw new Error('"Мои игры" should be the active, always-visible nav item on its own page');
  }
  await waitFor(() => doc1.getElementById('myGrid').textContent.includes('Сначала укажите, кто вы'));
  console.log('PASS: unidentified visitor sees a prompt instead of an empty grid or a wasted network call');

  const promptBtn = doc1.querySelector('#myGrid .empty button');
  if (!promptBtn) throw new Error('the prompt should include a button to open "это вы"');
  promptBtn.click();
  await waitFor(() => !doc1.getElementById('whoAmIOverlay').hidden);
  console.log('PASS: prompt button opens the "это вы" modal');

  // identify as Даша (brand-new account in this mock-server instance) -- she already
  // organizes 2 fixture events (Таверна Красный дракон, Брасс Бирмингем)
  doc1.getElementById('inputName').value = 'Даша Тестовая';
  doc1.getElementById('inputEmail').value = 'dasha@beeline.ru';
  doc1.getElementById('inputPin').value = '4444';
  doc1.getElementById('saveWhoAmI').click();
  await waitFor(() => doc1.getElementById('whoAmIOverlay').hidden === true, 5000);
  await waitFor(() => cardGames(doc1).length === 2);
  const announced1 = cardGames(doc1).sort();
  if (announced1.join(',') !== ['Брасс Бирмингем', 'Таверна Красный дракон'].sort().join(',')) {
    throw new Error('"Мои анонсы" should list exactly the 2 events Даша organizes, got: ' + announced1);
  }
  console.log('PASS: "Мои анонсы" lists exactly the events this account organizes ->', announced1);

  clickView(doc1, 'signups');
  await waitFor(() => doc1.getElementById('myGrid').textContent.includes('Вы пока никуда не записались'));
  console.log('PASS: "Мои записи" is empty before she has signed up for anything as a participant');

  // ---- 2. seed more server state directly (same pattern as run-test.js: raw fetch against
  // the mock server, then load a fresh page to observe it) ----
  // 2a. a scheduled/unpublished draft, also organized by Даша -- should show up under "Мои
  // анонсы" (that's the whole point of the dashboard: see your own drafts in one place),
  // even though it's invisible on the public calendar.
  const ceDraft = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'createEvent', publishNow: false, date: '2027-09-01', time: '20:00', city: 'Москва', organizer: 'Даша Тестовая', organizerEmail: 'dasha@beeline.ru', game: 'Черновик Даши' })
  }).then(r => r.json());
  if (!ceDraft.ok) throw new Error('setup: failed to create the draft event');

  // 2b. an event organized by someone else, that Даша then signs up for as a participant --
  // exercises "Мои записи" with an event she did NOT organize.
  const ceOther = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'createEvent', date: '2027-09-05', time: '19:00', city: 'Онлайн', organizer: 'Жора', organizerEmail: 'zhora@beeline.ru', game: 'Чужая игра', maxParticipants: 4 })
  }).then(r => r.json());
  if (!ceOther.ok) throw new Error('setup: failed to create the third-party event');
  const suOther = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'signup', date: '2027-09-05', time: '19:00', game: 'Чужая игра', name: 'Даша Тестовая', email: 'dasha@beeline.ru', guests: 0 })
  }).then(r => r.json());
  if (!suOther.ok) throw new Error('setup: failed to sign Даша up for the third-party event');

  // ---- 3. fresh page load, identity restored from localStorage (same shared key as every
  // other page) rather than re-driving the modal -- same pattern run-test.js uses for a
  // "returning, already-identified visitor" ----
  const dom2 = freshDom(html);
  dom2.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Даша Тестовая', email: 'dasha@beeline.ru' }));
  dom2.window.eval(myJs);
  const doc2 = dom2.window.document;

  await waitFor(() => cardGames(doc2).length === 3);
  const announced2 = cardGames(doc2).sort();
  if (announced2.join(',') !== ['Брасс Бирмингем', 'Таверна Красный дракон', 'Черновик Даши'].sort().join(',')) {
    throw new Error('"Мои анонсы" should now include the draft too, got: ' + announced2);
  }
  const draftCard = findCard(doc2, 'Черновик Даши');
  if (draftCard.querySelector('.badge').textContent !== 'Запланировано') {
    throw new Error('the draft card should carry the "Запланировано" badge');
  }
  const publishBtn = Array.from(draftCard.querySelectorAll('button')).find(b => b.textContent === 'Опубликовать');
  if (!publishBtn) throw new Error('the draft card should offer an "Опубликовать" button, right from the dashboard');
  console.log('PASS: "Мои анонсы" also surfaces an unpublished draft, with a working "Опубликовать" button ->', announced2);

  clickView(doc2, 'signups');
  await waitFor(() => cardGames(doc2).length === 1);
  if (cardGames(doc2)[0] !== 'Чужая игра') throw new Error('"Мои записи" should show the third-party event she joined, got: ' + cardGames(doc2));
  const otherCard = findCard(doc2, 'Чужая игра');
  const cancelBtn = Array.from(otherCard.querySelectorAll('button')).find(b => b.textContent === 'Отменить запись');
  if (!cancelBtn) throw new Error('a game she is signed up for should offer "Отменить запись"');
  console.log('PASS: "Мои записи" shows the one event she joined as a participant (not one she organizes)');

  cancelBtn.click();
  await waitFor(() => doc2.getElementById('myGrid').textContent.includes('Вы пока никуда не записались'));
  console.log('PASS: cancelling from the "Мои игры" dashboard works and clears "Мои записи" again');

  clickView(doc2, 'announcements');
  await waitFor(() => cardGames(doc2).length === 3);
  // the draft also carries the organizer-only reserved-seats stepper (same as any event of
  // theirs, published or not) -- find the publish button by its label, not just "the first
  // button in the card", so this doesn't accidentally click the stepper instead
  var publishBtnInCard = Array.from(findCard(doc2, 'Черновик Даши').querySelectorAll('button')).find(function (b) { return b.textContent === 'Опубликовать'; });
  if (!publishBtnInCard) throw new Error('draft card should have an "Опубликовать" button');
  publishBtnInCard.click();
  await waitFor(() => findCard(doc2, 'Черновик Даши').querySelector('.badge').textContent !== 'Запланировано');
  console.log('PASS: publishing a draft from the dashboard flips its badge, still listed under "Мои анонсы"');

  console.log('\nALL "МОИ ИГРЫ" TESTS PASSED');
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
