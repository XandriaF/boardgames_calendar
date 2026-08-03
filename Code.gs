/**
 * Настолки Билайн — backend на Google Apps Script.
 * Работает поверх листов «Мероприятия» и «Записи» в этой таблице.
 *
 * Установка (см. подробно SETUP.md):
 * 1. Открой Google-таблицу → Расширения → Apps Script.
 * 2. Удали код-заглушку, вставь целиком этот файл.
 * 3. Деплой → Новый деплой → тип «Веб-приложение».
 *    Execute as: Me. Who has access: Anyone (в организации, если хотите ограничить).
 * 4. Скопируй URL веб-приложения — он нужен в config.js на сайте.
 */

var SHEET_EVENTS = 'Мероприятия';
var SHEET_SIGNUPS = 'Записи';
var SHEET_CALENDAR = 'Календарь';
var SHEET_ACCOUNTS = 'Аккаунты';
var TIMEZONE = 'Europe/Moscow';

// Статусы, которые вообще показываются на публичном сайте
var PUBLIC_STATUSES = ['Набор открыт', 'Набрано', 'Отменено'];

// «Запланировано» -- организатор сохранил игру, но не опубликовал: по умолчанию видна
// только ему самому (по email) или амбассадорам (роль в листе «Аккаунты»)
var SCHEDULED_STATUS = 'Запланировано';

// роль «Амбассадор» в листе «Аккаунты» открывает видимость ВСЕХ запланированных и всех
// закрытых мероприятий -- ставится ТОЛЬКО руками в таблице, с сайта недоступно и нигде не
// отображается
var ROLE_AMBASSADOR = 'Амбассадор';

