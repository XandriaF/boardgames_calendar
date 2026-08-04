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

  // a broader, curated genre taxonomy -- covers the big board-game families (including
  // area control / abstracts / strategy, which the earlier short list was missing), stored
  // as a comma-separated list in the same «Жанр» column (same pattern as «Сеттинг»)
  var GENRE_OPTIONS = [
    'Стратегия', 'Евро', 'Америтреш', 'Абстрактная', 'Контроль территории',
    'Кооперативная', 'Пати', 'Карточная', 'Детектив/дедукция', 'НРИ',
    'Приключение', 'Экономика', 'Семейная', 'Варгейм'
  ];
  var SETTING_SUGGESTIONS = ['фэнтези', 'космос', 'детектив', 'ужасы', 'постапокалипсис', 'история'];
  // fixed dropdown of official locations -- "Другой" reveals a free-text field for anything else
  var CITY_OPTIONS = ['Онлайн', 'Москва', 'Астрахань', 'Рязань', 'Воронеж',
    'Пятигорск', 'Челябинск', 'Екатеринбург', 'Ростов-на-Дону', 'Оренбург', 'Другой'];

  var selectedGenres = [];

  // ---------- тип анонса: игра (полная форма) / событие (без записи, только описание) ----------
  var currentType = 'game';

  function setType(type) {
    currentType = type;
    document.querySelectorAll('#typeToggle .chip').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-type') === type);
    });

    var isEvent = type === 'event';
    document.querySelectorAll('.field-game-only').forEach(function (el) {
      // «закрытое» участники -- своя логика видимости (завязана на чекбокс), не трогаем
      // её напрямую здесь, чтобы не спорить с обработчиком fClosed ниже
      if (el.id === 'fClosedParticipantsWrap') return;
      el.hidden = isEvent;
    });
    if (isEvent) {
      document.getElementById('fClosedParticipantsWrap').hidden = true;
    } else {
      document.getElementById('fClosedParticipantsWrap').hidden = !document.getElementById('fClosed').checked;
    }

    var label = document.getElementById('fGameLabel');
    var input = document.getElementById('fGame');
    if (isEvent) {
      label.textContent = 'Описание события *';
      input.placeholder = 'Например: субботник, встреча клуба, деньрождение офиса...';
      document.getElementById('pageTitle').innerHTML = 'анонсировать <span class="accent">событие</span>';
      document.getElementById('pageLead').textContent = 'без записи и мест — просто отметка на сайте, что и когда будет. Заполните описание, город, где и когда.';
    } else {
      label.textContent = 'Игра *';
      input.placeholder = 'Каркассон';
      document.getElementById('pageTitle').innerHTML = 'анонсировать <span class="accent">игру</span>';
      document.getElementById('pageLead').textContent = 'заполните форму — мероприятие сразу появится на сайте и в таблице, а внизу получите готовый текст поста для вашего чата.';
    }
  }

  document.querySelectorAll('#typeToggle .chip').forEach(function (btn) {
    btn.addEventListener('click', function () { setType(btn.getAttribute('data-type')); });
  });

  function renderGenreChips() {
    var el = document.getElementById('fFormatGroup');
    el.innerHTML = '';
    GENRE_OPTIONS.forEach(function (g) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (selectedGenres.indexOf(g) !== -1 ? ' active' : '');
      chip.textContent = g;
      chip.addEventListener('click', function () {
        var i = selectedGenres.indexOf(g);
        if (i === -1) selectedGenres.push(g); else selectedGenres.splice(i, 1);
        renderGenreChips();
      });
      el.appendChild(chip);
    });
  }

  function fillCitySelect() {
    var el = document.getElementById('fCity');
    el.innerHTML = '<option value="">выберите город</option>' +
      CITY_OPTIONS.map(function (c) { return '<option value="' + c.replace(/"/g, '&quot;') + '">' + c + '</option>'; }).join('');
  }

  document.getElementById('fCity').addEventListener('change', function () {
    var isOther = this.value === 'Другой';
    document.getElementById('fCityOtherWrap').hidden = !isOther;
    if (!isOther) document.getElementById('fCityOther').value = '';
  });

  function loadSuggestions() {
    fillCitySelect();
    renderGenreChips();
    fillDatalist('settingList', SETTING_SUGGESTIONS);
  }

  function getMe() {
    try { return JSON.parse(localStorage.getItem('nastolki_me') || 'null'); } catch (e) { return null; }
  }
  // keeps the "это вы" identity in sync with index.html -- needed so a scheduled
  // (unpublished) event is recognized as "mine" there automatically
  function setMe(me) {
    localStorage.setItem('nastolki_me', JSON.stringify(me));
  }

  function showOverlay(id) { document.getElementById(id).hidden = false; }
  function hideOverlay(id) { document.getElementById(id).hidden = true; }

  // организатор/email больше не свободные поля формы -- это уже подтверждённая (PIN'ом)
  // личность из "это вы"; показываем её здесь же, чтобы её было видно и можно было сменить
  function renderWhoAmI() {
    var me = getMe();
    var textEl = document.getElementById('organizerIdText');
    var btn = document.getElementById('whoAmIBtn');
    if (me && me.name && me.email) {
      textEl.textContent = me.name + ' · ' + me.email;
      btn.textContent = 'изменить';
    } else {
      textEl.textContent = 'Ещё не указано — нажмите «это вы», чтобы участники видели, как с вами связаться';
      btn.textContent = 'это вы';
    }
  }

  function buildPostText(ev, link) {
    var lines = [];
    if (ev.eventType === 'event') {
      lines.push('📌 ' + ev.game);
      lines.push('');
      lines.push('📅 ' + fmtDate(ev.date) + (ev.time ? ', ' + ev.time : ''));
      lines.push('📍 ' + ev.city + (ev.place ? ' — ' + ev.place : ''));
      if (ev.organizer) lines.push('👤 Организатор: ' + ev.organizer);
      lines.push('');
      lines.push('Подробнее: ' + link);
      return lines.join('\n');
    }
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

  // одна строка = один участник закрытого мероприятия: "Имя, почта". Без запятой вся
  // строка считается почтой, а имя достаётся из её локальной части (до @)
  function parseClosedParticipants() {
    var raw = document.getElementById('fClosedParticipants').value || '';
    return raw.split('\n').map(function (line) {
      line = line.trim();
      if (!line) return null;
      var idx = line.indexOf(',');
      var name, email;
      if (idx === -1) {
        email = line;
        name = email.split('@')[0];
      } else {
        name = line.slice(0, idx).trim();
        email = line.slice(idx + 1).trim();
      }
      return { name: name, email: email };
    }).filter(Boolean);
  }

  function collectFormValues() {
    var cityRaw = document.getElementById('fCity').value;
    var city = cityRaw === 'Другой' ? document.getElementById('fCityOther').value.trim() : cityRaw;
    var me = getMe();
    return {
      date: document.getElementById('fDate').value,
      time: document.getElementById('fTime').value,
      city: city,
      format: selectedGenres.join(', '),
      game: document.getElementById('fGame').value.trim(),
      place: document.getElementById('fPlace').value.trim(),
      organizer: (me && me.name) || '',
      organizerEmail: (me && me.email) || '',
      maxParticipants: document.getElementById('fMax').value ? Number(document.getElementById('fMax').value) : null,
      difficulty: document.getElementById('fDifficulty').value,
      maxDuration: document.getElementById('fMaxDuration').value ? Number(document.getElementById('fMaxDuration').value) : null,
      setting: document.getElementById('fSetting').value.trim(),
      imageUrl: document.getElementById('fImage').value.trim(),
      teseraUrl: document.getElementById('fTesera').value.trim(),
      bggUrl: document.getElementById('fBgg').value.trim(),
      note: document.getElementById('fNote').value.trim(),
      isClosed: document.getElementById('fClosed').checked,
      closedParticipants: parseClosedParticipants(),
      eventType: currentType
    };
  }

  function doSubmit(publishNow) {
    hideFormError();
    var ev = collectFormValues();

    if (!ev.organizer || !ev.organizerEmail) {
      showFormError('Сначала укажите, кто вы — кнопка «это вы» рядом с полем «Организатор»');
      return;
    }
    if (!ev.date || !ev.city || !ev.game) {
      showFormError(ev.eventType === 'event' ? 'Заполните дату, город и описание события' : 'Заполните дату, город и игру');
      return;
    }

    var nowBtn = document.getElementById('submitNowBtn');
    var scheduleBtn = document.getElementById('submitScheduleBtn');
    nowBtn.disabled = true;
    scheduleBtn.disabled = true;
    var busyBtn = publishNow ? nowBtn : scheduleBtn;
    var busyBtnOriginalText = busyBtn.textContent;
    busyBtn.textContent = 'Добавляем…';

    apiPost({
      action: 'createEvent', publishNow: publishNow,
      date: ev.date, time: ev.time, city: ev.city, format: ev.format, game: ev.game,
      place: ev.place, organizer: ev.organizer, organizerEmail: ev.organizerEmail,
      maxParticipants: ev.maxParticipants, note: ev.note,
      difficulty: ev.difficulty, maxDuration: ev.maxDuration, setting: ev.setting,
      imageUrl: ev.imageUrl, teseraUrl: ev.teseraUrl, bggUrl: ev.bggUrl,
      isClosed: ev.isClosed, closedParticipants: ev.closedParticipants,
      eventType: ev.eventType
    }).then(function (res) {
      nowBtn.disabled = false;
      scheduleBtn.disabled = false;
      busyBtn.textContent = busyBtnOriginalText;

      if (!res.ok) {
        if (res.error === 'duplicate') {
          showFormError('Такая игра уже есть в таблице на эту дату и время — проверьте лист «Мероприятия»');
        } else {
          showFormError('Не получилось добавить мероприятие, попробуйте ещё раз');
        }
        return;
      }

      document.getElementById('resultCard').hidden = false;
      document.getElementById('copyHint').textContent = '';
      form.hidden = true;

      if (publishNow) {
        var anchor = slugifyEventId(ev.date, ev.time, ev.game);
        var link = new URL('index.html#' + anchor, window.location.href).href;
        document.getElementById('postText').value = buildPostText(ev, link);
        document.getElementById('scheduledNote').hidden = true;
        document.getElementById('publishedNote').hidden = false;
        document.getElementById('postText').hidden = false;
        document.getElementById('resultActionsRow').hidden = false;
        showStatus('Мероприятие «' + ev.game + '» добавлено ✅');
      } else {
        document.getElementById('scheduledNote').textContent = 'Мероприятие «' + ev.game + '» сохранено как запланированное — пока его видите только вы (по почте ' + ev.organizerEmail + ') и амбассадоры. Найдите его на главной странице и нажмите «Опубликовать», когда будете готовы.';
        document.getElementById('scheduledNote').hidden = false;
        document.getElementById('publishedNote').hidden = true;
        document.getElementById('postText').hidden = true;
        document.getElementById('resultActionsRow').hidden = true;
        showStatus('Мероприятие «' + ev.game + '» запланировано 🕓');
      }
      document.getElementById('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function () {
      nowBtn.disabled = false;
      scheduleBtn.disabled = false;
      busyBtn.textContent = busyBtnOriginalText;
      showFormError('Ошибка сети, попробуйте ещё раз');
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    doSubmit(true);
  });

  document.getElementById('submitScheduleBtn').addEventListener('click', function () {
    doSubmit(false);
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
    document.getElementById('fCityOtherWrap').hidden = true;
    document.getElementById('closedWarning').hidden = true;
    document.getElementById('fClosedParticipantsWrap').hidden = true;
    selectedGenres = [];
    setType('game');
    renderWhoAmI();
    loadSuggestions();
  });

  document.getElementById('fClosed').addEventListener('change', function () {
    document.getElementById('closedWarning').hidden = !this.checked;
    document.getElementById('fClosedParticipantsWrap').hidden = !this.checked;
  });

  // ---------- "это вы" (имя+почта+код) ----------
  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { hideOverlay('whoAmIOverlay'); });
  });
  document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.hidden = true;
    });
  });

  document.getElementById('whoAmIBtn').addEventListener('click', function () {
    var me = getMe();
    document.getElementById('inputName').value = (me && me.name) || '';
    document.getElementById('inputEmail').value = (me && me.email) || '';
    document.getElementById('inputPin').value = '';
    document.getElementById('whoAmIError').hidden = true;
    showOverlay('whoAmIOverlay');
  });

  document.getElementById('saveWhoAmI').addEventListener('click', function () {
    var name = document.getElementById('inputName').value.trim();
    var email = document.getElementById('inputEmail').value.trim();
    var pin = document.getElementById('inputPin').value.trim();
    var errEl = document.getElementById('whoAmIError');
    errEl.hidden = true;

    if (!name || !email.includes('@')) {
      errEl.textContent = 'Укажите имя и корпоративную почту';
      errEl.hidden = false;
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      errEl.textContent = 'Код должен состоять из 4 цифр';
      errEl.hidden = false;
      return;
    }

    var btn = document.getElementById('saveWhoAmI');
    btn.disabled = true;
    btn.textContent = 'Проверяем…';

    apiPost({ action: 'identify', name: name, email: email, pin: pin })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Сохранить';
        if (!res.ok) {
          if (res.error === 'wrong_pin') {
            errEl.textContent = 'Неверный код для этой почты. Если не помните его — напишите амбассадору Дарье: ddkolesnik@beeline.ru';
          } else if (res.error === 'invalid_pin') {
            errEl.textContent = 'Код должен состоять из 4 цифр';
          } else {
            errEl.textContent = 'Не получилось сохранить, попробуйте ещё раз';
          }
          errEl.hidden = false;
          return;
        }
        setMe({ name: name, email: email });
        hideOverlay('whoAmIOverlay');
        renderWhoAmI();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Сохранить';
        errEl.textContent = 'Ошибка сети, попробуйте ещё раз';
        errEl.hidden = false;
      });
  });

  // ---------- init ----------
  if (!API_URL || API_URL.indexOf('ВСТАВЬТЕ') !== -1) {
    showFormError('Сайт ещё не подключён к таблице. Заполните APPS_SCRIPT_URL в config.js — см. SETUP.md.');
    document.getElementById('submitNowBtn').disabled = true;
    document.getElementById('submitScheduleBtn').disabled = true;
  } else {
    setType('game');
    renderWhoAmI();
    loadSuggestions();
  }
})();
