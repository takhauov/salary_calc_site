/* Синхронизация данных с GitHub.
 *
 * Все данные расчётов (те же ключи, что и в «Экспорт бэкапа») хранятся одним файлом data/state.json
 * в вашем ПРИВАТНОМ репозитории. Сайт читает и пишет его через GitHub API с токеном,
 * который вы один раз вводите в этом браузере (токен хранится только здесь, в localStorage).
 *
 * Правила безопасности записи:
 *  - автосохранение происходит только если с момента нашей последней записи файл на GitHub не менялся;
 *  - если там более свежие данные, сайт ничего не затирает, а предлагает загрузить их или перезаписать вручную.
 */
(function () {
  const SETTINGS_KEY = 'ghSyncSettings_v1';
  const STATE_KEYS = ['wbSalaryHistory_v1', 'ozonSalaryHistory_v1', 'ozonLoanState_v1', 'ymSalaryHistory_v1',
    'ropSalaryHistory_v1', 'asSalaryHistory_v1', 'vedSalaryHistory_v1', 'upMappings_v1'];
  const DEFAULTS = {owner: '', repo: '', branch: 'main', path: 'data/state.json', token: '', auto: true, lastSha: ''};

  let timer = null;
  let busy = false;
  let dirty = false;
  const listeners = [];

  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function configured(s) { s = s || loadSettings(); return !!(s.owner && s.repo && s.token); }

  function status(msg, kind) {
    listeners.forEach(fn => { try { fn(msg, kind || 'info'); } catch (e) {} });
  }

  function collectState() {
    const state = {};
    STATE_KEYS.forEach(k => {
      try {
        const raw = localStorage.getItem(k);
        if (raw != null) state[k] = JSON.parse(raw);
      } catch (e) {}
    });
    return state;
  }

  function applyState(state) {
    STATE_KEYS.forEach(k => {
      if (state[k] !== undefined) localStorage.setItem(k, JSON.stringify(state[k]));
    });
  }

  // UTF-8 <-> base64
  function toB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fromB64(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function url(s) {
    const p = s.path.split('/').map(encodeURIComponent).join('/');
    return 'https://api.github.com/repos/' + encodeURIComponent(s.owner) + '/' + encodeURIComponent(s.repo) + '/contents/' + p;
  }
  function headers(s) {
    return {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + s.token,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async function fetchRemote(s) {
    const r = await fetch(url(s) + '?ref=' + encodeURIComponent(s.branch), {headers: headers(s), cache: 'no-store'});
    if (r.status === 404) return {exists: false};
    if (r.status === 401 || r.status === 403) throw new Error('GitHub отказал в доступе: проверьте токен и права (Contents: Read and write) на этот репозиторий');
    if (!r.ok) throw new Error('GitHub вернул ошибку ' + r.status);
    const j = await r.json();
    let content = j.content;
    if (j.encoding !== 'base64' || content == null || content === '') {
      // файл больше 1 МБ или API не вернул содержимое — запросим «сырым»
      const rr = await fetch(url(s) + '?ref=' + encodeURIComponent(s.branch), {headers: Object.assign({}, headers(s), {Accept: 'application/vnd.github.raw+json'}), cache: 'no-store'});
      if (!rr.ok) throw new Error('Не удалось прочитать файл из GitHub (' + rr.status + ')');
      return {exists: true, sha: j.sha, text: await rr.text()};
    }
    return {exists: true, sha: j.sha, text: fromB64(content)};
  }

  async function push(opts) {
    opts = opts || {};
    const s = loadSettings();
    if (!configured(s)) throw new Error('Сначала заполните настройки GitHub');
    if (busy) return;
    busy = true;
    try {
      status('Сохраняю в GitHub…');
      const remote = await fetchRemote(s);
      if (remote.exists && !opts.force && s.lastSha && remote.sha !== s.lastSha) {
        status('В GitHub лежат более новые данные. Нажмите «Загрузить из GitHub» (или «Перезаписать»).', 'warn');
        return {conflict: true};
      }
      if (remote.exists && !opts.force && !s.lastSha) {
        status('В репозитории уже есть данные. Нажмите «Загрузить из GitHub» или «Перезаписать».', 'warn');
        return {conflict: true};
      }
      const body = {
        message: 'Расчёт ЗП: обновление данных ' + new Date().toISOString().slice(0, 16).replace('T', ' '),
        content: toB64(JSON.stringify(collectState(), null, 2)),
        branch: s.branch,
      };
      if (remote.exists) body.sha = remote.sha;
      const r = await fetch(url(s), {method: 'PUT', headers: Object.assign({'Content-Type': 'application/json'}, headers(s)), body: JSON.stringify(body)});
      if (r.status === 409 || r.status === 422) {
        status('Файл в GitHub изменился во время сохранения. Нажмите «Загрузить из GitHub».', 'warn');
        return {conflict: true};
      }
      if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error('Нет прав на запись в репозиторий (' + r.status + ')');
      if (!r.ok) throw new Error('GitHub вернул ошибку ' + r.status);
      const j = await r.json();
      s.lastSha = j.content && j.content.sha ? j.content.sha : '';
      saveSettings(s);
      dirty = false;
      status('Сохранено в GitHub ✓ ' + new Date().toLocaleTimeString('ru-RU'), 'ok');
      dailyBackup().catch(() => {});
      return {ok: true};
    } finally {
      busy = false;
    }
  }

  async function pull() {
    const s = loadSettings();
    if (!configured(s)) throw new Error('Сначала заполните настройки GitHub');
    status('Загружаю из GitHub…');
    const remote = await fetchRemote(s);
    if (!remote.exists) { status('В репозитории ещё нет файла ' + s.path + '. Нажмите «Перезаписать», чтобы создать.', 'warn'); return {empty: true}; }
    const state = JSON.parse(remote.text);
    applyState(state);
    s.lastSha = remote.sha;
    saveSettings(s);
    dirty = false;
    status('Загружено из GitHub ✓', 'ok');
    return {ok: true};
  }

  async function check() {
    const s = loadSettings();
    if (!configured(s)) return {configured: false};
    try {
      const remote = await fetchRemote(s);
      if (!remote.exists) return {configured: true, exists: false};
      return {configured: true, exists: true, newer: !!s.lastSha && remote.sha !== s.lastSha, first: !s.lastSha};
    } catch (e) {
      status(e.message, 'err');
      return {configured: true, error: e.message};
    }
  }

  // ---------- бэкапы: data/backups/state-ГГГГ-ММ-ДД.json ----------
  const KEEP_BACKUPS = 60;
  function dirOf(s) { return s.path.replace(/[^/]*$/, '') + 'backups'; }
  function bUrl(s, name) {
    const p = (dirOf(s) + (name ? '/' + name : '')).split('/').map(encodeURIComponent).join('/');
    return 'https://api.github.com/repos/' + encodeURIComponent(s.owner) + '/' + encodeURIComponent(s.repo) + '/contents/' + p;
  }
  async function listBackups() {
    const s = loadSettings();
    if (!configured(s)) throw new Error('Сначала заполните настройки GitHub');
    const r = await fetch(bUrl(s) + '?ref=' + encodeURIComponent(s.branch), {headers: headers(s), cache: 'no-store'});
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('GitHub вернул ошибку ' + r.status);
    const j = await r.json();
    return j.filter(f => /\.json$/.test(f.name)).map(f => ({name: f.name, sha: f.sha})).sort((a, b) => a.name < b.name ? 1 : -1);
  }
  async function putBackup(name, text) {
    const s = loadSettings();
    const r = await fetch(bUrl(s, name), {method: 'PUT', headers: Object.assign({'Content-Type': 'application/json'}, headers(s)),
      body: JSON.stringify({message: 'Бэкап ' + name, content: toB64(text), branch: s.branch})});
    if (r.status === 422) return {exists: true};
    if (!r.ok) throw new Error('Не удалось создать бэкап (' + r.status + ')');
    return {ok: true};
  }
  async function pruneBackups(list) {
    const s = loadSettings();
    const auto = list.filter(f => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f.name));
    for (const f of auto.slice(KEEP_BACKUPS)) {
      await fetch(bUrl(s, f.name), {method: 'DELETE', headers: Object.assign({'Content-Type': 'application/json'}, headers(s)),
        body: JSON.stringify({message: 'Удаление старого бэкапа ' + f.name, sha: f.sha, branch: s.branch})});
    }
  }
  async function makeBackup(name) {
    const s = loadSettings();
    if (!configured(s)) throw new Error('Сначала заполните настройки GitHub');
    name = name || ('manual-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json');
    const r = await putBackup(name, JSON.stringify(collectState(), null, 2));
    status(r.exists ? 'Бэкап с таким именем уже есть' : 'Бэкап создан: ' + name, r.exists ? 'warn' : 'ok');
    return r;
  }
  async function dailyBackup() {
    const s = loadSettings();
    const day = new Date().toISOString().slice(0, 10);
    if (!configured(s) || s.lastBackupDay === day) return;
    const r = await putBackup('state-' + day + '.json', JSON.stringify(collectState(), null, 2));
    s.lastBackupDay = day; saveSettings(Object.assign(loadSettings(), {lastBackupDay: day}));
    if (r.ok) { try { await pruneBackups(await listBackups()); } catch (e) {} }
  }
  async function restoreBackup(name) {
    const s = loadSettings();
    const r = await fetch(bUrl(s, name) + '?ref=' + encodeURIComponent(s.branch), {headers: Object.assign({}, headers(s), {Accept: 'application/vnd.github.raw+json'}), cache: 'no-store'});
    if (!r.ok) throw new Error('Не удалось прочитать бэкап (' + r.status + ')');
    const state = JSON.parse(await r.text());
    await putBackup('before-restore-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json', JSON.stringify(collectState(), null, 2));
    applyState(state);
    status('Данные восстановлены из ' + name + '. Сохраняю в GitHub…', 'ok');
    await push({force: true});
    return {ok: true};
  }

  function schedule() {
    const s = loadSettings();
    if (!configured(s) || !s.auto) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { push().catch(e => status(e.message, 'err')); }, 3000);
  }

  // дожидается отправки несохранённых изменений (нужно перед перезагрузкой страницы)
  async function flush() {
    clearTimeout(timer);
    if (dirty && configured() && loadSettings().auto) {
      try { await push(); } catch (e) { status(e.message, 'err'); }
    }
  }

  // отслеживаем записи в наши ключи, чтобы автоматически отправлять изменения
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    origSet.apply(this, arguments);
    if (this === window.localStorage && STATE_KEYS.indexOf(k) >= 0) schedule();
  };

  window.GitSync = {
    STATE_KEYS, loadSettings, saveSettings, configured, collectState, applyState,
    push, pull, check, flush, listBackups, makeBackup, restoreBackup, onStatus: fn => listeners.push(fn),
  };
})();