// Тот же цветовой код, что был в исходном ручном календаре организаторов
var STATUS_COLORS = {
  'Набор открыт': '#FFFF00',
  'Набрано': '#00FF00',
  'Отменено': '#FF0000',
  'Непубличное': '#4A86E8',
  'Черновик': '#00FFFF',
  'Запланировано': '#FFA500'
};
var CALENDAR_DAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
var CALENDAR_WEEKS_AHEAD = 16; // сколько недель вперёд рисовать в «Календаре»

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'events';
    if (action === 'events') {
      // read the Записи sheet once and reuse it for both the events list and (if an
      // email was passed) the caller's registered ids -- avoids a second round trip
      // and a second full sheet read that the client used to need via action=myStatus
      var signups = getAllSignupStates();
      var email = normalizeEmail((e.parameter && e.parameter.email) || '');
      var hasAmbassadorAccess = email ? isAmbassadorEmail(email) : false;
      var result = { ok: true, events: getPublicEvents(signups, email, hasAmbassadorAccess) };
      if (email) result.registeredIds = getMyRegistrations(email, signups);
      return jsonOutput(result);
    }
    if (action === 'myStatus') {
      // kept for backwards compatibility (e.g. an old cached copy of app.js); the
      // current app.js gets registeredIds bundled into action=events instead
      var email2 = normalizeEmail(e.parameter.email || '');
      if (!email2) return jsonOutput({ ok: false, error: 'email required' });
      return jsonOutput({ ok: true, registered: getMyRegistrations(email2) });
    }
    return jsonOutput({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;

    if (action === 'signup') {
      return jsonOutput(handleSignup(body));
    }
    if (action === 'cancel') {
      return jsonOutput(handleCancel(body));
    }
    if (action === 'interest') {
      return jsonOutput(handleInterest(body));
    }
    if (action === 'publish') {
      return jsonOutput(handlePublish(body));
    }
    if (action === 'createEvent') {
      return jsonOutput(handleCreateEvent(body));
    }
    if (action === 'identify') {
      return jsonOutput(handleIdentify(body));
    }
    return jsonOutput({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

// ---------- events ----------

// viewerEmail/hasAmbassadorAccess control visibility of not-fully-public events:
// - «Запланировано» (scheduled/unpublished) events are hidden from everyone except their
//   creator (organizerEmail matches viewerEmail) or an ambassador.
// - «Закрытое» (closed) events are hidden from the general public grid too -- visible only
//   to the organizer, an ambassador, or someone who was actually added as a participant
//   (their email appears among the event's active signups).
// Regular open PUBLIC_STATUSES events (not closed) are always included for everyone.
function getPublicEvents(signups, viewerEmail, hasAmbassadorAccess) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var values = sheet.getDataRange().getValues();
  signups = signups || getAllSignupStates(); // { eventKey: [{name,email,status,guests}] }
  viewerEmail = normalizeEmail(viewerEmail || '');
  var events = [];

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var date = row[0];
    var time = formatTimeVal(row[1]);
    var city = row[2];
    var format = row[3]; // колонка называется «Жанр» в таблице, ключ в API остался format
    var game = row[4];
    var place = row[5];
    var organizer = row[6];
    var maxParticipants = row[7];
    var status = row[8];
    var note = row[9];
    var difficulty = row[10];
    var maxDuration = row[11];
    var teseraUrl = row[12];
    var bggUrl = row[13];
    var setting = row[14];
    var imageUrl = row[15];
    var organizerEmail = normalizeEmail(row[16] || '');
    var isClosed = isClosedVal(row[17]);

    if (!date || !game) continue;

    var dateStr = formatDate(date);
    var key = eventKey(dateStr, time, game);
    var active = (signups[key] || []).filter(function (p) { return p.status === 'Записан'; });

    var isPublicStatus = PUBLIC_STATUSES.indexOf(status) !== -1;
    var isScheduled = status === SCHEDULED_STATUS;
    var isOrganizerOrAmbassador = (viewerEmail && organizerEmail && viewerEmail === organizerEmail) || hasAmbassadorAccess;
    var isParticipant = !!viewerEmail && active.some(function (p) { return p.email === viewerEmail; });

    var visible;
    if (isScheduled) {
      visible = isOrganizerOrAmbassador;
    } else if (isPublicStatus && isClosed) {
      visible = isOrganizerOrAmbassador || isParticipant;
    } else if (isPublicStatus) {
      visible = true;
    } else {
      visible = false;
    }
    if (!visible) continue;

    var participantsCount = headcountOf(active); // считает и гостей (+1/+2/...), не только строки записи
    var isFull = maxParticipants ? participantsCount >= Number(maxParticipants) : false;
    var isOpen = status === 'Набор открыт' && !isFull && !isClosed;
    var interested = (signups[key] || []).filter(function (p) { return p.status === 'Интересуюсь'; });

    events.push({
      id: key,
      date: dateStr,
      time: time || '',
      city: capitalizeFirst(city),
      format: format || '',
      game: capitalizeFirst(game),
      place: place || '',
      organizer: capitalizeFirst(organizer),
      organizerEmail: organizerEmail || '',
      maxParticipants: maxParticipants ? Number(maxParticipants) : null,
      status: status,
      isClosed: isClosed,
      note: note || '',
      difficulty: difficulty || '',
      maxDuration: maxDuration ? Number(maxDuration) : null,
      teseraUrl: teseraUrl || '',
      bggUrl: bggUrl || '',
      setting: setting || '',
      imageUrl: imageUrl || '',
      participantsCount: participantsCount,
      // structured, not pre-joined into a string, so the client can show each participant's
      // corporate email as a hover tooltip next to their (capitalized) name
      participants: active.map(function (p) { return { name: capitalizeFirst(p.name), email: p.email, guests: p.guests || 0 }; }),
      isOpen: isOpen,
      isFull: isFull,
      interestCount: interested.length
    });
  }

  events.sort(function (a, b) {
    return (a.date + a.time).localeCompare(b.date + b.time);
  });
  return events;
}

// ---------- signups ----------

// участник может привести с собой гостей (+1/+2/...) -- каждый гость занимает
// отдельное место, поэтому "занято мест" считается по headcount (человек + гости),
// а не по числу строк записи
function headcountOf(active) {
  return active.reduce(function (sum, p) { return sum + 1 + (p.guests || 0); }, 0);
}

function handleSignup(body) {
  var date = body.date, time = body.time, game = body.game;
  var name = capitalizeFirst(body.name || '');
  var email = normalizeEmail(body.email || '');
  var guests = Math.max(0, Math.min(10, Math.floor(Number(body.guests) || 0)));

  if (!date || !game || !name || !email) {
    return { ok: false, error: 'missing fields' };
  }

  var eventInfo = findEvent(date, time, game);
  if (!eventInfo) return { ok: false, error: 'event not found' };
  if (eventInfo.status === 'Отменено') return { ok: false, error: 'event cancelled' };
  // «закрытое» мероприятие -- самостоятельная запись на сайте недоступна, участников
  // вносит только организатор (списком при создании)
  if (eventInfo.isClosed) return { ok: false, error: 'closed' };

  var signups = getAllSignupStates();
  var key = eventKey(date, time, game);
  var active = (signups[key] || []).filter(function (p) { return p.status === 'Записан'; });
  var headcount = headcountOf(active);
  var requested = 1 + guests;

  if (eventInfo.maxParticipants && headcount + requested > Number(eventInfo.maxParticipants)) {
    return { ok: false, error: 'full' };
  }

  appendSignupRow(date, time, game, name, email, 'Записан', guests);
  return { ok: true, participantsCount: headcount + requested };
}

function handleCancel(body) {
  var date = body.date, time = body.time, game = body.game;
  var email = normalizeEmail(body.email || '');
  if (!date || !game || !email) return { ok: false, error: 'missing fields' };

  var key = eventKey(date, time, game);
  // клиент присылает только email -- достаём имя из их последней записи на эту игру,
  // чтобы строка отмены в листе «Записи» не оставалась с пустым именем
  var before = getAllSignupStates();
  var mine = (before[key] || []).filter(function (p) { return p.email === email; })[0];
  var name = mine ? mine.name : '';

  appendSignupRow(date, time, game, name, email, 'Отменено', 0);
  var signups = getAllSignupStates();
  var active = (signups[key] || []).filter(function (p) { return p.status === 'Записан'; });
  return { ok: true, participantsCount: headcountOf(active) };
}

// «проявить интерес» -- для тех, кому конкретная дата/время/место не подходят, но кто
// хотел бы сыграть в эту игру в другой раз. Пишется той же строкой в «Записи», просто с
// отдельным статусом «Интересуюсь»; не занимает место и не требует открытой записи --
// сигнал видит организатор (participantsCount/isFull это не затрагивает).
function handleInterest(body) {
  var date = body.date, time = body.time, game = body.game;
  var name = capitalizeFirst(body.name || '');
  var email = normalizeEmail(body.email || '');
  if (!date || !game || !name || !email) return { ok: false, error: 'missing fields' };

  var eventInfo = findEvent(date, time, game);
  if (eventInfo && eventInfo.isClosed) return { ok: false, error: 'closed' };

  var key = eventKey(date, time, game);
  var signups = getAllSignupStates();
  var mine = (signups[key] || []).filter(function (p) { return p.email === email; })[0];
  // если человек уже реально записан на этот слот, «интерес» тут ни при чём -- не даём
  // случайно затереть активную запись строкой «Интересуюсь» (тот же email+ключ = latest
  // wins в getAllSignupStates)
  if (mine && mine.status === 'Записан') return { ok: true };

  appendSignupRow(date, time, game, name, email, 'Интересуюсь', 0);
  return { ok: true };
}

// ---------- organizer: create event ----------

function handleCreateEvent(body) {
  var date = body.date;
  var time = (body.time || '').trim();
  var city = capitalizeFirst((body.city || '').trim());
  var format = (body.format || '').trim(); // «Жанр» в таблице/на сайте -- CSV нескольких значений
  var game = capitalizeFirst((body.game || '').trim());
  var place = (body.place || '').trim();
  var organizer = capitalizeFirst((body.organizer || '').trim());
  var organizerEmail = normalizeEmail(body.organizerEmail || '');
  var maxParticipants = body.maxParticipants;
  var note = (body.note || '').trim();
  var difficulty = (body.difficulty || '').trim();
  var maxDuration = body.maxDuration;
  var setting = (body.setting || '').trim();
  var imageUrl = (body.imageUrl || '').trim();
  var teseraUrl = (body.teseraUrl || '').trim();
  var bggUrl = (body.bggUrl || '').trim();
  // publishNow defaults to true (backward compatible) -- explicit false means "Запланировать":
  // save privately, visible only to this organizer (and ambassadors) until they publish it
  var status = body.publishNow === false ? SCHEDULED_STATUS : 'Набор открыт';
  // «закрытое» мероприятие -- запись только через организатора: участники перечисляются
  // списком прямо при создании (ниже), самостоятельно записаться на сайте нельзя
  var isClosed = !!body.isClosed;

  if (!date || !game || !city || !organizer || !organizerEmail) {
    return { ok: false, error: 'missing fields' };
  }

  var existing = findEvent(date, time, game);
  if (existing) {
    return { ok: false, error: 'duplicate' };
  }

  // если картинку не указали руками, но дали ссылку на BGG -- пробуем сами достать обложку
  if (!imageUrl && bggUrl) {
    imageUrl = fetchBggImage(bggUrl);
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  sheet.appendRow([
    parseISODate(date),
    time,
    city,
    format,
    game,
    place,
    organizer,
    maxParticipants ? Number(maxParticipants) : '',
    status,
    note,
    difficulty,
    maxDuration ? Number(maxDuration) : '',
    teseraUrl,
    bggUrl,
    setting,
    imageUrl,
    organizerEmail,
    isClosed
  ]);
  // force the «Время» column to stay plain text -- otherwise Sheets can silently
  // auto-convert a value like "14:30" into a Time serial (see formatTimeVal above)
  sheet.getRange(sheet.getLastRow(), 2).setNumberFormat('@');

  // закрытое мероприятие: участников (по почте) добавляем сразу как обычные записи
  // (статус «Записан»), минуя проверки вместимости/дублей -- их вносит организатор
  if (isClosed && Array.isArray(body.closedParticipants)) {
    body.closedParticipants.forEach(function (p) {
      var pEmail = normalizeEmail((p && p.email) || '');
      if (!pEmail) return;
      var pName = capitalizeFirst((p && p.name) || pEmail.split('@')[0]);
      appendSignupRow(date, time, game, pName, pEmail, 'Записан', 0);
    });
  }

  return { ok: true, id: eventKey(date, time, game), status: status };
}

// организатор (по email) или амбассадор (роль в «Аккаунты») переводит своё
// запланированное мероприятие в «Набор открыт», делая его видимым всем
function handlePublish(body) {
  var date = body.date, time = body.time, game = body.game;
  if (!date || !game) return { ok: false, error: 'missing fields' };

  var email = normalizeEmail(body.email || '');
  var hasAmbassadorAccess = email ? isAmbassadorEmail(email) : false;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row[0] || !row[4]) continue;
    if (formatDate(row[0]) !== date || formatTimeVal(row[1]) !== String(time || '') || row[4] !== game) continue;

    var organizerEmail = normalizeEmail(row[16] || '');
    var isCreator = !!email && !!organizerEmail && email === organizerEmail;
    if (!isCreator && !hasAmbassadorAccess) return { ok: false, error: 'forbidden' };
    if (row[8] !== SCHEDULED_STATUS) return { ok: false, error: 'not scheduled' };

    sheet.getRange(r + 1, 9).setValue('Набор открыт'); // столбец I = Статус
    return { ok: true };
  }
  return { ok: false, error: 'event not found' };
}

// пытается достать обложку игры с BoardGameGeek по ссылке через официальный XML API2 --
// сделано именно на стороне Apps Script (а не в браузере), потому что у API BGG нет
// CORS-заголовков и прямой запрос из браузера был бы заблокирован. Любая проблема (плохая
// ссылка, BGG недоступен, неожиданный ответ) просто оставляет картинку пустой -- не должна
// мешать созданию самого мероприятия.
function fetchBggImage(bggUrl) {
  try {
    var match = String(bggUrl).match(/\/boardgame\/(\d+)/) || String(bggUrl).match(/[?&]id=(\d+)/);
    if (!match) return '';
    var id = match[1];
    var resp = UrlFetchApp.fetch('https://boardgamegeek.com/xmlapi2/thing?id=' + id, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return '';
    var item = XmlService.parse(resp.getContentText()).getRootElement().getChild('item');
    if (!item) return '';
    var imageEl = item.getChild('image');
    return imageEl ? imageEl.getText().trim() : '';
  } catch (err) {
    return '';
  }
}

function getMyRegistrations(email, signups) {
  signups = signups || getAllSignupStates();
  var result = [];
  Object.keys(signups).forEach(function (key) {
    var rows = signups[key];
    var mine = rows.filter(function (p) { return p.email === email; });
    if (!mine.length) return;
    var last = mine[mine.length - 1];
    if (last.status === 'Записан') result.push(key);
  });
  return result;
}

// ---------- helpers ----------

function findEvent(date, time, game) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row[0] || !row[4]) continue;
    if (formatDate(row[0]) === date && formatTimeVal(row[1]) === String(time || '') && row[4] === game) {
      return {
        maxParticipants: row[7] ? Number(row[7]) : null,
        status: row[8],
        isClosed: isClosedVal(row[17])
      };
    }
  }
  return null;
}

