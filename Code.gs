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
var TIMEZONE = 'Europe/Moscow';

// Статусы, которые вообще показываются на публичном сайте
var PUBLIC_STATUSES = ['Набор открыт', 'Набрано', 'Отменено'];

// Тот же цветовой код, что был в исходном ручном календаре организаторов
var STATUS_COLORS = {
  'Набор открыт': '#FFFF00',
  'Набрано': '#00FF00',
  'Отменено': '#FF0000',
  'Непубличное': '#4A86E8',
  'Черновик': '#00FFFF'
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
      var result = { ok: true, events: getPublicEvents(signups) };
      var email = normalizeEmail((e.parameter && e.parameter.email) || '');
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
    if (action === 'createEvent') {
      return jsonOutput(handleCreateEvent(body));
    }
    return jsonOutput({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

// ---------- events ----------

function getPublicEvents(signups) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var values = sheet.getDataRange().getValues();
  signups = signups || getAllSignupStates(); // { eventKey: [{name,email,status}] }
  var events = [];

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var date = row[0];
    var time = row[1];
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

    if (!date || !game) continue;
    if (PUBLIC_STATUSES.indexOf(status) === -1) continue;

    var dateStr = formatDate(date);
    var key = eventKey(dateStr, time, game);
    var active = (signups[key] || []).filter(function (p) { return p.status === 'Записан'; });
    var participantsCount = active.length;
    var isFull = maxParticipants ? participantsCount >= Number(maxParticipants) : false;
    var isOpen = status === 'Набор открыт' && !isFull;

    events.push({
      id: key,
      date: dateStr,
      time: time || '',
      city: city || '',
      format: format || '',
      game: game || '',
      place: place || '',
      organizer: organizer || '',
      maxParticipants: maxParticipants ? Number(maxParticipants) : null,
      status: status,
      note: note || '',
      difficulty: difficulty || '',
      maxDuration: maxDuration ? Number(maxDuration) : null,
      teseraUrl: teseraUrl || '',
      bggUrl: bggUrl || '',
      participantsCount: participantsCount,
      participantNames: active.map(function (p) { return p.name; }),
      isOpen: isOpen,
      isFull: isFull
    });
  }

  events.sort(function (a, b) {
    return (a.date + a.time).localeCompare(b.date + b.time);
  });
  return events;
}

// ---------- signups ----------

function handleSignup(body) {
  var date = body.date, time = body.time, game = body.game;
  var name = (body.name || '').trim();
  var email = normalizeEmail(body.email || '');

  if (!date || !game || !name || !email) {
    return { ok: false, error: 'missing fields' };
  }

  var eventInfo = findEvent(date, time, game);
  if (!eventInfo) return { ok: false, error: 'event not found' };
  if (eventInfo.status === 'Отменено') return { ok: false, error: 'event cancelled' };

  var signups = getAllSignupStates();
  var key = eventKey(date, time, game);
  var active = (signups[key] || []).filter(function (p) { return p.status === 'Записан'; });

  if (eventInfo.maxParticipants && active.length >= Number(eventInfo.maxParticipants)) {
    return { ok: false, error: 'full' };
  }

  appendSignupRow(date, time, game, name, email, 'Записан');
  return { ok: true, participantsCount: active.length + 1 };
}

function handleCancel(body) {
  var date = body.date, time = body.time, game = body.game;
  var email = normalizeEmail(body.email || '');
  if (!date || !game || !email) return { ok: false, error: 'missing fields' };

  appendSignupRow(date, time, game, '', email, 'Отменено');
  var signups = getAllSignupStates();
  var key = eventKey(date, time, game);
  var active = (signups[key] || []).filter(function (p) { return p.status === 'Записан'; });
  return { ok: true, participantsCount: active.length };
}

// ---------- organizer: create event ----------

function handleCreateEvent(body) {
  var date = body.date;
  var time = (body.time || '').trim();
  var city = (body.city || '').trim();
  var format = (body.format || '').trim(); // «Жанр» в таблице/на сайте
  var game = (body.game || '').trim();
  var place = (body.place || '').trim();
  var organizer = (body.organizer || '').trim();
  var maxParticipants = body.maxParticipants;
  var note = (body.note || '').trim();
  var difficulty = (body.difficulty || '').trim();
  var maxDuration = body.maxDuration;
  var teseraUrl = (body.teseraUrl || '').trim();
  var bggUrl = (body.bggUrl || '').trim();

  if (!date || !game || !city || !organizer) {
    return { ok: false, error: 'missing fields' };
  }

  var existing = findEvent(date, time, game);
  if (existing) {
    return { ok: false, error: 'duplicate' };
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
    'Набор открыт',
    note,
    difficulty,
    maxDuration ? Number(maxDuration) : '',
    teseraUrl,
    bggUrl
  ]);

  return { ok: true, id: eventKey(date, time, game) };
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
    if (formatDate(row[0]) === date && String(row[1] || '') === String(time || '') && row[4] === game) {
      return {
        maxParticipants: row[7] ? Number(row[7]) : null,
        status: row[8]
      };
    }
  }
  return null;
}

// returns { "date|time|game": [ {name, email, status}, ... in chronological order ] }
function getAllSignupStates() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SIGNUPS);
  var values = sheet.getDataRange().getValues();
  var map = {};
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var date = row[1], time = row[2], game = row[3], name = row[4], email = row[5], status = row[6];
    if (!date || !game || !email) continue;
    var dateStr = date instanceof Date ? formatDate(date) : String(date);
    var key = eventKey(dateStr, time, game);
    if (!map[key]) map[key] = [];
    map[key].push({ name: name, email: normalizeEmail(email), status: status });
  }
  // collapse to latest status per email, keep name from latest non-empty
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

function appendSignupRow(date, time, game, name, email, status) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SIGNUPS);
  sheet.appendRow([new Date(), date, time, game, name, email, status]);
}

function eventKey(dateStr, time, game) {
  return dateStr + '|' + (time || '') + '|' + game;
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
    var date = row[0], time = row[1], game = row[4], place = row[5], organizer = row[6], status = row[8];
    if (!date || !game) continue;
    var dateStr = formatDate(date);
    if (!map[dateStr]) map[dateStr] = [];
    map[dateStr].push({ time: time, game: game, place: place, organizer: organizer, status: status });
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
