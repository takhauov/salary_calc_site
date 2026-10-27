/* Вкладка «Загрузка отчётов»: перетащили .xlsm → программа сама достала прибыль/маржу по артикулам
 * и валовую маржу, сопоставила артикулы со строками расчёта, посчитала бонусы и записала в вкладки
 * менеджеров ВБ / Озон / ЯМ и РОП.  Файлы никуда не отправляются — читаются локально в браузере.
 *
 * Использует глобальные функции основного скрипта (index.html): computeRow, ozComputeRow, ymComputeRow,
 * tariffForMonth, TARIFFS, loadHistoryRaw/saveHistoryRaw (и oz/ym/rop аналоги), ozLoadLoanState/ozSaveLoanState.
 */
(function () {
  const MAP_KEY = 'upMappings_v1';
  const FEEDS = {wb: 'Менеджер ВБ', oz: 'Менеджер Озон', ym: 'Менеджер ЯМ'};
  const DIRS = ['ВБ', 'Озон', 'ЯМ', 'ВБ ИП Тарасов', 'Озон Тарасов', 'ЯМ Тарасов'];
  const NONE = '';

  const DEFAULT_LINES = {
    wb: ['Душ зелёный', 'Душ чёрный', 'Душ серый', 'Культиватор со штангой', 'Пила 8 дюймов', 'Секатор', 'Набор медиум', 'Краскопульт', 'Краскопульт 498'],
    oz: ['Душ зелёный', 'Душ чёрный', 'Душ серый', 'Культиватор со штангой', 'Культиватор', 'Секатор', 'Штанга для инструментов', 'Набор люкс', 'Набор медиум', 'Пила 8 дюймов', 'Краскопульт', 'Краскопульт 498'],
    ym: ['Душ зелёный', 'Душ серый', 'Душ чёрный', 'Культиватор со штангой', 'Набор медиум', 'Пила 8 дюймов', 'Секатор', 'Штанга для инструментов', 'Краскопульт', 'Краскопульт 498'],
  };
  const DEFAULT_ARTICLES = {wb: {}, oz: {}, ym: {}};
  const DEFAULT_ENTITIES = {};
  const MARKET_DEFAULT_ROLE = {wb: {dir: 'ВБ', feed: 'wb'}, oz: {dir: 'Озон', feed: 'oz'}, ym: {dir: 'ЯМ', feed: 'ym'}};
  const MARKET_LABEL = {wb: 'Wildberries', oz: 'Ozon', ym: 'Яндекс Маркет'};
  const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

  // ---------- хранилище сопоставлений ----------
  function loadMaps() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(MAP_KEY) || '{}') || {}; } catch (e) {}
    return {articles: Object.assign({wb: {}, oz: {}, ym: {}}, stored.articles || {}), entities: stored.entities || {}};
  }
  function saveMaps(m) { try { localStorage.setItem(MAP_KEY, JSON.stringify(m)); } catch (e) {} }
  function articleLine(maps, feed, key) {
    const own = maps.articles[feed] || {};
    if (key in own) return own[key];
    const d = DEFAULT_ARTICLES[feed] || {};
    return key in d ? d[key] : NONE;
  }
  function entityRole(maps, entity, market) {
    const k = String(entity || '').toLowerCase();
    return maps.entities[k] || DEFAULT_ENTITIES[k] || MARKET_DEFAULT_ROLE[market] || MARKET_DEFAULT_ROLE.wb;
  }

  // ---------- вспомогательное ----------
  const rub = n => Math.round(n || 0).toLocaleString('ru-RU') + ' ₽';
  const normName = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\([^)]*\)/g, ' ').replace(/[«»"']/g, '').replace(/\s+/g, ' ').trim();

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(k => {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    kids.flat().forEach(c => { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  // недели ISO, у которых ≥4 дней в месяце (правило «неделя относится к месяцу, если в нём 4+ дней»)
  function weeksOfMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    const counts = new Map();
    const days = new Date(y, m, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const dt = new Date(Date.UTC(y, m - 1, d));
      const dow = (dt.getUTCDay() + 6) % 7;               // 0 = понедельник
      const thursday = new Date(dt); thursday.setUTCDate(dt.getUTCDate() - dow + 3);
      const isoYear = thursday.getUTCFullYear();
      const jan4 = new Date(Date.UTC(isoYear, 0, 4));
      const week = 1 + Math.round(((thursday - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
      const key = isoYear + '-' + week;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries()).filter(([, c]) => c >= 4).map(([k]) => parseInt(k.split('-')[1], 10));
  }

  // ---------- разбор вставленного текста план-факта ----------
  function parsePlanText(text) {
    const out = {};
    const tokens = String(text || '').split(/\t|\r?\n/).map(t => t.trim()).filter(Boolean);
    let name = '';
    for (const t of tokens) {
      if (/^\d+(?:[.,]\d+)?\s*%$/.test(t)) {
        if (name && !(normName(name) in out)) out[normName(name)] = parseFloat(t.replace(',', '.'));
        name = '';
      } else if (/[А-Яа-яЁёA-Za-z]/.test(t) && !/₽|%/.test(t) && !/^[А-ЯЁA-Z ,.%₽/]+$/.test(t)) {
        name = t;
      }
    }
    return out;
  }

  // ---------- состояние ----------
  const S = {
    month: '',
    files: [],            // {id, name, parsed, role:{dir,feed}}
    planText: {wb: '', oz: '', ym: ''},
    planOverride: {wb: {}, oz: {}, ym: {}},
    opiu: [],             // файлы ОПиУ: {id, name, period, gross:{компания: сумма}}
    nextId: 1,
  };

  function currentMonth() {
    const el = document.getElementById('up-month');
    return (el && el.value) || S.month || new Date().toISOString().slice(0, 7);
  }

  // существующая запись месяца в истории менеджера (для сохранения оклада, доп. премии и т.д.)
  function existingEntry(feed, ym) {
    try {
      if (feed === 'wb') return (loadHistoryRaw()[ym]) || null;
      if (feed === 'oz') return (ozLoadHistoryRaw()[ym]) || null;
      if (feed === 'ym') return (ymLoadHistoryRaw()[ym]) || null;
    } catch (e) {}
    return null;
  }

  // сводим артикулы всех файлов менеджера в строки расчёта
  function buildLines(feed) {
    const maps = loadMaps();
    const ym = currentMonth();
    const lines = new Map();
    const unmapped = [];
    S.files.filter(f => f.role.feed === feed).forEach(f => {
      f.parsed.articles.forEach(a => {
        const line = articleLine(maps, feed, a.key);
        if (!line) {
          if (Math.abs(a.profit) >= 10000 || a.revenue >= 50000) unmapped.push({file: f, article: a});
          return;
        }
        const cur = lines.get(line) || {name: line, profit: 0, revenue: 0, units: 0, ads: 0, from: []};
        cur.profit += a.profit; cur.revenue += a.revenue; cur.units += a.units; cur.ads += a.ads || 0;
        cur.from.push(a.name);
        lines.set(line, cur);
      });
    });
    const planFromText = parsePlanText(S.planText[feed]);
    const ex = existingEntry(feed, ym);
    const rows = Array.from(lines.values()).map(l => {
      const margin = l.revenue > 100 ? Math.round(l.profit / l.revenue * 10000) / 100 : 0;
      const key = normName(l.name);
      let plan = '';
      let planSrc = '';
      if (S.planOverride[feed][l.name] !== undefined) { plan = S.planOverride[feed][l.name]; planSrc = 'вручную'; }
      else if (key in planFromText) { plan = planFromText[key]; planSrc = 'из план-факта'; }
      else if (ex && ex.rows) {
        const old = ex.rows.find(r => normName(r.name) === key);
        if (old && old.plan !== '' && old.plan != null) { plan = old.plan; planSrc = 'из прошлой записи'; }
      }
      let catOverride = null;
      if (ex && ex.rows) { const old = ex.rows.find(r => normName(r.name) === key); if (old) catOverride = old.catOverride || null; }
      return {name: l.name, profit: Math.round(l.profit * 100) / 100, plan, margin, catOverride, from: l.from, planSrc, drr: (feed === 'wb' && l.ads > 0 && l.revenue > 100) ? Math.round(l.ads / l.revenue * 10000) / 100 : ''};
    });
    rows.sort((a, b) => b.profit - a.profit);
    // строки прошлой записи, которых нет в загруженных файлах, сохраняем (если не выбрана полная замена)
    const replaceAll = document.getElementById('up-replace') && document.getElementById('up-replace').checked;
    if (!replaceAll && ex && ex.rows) {
      const have = new Set(rows.map(r => normName(r.name)));
      ex.rows.forEach(old => {
        if (have.has(normName(old.name))) return;
        rows.push({name: old.name, profit: parseFloat(old.profit) || 0, plan: old.plan, margin: parseFloat(old.margin) || 0,
          catOverride: old.catOverride || null, from: ['прошлая запись'], planSrc: 'из прошлой записи', drr: old.drr || '', kept: true});
      });
    }
    return {rows, unmapped, planFromText};
  }

  function computeFor(feed, row, ym) {
    if (feed === 'wb') return computeRow(row, tariffForMonth(ym));
    if (feed === 'oz') return ozComputeRow(row);
    return ymComputeRow(row);
  }
  function okladFor(feed, ym) {
    const ex = existingEntry(feed, ym);
    if (feed === 'wb') return ex && ex.manualOklad ? ex.oklad : TARIFFS[tariffForMonth(ym)].oklad;
    if (ex && ex.oklad != null) return ex.oklad;
    return 25000;
  }

  function setMonth(ym) {
    const el = document.getElementById('up-month');
    if (el && ym) { el.value = ym; S.month = ym; }
  }

  // валовая маржа кабинета за месяц: из самого отчёта (старый формат) или из файла ОПиУ (новый)
  function grossFor(f, ym) {
    const monthName = MONTH_NAMES[parseInt(ym.split('-')[1], 10) - 1];
    if (f.parsed.gross && f.parsed.gross[monthName] !== undefined) return f.parsed.gross[monthName];
    const ent = f.parsed.entity;
    for (const o of S.opiu) {
      if (o.period && o.period.ym === ym && ent in o.gross) return o.gross[ent];
    }
    return undefined;
  }

  // ---------- загрузка файлов ----------
  async function addFiles(fileList) {
    const status = document.getElementById('up-status');
    for (const file of Array.from(fileList)) {
      if (!/\.(xlsm|xlsx)$/i.test(file.name)) { status.textContent = 'Пропустил «' + file.name + '»: нужен файл .xlsm или .xlsx'; continue; }
      status.textContent = 'Читаю «' + file.name + '»… (несколько секунд)';
      await new Promise(r => setTimeout(r, 30));
      try {
        const buf = await file.arrayBuffer();
        const any = ReportParser.parseAny(XLSX, buf, file.name, {type: 'array'});
        const maps = loadMaps();
        if (any.kind === 'opiu') {
          S.opiu = S.opiu.filter(o => !(o.period && any.period && o.period.label === any.period.label));
          S.opiu.push({id: S.nextId++, name: file.name, period: any.period, gross: any.gross});
          if (any.period && any.period.ym) setMonth(any.period.ym);
        } else if (any.kind === 'multi') {
          any.cabinets.forEach(cab => {
            const parsed = Object.assign({fileName: file.name, period: any.period}, cab);
            const role = Object.assign({}, entityRole(maps, parsed.entity, parsed.market));
            S.files = S.files.filter(f => !(f.parsed.entity === parsed.entity && f.parsed.market === parsed.market));
            S.files.push({id: S.nextId++, name: file.name, parsed, role});
          });
          if (any.period && any.period.ym) setMonth(any.period.ym);
        } else {
          const parsed = any;
          const role = Object.assign({}, entityRole(maps, parsed.entity, parsed.market));
          // тот же кабинет загружен повторно — заменяем
          S.files = S.files.filter(f => !(parsed.entity && f.parsed.entity === parsed.entity && f.parsed.market === parsed.market));
          S.files.push({id: S.nextId++, name: file.name, parsed, role});
        }
        status.textContent = 'Готово: «' + file.name + '»';
      } catch (e) {
        status.textContent = 'Не удалось прочитать «' + file.name + '»: ' + e.message;
      }
    }
    render();
  }

  // ---------- отрисовка ----------
  function roleSelect(f) {
    const sel = h('select', {onchange: ev => {
      const [dir, feed] = ev.target.value.split('|');
      f.role = {dir, feed};
      const maps = loadMaps();
      if (f.parsed.entity) { maps.entities[f.parsed.entity.toLowerCase()] = f.role; saveMaps(maps); }
      render();
    }});
    const opts = [['', '', '— не учитывать —'], ['ВБ', 'wb', 'ВБ (менеджер ВБ)'], ['ВБ ИП Тарасов', 'wb', 'ВБ ИП Тарасов (в расчёт менеджера ВБ)'],
      ['Озон', 'oz', 'Озон (менеджер Озон)'], ['Озон Тарасов', 'oz', 'Озон Тарасов (в расчёт менеджера Озон)'],
      ['ЯМ', 'ym', 'ЯМ (менеджер ЯМ)'], ['ЯМ Тарасов', 'ym', 'ЯМ Тарасов (в расчёт менеджера ЯМ)']];
    opts.forEach(([dir, feed, label]) => {
      const o = h('option', {value: dir + '|' + feed, text: label});
      if (f.role.dir === dir && f.role.feed === feed) o.selected = true;
      sel.appendChild(o);
    });
    return sel;
  }

  function renderFiles(ym) {
    const box = document.getElementById('up-files');
    box.innerHTML = '';
    if (S.files.length === 0 && S.opiu.length === 0) { box.appendChild(h('p', {class: 'history-empty', text: 'Пока ничего не загружено.'})); return; }
    S.opiu.forEach(o => {
      const per = o.period;
      const names = Object.keys(o.gross);
      box.appendChild(h('div', {class: 'up-file'},
        h('div', {class: 'up-file-head'}, h('strong', {text: 'ОПиУ — сводка по компаниям'}), h('span', {class: 'up-badge', text: 'валовая маржа'}),
          h('button', {class: 'up-x', title: 'Убрать файл', onclick: () => { S.opiu = S.opiu.filter(x => x.id !== o.id); render(); }, text: '✕'})),
        h('div', {class: 'up-file-meta', text: 'Компаний: ' + names.length + ' · валовая маржа всего: ' + rub(names.reduce((t, n) => t + o.gross[n], 0))}),
        per ? h('div', {class: 'up-file-meta' + (per.ym && per.full ? '' : ' up-warn'), text: 'Период отчёта: ' + per.label +
          (!per.ym ? ' — период больше одного месяца, маржа не будет учтена' : per.full ? '' : ' — не весь месяц, итоги будут неполными')}) : null));
    });
    const monthName = MONTH_NAMES[parseInt(ym.split('-')[1], 10) - 1];
    S.files.forEach(f => {
      const gross = grossFor(f, ym);
      const per = f.parsed.period;
      const card = h('div', {class: 'up-file'},
        h('div', {class: 'up-file-head'},
          h('strong', {text: (f.parsed.entity || f.name)}),
          h('span', {class: 'up-badge', text: MARKET_LABEL[f.parsed.market]}),
          h('button', {class: 'up-x', title: 'Убрать файл', onclick: () => { S.files = S.files.filter(x => x.id !== f.id); render(); }, text: '✕'})),
        h('div', {class: 'up-file-meta'},
          'Артикулов: ' + f.parsed.articles.length + ' · реализация по артикулам: ' + rub(f.parsed.totals.revenue) +
          ' · прибыль: ' + rub(f.parsed.totals.profit)),
        h('div', {class: 'up-file-meta'}, 'Валовая маржа за ' + monthName + ': ',
          h('strong', {text: gross === undefined ? 'нет данных' : rub(gross)})),
        per ? h('div', {class: 'up-file-meta' + (per.full ? '' : ' up-warn'), text: 'Период отчёта: ' + per.label + (per.full ? '' : ' — не весь месяц, итоги будут неполными')}) : null,
        h('div', {class: 'up-file-role'}, 'Куда относить: ', roleSelect(f)));
      box.appendChild(card);
    });
  }

  function lineSelect(feed, art, maps, onChange) {
    const cur = articleLine(maps, feed, art.key);
    const names = DEFAULT_LINES[feed].slice();
    if (cur && !names.includes(cur)) names.push(cur);
    const sel = h('select', {onchange: ev => {
      let v = ev.target.value;
      if (v === '__new__') {
        v = (window.prompt('Название новой строки расчёта:') || '').trim();
        if (!v) { ev.target.value = cur; return; }
      }
      const m = loadMaps();
      m.articles[feed][art.key] = v;
      saveMaps(m);
      onChange();
    }});
    sel.appendChild(h('option', {value: NONE, text: '— не учитывать —'}));
    names.forEach(n => { const o = h('option', {value: n, text: n}); if (n === cur) o.selected = true; sel.appendChild(o); });
    sel.appendChild(h('option', {value: '__new__', text: '＋ другая строка…'}));
    return sel;
  }

  function renderFeed(feed, ym) {
    const files = S.files.filter(f => f.role.feed === feed);
    const sec = h('div', {class: 'card up-feed'});
    sec.appendChild(h('h2', {text: FEEDS[feed]}));
    if (files.length === 0) {
      sec.appendChild(h('p', {class: 'history-empty', text: 'Файлов для этого менеджера пока нет — расчёт не будет изменён.'}));
      return sec;
    }
    const maps = loadMaps();
    const res = buildLines(feed);

    // сопоставление артикулов
    const det = h('details', {class: 'up-details'});
    const allArts = [];
    files.forEach(f => f.parsed.articles.forEach(a => {
      if (Math.abs(a.profit) >= 1 || a.revenue >= 1) allArts.push({f, a});
    }));
    const unm = res.unmapped.length;
    det.appendChild(h('summary', {text: 'Артикулы → строки расчёта (' + allArts.length + ')' + (unm ? ' · требуют выбора: ' + unm : '')}));
    const t = h('table', {class: 'up-table'});
    t.appendChild(h('thead', {}, h('tr', {}, h('th', {text: 'Артикул в отчёте'}), h('th', {text: 'Кабинет'}), h('th', {class: 'num', text: 'Прибыль'}), h('th', {class: 'num', text: 'Реализация'}), h('th', {text: 'Строка расчёта'}))));
    const tb = h('tbody');
    allArts.sort((x, y) => Math.abs(y.a.profit) - Math.abs(x.a.profit)).forEach(({f, a}) => {
      const isUn = res.unmapped.some(u => u.article === a);
      tb.appendChild(h('tr', {class: isUn ? 'up-unmapped' : ''},
        h('td', {text: a.name}), h('td', {text: f.parsed.entity}),
        h('td', {class: 'num', text: rub(a.profit)}), h('td', {class: 'num', text: rub(a.revenue)}),
        h('td', {}, lineSelect(feed, a, maps, render))));
    });
    t.appendChild(tb);
    det.appendChild(t);
    if (unm) det.open = true;
    sec.appendChild(det);

    // план-факт
    const plan = h('div', {class: 'up-plan'},
      h('label', {text: 'План-факт (вставьте таблицу «Товар … План, %» с сайта план-факта):'}),
      h('textarea', {rows: 3, 'data-feed': feed, placeholder: 'Скопируйте таблицу с сайта план-факта и вставьте сюда', oninput: ev => { S.planText[feed] = ev.target.value; S.focusFeed = feed; clearTimeout(S._pt); S._pt = setTimeout(() => render(true), 500); }}));
    plan.querySelector('textarea').value = S.planText[feed];
    sec.appendChild(plan);

    // результат
    const ymm = ym;
    const tbl = h('table', {class: 'up-table up-result'});
    tbl.appendChild(h('thead', {}, h('tr', {}, h('th', {text: 'Строка'}), h('th', {class: 'num', text: 'Прибыль, ₽'}), h('th', {class: 'num', text: 'Маржа, %'}),
      h('th', {class: 'num', text: 'План, %'}), h('th', {text: 'Кат.'}), h('th', {class: 'num', text: 'За план'}), h('th', {class: 'num', text: 'За маржу'}), h('th', {class: 'num', text: 'Итого'}))));
    const body = h('tbody');
    let bonusSum = 0;
    res.rows.forEach(r => {
      const c = computeFor(feed, r, ymm);
      bonusSum += c.total;
      const inp = h('input', {type: 'number', step: '0.1', class: 'up-plan-input', value: r.plan === '' ? '' : String(r.plan),
        title: r.planSrc ? 'Источник: ' + r.planSrc : 'План не найден — введите вручную',
        onchange: ev => { S.planOverride[feed][r.name] = ev.target.value === '' ? '' : parseFloat(ev.target.value); render(true); }});
      body.appendChild(h('tr', {title: 'Артикулы: ' + r.from.join(', '), class: r.kept ? 'up-kept' : ''},
        h('td', {text: r.name}), h('td', {class: 'num', text: rub(r.profit).replace(' ₽', '')}), h('td', {class: 'num', text: String(r.margin)}),
        h('td', {class: 'num'}, inp),
        h('td', {}, h('span', {class: 'cat-' + (c.cat || 'x'), text: c.cat || '—'})),
        h('td', {class: 'num', text: rub(c.planBonus).replace(' ₽', '')}), h('td', {class: 'num', text: rub(c.marginBonus).replace(' ₽', '')}),
        h('td', {class: 'num', text: rub(c.total).replace(' ₽', '')})));
    });
    tbl.appendChild(body);
    sec.appendChild(tbl);
    const oklad = okladFor(feed, ymm);
    sec.appendChild(h('div', {class: 'up-total'}, 'Оклад ' + rub(oklad) + ' + бонусы ' + rub(bonusSum) + ' = ', h('strong', {text: rub(oklad + bonusSum) + ' начислено'})));
    const missing = res.rows.filter(r => r.plan === '').map(r => r.name);
    if (missing.length) sec.appendChild(h('p', {class: 'up-warn', text: 'Нет плана для: ' + missing.join(', ') + ' — для категорий A/B без плана бонус за план = 0.'}));
    return sec;
  }

  // валовая маржа по кабинетам из загруженных файлов: {'направление|кабинет': сумма}
  function cabinetGross(ym) {
    const monthName = MONTH_NAMES[parseInt(ym.split('-')[1], 10) - 1];
    const out = {};
    // компании из файла ОПиУ, для которых нет файла по артикулам
    const covered = new Set(S.files.map(f => f.parsed.entity));
    const maps0 = loadMaps();
    S.opiu.forEach(o => {
      if (!o.period || o.period.ym !== ym) return;
      Object.keys(o.gross).forEach(comp => {
        if (covered.has(comp)) return;
        const role = maps0.entities[comp.toLowerCase()] || DEFAULT_ENTITIES[comp.toLowerCase()];
        if (!role || !role.dir) return;
        const k = role.dir + '|' + comp;
        out[k] = (out[k] || 0) + o.gross[comp];
      });
    });
    S.files.forEach(f => {
      const g = grossFor(f, ym);
      if (g === undefined || !f.role.dir) return;
      const k = f.role.dir + '|' + (f.parsed.entity || f.parsed.fileName);
      out[k] = (out[k] || 0) + g;
    });
    return out;
  }
  // Итог по направлениям. Если в записи месяца есть разбивка по кабинетам (ex.cabinets),
  // то перезагрузка одного кабинета заменяет только его долю, остальное остаётся.
  function ropMerge(ym, ex) {
    const cab = cabinetGross(ym);
    const prevCab = Object.assign({}, (ex && ex.cabinets) || {});
    const margins = Object.assign({}, (ex && ex.margins) || {});
    const touched = {};
    Object.keys(cab).forEach(k => {
      const dir = k.split('|')[0];
      touched[dir] = true;
      const hasSplit = Object.keys(prevCab).some(x => x.split('|')[0] === dir);
      if (hasSplit) margins[dir] = (margins[dir] || 0) - (prevCab[k] || 0) + cab[k];
    });
    // направления без разбивки: заменяем итог суммой загруженных файлов
    Object.keys(touched).forEach(dir => {
      const hasSplit = Object.keys(prevCab).some(x => x.split('|')[0] === dir);
      if (!hasSplit) margins[dir] = Object.keys(cab).filter(k => k.split('|')[0] === dir).reduce((t, k) => t + cab[k], 0);
    });
    const cabinets = Object.assign({}, prevCab);
    Object.keys(cab).forEach(k => { cabinets[k] = cab[k]; });
    return {margins, cabinets, touched};
  }
  function ropPreview(ym) { return ropMerge(ym, ropLoadHistoryRaw()[ym]).touched; }

  function renderRop(ym) {
    const sec = h('div', {class: 'card up-feed'});
    sec.appendChild(h('h2', {text: 'РОП — валовая маржа за месяц'}));
    const sums = ropPreview(ym);
    const dirs = Object.keys(sums);
    if (dirs.length === 0) { sec.appendChild(h('p', {class: 'history-empty', text: 'Нет данных: в загруженных файлах не нашлась «Валовая маржа» за этот месяц.'})); return sec; }
    const ex = ropLoadHistoryRaw()[ym];
    const merged = ropMerge(ym, ex).margins;
    const tbl = h('table', {class: 'up-table'});
    tbl.appendChild(h('thead', {}, h('tr', {}, h('th', {text: 'Направление'}), h('th', {class: 'num', text: 'Валовая маржа, ₽'}), h('th', {text: 'Источник'}))));
    const tb = h('tbody');
    let total = 0;
    DIRS.forEach(d => {
      if (merged[d] === undefined) return;
      total += merged[d];
      tb.appendChild(h('tr', {}, h('td', {text: d}), h('td', {class: 'num', text: rub(merged[d]).replace(' ₽', '')}),
        h('td', {text: d in sums ? 'из загруженных отчётов' : 'из прошлой записи'})));
    });
    tbl.appendChild(tb);
    sec.appendChild(tbl);
    const oklad = ex ? ex.oklad : 80000, adv = ex ? ex.advance : 40000;
    sec.appendChild(h('div', {class: 'up-total'}, 'Премия 3% = ' + rub(total * 0.03) + ' · к доплате = ', h('strong', {text: rub(oklad - adv + total * 0.03)})));
    return sec;
  }

  function render(keepFocus) {
    const ym = currentMonth();
    S.month = ym;
    const wk = weeksOfMonth(ym);
    const hint = document.getElementById('up-weeks-hint');
    if (hint) hint.textContent = 'Недели для среза в Excel за выбранный месяц (правило «4+ дня»): ' + (wk.length ? wk[0] + '–' + wk[wk.length - 1] : '—');
    renderFiles(ym);
    const out = document.getElementById('up-feeds');
    // сохраняем положение прокрутки и фокус при перерисовке по вводу
    const y = window.scrollY;
    out.innerHTML = '';
    Object.keys(FEEDS).forEach(feed => out.appendChild(renderFeed(feed, ym)));
    out.appendChild(renderRop(ym));
    if (keepFocus) window.scrollTo(0, y);
    if (S.focusFeed) {
      const ta = document.querySelector('textarea[data-feed="' + S.focusFeed + '"]');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      S.focusFeed = null;
    }
    document.getElementById('up-apply').disabled = S.files.length === 0 && S.opiu.length === 0;
  }

  // ---------- запись в расчёты ----------
  async function apply() {
    const ym = currentMonth();
    const summary = [];
    Object.keys(FEEDS).forEach(feed => {
      if (!S.files.some(f => f.role.feed === feed)) return;
      const res = buildLines(feed);
      const rows = res.rows.map(r => ({name: r.name, profit: r.profit, plan: r.plan, margin: r.margin, catOverride: r.catOverride, ...(feed === 'wb' ? {drr: r.drr === undefined ? '' : r.drr} : {})}));
      let bonus = 0;
      rows.forEach(r => { bonus += computeFor(feed, r, ym).total; });
      if (feed === 'wb') {
        const hist = loadHistoryRaw(); const ex = hist[ym] || {};
        hist[ym] = {oklad: ex.oklad != null ? ex.oklad : TARIFFS[tariffForMonth(ym)].oklad, manualOklad: !!ex.manualOklad, rows};
        saveHistoryRaw(hist);
      } else if (feed === 'oz') {
        const hist = ozLoadHistoryRaw(); const ex = hist[ym] || {};
        hist[ym] = {oklad: ex.oklad != null ? ex.oklad : 25000, extra: ex.extra || 0,
          officialAdvance: ex.officialAdvance != null ? ex.officialAdvance : 5420, officialSalary: ex.officialSalary != null ? ex.officialSalary : 8314,
          advance: ex.advance != null ? ex.advance : 11000, rows};
        ozSaveHistoryRaw(hist);
        // платёж по ссуде списывается один раз за месяц (как при ручном «Сохранить»)
        const loan = ozLoadLoanState();
        if (!loan.paidMonths.includes(ym)) {
          const remaining = Math.max(0, (loan.total || 350000) - loan.paid);
          const ded = Math.min(5000, remaining);
          if (ded > 0) { loan.paid += ded; loan.paidMonths.push(ym); ozSaveLoanState(loan); }
        }
      } else {
        const hist = ymLoadHistoryRaw(); const ex = hist[ym] || {};
        hist[ym] = {oklad: ex.oklad != null ? ex.oklad : 25000, extra: ex.extra || 0,
          officialAdvance: ex.officialAdvance != null ? ex.officialAdvance : 5421, officialSalary: ex.officialSalary != null ? ex.officialSalary : 8314,
          advance: ex.advance != null ? ex.advance : 10000, rows};
        ymSaveHistoryRaw(hist);
      }
      summary.push(FEEDS[feed] + ': ' + rows.length + ' строк, бонусы ' + rub(bonus));
    });
    const sums = ropPreview(ym);
    if (Object.keys(sums).length) {
      const hist = ropLoadHistoryRaw(); const ex = hist[ym] || {oklad: 80000, advance: 40000, margins: {}};
      const m = ropMerge(ym, ex);
      ex.margins = m.margins; ex.cabinets = m.cabinets;
      hist[ym] = ex;
      ropSaveHistoryRaw(hist);
      summary.push('РОП: валовая маржа обновлена (' + Object.keys(sums).join(', ') + ')');
    }
    const st = document.getElementById('up-status');
    st.textContent = 'Записываю…';
    if (window.GitSync) await GitSync.flush();
    try { sessionStorage.setItem('upJustApplied', JSON.stringify({ym, summary})); } catch (e) {}
    location.reload();
  }

  // ---------- инициализация ----------
  function init() {
    const el = document.getElementById('tab-up');
    if (!el) return;
    const monthEl = document.getElementById('up-month');
    // по умолчанию — прошлый месяц (зарплата считается за прошедший)
    const now = new Date(); now.setDate(1); now.setMonth(now.getMonth() - 1);
    monthEl.value = now.toISOString().slice(0, 7);
    monthEl.addEventListener('change', () => render());
    const drop = document.getElementById('up-drop');
    const input = document.getElementById('up-file-input');
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files.length) addFiles(input.files); input.value = ''; });
    document.getElementById('up-apply').addEventListener('click', apply);
    document.getElementById('up-clear').addEventListener('click', () => { S.files = []; S.opiu = []; render(); });
    document.getElementById('up-replace').addEventListener('change', () => render());
    render();
    try {
      const done = JSON.parse(sessionStorage.getItem('upJustApplied') || 'null');
      if (done) {
        sessionStorage.removeItem('upJustApplied');
        document.querySelector('.tab-btn[data-tab="up"]').click();
        monthEl.value = done.ym;
        document.getElementById('up-status').textContent = '✓ Записано за ' + done.ym + ': ' + done.summary.join(' · ');
        render();
      }
    } catch (e) {}
  }

  window.UploadTab = {parsePlanText, weeksOfMonth, normName, addFiles, state: S, render};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
