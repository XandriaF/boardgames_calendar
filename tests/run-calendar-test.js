const fs = require('fs');
const vm = require('vm');

const CODE_PATH = '/sessions/keen-relaxed-thompson/mnt/boardgames_calendar/Code.gs';
const code = fs.readFileSync(CODE_PATH, 'utf8');

// ---- grid sheet stub: enough of the Range API surface that rebuildCalendar() uses ----
function makeGridSheet() {
  const cells = {};
  function key(r, c) { return r + ',' + c; }
  function cellAt(r, c) {
    if (!cells[key(r, c)]) cells[key(r, c)] = { value: null, background: null, fontWeight: null, align: null, wrap: false, numberFormat: null, merged: false };
    return cells[key(r, c)];
  }
  return {
    getRange(row, col, numRows, numCols) {
      numRows = numRows || 1; numCols = numCols || 1;
      const coords = [];
      for (let r = 0; r < numRows; r++) for (let c = 0; c < numCols; c++) coords.push([row + r, col + c]);
      const rangeObj = {
        setValue(v) { coords.forEach(([r, c]) => { cellAt(r, c).value = v; }); return rangeObj; },
        setBackground(bg) { coords.forEach(([r, c]) => { cellAt(r, c).background = bg; }); return rangeObj; },
        setFontWeight(fw) { coords.forEach(([r, c]) => { cellAt(r, c).fontWeight = fw; }); return rangeObj; },
        setHorizontalAlignment(a) { coords.forEach(([r, c]) => { cellAt(r, c).align = a; }); return rangeObj; },
        setWrap(w) { coords.forEach(([r, c]) => { cellAt(r, c).wrap = w; }); return rangeObj; },
        setNumberFormat(f) { coords.forEach(([r, c]) => { cellAt(r, c).numberFormat = f; }); return rangeObj; },
        merge() { coords.forEach(([r, c]) => { cellAt(r, c).merged = true; }); return rangeObj; }
      };
      return rangeObj;
    },
    clear() { Object.keys(cells).forEach(k => delete cells[k]); },
    setColumnWidth() {},
    setFrozenRows() {},
    _cellAt: cellAt
  };
}

function makeValuesSheetStub(rows) {
  return {
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    appendRow(row) { rows.push(row); }
  };
}

// Мероприятия fixture: Дата, Время, Город, Формат, Игра, Место, Организатор, Макс, Статус, Комментарий
const eventsRows = [
  ['Дата', 'Время', 'Город', 'Формат', 'Игра', 'Место', 'Организатор', 'Макс', 'Статус', 'Комментарий'],
];
let signupRows = [['Timestamp', 'Дата', 'Время', 'Игра', 'Имя', 'Корп. почта', 'Статус']];

let calendarSheet = null;
let insertedCalendarSheet = false;

const sandbox = {
  console,
  SpreadsheetApp: {
    getActiveSpreadsheet() {
      return {
        getSheetByName(name) {
          if (name === 'Календарь') return calendarSheet;
          if (name === 'Мероприятия') return makeValuesSheetStub(eventsRows);
          if (name === 'Записи') return makeValuesSheetStub(signupRows);
          return null;
        },
        insertSheet(name) {
          calendarSheet = makeGridSheet();
          insertedCalendarSheet = true;
          return calendarSheet;
        }
      };
    },
    getUi() {
      return { createMenu() { return { addItem() { return this; }, addToUi() {} }; } };
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
    createTextOutput(text) { return { _text: text, setMimeType() { return this; } }; }
  }
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'Code.gs' });

// build fixture event dates using the SANDBOX's own Date constructor (cross-realm instanceof gotcha)
const D = vm.runInContext('Date', sandbox);
function addEvent(y, m, d, time, city, format, game, place, organizer, max, status) {
  eventsRows.push([new D(y, m - 1, d), time, city, format, game, place, organizer, max, status, '']);
}

// fixed "today" for deterministic testing: Wednesday 2026-08-05 -> current week Monday = 2026-08-03
const TODAY = new D(2026, 7, 5); // month is 0-indexed: 7 = August

// two events same day (to test multi-event join + first-event-wins color), one empty day gap, one other week
addEvent(2026, 8, 3, '18:00', 'Москва', 'Настольная игра', 'Каркассон', 'Клубик', 'Даша', 4, 'Набор открыт');
addEvent(2026, 8, 3, '20:00', 'Москва', 'Настольная игра', 'Доминион', 'Клубик', 'Игорь', '', 'Черновик');
addEvent(2026, 8, 6, '19:00', 'Санкт-Петербург', 'НРИ', 'Зов Ктулху', 'Офис СПб', 'Оля', '', 'Отменено');
addEvent(2026, 8, 17, '18:30', 'Москва', 'Настольная игра', 'Терраформирование Марса', 'ШК', 'Настя', 4, 'Набрано');
// draft-only day should still render as empty-looking on its own if it were the sole event... (covered above via combined day)

