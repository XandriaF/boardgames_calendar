// Executes the literal Code.gs against stubbed Apps Script globals (SpreadsheetApp, Utilities, ContentService)
// to catch real logic bugs (undefined vars, wrong column indices, etc.) independent of the hand-written mock server.
const fs = require('fs');
const vm = require('vm');

const CODE_PATH = '/sessions/keen-relaxed-thompson/mnt/boardgames_calendar/Code.gs';
const code = fs.readFileSync(CODE_PATH, 'utf8');

// ---- fixture data, matching the exact column order of the real sheets ----
// Мероприятия: Дата, Время, Город, Жанр, Игра, Место, Организатор, Макс.участников, Статус, Комментарий,
//              Сложность, Макс. время игры, Тесера, BGG, Сеттинг, Картинка, Email организатора, Закрытое,
//              Занято организатором, Тип
const eventsRows = [
  ['Дата','Время','Город','Жанр','Игра','Место','Организатор','Макс. участников','Статус','Комментарий','Сложность','Макс. время игры','Тесера','BGG','Сеттинг','Картинка','Email организатора','Закрытое','Занято организатором','Тип','Игры события'],
  [new Date('2026-08-07T00:00:00'), '18:00', 'Москва', 'Стратегия, Евро', 'Таверна Красный дракон', 'Клубик', 'Даша', 2, 'Набор открыт', '', 'Средняя', 90, 'https://tesera.ru/game/tavern/', 'https://boardgamegeek.com/boardgame/tavern', 'фэнтези, таверна', 'https://example.com/tavern.jpg', 'dasha@beeline.ru', false, 0, 'Игра', ''],
  [new Date('2026-08-08T00:00:00'), '12:20', 'Санкт-Петербург', 'НРИ', 'Брасс Бирмингем', 'МПК', 'Даша', '', 'Набрано', '', '', '', '', '', '', '', 'dasha@beeline.ru', false, 0, 'Игра', ''],
  [new Date('2026-08-04T00:00:00'), '', 'Москва', 'Стратегия', 'Descent', '', 'Влад', '', 'Отменено', '', '', '', '', '', '', '', 'vlad@beeline.ru', false, 0, 'Игра', ''],
  [new Date('2026-08-20T00:00:00'), '', 'Москва', 'Стратегия', 'Нечто', '', 'Даша', '', 'Черновик', '', '', '', '', '', '', '', 'dasha@beeline.ru', false, 0, 'Игра', ''], // should be hidden
  // simulates Google Sheets auto-converting a plain "14:59" string into a Time serial --
  // Apps Script reads that back as a Date anchored to the classic 1899-12-30 time-only epoch
  [new Date('2026-09-20T00:00:00'), new Date(1899, 11, 30, 14, 59, 43), 'Москва', 'Евро', 'Тест Время-Баг', 'ШК', 'Даша', 4, 'Набор открыт', '', '', '', '', '', '', '', 'dasha@beeline.ru', false, 0, 'Игра', ''],
  // scheduled/unpublished -- only visible to its creator (olya@beeline.ru) or an ambassador,
  // not in the general public list
  [new Date('2026-10-01T00:00:00'), '19:00', 'Москва', 'Абстрактная', 'Секретный проект', '', 'Оля', '', 'Запланировано', '', '', '', '', '', '', '', 'olya@beeline.ru', false, 0, 'Игра', ''],
  // closed/private: publicly-statused but hidden from the general grid -- visible only to
  // its organizer, ambassadors, or its (creation-time) participants
  [new Date('2026-10-10T00:00:00'), '19:00', 'Москва', 'Кооперативная', 'Приватная встреча', '', 'Настя', '', 'Набор открыт', '', '', '', '', '', '', '', 'nastya2@beeline.ru', true, 0, 'Игра', ''],
  // has 2 seats already manually reserved (organizer marked them via +/-, no name/email)
  [new Date('2026-10-15T00:00:00'), '18:00', 'Москва', 'Пати', 'Мафия', '', 'Витя', 5, 'Набор открыт', '', '', '', '', '', '', '', 'vitya3@beeline.ru', false, 2, 'Игра', ''],
  // «Событие» -- просто отметка (описание/где/когда/город), без записи; колонка Т = "Событие",
  // колонка U несёт 2 прикреплённые игры (хвостом, как если бы вписали руками в таблицу)
  [new Date('2026-10-25T00:00:00'), '19:00', 'Москва', '', 'Пятничные посиделки клуба', 'Клубик', 'Даша', '', 'Набор открыт', '', '', '', '', '', '', '', 'dasha@beeline.ru', false, 0, 'Событие',
    'Каркассон||Семейная||Средняя||45||||||https://boardgamegeek.com/boardgame/822||\nМанчкин||||||||||||||'],
];

// Записи: Timestamp, Дата, Время, Игра, Имя, Корп.почта, Статус, Гости
let signupRows = [
  ['Timestamp','Дата','Время','Игра','Имя','Корп. почта','Статус','Гости'],
  // pre-added participant of the closed fixture event, as if the organizer had listed them
  // at creation time (bypassing handleSignup entirely, same as handleCreateEvent does)
  [new Date(), '2026-10-10', '19:00', 'Приватная встреча', 'Костя', 'kostya@beeline.ru', 'Записан', 0],
];

