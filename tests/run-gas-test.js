// Executes the literal Code.gs against stubbed Apps Script globals (SpreadsheetApp, Utilities, ContentService)
// to catch real logic bugs (undefined vars, wrong column indices, etc.) independent of the hand-written mock server.
const fs = require('fs');
const vm = require('vm');

const CODE_PATH = '/sessions/keen-relaxed-thompson/mnt/boardgames_calendar/Code.gs';
const code = fs.readFileSync(CODE_PATH, 'utf8');

// ---- fixture data, matching the exact column order of the real sheets ----
// Мероприятия: Дата, Время, Город, Жанр, Игра, Место, Организатор, Макс.участников, Статус, Комментарий,
//              Сложность, Макс. время игры, Тесера, BGG, Сеттинг, Картинка
const eventsRows = [
  ['Дата','Время','Город','Жанр','Игра','Место','Организатор','Макс. участников','Статус','Комментарий','Сложность','Макс. время игры','Тесера','BGG','Сеттинг','Картинка'],
  [new Date('2026-08-07T00:00:00'), '18:00', 'Москва', 'Настольная игра', 'Таверна Красный дракон', 'Клубик', 'Даша', 2, 'Набор открыт', '', 'Средняя', 90, 'https://tesera.ru/game/tavern/', 'https://boardgamegeek.com/boardgame/tavern', 'фэнтези, таверна', 'https://example.com/tavern.jpg'],
  [new Date('2026-08-08T00:00:00'), '12:20', 'Санкт-Петербург', 'НРИ', 'Брасс Бирмингем', 'МПК', 'Даша', '', 'Набрано', '', '', '', '', '', '', ''],
  [new Date('2026-08-04T00:00:00'), '', 'Москва', 'Настольная игра', 'Descent', '', 'Влад', '', 'Отменено', '', '', '', '', '', '', ''],
  [new Date('2026-08-20T00:00:00'), '', 'Москва', 'Настольная игра', 'Нечто', '', 'Даша', '', 'Черновик', '', '', '', '', '', '', ''], // should be hidden
  // simulates Google Sheets auto-converting a plain "14:59" string into a Time serial --
  // Apps Script reads that back as a Date anchored to the classic 1899-12-30 time-only epoch
  [new Date('2026-09-20T00:00:00'), new Date(1899, 11, 30, 14, 59, 43), 'Москва', 'Евро', 'Тест Время-Баг', 'ШК', 'Даша', 4, 'Набор открыт', '', '', '', '', '', '', ''],
];

// Записи: Timestamp, Дата, Время, Игра, Имя, Корп.почта, Статус, Гости
let signupRows = [
  ['Timestamp','Дата','Время','Игра','Имя','Корп. почта','Статус','Гости'],
];

function makeSheetStub(rows) {
  return {
    getDataRange() {
      return { getValues: () => rows.map(r => r.slice()) };
    },
    appendRow(row) {
      rows.push(row);
    },
    getLastRow() {
      return rows.length; // 1-indexed, matches Sheets (row 1 = header)
    },
    getRange(r, c) {
      return {
        setNumberFormat(fmt) { this._fmt = fmt; return this; },
        setValue(v) { rows[r - 1][c - 1] = v; return this; }
      };
    }
  };
}