// returns { "date|time|game": [ {name, email, status, guests}, ... in chronological order ] }
function getAllSignupStates() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SIGNUPS);
  var values = sheet.getDataRange().getValues();
  var map = {};
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var date = row[1], time = formatTimeVal(row[2]), game = row[3], name = row[4], email = row[5], status = row[6];
    var guests = row[7]; // «Гости» -- сколько человек участник приводит с собой (+1/+2/...)
    if (!date || !game || !email) continue;
    var dateStr = date instanceof Date ? formatDate(date) : String(date);
    var key = eventKey(dateStr, time, game);
    if (!map[key]) map[key] = [];
    map[key].push({ name: name, email: normalizeEmail(email), status: status, guests: Number(guests) || 0 });
  }
  // collapse to latest status per email, keep name/guests from latest entry
  var collapsed = {};
  Object.keys(map).forEach(function (key) {
    var byEmail = {};
    map[key].forEach(function (entry) {
      byEmail[entry.email] = entry; // last write wins (rows are in sheet order = chronological)
    });
    collapsed[key] = Object.keys(byEmail).map(function (email) { return byEmail[email]; });
  });
  return collapsed;
}

function appendSignupRow(date, time, game, name, email, status, guests) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SIGNUPS);
  sheet.appendRow([new Date(), date, time, game, name, email, status, guests || 0]);
  // same auto-time-conversion guard as the Мероприятия sheet's «Время» column
  sheet.getRange(sheet.getLastRow(), 3).setNumberFormat('@');
}