let failures = 0;
function check(label, cond) {
  if (cond) console.log('PASS:', label);
  else { console.log('FAIL:', label); failures++; }
}

sandbox.rebuildCalendar(TODAY);

check('inserted a new Календарь sheet on first run', insertedCalendarSheet === true);

// legend row 1: label + 5 status colors
check('legend label present', calendarSheet._cellAt(1, 1).value === 'Легенда:');
const legendColors = [2, 3, 4, 5, 6].map(c => calendarSheet._cellAt(1, c).background);
check('legend has all 5 status colors', JSON.stringify(legendColors) === JSON.stringify(['#FFFF00', '#00FF00', '#FF0000', '#4A86E8', '#00FFFF']));

// header row 3: "Неделя" + 7 merged day names
check('header label "Неделя"', calendarSheet._cellAt(3, 1).value === 'Неделя');
check('Monday header merged & correct', calendarSheet._cellAt(3, 2).value === 'Понедельник' && calendarSheet._cellAt(3, 2).merged === true);
check('Sunday header at column 14', calendarSheet._cellAt(3, 14).value === 'Воскресенье');

// week 1 = row 4, Monday 2026-08-03 in column 2 (date), column 3 (text)
const mondayCell = calendarSheet._cellAt(4, 2);
check('first week starts on Monday 2026-08-03', mondayCell.value.getFullYear() === 2026 && mondayCell.value.getMonth() === 7 && mondayCell.value.getDate() === 3);

const mondayTextCell = calendarSheet._cellAt(4, 3);
check('Monday cell joins both events with newline', mondayTextCell.value === '18:00 Каркассон (Клубик) · Даша\n20:00 Доминион (Клубик) · Игорь');
check('Monday cell colored by FIRST event\'s status (Набор открыт = yellow)', mondayTextCell.background === '#FFFF00');

// Tuesday 2026-08-04 has no events -> must stay blank, no background
const tuesdayTextCell = calendarSheet._cellAt(4, 5);
check('empty day (Tuesday) has no value', tuesdayTextCell.value === null);
check('empty day (Tuesday) has no background (stays visually blank)', tuesdayTextCell.background === null);

// Thursday 2026-08-06 -> cancelled event, red
const thursdayTextCell = calendarSheet._cellAt(4, 9);
check('Thursday (cancelled event) text correct', thursdayTextCell.value === '19:00 Зов Ктулху (Офис СПб) · Оля');
check('Thursday colored red for Отменено', thursdayTextCell.background === '#FF0000');

// week 3 (row 6) should contain 2026-08-17 (Monday of week starting 08-17 -> that's the 3rd Monday: 08-03, 08-10, 08-17)
const week3MondayDate = calendarSheet._cellAt(6, 2).value;
check('week 3 row starts 2026-08-17', week3MondayDate.getMonth() === 7 && week3MondayDate.getDate() === 17);
// event was on Monday 2026-08-17 itself
const week3MondayText = calendarSheet._cellAt(6, 3);
check('week 3 Monday has the Набрано event, green', week3MondayText.value.includes('Терраформирование Марса') && week3MondayText.background === '#00FF00');

check('generated exactly CALENDAR_WEEKS_AHEAD (16) week rows', (() => {
  // row 4..19 should have a week number, row 20 should not
  for (let r = 4; r < 4 + 16; r++) { if (calendarSheet._cellAt(r, 1).value == null) return false; }
  return calendarSheet._cellAt(4 + 16, 1).value === null;
})());

// ---- second run: sheet already exists, should clear() and rebuild cleanly (no leftover stale cells) ----
insertedCalendarSheet = false;
// pollute a cell that should get cleared away
calendarSheet.getRange(50, 50).setValue('leftover junk');
sandbox.rebuildCalendar(TODAY);
check('second run reuses existing sheet (no re-insert)', insertedCalendarSheet === false);
check('second run clears stale leftover cells', calendarSheet._cellAt(50, 50).value === null);
check('second run still renders correctly (Monday text unchanged)', calendarSheet._cellAt(4, 3).value === '18:00 Каркассон (Клубик) · Даша\n20:00 Доминион (Клубик) · Игорь');

console.log(failures === 0 ? '\nALL CALENDAR TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
