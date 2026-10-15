/* Панель «☁ GitHub»: настройки, ручные кнопки и баннер о более новых данных. */
(function () {
  const $ = id => document.getElementById(id);
  const panel = $('gh-panel');
  if (!panel || !window.GitSync) return;

  function fill() {
    const s = GitSync.loadSettings();
    $('gh-owner').value = s.owner; $('gh-repo').value = s.repo; $('gh-branch').value = s.branch;
    $('gh-path').value = s.path; $('gh-token').value = s.token; $('gh-auto').checked = !!s.auto;
  }
  function readForm() {
    const s = GitSync.loadSettings();
    const changedRepo = s.owner !== $('gh-owner').value.trim() || s.repo !== $('gh-repo').value.trim() ||
      s.branch !== ($('gh-branch').value.trim() || 'main') || s.path !== ($('gh-path').value.trim() || 'data/state.json');
    s.owner = $('gh-owner').value.trim(); s.repo = $('gh-repo').value.trim();
    s.branch = $('gh-branch').value.trim() || 'main'; s.path = $('gh-path').value.trim() || 'data/state.json';
    s.token = $('gh-token').value.trim(); s.auto = $('gh-auto').checked;
    if (changedRepo) s.lastSha = '';
    return s;
  }
  function setStatus(msg, kind) {
    const el = $('gh-status');
    el.textContent = msg; el.className = kind || '';
  }
  GitSync.onStatus(setStatus);

  $('gh-toggle-btn').addEventListener('click', () => panel.classList.toggle('open'));
  $('gh-save-settings').addEventListener('click', async () => {
    GitSync.saveSettings(readForm());
    setStatus('Настройки сохранены. Проверяю доступ…');
    const r = await GitSync.check();
    if (r.error) return;
    if (!r.exists) setStatus('Доступ есть. Файла данных в репозитории ещё нет — нажмите «Перезаписать данными этого браузера», чтобы создать его.', 'warn');
    else if (r.first) setStatus('Доступ есть. В репозитории уже лежат данные: нажмите «Загрузить из GitHub» (или «Перезаписать», если актуальны данные этого браузера).', 'warn');
    else setStatus('Доступ есть ✓', 'ok');
  });
  $('gh-pull').addEventListener('click', async () => {
    GitSync.saveSettings(readForm());
    try {
      if (!window.confirm('Заменить данные в этом браузере данными из GitHub?')) return;
      const r = await GitSync.pull();
      if (r && r.ok) setTimeout(() => location.reload(), 700);
    } catch (e) { setStatus(e.message, 'err'); }
  });
  $('gh-push').addEventListener('click', async () => {
    GitSync.saveSettings(readForm());
    try {
      if (!window.confirm('Перезаписать файл в GitHub данными этого браузера?')) return;
      await GitSync.push({force: true});
    } catch (e) { setStatus(e.message, 'err'); }
  });

  async function showBackups() {
    const box = $('gh-backups');
    box.textContent = 'Загружаю список…';
    try {
      const list = await GitSync.listBackups();
      box.textContent = '';
      if (!list.length) { box.textContent = 'Бэкапов пока нет.'; return; }
      list.forEach(f => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:3px 0';
        const t = document.createElement('span'); t.textContent = f.name; t.style.minWidth = '260px';
        const b = document.createElement('button'); b.className = 'up-btn ghost'; b.textContent = 'Восстановить';
        b.addEventListener('click', async () => {
          if (!window.confirm('Заменить текущие данные бэкапом ' + f.name + '? Перед этим будет сделана копия текущих.')) return;
          try { const r = await GitSync.restoreBackup(f.name); if (r && r.ok) setTimeout(() => location.reload(), 800); }
          catch (e) { setStatus(e.message, 'err'); }
        });
        row.appendChild(t); row.appendChild(b); box.appendChild(row);
      });
    } catch (e) { box.textContent = ''; setStatus(e.message, 'err'); }
  }
  $('gh-backup-now').addEventListener('click', async () => {
    GitSync.saveSettings(readForm());
    try { await GitSync.makeBackup(); if ($('gh-backups').textContent) showBackups(); } catch (e) { setStatus(e.message, 'err'); }
  });
  $('gh-backup-list').addEventListener('click', showBackups);

  fill();
  // при открытии: проверяем, нет ли в GitHub более свежих данных
  (async function () {
    if (!GitSync.configured()) return;
    const r = await GitSync.check();
    const banner = $('gh-banner');
    if (r && r.newer) {
      banner.style.display = 'block';
      banner.textContent = 'В GitHub есть более свежие данные, чем в этом браузере. Откройте «☁ GitHub» и нажмите «Загрузить из GitHub».';
    } else if (r && r.first && r.exists) {
      banner.style.display = 'block';
      banner.textContent = 'В репозитории уже есть данные. Откройте «☁ GitHub» и выберите «Загрузить из GitHub» или «Перезаписать».';
    }
  })();
})();