function eventKey(dateStr, time, game) {
  return dateStr + '|' + (time || '') + '|' + game;
}

// Google Sheets sometimes auto-detects a plain "14:30" string written into the «Время»
// column as a Time value and silently converts the cell to a time serial number, which
// getDataRange().getValues() then returns as a Date object anchored to 1899-12-30 (the
// classic time-only epoch) instead of the original string. This defensively reformats
// any such Date back into a clean "HH:mm" string wherever a time value is read.
function formatTimeVal(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, TIMEZONE, 'HH:mm');
  }
  return String(val || '').trim();
}

function formatDate(dateVal) {
  if (dateVal instanceof Date) {
    return Utilities.formatDate(dateVal, TIMEZONE, 'yyyy-MM-dd');
  }
  return String(dateVal);
}

// parses 'yyyy-MM-dd' into a Date built from local components, so the calendar
// date written to the sheet can never drift a day depending on execution timezone
function parseISODate(s) {
  var parts = String(s).split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// приводит первую букву к заглавной, остальное не трогает -- имена/города/игры вида
// "иван иванов" или "москва" на сайте должны выглядеть как "Иван иванов"/"Москва"
function capitalizeFirst(s) {
  s = String(s || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// checkbox-колонка «Закрытое» обычно приходит настоящим boolean из getValues(), но
// принимаем и текстовые варианты на случай, если кто-то впишет значение руками
function isClosedVal(v) {
  if (v === true) return true;
  return /^(true|да|yes|1)$/i.test(String(v || '').trim());
}

// ---------- аккаунты (лист «Аккаунты»): email + 4-значный код + роль ----------
//
// Роль ("Участник"/"Амбассадор") можно поставить ТОЛЬКО вручную в самой таблице -- ни один
// запрос с сайта не может её выставить или прочитать напрямую. Единственное, что сайт
// умеет -- это спросить "какая роль у email X", чтобы решить, показывать ли этому
// человеку все запланированные/закрытые мероприятия.

function findAccountRow(sheet, email) {
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (normalizeEmail(values[r][0] || '') === email) return r + 1; // 1-based sheet row
  }
  return -1;
}

function getAccountRole(email) {
  email = normalizeEmail(email || '');
  if (!email) return '';
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ACCOUNTS);
  if (!sheet) return '';
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (normalizeEmail(values[r][0] || '') === email) return String(values[r][3] || '').trim();
  }
  return '';
}

