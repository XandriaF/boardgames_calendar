(function () {
  'use strict';

  var API_URL = (window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) || '';

  var WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  function fmtDate(iso) {
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  // must stay identical to the slug logic in app.js so links point at the right card
  function slugifyEventId(date, time, game) {
    var raw = (date + '-' + (time || '') + '-' + game).toLowerCase();
    return 'ev-' + raw.replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  }

  function apiGet(action, params) {
    var url = API_URL + '?action=' + encodeURIComponent(action);
    Object.keys(params || {}).forEach(function (k) {
      url += '&' + k + '=' + encodeURIComponent(params[k]);
    });
    url += '&_ts=' + Date.now(); // avoid a stale cached response for identical GET URLs
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); });
  }

  function apiPost(payload) {
    return fetch(API_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  function fillDatalist(id, values) {
    var el = document.getElementById(id);
    el.innerHTML = values.map(function (v) { return '<option value="' + v.replace(/"/g, '&quot;') + '">'; }).join('');
  }

  // a fixed, curated list instead of deriving жанр suggestions from the sheet's raw
  // historical values -- legacy rows have generic entries like "Настольная игра" that
  // aren't useful as a genre tag (it's just a synonym for "board game" itself)
  var GENRE_SUGGESTIONS = ['Евро', 'Америтреш', 'Пати', 'Кооперативная', 'Карточная', 'НРИ'];
  var SETTING_SUGGESTIONS = ['фэнтези', 'космос', 'детектив', 'ужасы', 'постапокалипсис', 'история'];
  // fixed list of official cities, always offered -- merged (not replaced) with whatever
  // real city names already appear in existing events, since those are legitimate values too
  var CITY_SUGGESTIONS = ['Онлайн (Board Game Arena)', 'Москва', 'Астрахань', 'Рязань', 'Воронеж',
    'Пятигорск', 'Челябинск', 'Екатеринбург', 'Ростов-на-Дону', 'Оренбург'];

  function loadSuggestions() {
    fillDatalist('formatList', GENRE_SUGGESTIONS);
    fillDatalist('settingList', SETTING_SUGGESTIONS);
    fillDatalist('cityList', CITY_SUGGESTIONS);
    apiGet('events').then(function (res) {
      if (!res.ok) return;
      var cities = Array.from(new Set(CITY_SUGGESTIONS.concat(res.events.map(function (e) { return e.city; }).filter(Boolean))));
      fillDatalist('cityList', cities);
    }).catch(function () { /* suggestions are a nice-to-have, ignore failures */ });
  }

  function getMe() {
    try { return JSON.parse(localStorage.getItem('nastolki_me') || 'null'); } catch (e) { return null; }
  }

  function buildPostText(ev, link) {
    var lines = [];
    lines.push('🎲 ' + ev.game);
    lines.push('');
    lines.push('📅 ' + fmtDate(ev.date) + (ev.time ? ', ' + ev.time : ''));
    lines.push('📍 ' + ev.city + (ev.place ? ' — ' + ev.place : ''));
    lines.push('👤 Организатор: ' + ev.organizer);
    lines.push('👥 Мест: ' + (ev.maxParticipants ? ev.maxParticipants : 'без ограничений'));
    if (ev.difficulty) lines.push('🎯 Сложность: ' + ev.difficulty);
    if (ev.maxDuration) lines.push('⏱ Время партии: ~' + ev.maxDuration + ' мин (при полном столе)');
    if (ev.setting) lines.push('🌍 Сеттинг: ' + ev.setting);
    if (ev.imageUrl) lines.push('🖼 ' + ev.imageUrl);
    if (ev.teseraUrl) lines.push('🔗 Тесера: ' + ev.teseraUrl);
    if (ev.bggUrl) lines.push('🔗 BGG: ' + ev.bggUrl);
    if (ev.note) lines.push('ℹ️ ' + ev.note);
    lines.push('');
    lines.push('Записаться: ' + link);
    return lines.join('\n');
  }

  function showFormError(msg) {
    var el = document.getElementById('formError');
    el.textContent = msg;
    el.hidden = false;
  }
  function hideFormError() {
    document.getElementById('formError').hidden = true;
  }
  function showStatus(msg) {
    var el = document.getElementById('formStatus');
    el.textContent = msg;
    el.hidden = false;
  }

  var form = document.getElementById('eventForm');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    hideFormError();

    var ev = {
      date: document.getElementById('fDate').value,
      time: document.getElementById('fTime').value,
      city: document.getElementById('fCity').value.trim(),
      format: document.getElementById('fFormat').value.trim(),
      game: document.getElementById('fGame').value.trim(),
      place: document.getElementById('fPlace').value.trim(),
      organizer: document.getElementById('fOrganizer').value.trim() || (getMe() && getMe().name) || '',
      maxParticipants: document.getElementById('fMax').value ? Number(document.getElementById('fMax').value) : null,
      difficulty: document.getElementById('fDifficulty').value,
      maxDuration: document.getElementById('fMaxDuration').value ? Number(document.getElementById('fMaxDuration').value) : null,
      setting: document.getElementById('fSetting').value.trim(),
      imageUrl: document.getElementById('fImage').value.trim(),
      teseraUrl: document.getElementById('fTesera').value.trim(),
      bggUrl: document.getElementById('fBgg').value.trim(),
      note: document.getElementById('fNote').value.trim()
    };

    if (!ev.date || !ev.city || !ev.game || !ev.organizer) {
      showFormError('Заполните дату, город, игру и организатора');
      return;
    }

    var btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Добавляем…';

    apiPost({
      action: 'createEvent',
      date: ev.date, time: ev.time, city: ev.city, format: ev.format, game: ev.game,
      place: ev.place, organizer: ev.organizer, maxParticipants: ev.maxParticipants, note: ev.note,
      difficulty: ev.difficulty, maxDuration: ev.maxDuration, setting: ev.setting,
      imageUrl: ev.imageUrl, teseraUrl: ev.teseraUrl, bggUrl: ev.bggUrl
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = 'Добавить и получить текст поста';

      if (!res.ok) {
        if (res.error === 'duplicate') {
          showFormError('Такая игра уже есть в таблице на эту дату и время — проверьте лист «Мероприятия»');
        } else {
          showFormError('Не получилось добавить мероприятие, попробуйте ещё раз');
        }
        return;
      }

      var anchor = slugifyEventId(ev.date, ev.time, ev.game);
      var link = new URL('index.html#' + anchor, window.location.href).href;
      var text = buildPostText(ev, link);

      document.getElementById('postText').value = text;
      document.getElementById('resultCard').hidden = false;
      document.getElementById('copyHint').textContent = '';
      form.hidden = true;
      showStatus('Мероприятие «' + ev.game + '» добавлено ✅');
      document.getElementById('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Добавить и получить текст поста';
      showFormError('Ошибка сети, попробуйте ещё раз');
    });
  });

  document.getElementById('copyBtn').addEventListener('click', function () {
    var textarea = document.getElementById('postText');
    var hint = document.getElementById('copyHint');
    var done = function () { hint.textContent = 'Скопировано в буфер обмена'; };
    var fail = function () {
      textarea.focus();
      textarea.select();
      hint.textContent = 'Не удалось скопировать автоматически — текст выделен, нажмите Ctrl+C';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textarea.value).then(done).catch(fail);
    } else {
      fail();
    }
  });

  document.getElementById('resetBtn').addEventListener('click', function () {
    form.reset();
    form.hidden = false;
    document.getElementById('resultCard').hidden = true;
    document.getElementById('formStatus').hidden = true;
    document.getElementById('fOrganizer').value = (getMe() && getMe().name) || '';
    loadSuggestions();
  });

  // ---------- init ----------
  if (!API_URL || API_URL.indexOf('ВСТАВЬТЕ') !== -1) {
    showFormError('Сайт ещё не подключён к таблице. Заполните APPS_SCRIPT_URL в config.js — см. SETUP.md.');
    document.getElementById('submitBtn').disabled = true;
  } else {
    var me = getMe();
    if (me && me.name) document.getElementById('fOrganizer').value = me.name;
    loadSuggestions();
  }
})();
