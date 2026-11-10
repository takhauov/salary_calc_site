/* Доступ сотрудников: у каждого сотрудника — свой зашифрованный «снимок» его расчёта (только просмотр).
 *
 * Как это работает:
 *  - владелец (этот браузер) для каждого сотрудника задаёт пароль;
 *  - сайт собирает снимок расчёта сотрудника (итоги, таблица, выплаты по ведомости), шифрует его паролем
 *    (PBKDF2-SHA256 + AES-GCM) и кладёт файл data/view/<id>.json в публичный репозиторий сайта;
 *  - сотрудник открывает view.html?u=<id>, вводит пароль и видит только свой расчёт. Расшифровка — в его браузере.
 * Пароли хранятся только в этом браузере (ключ viewAccess_v1), в GitHub и в бэкапы НЕ попадают.
 */
(function () {
  const KEY = 'viewAccess_v1';
  const PEOPLE = [
    {id: 'wb', title: 'Менеджер ВБ', source: 'wb'},
    {id: 'oz', title: 'Менеджер Озон', source: 'oz'},
    {id: 'ym', title: 'Менеджер ЯМ', source: 'ym'},
    {id: 'rop', title: 'РОП', source: 'rop'},
    {id: 'as', title: 'Ассистент', source: 'as'},
  ];
  const ITER = 250000;
  const MIN_PW = 8;

  function load() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
    return Object.assign({siteRepo: 'salary_calc_site', branch: 'main', auto: true, pw: {}, hashes: {}}, c);
  }
  function save(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {} }

  // ---------- снимок расчёта ----------
  const num = v => Math.round((parseFloat(v) || 0) * 100) / 100;
  const FIELDS = [['advOf', 'Аванс официальный'], ['advNeof', 'Аванс неофициальный'], ['salOf', 'ЗП официальная'], ['salNeof', 'ЗП неофициальная'], ['prem', 'Премия']];

  function monthsOf(source) {
    const hist = ({wb: loadHistoryRaw, oz: ozLoadHistoryRaw, ym: ymLoadHistoryRaw, rop: ropLoadHistoryRaw, as: asLoadHistoryRaw})[source]();
    return {hist, months: Object.keys(hist).sort().reverse()};
  }

  function longMonth(ym) {
    const names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    const [y, m] = ym.split('-');
    return names[parseInt(m, 10) - 1] + ' ' + y;
  }

  function rowsTable(rowsIn, computeFn, extraCols) {
    return rowsIn.map(r => {
      const c = computeFn(r);
      const cells = [r.name || '—', num(r.profit), c.cat || '—', r.plan === '' || r.plan == null ? '—' : num(r.plan), r.margin === '' || r.margin == null ? '—' : num(r.margin), c.planBonus, c.marginBonus];
      if (extraCols) cells.push(c.drrBonus || 0);
      cells.push(c.total);
      return cells;
    });
  }

  function payments(source, ym) {
    const rec = vedLoadHistoryRaw()[ym];
    if (!rec || !rec.roster) return null;
    const row = rec.roster.find(r => r.source === source);
    if (!row) return null;
    const eff = vedEffective(row, ym);
    return FIELDS.map(([f, label]) => ({label, value: num(eff[f].value), paid: !!(row.paid && row.paid[f])}));
  }

  function personName(source) {
    for (const ym of Object.keys(vedLoadHistoryRaw()).sort().reverse()) {
      const row = ((vedLoadHistoryRaw()[ym] || {}).roster || []).find(r => r.source === source);
      if (row && row.name) return row.name;
    }
    return '';
  }

  function monthBlock(p, ym, hist) {
    const auto = vedGetAutoData(p.source, ym) || {};
    const h = hist[ym];
    const m = {ym, label: longMonth(ym), summary: [], table: null, payments: payments(p.source, ym), notes: []};
    const pay = (auto.salNeof || 0) + (auto.prem || 0);
    if (p.source === 'wb') {
      const tk = tariffForMonth(ym), t = TARIFFS[tk];
      const oklad = h.manualOklad ? h.oklad : t.oklad;
      const bonus = h.rows.reduce((a, r) => a + computeRow(r, tk).total, 0);
      m.headline = {label: 'К доплате за месяц', value: num(pay)};
      m.summary = [['Оклад', oklad], ['Аванс (оклад/2)', oklad / 2], ['Сумма бонусов', bonus], ['Доп. премия', h.extra || 0], ['Начислено всего', oklad + bonus + (h.extra || 0)]];
      const hasDrr = !!t.hasDRR;
      m.table = {head: ['Артикул', 'Маржинальная прибыль, ₽', 'Категория', '% плана', '% маржинальности', 'Бонус за план', 'Бонус за маржу'].concat(hasDrr ? ['Бонус за ДРР'] : []).concat(['Итого бонус']),
        rows: rowsTable(h.rows, r => computeRow(r, tk), hasDrr)};
    } else if (p.source === 'oz' || p.source === 'ym') {
      const fn = p.source === 'oz' ? ozComputeRow : ymComputeRow;
      const bonus = h.rows.reduce((a, r) => a + fn(r).total, 0);
      m.headline = {label: 'К доплате в конце месяца', value: num(pay)};
      m.summary = [['Оклад', h.oklad], ['Сумма бонусов', bonus], ['Доп. премия', h.extra || 0], ['Начислено всего', h.oklad + bonus + (h.extra || 0)],
        ['Официально (аванс + ЗП)', (h.officialAdvance || 0) + (h.officialSalary || 0)], ['Неофициальный аванс', h.advance || 0]];
      m.table = {head: ['Артикул', 'Маржинальная прибыль, ₽', 'Категория', '% плана', '% маржинальности', 'Бонус за план', 'Бонус за маржу', 'Итого бонус'], rows: rowsTable(h.rows, fn, false)};
      if (p.source === 'oz') m.notes.push('Погашение займа (если есть) учтено в неофициальной ЗП.');
    } else if (p.source === 'rop') {
      let marginSum = 0;
      const rows = [];
      ROP_DIRECTIONS.forEach(d => { const v = parseFloat(h.margins && h.margins[d]) || 0; if (v) { rows.push([d, num(v)]); marginSum += v; } });
      m.headline = {label: 'К доплате за месяц', value: num(pay)};
      m.summary = [['Оклад', h.oklad], ['Аванс (неофициальный)', h.advance || 0], ['Официально (аванс + ЗП)', (h.officialAdvance || 0) + (h.officialSalary || 0)],
        ['Маржа после налогов, всего', marginSum], ['Премия (3%)', marginSum * 0.03], ['Начислено всего', h.oklad + marginSum * 0.03]];
      m.table = {head: ['Направление', 'Маржа после налогов, ₽'], rows};
    } else if (p.source === 'as') {
      const e = asWithAuto(h, ym), r = asCalc(e);
      m.headline = {label: 'ЗП неофициально', value: num(r.salNeof)};
      m.summary = [['Аванс всего', r.advOf + r.advNeof], ['Премия (блогеры + закупки + школы)', r.salNeof - AS_BASE_SALARY], ['ЗП официально', r.salOf], ['Итого начислено', r.total]];
      m.table = {head: ['Составляющая', 'Сумма, ₽'], rows: [
        ['Аванс неофициальный (фикс)', r.advNeof], ['Официальный аванс', r.advOf], ['ЗП неофициальная (фикс)', AS_BASE_SALARY], ['Официальная ЗП', r.salOf],
        ['Доплата за блогеров', num(e.bloggers)], ['Доплата за закупки (1% от ' + Math.round(num(e.purchaseVolume)).toLocaleString('ru-RU') + ' ₽)', r.purchaseBonus], ['Доплата за поиск товара для школ', num(e.schools)]]};
    }
    m.summary = m.summary.map(([label, value]) => ({label, value: num(value)}));
    return m;
  }

  function buildSnapshot(id) {
    const p = PEOPLE.find(x => x.id === id);
    const {hist, months} = monthsOf(p.source);
    return {v: 1, id, title: p.title, person: personName(p.source), months: months.map(ym => monthBlock(p, ym, hist))};
  }

  // ---------- шифрование ----------
  const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  async function deriveKey(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256'}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(obj, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, ITER);
    const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(obj))));
    return {v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct)};
  }
  async function sha256hex(text) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return Array.from(d).map(x => x.toString(16).padStart(2, '0')).join('');
  }

  // ---------- публикация в публичный репозиторий сайта ----------
  function ghHeaders(token) { return {'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28'}; }
  async function putFile(cfg, id, text) {
    const s = GitSync.loadSettings();
    if (!GitSync.configured(s)) throw new Error('Сначала подключите GitHub (кнопка «☁ GitHub»)');
    const base = 'https://api.github.com/repos/' + encodeURIComponent(s.owner) + '/' + encodeURIComponent(cfg.siteRepo);
    const repo = await fetch(base, {headers: ghHeaders(s.token), cache: 'no-store'});
    if (repo.status === 404 || repo.status === 403 || repo.status === 401) throw new Error('У токена нет доступа к репозиторию сайта «' + cfg.siteRepo + '». Добавьте этот репозиторий в токен (Contents: Read and write).');
    const url = base + '/contents/data/view/' + id + '.json';
    const cur = await fetch(url + '?ref=' + encodeURIComponent(cfg.branch), {headers: ghHeaders(s.token), cache: 'no-store'});
    const body = {message: 'Снимок расчёта: ' + id, content: btoa(text), branch: cfg.branch};
    if (cur.ok) body.sha = (await cur.json()).sha;
    else if (cur.status !== 404) throw new Error('GitHub вернул ошибку ' + cur.status);
    const r = await fetch(url, {method: 'PUT', headers: Object.assign({'Content-Type': 'application/json'}, ghHeaders(s.token)), body: JSON.stringify(body)});
    if (!r.ok) throw new Error('Не удалось записать снимок (' + r.status + ')');
  }

  async function publish(id, opts) {
    opts = opts || {};
    const cfg = load();
    const pw = (cfg.pw[id] || '').trim();
    if (pw.length < MIN_PW) return {skipped: 'no-password'};
    const snap = buildSnapshot(id);
    const fp = await sha256hex(pw + '|' + JSON.stringify(snap));
    if (!opts.force && cfg.hashes[id] === fp) return {skipped: 'unchanged'};
    snap.updated = new Date().toISOString();
    const enc = await encrypt(snap, pw);
    await putFile(cfg, id, JSON.stringify(enc));
    const c2 = load(); c2.hashes[id] = fp; save(c2);
    return {ok: true};
  }

  async function publishAll(opts) {
    const res = {};
    for (const p of PEOPLE) { res[p.id] = await publish(p.id, opts); }
    return res;
  }

  window.Access = {PEOPLE, load, save, buildSnapshot, encrypt, publish, publishAll, MIN_PW};

  // ---------- интерфейс ----------
  const $ = id => document.getElementById(id);
  const panel = $('access-panel');
  if (!panel) return;
  const viewUrl = id => new URL('view.html?u=' + id, location.href).href;
  function setMsg(el, text, kind) { el.textContent = text; el.className = 'acc-msg ' + (kind || ''); }
  function genPassword() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const a = crypto.getRandomValues(new Uint32Array(14));
    return Array.from(a).map(x => alphabet[x % alphabet.length]).join('');
  }
  function render() {
    const cfg = load();
    $('acc-site-repo').value = cfg.siteRepo; $('acc-auto').checked = !!cfg.auto;
    const box = $('acc-list'); box.textContent = '';
    PEOPLE.forEach(p => {
      const row = document.createElement('div'); row.className = 'acc-row';
      row.innerHTML = '<div class="acc-name"><b></b><span class="acc-who"></span></div>' +
        '<input type="text" class="acc-pw" autocomplete="off" placeholder="пароль, от 8 знаков">' +
        '<button class="up-btn ghost acc-gen">Придумать</button>' +
        '<button class="up-btn acc-pub">Опубликовать</button>' +
        '<button class="up-btn ghost acc-copy">Скопировать ссылку</button><span class="acc-msg"></span>';
      row.querySelector('b').textContent = p.title;
      let who = ''; try { who = personName(p.source); } catch (e) {}
      row.querySelector('.acc-who').textContent = who ? ' — ' + who : '';
      const pw = row.querySelector('.acc-pw'); pw.value = cfg.pw[p.id] || '';
      const msg = row.querySelector('.acc-msg');
      pw.addEventListener('input', () => { const c = load(); c.pw[p.id] = pw.value; save(c); });
      row.querySelector('.acc-gen').addEventListener('click', () => { pw.value = genPassword(); pw.dispatchEvent(new Event('input')); setMsg(msg, 'Пароль создан — нажмите «Опубликовать» и передайте сотруднику ссылку и пароль', 'warn'); });
      row.querySelector('.acc-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(viewUrl(p.id)); setMsg(msg, 'Ссылка скопирована', 'ok'); } catch (e) { setMsg(msg, viewUrl(p.id), ''); }
      });
      row.querySelector('.acc-pub').addEventListener('click', async () => {
        setMsg(msg, 'Публикую…', '');
        try {
          if ((pw.value || '').trim().length < MIN_PW) return setMsg(msg, 'Пароль должен быть не короче ' + MIN_PW + ' знаков', 'err');
          await publish(p.id, {force: true}); setMsg(msg, 'Опубликовано ✓ ' + new Date().toLocaleTimeString('ru-RU') + '. Ссылка: ' + viewUrl(p.id), 'ok');
        } catch (e) { setMsg(msg, e.message, 'err'); }
      });
      box.appendChild(row);
    });
  }
  $('access-toggle-btn').addEventListener('click', () => { panel.classList.toggle('open'); if (panel.classList.contains('open')) render(); });
  $('acc-site-repo').addEventListener('change', () => { const c = load(); c.siteRepo = $('acc-site-repo').value.trim() || 'salary_calc_site'; c.hashes = {}; save(c); });
  $('acc-auto').addEventListener('change', () => { const c = load(); c.auto = $('acc-auto').checked; save(c); });
  $('acc-pub-all').addEventListener('click', async () => {
    const st = $('acc-status'); setMsg(st, 'Публикую всех…', '');
    try {
      const r = await publishAll({force: true});
      const n = Object.values(r).filter(x => x.ok).length, skip = Object.values(r).filter(x => x.skipped === 'no-password').length;
      setMsg(st, 'Опубликовано: ' + n + (skip ? '. Без пароля пропущено: ' + skip : ''), 'ok');
    } catch (e) { setMsg(st, e.message, 'err'); }
  });
  // после каждого автосохранения данных в GitHub — обновляем снимки (только изменившиеся)
  let t = null;
  GitSync.onSaved(() => {
    if (!load().auto) return;
    clearTimeout(t);
    t = setTimeout(() => { publishAll().then(r => { const n = Object.values(r).filter(x => x.ok).length; if (n) setMsg($('acc-status'), 'Снимки обновлены: ' + n + ' ✓ ' + new Date().toLocaleTimeString('ru-RU'), 'ok'); }).catch(e => setMsg($('acc-status'), e.message, 'err')); }, 4000);
  });
})();
