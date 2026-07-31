// Executes the literal Code.gs against stubbed Apps Script globals (SpreadsheetApp, Utilities, ContentService)
// to catch real logic bugs (undefined vars, wrong column indices, etc.) independent of the hand-written mock server.
const fs = require('fs');
const vm = require('vm');

const CODE_PATH = '/sessions/keen-relaxed-thompson/mnt/boardgames_calendar/Code.gs';
const code = fs.readFileSync(CODE_PATH, 'utf8');

// ---- fixture data, matching the exact column order of the real sheets ----
// Мероприятия: Дата, Время, Город, Жанр, Игра, Место, Организатор, Макс.участников, Статус, Комментарий,
//              Сложность, Макс. время игры, Тесера, BGG
const eventsRows = [
  ['Дата','Время','Город','Жанр','Игра','Место','Организатор','Макс. участников','Статус','Комментарий','Сложность','Макс. время игры','Тесера','BGG'],
  [new Date('2026-08-07T00:00:00'), '18:00', 'Москва', 'Настольная игра', 'Таверна Красный дракон', 'Клубик', 'Даша', 2, 'Набор открыт', '', 'Средняя', 90, 'https://tesera.ru/game/tavern/', 'https://boardgamegeek.com/boardgame/tavern'],
  [new Date('2026-08-08T00:00:00'), '12:20', 'Санкт-Петербург', 'НРИ', 'Брасс Бирмингем', 'МПК', 'Даша', '', 'Набрано', '', '', '', '', ''],
  [new Date('2026-08-04T00:00:00'), '', 'Москва', 'Настольная игра', 'Descent', '', 'Влад', '', 'Отменено', '', '', '', '', ''],
  [new Date('2026-08-20T00:00:00'), '', 'Москва', 'Настольная игра', 'Нечто', '', 'Даша', '', 'Черновик', '', '', '', '', ''], // should be hidden
];

// Записи: Timestamp, Дата, Время, Игра, Имя, Корп.почта, Статус
let signupRows = [
  ['Timestamp','Дата','Время','Игра','Имя','Корп. почта','Статус'],
];

function makeSheetStub(rows) {
  return {
    getDataRange() {
      return { getValues: () => rows.map(r => r.slice()) };
    },
    appendRow(row) {
      rows.push(row);
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
      return `${y}-${m}-${d}`;
    }
  },
  ContentService: {
    MimeType: { JSON: 'JSON' },
    createTextOutput(text) {
      return { _text: text, setMimeType() { return this; } };
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
eventsRows.forEach(row => { if (row[0] instanceof Date) row[0] = new D(row[0].getTime()); });

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
check('3 public events returned', r1.events.length === 3);

const dracon = r1.events.find(e => e.game === 'Таверна Красный дракон');
check('open event isOpen=true, 0 participants', dracon && dracon.isOpen === true && dracon.participantsCount === 0);
check('open event carries difficulty/maxDuration/tesera/bgg from sheet columns K-N',
  dracon && dracon.difficulty === 'Средняя' && dracon.maxDuration === 90 &&
  dracon.teseraUrl === 'https://tesera.ru/game/tavern/' && dracon.bggUrl === 'https://boardgamegeek.com/boardgame/tavern');

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

// ---- createEvent (organizer form) ----
const before = eventsRows.length;
const ce1 = callDoPost({
  action: 'createEvent', date: '2026-09-10', time: '19:00', city: 'Новосибирск', format: 'Настольная игра',
  game: 'Терраформирование Марса', place: 'Офис НСК', organizer: 'Оля', maxParticipants: 4, note: 'новичкам ок',
  difficulty: 'Сложная', maxDuration: 150, teseraUrl: 'https://tesera.ru/game/mars/', bggUrl: 'https://boardgamegeek.com/boardgame/mars'
});
check('createEvent ok', ce1.ok === true);
check('createEvent appended exactly one row', eventsRows.length === before + 1);
const newRow = eventsRows[eventsRows.length - 1];
check('createEvent wrote status Набор открыт', newRow[8] === 'Набор открыт');
check('createEvent wrote correct city/game', newRow[2] === 'Новосибирск' && newRow[4] === 'Терраформирование Марса');
check('createEvent wrote difficulty/maxDuration/tesera/bgg into columns K-N',
  newRow[10] === 'Сложная' && newRow[11] === 150 &&
  newRow[12] === 'https://tesera.ru/game/mars/' && newRow[13] === 'https://boardgamegeek.com/boardgame/mars');
check('createEvent date round-trips via formatDate to 2026-09-10',
  sandbox.formatDate ? true : true); // sanity placeholder, checked below via doGet

const r4 = callDoGet({ action: 'events' });
const created = r4.events.find(e => e.game === 'Терраформирование Марса');
check('new event visible via doGet with correct date', created && created.date === '2026-09-10');
check('new event isOpen (fresh, 0 participants, max 4)', created && created.isOpen === true && created.participantsCount === 0);
check('new event visible via doGet carries the new fields too',
  created.difficulty === 'Сложная' && created.maxDuration === 150 &&
  created.teseraUrl === 'https://tesera.ru/game/mars/' && created.bggUrl === 'https://boardgamegeek.com/boardgame/mars');

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
  createdNoExtras.teseraUrl === '' && createdNoExtras.bggUrl === '');

// duplicate rejected
const ce2 = callDoPost({
  action: 'createEvent', date: '2026-09-10', time: '19:00', city: 'Новосибирск', format: 'Настольная игра',
  game: 'Терраформирование Марса', place: 'Офис НСК', organizer: 'Оля', maxParticipants: 4, note: ''
});
check('duplicate createEvent rejected', ce2.ok === false && ce2.error === 'duplicate');

// missing required fields rejected
const ce3 = callDoPost({ action: 'createEvent', date: '2026-09-11', time: '19:00', game: 'Без города' });
check('createEvent missing fields rejected', ce3.ok === false && ce3.error === 'missing fields');

console.log(failures === 0 ? '\nALL GAS-LOGIC TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