const sandbox = {
  console,
  SpreadsheetApp: {
    getActiveSpreadsheet() {
      return {
        getSheetByName(name) {
          if (name === 'Мероприятия') return makeSheetStub(eventsRows);
          if (name === 'Записи') return makeSheetStub(signupRows);
          throw new Error('unknown sheet ' + name);
        }
      };
    }
  },
  Utilities: {
    formatDate(date, tz, fmt) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      if (fmt === 'HH:mm') {
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
      }
      return `${y}-${m}-${d}`;
    }
  },
  ContentService: {
    MimeType: { JSON: 'JSON' },
    createTextOutput(text) {
      return { _text: text, setMimeType() { return this; } };
    }
  },
  // stubbed BGG lookup: id=999 "succeeds" with a mock cover image, anything else 404s,
  // so fetchBggImage()'s error handling is exercised too
  UrlFetchApp: {
    fetch(url) {
      if (url.indexOf('id=999') !== -1) {
        return {
          getResponseCode: () => 200,
          getContentText: () => '<items><item id="999"><image>https://cf.geekdo-images.com/mock/999.jpg</image></item></items>'
        };
      }
      return { getResponseCode: () => 404, getContentText: () => '' };
    }
  },
  // minimal shim of just the XmlService methods fetchBggImage() actually calls
  // (getRootElement -> getChild('item') -> getChild('image') -> getText), backed by a
  // small regex instead of a real XML parser -- enough to exercise the real Code.gs logic
  XmlService: {
    parse(text) {
      return {
        getRootElement() {
          return {
            getChild(tag) {
              if (tag !== 'item') return null;
              const m = text.match(/<image>([^<]*)<\/image>/);
              return {
                getChild(t2) {
                  if (t2 !== 'image' || !m) return null;
                  return { getText: () => m[1] };
                }
              };
            }
          };
        }
      };
    }
  }
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'Code.gs' });

// IMPORTANT: Date objects must be created via the sandbox's own Date constructor.
// vm.createContext gives the sandbox its own realm, so a `new Date(...)` built in the
// outer Node process is NOT `instanceof` the sandbox's Date -- Code.gs's `dateVal instanceof Date`
// check would (falsely, only in this test) fail. In real Apps Script there is only one realm,
// so this is purely a test-harness concern, not a bug in Code.gs.
const D = vm.runInContext('Date', sandbox);
eventsRows.forEach(row => {
  if (row[0] instanceof Date) row[0] = new D(row[0].getTime());
  if (row[1] instanceof Date) row[1] = new D(row[1].getTime());
});

function callDoGet(params) {
  const out = sandbox.doGet({ parameter: params });
  return JSON.parse(out._text);
}
function callDoPost(payload) {
  const out = sandbox.doPost({ postData: { contents: JSON.stringify(payload) } });
  return JSON.parse(out._text);
}

// ---- run assertions ----
let failures = 0;
function check(label, cond) {
  if (cond) console.log('PASS:', label);
  else { console.log('FAIL:', label); failures++; }
}

const r1 = callDoGet({ action: 'events' });
check('doGet events ok', r1.ok === true);
check('draft (Черновик) hidden from public list', !r1.events.some(e => e.game === 'Нечто'));
check('4 public events returned', r1.events.length === 4);

const timeBug = r1.events.find(e => e.game === 'Тест Время-Баг');
check('a Время cell corrupted into a Date object (Sheets auto-conversion) is reformatted back to "HH:mm"',
  timeBug && timeBug.time === '14:59');

const dracon = r1.events.find(e => e.game === 'Таверна Красный дракон');
check('open event isOpen=true, 0 participants', dracon && dracon.isOpen === true && dracon.participantsCount === 0);
check('open event carries difficulty/maxDuration/tesera/bgg from sheet columns K-N',
  dracon && dracon.difficulty === 'Средняя' && dracon.maxDuration === 90 &&
  dracon.teseraUrl === 'https://tesera.ru/game/tavern/' && dracon.bggUrl === 'https://boardgamegeek.com/boardgame/tavern');
check('open event carries setting from sheet column O', dracon && dracon.setting === 'фэнтези, таверна');
check('open event carries imageUrl from sheet column P', dracon && dracon.imageUrl === 'https://example.com/tavern.jpg');

const brassEmptyFields = r1.events.find(e => e.game === 'Брасс Бирмингем');
check('event with blank K-N columns returns empty/null, not undefined or errors',
  brassEmptyFields.difficulty === '' && brassEmptyFields.maxDuration === null &&
  brassEmptyFields.teseraUrl === '' && brassEmptyFields.bggUrl === '');

const brass = r1.events.find(e => e.game === 'Брасс Бирмингем');
check('Набрано event isOpen=false (full by status)', brass && brass.isOpen === false);

const descent = r1.events.find(e => e.game === 'Descent');
check('cancelled event still listed with status Отменено', descent && descent.status === 'Отменено');