function isAmbassadorEmail(email) {
  return getAccountRole(email) === ROLE_AMBASSADOR;
}

// первый вход с почты -- человек сам придумывает 4-значный код, он закрепляется за
// почтой. Повторный вход с той же почты (даже под другим именем) требует этот же код;
// если код не совпал, отправляем к амбассадору Дарье, чтобы сбросила вручную в таблице.
function handleIdentify(body) {
  var name = capitalizeFirst(String(body.name || '').trim());
  var email = normalizeEmail(body.email || '');
  var pin = String(body.pin || '').trim();

  if (!name || !email) return { ok: false, error: 'missing_fields' };
  if (!/^\d{4}$/.test(pin)) return { ok: false, error: 'invalid_pin' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ACCOUNTS);
  var rowIndex = findAccountRow(sheet, email);

  if (rowIndex === -1) {
    sheet.appendRow([email, name, pin, 'Участник', new Date()]);
    // PIN должен остаться текстом -- иначе код вида "0512" потеряет ведущий ноль
    sheet.getRange(sheet.getLastRow(), 3).setNumberFormat('@');
    return { ok: true, isNew: true };
  }

  var storedPin = String(sheet.getRange(rowIndex, 3).getValue() || '').trim();
  if (storedPin !== pin) return { ok: false, error: 'wrong_pin' };

  // код верный -- заодно обновим отображаемое имя, если оно поменялось
  var storedName = sheet.getRange(rowIndex, 2).getValue();
  if (storedName !== name) sheet.getRange(rowIndex, 2).setValue(name);

  return { ok: true, isNew: false };
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- organizer calendar view (лист «Календарь») ----------
//
// Восстанавливает визуальный понедельный календарь, как в исходном ручном файле:
// строка на неделю, колонка на день недели, цвет ячейки = статус мероприятия.
// В отличие от исходного файла, эта таблица не заполняется руками -- она собирается
// автоматически из листа «Мероприятия», поэтому не может разойтись с данными сайта.
// Пустой день остаётся без заливки, поэтому "дыры" в расписании видно с первого взгляда.
//
// Запускается автоматически при открытии таблицы (onOpen) и вручную через меню
// «Настолки → Обновить календарь» -- этому НЕ нужен повторный деплой веб-приложения,
// это отдельная функция, не связанная с публичным URL сайта.

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Настолки')
    .addItem('Обновить календарь', 'rebuildCalendar')
    .addToUi();
  try {
    rebuildCalendar();
  } catch (err) {
    // не должны мешать открытию таблицы, даже если построение календаря упало
  }
}