// Аккаунты: Email, Имя, PIN, Роль, Дата регистрации -- роль ставится ТОЛЬКО вручную сюда,
// никогда через doGet/doPost
let accountRows = [
  ['Email', 'Имя', 'PIN', 'Роль', 'Дата регистрации'],
];

// Заявки: Игра, Офис, Ссылка на BGG -- пополняется ТОЛЬКО вручную, сайт только читает
let requestRows = [
  ['Игра', 'Офис', 'Ссылка на BGG'],
  ['Каркассон', 'Москва, Санкт-Петербург', 'https://boardgamegeek.com/boardgame/822/carcassonne'],
  ['Манчкин', '', ''],
];

// Заявки_голоса: Timestamp, Игра, Имя, Email, Статус ("Голос"/"Отмена") -- событийный лог,
// побеждает последний статус на пару (игра,email), как и «Записи»
let voteRows = [
  ['Timestamp', 'Игра', 'Имя', 'Email', 'Статус'],
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
        setValue(v) { rows[r - 1][c - 1] = v; return this; },
        getValue() { return rows[r - 1][c - 1]; }
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
          if (name === 'Аккаунты') return makeSheetStub(accountRows);
          if (name === 'Заявки') return makeSheetStub(requestRows);
          if (name === 'Заявки_голоса') return makeSheetStub(voteRows);
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
check('closed event (Приватная встреча) hidden from anonymous public list', !r1.events.some(e => e.game === 'Приватная встреча'));
check('6 public events returned', r1.events.length === 6);

const dracon0 = r1.events.find(e => e.game === 'Таверна Красный дракон');
check('regular event defaults to type="game"', dracon0 && dracon0.type === 'game');

const fridayMeetup = r1.events.find(e => e.game === 'Пятничные посиделки клуба');
check('«событие» fixture read from column T as type="event"', fridayMeetup && fridayMeetup.type === 'event');
check('«событие» still carries где/когда/город like a normal event', fridayMeetup && fridayMeetup.place === 'Клубик' && fridayMeetup.city === 'Москва');
check('«событие» games list parsed from column U (2 games)', fridayMeetup && fridayMeetup.games.length === 2);
check('first attached game carries name/жанр/сложность/время/bgg parsed from the || format',
  fridayMeetup && fridayMeetup.games[0].game === 'Каркассон' && fridayMeetup.games[0].format === 'Семейная' &&
  fridayMeetup.games[0].difficulty === 'Средняя' && fridayMeetup.games[0].maxDuration === 45 &&
  fridayMeetup.games[0].bggUrl === 'https://boardgamegeek.com/boardgame/822');
check('second attached game with only a name parses cleanly, empty optional fields',
  fridayMeetup && fridayMeetup.games[1].game === 'Манчкин' && fridayMeetup.games[1].format === '' &&
  fridayMeetup.games[1].maxDuration === null);

const draconNoGames = r1.events.find(e => e.game === 'Таверна Красный дракон');
check('a regular "Игра" event has an empty games list', draconNoGames && Array.isArray(draconNoGames.games) && draconNoGames.games.length === 0);

const mafia = r1.events.find(e => e.game === 'Мафия');
check('event with 2 manually-reserved seats (no name/email) reflects that in participantsCount',
  mafia && mafia.reservedCount === 2 && mafia.participantsCount === 2 && mafia.participants.length === 0);
check('reserved-only seats do not make the event full below its max', mafia && mafia.isFull === false && mafia.isOpen === true);

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
check('after cancel: isOpen=true again, count=1, only Игрок2 listed', dracon3.isOpen === true && dracon3.participantsCount === 1 && dracon3.participants[0].name === 'Игрок2');
check('event carries organizerEmail for the hover tooltip', dracon3.organizerEmail === 'dasha@beeline.ru');

// the cancellation log row itself (client only sends email, not name) must still carry
// the person's name in the «Записи» sheet, not leave it blank
const cancelLogRow = signupRows[signupRows.length - 1];
check('cancellation row in «Записи» keeps the person\'s name instead of leaving it blank',
  cancelLogRow[4] === 'Игрок1' && cancelLogRow[6] === 'Отменено');

// guests (+1/+2): only 1 seat remains (Игрок2 registered, max 2) -- a +1 guest request
// needs 2 seats and must be rejected, but a plain (0-guest) signup should fill exactly to 2/2
const sGuestTooMany = callDoPost({ action: 'signup', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Игрок3', email: 'p3@beeline.ru', guests: 1 });
check('signup with +1 guest rejected when only 1 seat remains', sGuestTooMany.ok === false && sGuestTooMany.error === 'full');
const sGuestFits = callDoPost({ action: 'signup', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Игрок3', email: 'p3@beeline.ru', guests: 0 });
check('signup without guests fills the last seat, count=2', sGuestFits.ok === true && sGuestFits.participantsCount === 2);
const cGuestUndo = callDoPost({ action: 'cancel', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', email: 'p3@beeline.ru' });
check('cleanup cancel ok', cGuestUndo.ok === true);

// ---- "проявить интерес" -- for people this exact slot doesn't suit, but who'd like to
// play the game some other time. Only p2 remains actively signed up at this point (count=1).
const i1 = callDoPost({ action: 'interest', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Интересующийся', email: 'interested@beeline.ru' });
check('interest ok', i1.ok === true);
const rInterest = callDoGet({ action: 'events' });
const draconInterest = rInterest.events.find(e => e.game === 'Таверна Красный дракон');
check('interestCount reflects the new interest row', draconInterest.interestCount === 1);
check('expressing interest does not affect participantsCount/isFull', draconInterest.participantsCount === 1 && draconInterest.isFull === false);

const i2 = callDoPost({ action: 'interest', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Ещё Один', email: 'interested2@beeline.ru' });
check('second interest ok', i2.ok === true);
const rInterest2 = callDoGet({ action: 'events' });
check('interestCount increments for a second person', rInterest2.events.find(e => e.game === 'Таверна Красный дракон').interestCount === 2);

// expressing interest for someone who is already actively registered (p2) must not overwrite
// their active signup with an "Интересуюсь" row -- getAllSignupStates collapses to the latest
// row per (event, email), so that would otherwise silently un-register them
const iAlreadyRegistered = callDoPost({ action: 'interest', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', name: 'Игрок2', email: 'p2@beeline.ru' });
check('interest from an already-registered participant is a no-op', iAlreadyRegistered.ok === true);
const rAfterNoopInterest = callDoGet({ action: 'events', email: 'p2@beeline.ru' });
check('already-registered participant stays registered after a no-op interest call',
  rAfterNoopInterest.registeredIds.includes('2026-08-07|18:00|Таверна Красный дракон'));

const iMissing = callDoPost({ action: 'interest', date: '2026-08-07', time: '18:00', game: 'Таверна Красный дракон', email: 'noname@beeline.ru' });
check('interest missing name rejected', iMissing.ok === false && iMissing.error === 'missing fields');

const iClosed = callDoPost({ action: 'interest', date: '2026-10-10', time: '19:00', game: 'Приватная встреча', name: 'Любопытный', email: 'curious@beeline.ru' });
check('interest on a closed event rejected', iClosed.ok === false && iClosed.error === 'closed');

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
const bugParticipantLabels = bugEv.participants.map(p => p.name + (p.guests ? ' +' + p.guests : ''));
check('event with a guest signup shows correct headcount, isFull, and "Имя +N" in participants',
  bugEv.participantsCount === 4 && bugEv.isFull === true &&
  bugParticipantLabels.includes('ИгрокБаг') && bugParticipantLabels.includes('ИгрокБаг2 +2'));
check('participants carry email for the hover tooltip', bugEv.participants.find(p => p.name === 'ИгрокБаг').email === 'bug@beeline.ru');

// ---- createEvent (organizer form) ----
const before = eventsRows.length;
const ce1 = callDoPost({
  action: 'createEvent', date: '2026-09-10', time: '19:00', city: 'Новосибирск', format: 'Стратегия, Экономика',
  game: 'Терраформирование Марса', place: 'Офис НСК', organizer: 'Оля', organizerEmail: 'olya@beeline.ru', maxParticipants: 4, note: 'новичкам ок',
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
check('createEvent wrote organizerEmail into column Q', newRow[16] === 'olya@beeline.ru');
check('createEvent defaults isClosed to false in column R', newRow[17] === false);
check('createEvent defaults reservedCount to 0 in column S', newRow[18] === 0);
check('createEvent without eventType defaults to "Игра" in column T', newRow[19] === 'Игра');
check('createEvent for type "Игра" leaves column U (Игры события) empty', newRow[20] === '');

// ---- «Тип»: анонс события (eventType:'event') -- описание/где/когда/город only, no
// signup concept; «закрытое» is forced off even if the client somehow still sent it.
// Also carries an optional list of attached board games (same fields as a normal
// game announcement), including the BGG-cover-autofetch behaviour per attached game.
const ceEvent = callDoPost({
  action: 'createEvent', date: '2026-09-18', time: '20:00', city: 'Москва', format: '',
  game: 'Субботник в офисе', place: 'Опен-спейс', organizer: 'Оля', organizerEmail: 'olya@beeline.ru',
  eventType: 'event', isClosed: true, closedParticipants: [{ name: 'Кто-то', email: 'someone@beeline.ru' }],
  games: [
    { game: 'Игра с BGG', bggUrl: 'https://boardgamegeek.com/boardgame/999/some-game-name', format: 'Евро', difficulty: 'Средняя' },
    { game: 'Игра с картинкой', bggUrl: 'https://boardgamegeek.com/boardgame/999/some-game-name', imageUrl: 'https://example.com/manual2.jpg' },
    { game: '   ' } // no real name -- must be dropped, not stored as a blank line
  ]
});
check('createEvent with eventType:"event" ok', ceEvent.ok === true);
const eventRow = eventsRows[eventsRows.length - 1];
check('createEvent wrote "Событие" into column T', eventRow[19] === 'Событие');
check('createEvent forces isClosed=false in column R for a «событие», even if the client sent isClosed:true', eventRow[17] === false);
check('createEvent serialized exactly 2 games into column U (blank-name entry dropped)', eventRow[20].split('\n').length === 2);

const rEventType = callDoGet({ action: 'events' });
const createdEventType = rEventType.events.find(e => e.game === 'Субботник в офисе');
check('newly created «событие» visible via doGet with type="event"', createdEventType && createdEventType.type === 'event');
check('«событие» with isClosed forced off is publicly visible (not hidden like a closed event)', !!createdEventType);
check('attached games round-trip through doGet (2 games, blank one dropped)', createdEventType && createdEventType.games.length === 2);
check('attached game with only a bggUrl auto-fetched its cover image',
  createdEventType && createdEventType.games[0].game === 'Игра с BGG' && createdEventType.games[0].imageUrl === 'https://cf.geekdo-images.com/mock/999.jpg');
check('attached game with a manual imageUrl keeps it (not overwritten by BGG auto-fetch)',
  createdEventType && createdEventType.games[1].imageUrl === 'https://example.com/manual2.jpg');

// a "закрытое" participant list is meaningless once isClosed was forced to false for an
// событие -- confirm no signup row was created for it either
const rEventTypeParticipant = callDoGet({ action: 'events', email: 'someone@beeline.ru' });
check('a closedParticipants entry is not auto-registered for a forced-open «событие»',
  !rEventTypeParticipant.registeredIds.includes(createdEventType && createdEventType.id));

// createEvent for a plain "Игра" must ignore any "games" payload entirely -- the main
// game is already the form's own fields, attaching a sub-list only makes sense for «событие»
const ceGameIgnoresGames = callDoPost({
  action: 'createEvent', date: '2026-09-19', time: '18:00', city: 'Москва', format: '',
  game: 'Обычная игра с лишним games', place: '', organizer: 'Оля', organizerEmail: 'olya@beeline.ru',
  games: [{ game: 'Должно быть проигнорировано' }]
});
check('createEvent for type "Игра" ignores a stray games payload', ceGameIgnoresGames.ok === true);
const ignoredGamesRow = eventsRows[eventsRows.length - 1];
check('column U stays empty for "Игра" even if games[] was sent', ignoredGamesRow[20] === '');

// ---- BGG cover auto-fetch ----
// no imageUrl given, but bggUrl points to a game the stubbed BGG API "knows" (id=999) --
// Code.gs should fetch and use that cover image
const ceBgg = callDoPost({
  action: 'createEvent', date: '2026-09-13', time: '18:00', city: 'Москва', format: 'Евро',
  game: 'Игра с BGG', place: '', organizer: 'Оля', organizerEmail: 'olya@beeline.ru', maxParticipants: null, note: '',
  bggUrl: 'https://boardgamegeek.com/boardgame/999/some-game-name'
});
check('createEvent with only a bggUrl still ok', ceBgg.ok === true);
const rowBgg = eventsRows[eventsRows.length - 1];
check('createEvent auto-fetched the BGG cover image into column P',
  rowBgg[15] === 'https://cf.geekdo-images.com/mock/999.jpg');

// a manually-provided imageUrl must win over the BGG auto-fetch, not get overwritten
const ceBggManual = callDoPost({
  action: 'createEvent', date: '2026-09-14', time: '18:00', city: 'Москва', format: 'Евро',
  game: 'Игра с картинкой и BGG', place: '', organizer: 'Оля', organizerEmail: 'olya@beeline.ru', maxParticipants: null, note: '',
  bggUrl: 'https://boardgamegeek.com/boardgame/999/some-game-name', imageUrl: 'https://example.com/manual.jpg'
});
check('createEvent with both imageUrl and bggUrl keeps the manual image', ceBggManual.ok === true);
const rowBggManual = eventsRows[eventsRows.length - 1];
check('manual imageUrl is not overwritten by the BGG auto-fetch', rowBggManual[15] === 'https://example.com/manual.jpg');

// bggUrl pointing at a game the stubbed API does NOT know (404) -- must not crash, just no image
const ceBggMiss = callDoPost({
  action: 'createEvent', date: '2026-09-15', time: '18:00', city: 'Москва', format: 'Евро',
  game: 'Игра без обложки на BGG', place: '', organizer: 'Оля', organizerEmail: 'olya@beeline.ru', maxParticipants: null, note: '',
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
  action: 'createEvent', date: '2026-09-12', time: '20:00', city: 'Казань', format: 'Семейная',
  game: 'Каркассон', place: '', organizer: 'Витя', organizerEmail: 'vitya@beeline.ru', maxParticipants: null, note: ''
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
  action: 'createEvent', date: '2026-09-10', time: '19:00', city: 'Новосибирск', format: 'Стратегия',
  game: 'Терраформирование Марса', place: 'Офис НСК', organizer: 'Оля', organizerEmail: 'olya@beeline.ru', maxParticipants: 4, note: ''
});
check('duplicate createEvent rejected', ce2.ok === false && ce2.error === 'duplicate');

// missing required fields rejected
const ce3 = callDoPost({ action: 'createEvent', date: '2026-09-11', time: '19:00', game: 'Без города' });
check('createEvent missing fields rejected', ce3.ok === false && ce3.error === 'missing fields');

// createEvent without an organizerEmail is rejected too -- needed for the "who can publish
// a scheduled event / see the hover tooltip" features to make sense
const ceNoOrgEmail = callDoPost({
  action: 'createEvent', date: '2026-09-16', time: '19:00', city: 'Москва', format: '',
  game: 'Без почты организатора', place: '', organizer: 'Кто-то', maxParticipants: null, note: ''
});
check('createEvent without organizerEmail rejected', ceNoOrgEmail.ok === false && ceNoOrgEmail.error === 'missing fields');

// ---- заглавные буквы: имена/города/игры нормализуются при записи ----
const ceLower = callDoPost({
  action: 'createEvent', date: '2026-09-17', time: '18:00', city: 'казань', format: '',
  game: 'манчкин', place: '', organizer: 'витя нижний', organizerEmail: 'vitya2@beeline.ru', maxParticipants: null, note: ''
});
check('createEvent capitalizes city/game/organizer written in lowercase', ceLower.ok === true);
const rLower = callDoGet({ action: 'events' });
const lowerEv = rLower.events.find(e => e.game === 'Манчкин');
check('city/game/organizer come back capitalized', lowerEv && lowerEv.city === 'Казань' && lowerEv.organizer === 'Витя нижний');

const sLowerName = callDoPost({ action: 'signup', date: '2026-09-17', time: '18:00', game: 'Манчкин', name: 'игрок снизу', email: 'lower@beeline.ru' });
check('signup capitalizes a lowercase name', sLowerName.ok === true);
const rLowerName = callDoGet({ action: 'events' });
const lowerNameEv = rLowerName.events.find(e => e.game === 'Манчкин');
check('participant name comes back capitalized', lowerNameEv.participants[0].name === 'Игрок снизу');

// «Жанр» holds several comma-separated values, same pattern as «Сеттинг»
const draconAgain = rLower.events.find(e => e.game === 'Таверна Красный дракон');
check('multi-value «Жанр» round-trips as a comma-separated string', draconAgain.format === 'Стратегия, Евро');

// ---- «Аккаунты»: identify (email + 4-значный PIN) ----
const id1 = callDoPost({ action: 'identify', name: 'Игрок Один', email: 'newacc@beeline.ru', pin: '1234' });
check('identify: brand-new email creates the account', id1.ok === true && id1.isNew === true);

const id2 = callDoPost({ action: 'identify', name: 'Игрок Один', email: 'newacc@beeline.ru', pin: '0000' });
check('identify: wrong PIN on a known email is rejected', id2.ok === false && id2.error === 'wrong_pin');

const id3 = callDoPost({ action: 'identify', name: 'Игрок Один', email: 'newacc@beeline.ru', pin: '1234' });
check('identify: correct PIN on a known email succeeds', id3.ok === true && id3.isNew === false);

const id4 = callDoPost({ action: 'identify', name: 'Игрок Один', email: 'newacc@beeline.ru', pin: '12' });
check('identify: PIN must be exactly 4 digits', id4.ok === false && id4.error === 'invalid_pin');

const id5 = callDoPost({ action: 'identify', name: '', email: 'noname@beeline.ru', pin: '1234' });
check('identify: missing name rejected', id5.ok === false && id5.error === 'missing_fields');

const idRename = callDoPost({ action: 'identify', name: 'Новое Имя', email: 'newacc@beeline.ru', pin: '1234' });
check('identify with the correct PIN updates the stored display name', idRename.ok === true);
const renamedRow = accountRows.find(r => r[0] === 'newacc@beeline.ru');
check('account row name updated in «Аккаунты»', renamedRow && renamedRow[1] === 'Новое Имя');

// a PIN with a leading zero must round-trip exactly (stored as text, not a number)
const idZero = callDoPost({ action: 'identify', name: 'Ноль Ноль', email: 'zeropin@beeline.ru', pin: '0512' });
check('identify: PIN with a leading zero accepted', idZero.ok === true);
const zeroRow = accountRows.find(r => r[0] === 'zeropin@beeline.ru');
check('leading-zero PIN preserved as a 4-character string', zeroRow && String(zeroRow[2]) === '0512');
const idZeroCheck = callDoPost({ action: 'identify', name: 'Ноль Ноль', email: 'zeropin@beeline.ru', pin: '0512' });
check('leading-zero PIN can be used again to log back in', idZeroCheck.ok === true);

// ---- «Запланировано»: видно только создателю (по email) или амбассадору (роль в «Аккаунты») ----
const rNoAccess = callDoGet({ action: 'events' });
check('scheduled event hidden with no email', !rNoAccess.events.some(e => e.game === 'Секретный проект'));

const rWrongEmail = callDoGet({ action: 'events', email: 'someone-else@beeline.ru' });
check('scheduled event hidden from a different, non-ambassador email', !rWrongEmail.events.some(e => e.game === 'Секретный проект'));

const rCreatorEmail = callDoGet({ action: 'events', email: 'olya@beeline.ru' });
const secretEvForCreator = rCreatorEmail.events.find(e => e.game === 'Секретный проект');
check('scheduled event visible to its creator by email', secretEvForCreator && secretEvForCreator.status === 'Запланировано');

// роль «Амбассадор» ставится ТОЛЬКО вручную в самой таблице -- симулируем это, просто
// дописав строку в лист «Аккаунты» напрямую (ни один запрос с сайта так не может)
accountRows.push(['ambassador@beeline.ru', 'Амбассадор Тестов', '0000', 'Амбассадор', new Date()]);

const rAmbassador = callDoGet({ action: 'events', email: 'ambassador@beeline.ru' });
check('scheduled event visible to an account with the Амбассадор role', rAmbassador.events.some(e => e.game === 'Секретный проект'));
check('closed event also visible to an account with the Амбассадор role', rAmbassador.events.some(e => e.game === 'Приватная встреча'));

// a plain "Участник" role must NOT grant ambassador-level access
accountRows.push(['participant-role@beeline.ru', 'Обычный Участник', '1111', 'Участник', new Date()]);
const rParticipantRole = callDoGet({ action: 'events', email: 'participant-role@beeline.ru' });
check('an explicit "Участник" role does not reveal the scheduled event', !rParticipantRole.events.some(e => e.game === 'Секретный проект'));
check('an explicit "Участник" role does not reveal the closed event', !rParticipantRole.events.some(e => e.game === 'Приватная встреча'));

// публикация: не создатель и не амбассадор -- запрещено
const pForbidden = callDoPost({ action: 'publish', date: '2026-10-01', time: '19:00', game: 'Секретный проект', email: 'someone-else@beeline.ru' });
check('publish forbidden for a non-creator, non-ambassador', pForbidden.ok === false && pForbidden.error === 'forbidden');
const rStillScheduled = callDoGet({ action: 'events', email: 'olya@beeline.ru' });
check('event still Запланировано after a forbidden publish attempt',
  rStillScheduled.events.find(e => e.game === 'Секретный проект').status === 'Запланировано');

// публикация амбассадором -- разрешена, даже не будучи создателем
const pAmbassador = callDoPost({ action: 'publish', date: '2026-10-01', time: '19:00', game: 'Секретный проект', email: 'ambassador@beeline.ru' });
check('an ambassador can publish someone else\'s scheduled event', pAmbassador.ok === true);
const rPublished = callDoGet({ action: 'events' });
check('event is now publicly visible after being published', rPublished.events.some(e => e.game === 'Секретный проект' && e.status === 'Набор открыт'));

// публикация уже опубликованного события -- отклоняется
const pAlreadyPublished = callDoPost({ action: 'publish', date: '2026-10-01', time: '19:00', game: 'Секретный проект', email: 'ambassador@beeline.ru' });
check('publishing an already-published event is rejected', pAlreadyPublished.ok === false && pAlreadyPublished.error === 'not scheduled');

// ---- «Запланировать» через createEvent (publishNow:false), затем публикация создателем ----
const ceScheduled = callDoPost({
  action: 'createEvent', date: '2026-10-05', time: '20:00', city: 'Москва', format: 'Пати',
  game: 'Новая скрытая игра', place: '', organizer: 'Женя', organizerEmail: 'zhenya@beeline.ru',
  maxParticipants: null, note: '', publishNow: false
});
check('createEvent with publishNow:false ok, returns status Запланировано', ceScheduled.ok === true && ceScheduled.status === 'Запланировано');
const rHiddenScheduled = callDoGet({ action: 'events' });
check('freshly scheduled event not in the public list', !rHiddenScheduled.events.some(e => e.game === 'Новая скрытая игра'));
const rOwnScheduled = callDoGet({ action: 'events', email: 'zhenya@beeline.ru' });
check('freshly scheduled event visible to its own creator', rOwnScheduled.events.some(e => e.game === 'Новая скрытая игра'));

const pByCreator = callDoPost({ action: 'publish', date: '2026-10-05', time: '20:00', game: 'Новая скрытая игра', email: 'zhenya@beeline.ru' });
check('creator can publish their own scheduled event (no ambassador role needed)', pByCreator.ok === true);
const rNowPublic = callDoGet({ action: 'events' });
check('event is publicly visible after the creator publishes it', rNowPublic.events.some(e => e.game === 'Новая скрытая игра' && e.status === 'Набор открыт'));

// ---- «закрытое»: preset fixture visibility + createEvent with a creation-time participant list ----
const rClosedStranger = callDoGet({ action: 'events', email: 'stranger@beeline.ru' });
check('preset closed event hidden from an unrelated identified visitor', !rClosedStranger.events.some(e => e.game === 'Приватная встреча'));

const rClosedOrganizer = callDoGet({ action: 'events', email: 'nastya2@beeline.ru' });
const closedEvForOrganizer = rClosedOrganizer.events.find(e => e.game === 'Приватная встреча');
check('preset closed event visible to its organizer, isClosed=true', closedEvForOrganizer && closedEvForOrganizer.isClosed === true);

const rClosedParticipant = callDoGet({ action: 'events', email: 'kostya@beeline.ru' });
const closedEvForParticipant = rClosedParticipant.events.find(e => e.game === 'Приватная встреча');
check('preset closed event visible to its (creation-time) participant', !!closedEvForParticipant);
check('participant is bundled into registeredIds for the closed event', closedEvForParticipant && rClosedParticipant.registeredIds.includes(closedEvForParticipant.id));

// direct self-signup against a closed event must be rejected server-side, not just hidden in the UI
const sClosedDirect = callDoPost({ action: 'signup', date: '2026-10-10', time: '19:00', game: 'Приватная встреча', name: 'Незваный', email: 'uninvited@beeline.ru' });
check('direct signup against a closed event is rejected', sClosedDirect.ok === false && sClosedDirect.error === 'closed');

// createEvent with isClosed + closedParticipants: participants get auto-registered
const ceClosed = callDoPost({
  action: 'createEvent', date: '2026-11-01', time: '18:00', city: 'Москва', format: 'Карточная',
  game: 'Клуб по интересам', place: '', organizer: 'Настя', organizerEmail: 'nastya2@beeline.ru',
  maxParticipants: null, note: '', isClosed: true,
  closedParticipants: [{ name: 'Дима Волков', email: 'dima.volkov@beeline.ru' }, { email: 'noname.participant@beeline.ru' }]
});
check('createEvent with isClosed+closedParticipants ok', ceClosed.ok === true);
const closedRow = eventsRows[eventsRows.length - 1];
check('createEvent wrote isClosed=true into column R', closedRow[17] === true);

const rNewClosedAnon = callDoGet({ action: 'events' });
check('newly created closed event hidden from anonymous visitors', !rNewClosedAnon.events.some(e => e.game === 'Клуб по интересам'));

const rNewClosedParticipant = callDoGet({ action: 'events', email: 'dima.volkov@beeline.ru' });
const newClosedEvForParticipant = rNewClosedParticipant.events.find(e => e.game === 'Клуб по интересам');
check('a participant listed at creation time is auto-registered and can see the closed event', !!newClosedEvForParticipant);
check('participant name capitalized from the closedParticipants list', newClosedEvForParticipant && newClosedEvForParticipant.participants.some(p => p.name === 'Дима Волков'));

const rNewClosedNoName = callDoGet({ action: 'events', email: 'noname.participant@beeline.ru' });
const newClosedEvForNoNameParticipant = rNewClosedNoName.events.find(e => e.game === 'Клуб по интересам');
check('a participant listed with only an email still gets registered, name derived from the email', !!newClosedEvForNoNameParticipant);

// ---- adjustReserved: organizer marks seats as taken (+/-) without a name/email ----
const arForbidden = callDoPost({ action: 'adjustReserved', date: '2026-10-15', time: '18:00', game: 'Мафия', email: 'someone-else@beeline.ru', delta: 1 });
check('adjustReserved forbidden for a non-organizer, non-ambassador', arForbidden.ok === false && arForbidden.error === 'forbidden');

const arPlus = callDoPost({ action: 'adjustReserved', date: '2026-10-15', time: '18:00', game: 'Мафия', email: 'vitya3@beeline.ru', delta: 1 });
check('organizer can increment the reserved-seats counter', arPlus.ok === true && arPlus.reservedCount === 3);
const rAfterPlus = callDoGet({ action: 'events' });
check('reserved count reflected in doGet after +1', rAfterPlus.events.find(e => e.game === 'Мафия').reservedCount === 3);

const arMinus = callDoPost({ action: 'adjustReserved', date: '2026-10-15', time: '18:00', game: 'Мафия', email: 'vitya3@beeline.ru', delta: -1 });
check('organizer can decrement the reserved-seats counter', arMinus.ok === true && arMinus.reservedCount === 2);

// Мафия has maxParticipants=5 and reservedCount=2 (no named signups) -- 3 more should exactly
// fill it, a 4th should be rejected as full
const arFill = callDoPost({ action: 'adjustReserved', date: '2026-10-15', time: '18:00', game: 'Мафия', email: 'vitya3@beeline.ru', delta: 3 });
check('incrementing by more than 1 at once works and fills exactly to capacity', arFill.ok === true && arFill.reservedCount === 5);
const arOverfull = callDoPost({ action: 'adjustReserved', date: '2026-10-15', time: '18:00', game: 'Мафия', email: 'vitya3@beeline.ru', delta: 1 });
check('incrementing past maxParticipants is rejected', arOverfull.ok === false && arOverfull.error === 'full');
const rMafiaFull = callDoGet({ action: 'events' });
const mafiaFull = rMafiaFull.events.find(e => e.game === 'Мафия');
check('event is now full purely from reserved seats, with no named participants', mafiaFull.isFull === true && mafiaFull.participants.length === 0);

// decrementing floors at 0, never goes negative
const arDrain = callDoPost({ action: 'adjustReserved', date: '2026-10-15', time: '18:00', game: 'Мафия', email: 'vitya3@beeline.ru', delta: -10 });
check('decrementing far past 0 floors at 0 instead of going negative', arDrain.ok === true && arDrain.reservedCount === 0);

// an ambassador can adjust someone else's event too, same as publish
const arAmbassador = callDoPost({ action: 'adjustReserved', date: '2026-10-15', time: '18:00', game: 'Мафия', email: 'ambassador@beeline.ru', delta: 1 });
check('an ambassador can also adjust the reserved-seats counter on someone else\'s event', arAmbassador.ok === true && arAmbassador.reservedCount === 1);

// reserved seats count alongside named signups toward the same capacity
const sMafia = callDoPost({ action: 'signup', date: '2026-10-15', time: '18:00', game: 'Мафия', name: 'Реальный Игрок', email: 'realplayer@beeline.ru' });
check('named signup succeeds alongside an existing reserved seat', sMafia.ok === true);
const rMafiaMixed = callDoGet({ action: 'events' });
const mafiaMixed = rMafiaMixed.events.find(e => e.game === 'Мафия');
check('participantsCount combines named signups and manually-reserved seats', mafiaMixed.reservedCount === 1 && mafiaMixed.participantsCount === 2 && mafiaMixed.participants.length === 1);

const arMissingFields = callDoPost({ action: 'adjustReserved', date: '2026-10-15', time: '18:00', game: 'Мафия', email: 'vitya3@beeline.ru', delta: 0 });
check('adjustReserved with delta=0 rejected as a no-op/missing field', arMissingFields.ok === false);

const arEventNotFound = callDoPost({ action: 'adjustReserved', date: '2099-01-01', time: '18:00', game: 'Не существует', email: 'vitya3@beeline.ru', delta: 1 });
check('adjustReserved against a non-existent event rejected', arEventNotFound.ok === false && arEventNotFound.error === 'event not found');

// ---- «Приём заявок»: каталог (лист «Заявки», только ручное пополнение) + голоса ----
// 1 плюсик на игру на человека, но игр можно поддержать сколько угодно
const rq1 = callDoGet({ action: 'requests' });
check('doGet requests ok', rq1.ok === true);
check('2 catalog games returned', rq1.requests.length === 2);
check('anonymous viewer has iVoted=false everywhere, votes start at 0',
  rq1.requests.every(r => r.iVoted === false && r.votes === 0));
check('catalog carries office/bggUrl straight from the sheet',
  rq1.requests.find(r => r.game === 'Каркассон').office === 'Москва, Санкт-Петербург' &&
  rq1.requests.find(r => r.game === 'Каркассон').bggUrl === 'https://boardgamegeek.com/boardgame/822/carcassonne');

const v1 = callDoPost({ action: 'vote', game: 'Каркассон', email: 'voter1@beeline.ru', name: 'Голосующий Один' });
check('first vote for Каркассон ok, count=1', v1.ok === true && v1.votes === 1 && v1.iVoted === true);

const v1Again = callDoPost({ action: 'vote', game: 'Каркассон', email: 'voter1@beeline.ru', name: 'Голосующий Один' });
check('voting again for the same game just re-affirms (still 1 active voter, not double-counted)', v1Again.ok === true && v1Again.votes === 1);

const v2 = callDoPost({ action: 'vote', game: 'Каркассон', email: 'voter2@beeline.ru', name: 'Голосующий Два' });
check('a second, different person can also vote for the same game, count=2', v2.ok === true && v2.votes === 2);

// same person voting for a DIFFERENT game too -- unlimited games per person, each with its own vote
const v1Other = callDoPost({ action: 'vote', game: 'Манчкин', email: 'voter1@beeline.ru', name: 'Голосующий Один' });
check('the same person can also vote for a different game (no cross-game exclusivity)', v1Other.ok === true && v1Other.votes === 1);

const rq2 = callDoGet({ action: 'requests', email: 'voter1@beeline.ru' });
const carcForVoter1 = rq2.requests.find(r => r.game === 'Каркассон');
const munchkinForVoter1 = rq2.requests.find(r => r.game === 'Манчкин');
check('voter1 sees iVoted=true for both games they voted for', carcForVoter1.iVoted === true && munchkinForVoter1.iVoted === true);
check('requests list sorted by votes desc (Каркассон with 2 first)', rq2.requests[0].game === 'Каркассон');

const rq3 = callDoGet({ action: 'requests', email: 'voter2@beeline.ru' });
check('a different viewer only sees their own vote as iVoted (not Манчкин, which they never voted for)',
  rq3.requests.find(r => r.game === 'Каркассон').iVoted === true && rq3.requests.find(r => r.game === 'Манчкин').iVoted === false);

const unv1 = callDoPost({ action: 'unvote', game: 'Каркассон', email: 'voter1@beeline.ru', name: 'Голосующий Один' });
check('unvote removes the vote, count back to 1', unv1.ok === true && unv1.votes === 1 && unv1.iVoted === false);

const rq4 = callDoGet({ action: 'requests', email: 'voter1@beeline.ru' });
check('after unvote, iVoted=false for voter1 on Каркассон', rq4.requests.find(r => r.game === 'Каркассон').iVoted === false);
check('vote count reflects only the still-active voter (voter2)', rq4.requests.find(r => r.game === 'Каркассон').votes === 1);

const voteMissingFields = callDoPost({ action: 'vote', game: '', email: 'voter1@beeline.ru' });
check('vote with no game rejected', voteMissingFields.ok === false && voteMissingFields.error === 'missing fields');

const voteUnknownGame = callDoPost({ action: 'vote', game: 'Игра, которой нет в каталоге', email: 'voter1@beeline.ru' });
check('voting for a game not in the «Заявки» catalog is rejected', voteUnknownGame.ok === false && voteUnknownGame.error === 'not found');

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
  action: 'createEvent', date: '2026-08-07', time: '18:00', city: 'Москва', format: 'Стратегия',
  game: 'Таверна Красный дракон', place: 'Клубик', organizer: 'Даша', organizerEmail: 'dasha@beeline.ru', maxParticipants: 2, note: ''
});
check('re-announcing the same date/time/game after the old row was deleted is allowed (no false duplicate)', ceAfterDelete.ok === true);

console.log(failures === 0 ? '\nALL GAS-LOGIC TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