// signup flow against maxParticipants=2
const s1 = callDoPost({ action: 'signup', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Игрок1', email: 'p1@beeline.ru' });
check('signup 1 ok, count=1', s1.ok === true && s1.participantsCount === 1);
const s2 = callDoPost({ action: 'signup', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Игрок2', email: 'p2@beeline.ru' });
check('signup 2 ok, count=2 (hits max)', s2.ok === true && s2.participantsCount === 2);
const s3 = callDoPost({ action: 'signup', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Игрок3', email: 'p3@beeline.ru' });
check('signup 3 rejected: full', s3.ok === false && s3.error === 'full');

const r2 = callDoGet({ action: 'events' });
const dracon2 = r2.events.find(e => e.game === 'Таверна Красный дракон');
check('after 2 signups: isOpen=false, isFull=true, count=2', dracon2.isOpen === false && dracon2.isFull === true && dracon2.participantsCount === 2);

// cancel one, should reopen
const c1 = callDoPost({ action: 'cancel', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', email: 'p1@beeline.ru' });
check('cancel ok, count back to 1', c1.ok === true && c1.participantsCount === 1);
const r3 = callDoGet({ action: 'events' });
const dracon3 = r3.events.find(e => e.game === 'Таверна Красный дракон');
check('after cancel: isOpen=true again, count=1, only Игрок2 listed', dracon3.isOpen === true && dracon3.participantsCount === 1 && dracon3.participantNames[0] === 'Игрок2');

// guests (+1/+2): only 1 seat remains (Игрок2 registered, max 2) -- a +1 guest request
// needs 2 seats and must be rejected, but a plain (0-guest) signup should fill exactly to 2/2
const sGuestTooMany = callDoPost({ action: 'signup', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Игрок3', email: 'p3@beeline.ru', guests: 1 });
check('signup with +1 guest rejected when only 1 seat remains', sGuestTooMany.ok === false && sGuestTooMany.error === 'full');
const sGuestFits = callDoPost({ action: 'signup', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Игрок3', email: 'p3@beeline.ru', guests: 0 });
check('signup without guests fills the last seat, count=2', sGuestFits.ok === true && sGuestFits.participantsCount === 2);
const cGuestUndo = callDoPost({ action: 'cancel', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', email: 'p3@beeline.ru' });
check('cleanup cancel ok', cGuestUndo.ok === true);

// myStatus
const my2 = callDoGet({ action: 'myStatus', email: 'p2@beeline.ru' });
check('myStatus for p2 includes the dracon event', my2.ok && my2.registered.includes('2026-08-07|18:00|Таверна Красный дракон'));
const my1 = callDoGet({ action: 'myStatus', email: 'p1@beeline.ru' });
check('myStatus for p1 (cancelled) is empty', my1.ok && my1.registered.length === 0);

// action=events with an email should bundle registeredIds in the same response (no second
// call to myStatus / no second read of the Записи sheet needed on the client's initial load)
const r3b = callDoGet({ action: 'events', email: 'p2@beeline.ru' });
check('events+email returns registeredIds bundled, matching myStatus for the same user',
  r3b.ok && Array.isArray(r3b.registeredIds) && r3b.registeredIds.includes('2026-08-07|18:00|Таверна Красный дракон'));
const r3c = callDoGet({ action: 'events' });
check('events without email omits registeredIds entirely', r3c.ok && r3c.registeredIds === undefined);

// signup rejected on cancelled event
const s4 = callDoPost({ action: 'signup', date: '2026-08-04', time: '', game: 'Descent', name: 'X', email: 'x@beeline.ru' });
check('signup on cancelled event rejected', s4.ok === false && s4.error === 'event cancelled');

// signup against the event whose Время cell was corrupted into a Date object -- findEvent
// must still match it correctly against the clean "14:59" string a real client would send
const sBug = callDoPost({ action: 'signup', date: '2026-09-20', time: '14:59', game: 'Тест Время-Баг', name: 'ИгрокБаг', email: 'bug@beeline.ru' });
check('signup succeeds against an event whose Время cell was corrupted into a Date object', sBug.ok === true && sBug.participantsCount === 1);

// this event has maxParticipants=4; ИгрокБаг already used 1 seat, so ИгрокБаг2 bringing
// +2 guests (3 seats) should fit exactly (1 + 3 = 4)
const sBugGuest = callDoPost({ action: 'signup', date: '2026-09-20', time: '14:59', game: 'Тест Время-Баг', name: 'ИгрокБаг2', email: 'bug2@beeline.ru', guests: 2 });
check('signup with +2 guests succeeds, headcount reflects all 3 extra seats', sBugGuest.ok === true && sBugGuest.participantsCount === 4);
const rBugGuest = callDoGet({ action: 'events' });
const bugEv = rBugGuest.events.find(e => e.game === 'Тест Время-Баг');
check('event with a guest signup shows correct headcount, isFull, and "Имя +N" in participant names',
  bugEv.participantsCount === 4 && bugEv.isFull === true &&
  bugEv.participantNames.includes('ИгрокБаг') && bugEv.participantNames.includes('ИгрокБаг2 +2'));

// ---- createEvent (organizer form) ----
const before = eventsRows.length;
const ce1 = callDoPost({
  action: 'createEvent', date: '2026-09-10', time: '19:00', city: 'Новосибирск', format: 'Настольная игра',
  game: 'Терраформирование Марса', place: 'Офис НСК', organizer: 'Оля', maxParticipants: 4, note: 'новичкам ок',
  difficulty: 'Сложная', maxDuration: 150, teseraUrl: 'https://tesera.ru/game/mars/', bggUrl: 'https://boardgamegeek.com/boardgame/mars',
  setting: 'космос, экономика', imageUrl: 'https://example.com/mars.jpg'
});
check('createEvent ok', ce1.ok === true);
check('createEvent appended exactly one row', eventsRows.length === before + 1);
const newRow = eventsRows[eventsRows.length - 1];
check('createEvent wrote status Набор открыт', newRow[8] === 'Набор открыт');
check('createEvent wrote correct city/game', newRow[2] === 'Новосибирск' && newRow[4] === 'Терраформирование Марса');
check('createEvent wrote difficulty/maxDuration/tesera/bgg into columns K-N',
  newRow[10] === 'Сложная' && newRow[11] === 150 &&
  newRow[12] === 'https://tesera.ru/game/mars/' && newRow[13] === 'https://boardgamegeek.com/boardgame/mars');
check('createEvent wrote setting into column O', newRow[14] === 'космос, экономика');
check('createEvent wrote imageUrl into column P', newRow[15] === 'https://example.com/mars.jpg');
check('createEvent date round-trips via formatDate to 2026-09-10',
  sandbox.formatDate ? true : true); // sanity placeholder, checked below via doGet

// ---- BGG cover auto-fetch ----
// no imageUrl given, but bggUrl points to a game the stubbed BGG API "knows" (id=999) --
// Code.gs should fetch and use that cover image
const ceBgg = callDoPost({
  action: 'createEvent', date: '2026-09-13', time: '18:00', city: 'Москва', format: 'Евро',
  game: 'Игра с BGG', place: '', organizer: 'Оля', maxParticipants: null, note: '',
  bggUrl: 'https://boardgamegeek.com/boardgame/999/some-game-name'
});
check('createEvent with only a bggUrl still ok', ceBgg.ok === true);
const rowBgg = eventsRows[eventsRows.length - 1];
check('createEvent auto-fetched the BGG cover image into column P',
  rowBgg[15] === 'https://cf.geekdo-images.com/mock/999.jpg');

// a manually-provided imageUrl must win over the BGG auto-fetch, not get overwritten
const ceBggManual = callDoPost({
  action: 'createEvent', date: '2026-09-14', time: '18:00', city: 'Москва', format: 'Евро',
  game: 'Игра с картинкой и BGG', place: '', organizer: 'Оля', maxParticipants: null, note: '',
  bggUrl: 'https://boardgamegeek.com/boardgame/999/some-game-name', imageUrl: 'https://example.com/manual.jpg'
});
check('createEvent with both imageUrl and bggUrl keeps the manual image', ceBggManual.ok === true);
const rowBggManual = eventsRows[eventsRows.length - 1];
check('manual imageUrl is not overwritten by the BGG auto-fetch', rowBggManual[15] === 'https://example.com/manual.jpg');

// bggUrl pointing at a game the stubbed API does NOT know (404) -- must not crash, just no image
const ceBggMiss = callDoPost({
  action: 'createEvent', date: '2026-09-15', time: '18:00', city: 'Москва', format: 'Евро',
  game: 'Игра без обложки на BGG', place: '', organizer: 'Оля', maxParticipants: null, note: '',
  bggUrl: 'https://boardgamegeek.com/boardgame/111111/unknown-game'
});
check('createEvent with a BGG lookup miss still succeeds (best-effort, no crash)', ceBggMiss.ok === true);
const rowBggMiss = eventsRows[eventsRows.length - 1];
check('failed BGG lookup leaves imageUrl empty rather than crashing', rowBggMiss[15] === '');

const r4 = callDoGet({ action: 'events' });
const created = r4.events.find(e => e.game === 'Терраформирование Марса');
check('new event visible via doGet with correct date', created && created.date === '2026-09-10');
check('new event isOpen (fresh, 0 participants, max 4)', created && created.isOpen === true && created.participantsCount === 0);
check('new event visible via doGet carries the new fields too',
  created.difficulty === 'Сложная' && created.maxDuration === 150 &&
  created.teseraUrl === 'https://tesera.ru/game/mars/' && created.bggUrl === 'https://boardgamegeek.com/boardgame/mars' &&
  created.setting === 'космос, экономика' && created.imageUrl === 'https://example.com/mars.jpg');

// createEvent without any of the new optional fields -> should not throw, should return empty/null
const ce4 = callDoPost({
  action: 'createEvent', date: '2026-09-12', time: '20:00', city: 'Казань', format: 'Настольная игра',
  game: 'Каркассон', place: '', organizer: 'Витя', maxParticipants: null, note: ''
});
check('createEvent without optional fields still ok', ce4.ok === true);
const r5 = callDoGet({ action: 'events' });
const createdNoExtras = r5.events.find(e => e.game === 'Каркассон');
check('createEvent without optional fields yields empty/null, not undefined or crash',
  createdNoExtras.difficulty === '' && createdNoExtras.maxDuration === null &&
  createdNoExtras.teseraUrl === '' && createdNoExtras.bggUrl === '' && createdNoExtras.setting === '' &&
  createdNoExtras.imageUrl === '');

// duplicate rejected
const ce2 = callDoPost({
  action: 'createEvent', date: '2026-09-10', time: '19:00', city: 'Новосибирск', format: 'Настольная игра',
  game: 'Терраформирование Марса', place: 'Офис НСК', organizer: 'Оля', maxParticipants: 4, note: ''
});
check('duplicate createEvent rejected', ce2.ok === false && ce2.error === 'duplicate');

// missing required fields rejected
const ce3 = callDoPost({ action: 'createEvent', date: '2026-09-11', time: '19:00', game: 'Без города' });
check('createEvent missing fields rejected', ce3.ok === false && ce3.error === 'missing fields');

// ---- organizer deletes an event row directly in Google Sheets ----
// (do this last -- it removes "Таверна Красный дракон" from the fixture, which earlier
// assertions above still depend on being present)
const draconRowIndex = eventsRows.findIndex(row => row[4] === 'Таверна Красный дракон');
eventsRows.splice(draconRowIndex, 1); // simulates manually deleting the sheet row

const rAfterDelete = callDoGet({ action: 'events' });
check('deleted event no longer appears in doGet(events)', !rAfterDelete.events.some(e => e.game === 'Таверна Красный дракон'));

const sAfterDelete = callDoPost({ action: 'signup', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Кто-то', email: 'ghost@beeline.ru' });
check('signup against a deleted event is rejected ("event not found"), not a crash', sAfterDelete.ok === false && sAfterDelete.error === 'event not found');

const ceAfterDelete = callDoPost({
  action: 'createEvent', date: '2026-08-07', time: '18:00', city: 'Москва', format: 'Настольная игра',
  game: 'Таверна Красный дракон', place: 'Клубик', organizer: 'Даша', maxParticipants: 2, note: ''
});
check('re-announcing the same date/time/game after the old row was deleted is allowed (no false duplicate)', ceAfterDelete.ok === true);

console.log(failures === 0 ? '\nALL GAS-LOGIC TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