// todayOverride existe только для тестов (см. test/run-calendar-test.js) -- в реальной
// работе всегда вызывается без аргумента и берёт настоящую сегодняшнюю дату.
function rebuildCalendar(todayOverride) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_CALENDAR);
  if (!sheet) sheet = ss.insertSheet(SHEET_CALENDAR);
  sheet.clear();

  var eventsByDate = groupEventsByDate();

  var legendRow = 1;
  sheet.getRange(legendRow, 1).setValue('Легенда:').setFontWeight('bold');
  var legendCol = 2;
  var statusNames = Object.keys(STATUS_COLORS);
  for (var s = 0; s < statusNames.length; s++) {
    sheet.getRange(legendRow, legendCol).setValue(statusNames[s]).setBackground(STATUS_COLORS[statusNames[s]]);
    legendCol++;
  }

  var headerRow = 3;
  sheet.getRange(headerRow, 1).setValue('Неделя').setFontWeight('bold');
  for (var d = 0; d < 7; d++) {
    var headerCol = 2 + d * 2;
    sheet.getRange(headerRow, headerCol, 1, 2).merge()
      .setValue(CALENDAR_DAY_NAMES[d])
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  }
  sheet.setFrozenRows(headerRow);

  var mondays = getUpcomingMondays(CALENDAR_WEEKS_AHEAD, todayOverride);
  var row = headerRow + 1;
  for (var w = 0; w < mondays.length; w++) {
    var monday = mondays[w];
    sheet.getRange(row, 1).setValue(getIsoWeekNumber(monday));

    for (var day = 0; day < 7; day++) {
      var date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day);
      var dateCol = 2 + day * 2;
      var textCol = dateCol + 1;

      sheet.getRange(row, dateCol).setValue(date).setNumberFormat('dd.MM');

      var dateStr = formatDate(date);
      var dayEvents = eventsByDate[dateStr] || [];
      if (dayEvents.length) {
        var lines = [];
        for (var i = 0; i < dayEvents.length; i++) {
          lines.push(formatCalendarEventLine(dayEvents[i]));
        }
        var cell = sheet.getRange(row, textCol).setValue(lines.join('\n')).setWrap(true);
        var color = STATUS_COLORS[dayEvents[0].status];
        if (color) cell.setBackground(color);
      }
    }
    row++;
  }

  sheet.setColumnWidth(1, 70);
  for (var c = 0; c < 7; c++) {
    sheet.setColumnWidth(2 + c * 2, 60);
    sheet.setColumnWidth(3 + c * 2, 220);
  }
}

function formatCalendarEventLine(ev) {
  var parts = [];
  if (ev.time) parts.push(ev.time);
  parts.push(ev.game);
  if (ev.isClosed) parts.push('[закрытое]');
  if (ev.place) parts.push('(' + ev.place + ')');
  if (ev.organizer) parts.push('· ' + ev.organizer);
  return parts.join(' ');
}

// { "yyyy-MM-dd": [ {time, game, place, organizer, status}, ... ] } -- все статусы,
// это внутренний вид для организаторов, а не публичный список на сайте
function groupEventsByDate() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var values = sheet.getDataRange().getValues();
  var map = {};
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var date = row[0], time = formatTimeVal(row[1]), game = row[4], place = row[5], organizer = row[6], status = row[8];
    var isClosed = isClosedVal(row[17]);
    if (!date || !game) continue;
    var dateStr = formatDate(date);
    if (!map[dateStr]) map[dateStr] = [];
    map[dateStr].push({ time: time, game: game, place: place, organizer: organizer, status: status, isClosed: isClosed });
  }
  return map;
}

// понедельники, начиная с понедельника текущей недели, на numWeeks недель вперёд
function getUpcomingMondays(numWeeks, todayOverride) {
  var today = todayOverride || new Date();
  var day = today.getDay(); // 0=вс .. 6=сб
  var diffToMonday = (day === 0) ? -6 : (1 - day);
  var monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + diffToMonday);
  var mondays = [];
  for (var i = 0; i < numWeeks; i++) {
    mondays.push(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i * 7));
  }
  return mondays;
}

// стандартный алгоритм номера недели ISO-8601 (для подписи "Неделя" в календаре)
function getIsoWeekNumber(date) {
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
