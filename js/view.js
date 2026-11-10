/* Страница сотрудника: загружает зашифрованный снимок data/view/<u>.json, расшифровывает паролем и показывает расчёт (только просмотр). */
(function () {
  const ID = (new URLSearchParams(location.search).get('u') || '').toLowerCase();
  const VALID = ['wb', 'oz', 'ym', 'rop', 'as'];
  const $ = id => document.getElementById(id);
  const KEY = 'viewPw_' + ID;
  const rub = n => Math.round(n).toLocaleString('ru-RU') + ' ₽';
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const msg = (t, k) => { $('msg').textContent = t; $('msg').className = k || ''; };

  async function decrypt(file, pw) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({name: 'PBKDF2', salt: unb64(file.salt), iterations: file.iter, hash: 'SHA-256'}, base, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(file.iv)}, key, unb64(file.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function showMonth(app, snap, m) {
    app.querySelector('.body').textContent = '';
    const body = app.querySelector('.body');
    const head = el('div', 'card head');
    head.appendChild(el('div', 'lab', m.headline.label)); head.appendChild(el('div', 'val', rub(m.headline.value)));
    const grid = el('div', 'grid');
    m.summary.forEach(s => { const d = el('div'); d.appendChild(el('div', 'lab', s.label)); d.appendChild(el('div', 'val', rub(s.value))); grid.appendChild(d); });
    head.appendChild(grid); body.appendChild(head);
    if (m.payments) {
      const c = el('div', 'card'); c.appendChild(el('h2', null, 'Выплаты'));
      m.payments.filter(p => p.value || p.paid).forEach(p => {
        const r = el('div', 'pay'); const l = el('span', null, p.label);
        l.appendChild(el('span', 'tag' + (p.paid ? ' paid' : ''), p.paid ? 'выплачено ✓' : 'не выплачено'));
        r.appendChild(l); r.appendChild(el('b', null, rub(p.value))); c.appendChild(r);
      });
      body.appendChild(c);
    }
    if (m.table && m.table.rows.length) {
      const c = el('div', 'card'); c.appendChild(el('h2', null, 'Расчёт'));
      const sc = el('div', 'scroll'); const t = el('table'); const tr = el('tr');
      m.table.head.forEach(h => tr.appendChild(el('th', null, h))); const th = el('thead'); th.appendChild(tr); t.appendChild(th);
      const tb = el('tbody');
      m.table.rows.forEach(r => { const row = el('tr'); r.forEach((v, i) => row.appendChild(el('td', null, typeof v === 'number' && i > 0 ? (v >= 1000 || Number.isInteger(v) ? Math.round(v).toLocaleString('ru-RU') : String(v).replace('.', ',')) : String(v)))); tb.appendChild(row); });
      t.appendChild(tb); sc.appendChild(t); c.appendChild(sc);
      m.notes.forEach(n => c.appendChild(el('div', 'note', n)));
      body.appendChild(c);
    } else m.notes.forEach(n => body.appendChild(el('div', 'note', n)));
  }

  function show(snap) {
    $('login').style.display = 'none';
    const app = $('app'); app.style.display = 'block'; app.textContent = '';
    const top = el('div', 'top'); const left = el('div');
    left.appendChild(el('h1', null, snap.person || snap.title)); left.appendChild(el('p', 'sub', snap.title + (snap.updated ? ' · обновлено ' + new Date(snap.updated).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}) : '')));
    const out = el('button', 'link', 'Выйти'); out.addEventListener('click', () => { try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); });
    top.appendChild(left); top.appendChild(out); app.appendChild(top);
    if (!snap.months.length) { app.appendChild(el('div', 'card', 'Сохранённых расчётов пока нет.')); return; }
    const months = el('div', 'months'); app.appendChild(months); app.appendChild(el('div', 'body'));
    snap.months.forEach((m, i) => {
      const b = el('button', i === 0 ? 'on' : '', m.label);
      b.addEventListener('click', () => { months.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); showMonth(app, snap, m); });
      months.appendChild(b);
    });
    showMonth(app, snap, snap.months[0]);
  }

  async function open(pw, remember, silent) {
    if (!VALID.includes(ID)) return msg('Неверная ссылка', 'err');
    $('go').disabled = true; msg('Проверяю…');
    try {
      const r = await fetch('data/view/' + ID + '.json?t=' + Date.now(), {cache: 'no-store'});
      if (r.status === 404) return msg('Расчёт ещё не опубликован. Обратитесь к руководителю.', 'err');
      if (!r.ok) return msg('Не удалось загрузить данные (' + r.status + ')', 'err');
      let snap;
      try { snap = await decrypt(await r.json(), pw); }
      catch (e) { try { localStorage.removeItem(KEY); } catch (x) {} return msg(silent ? '' : 'Неверный пароль', 'err'); }
      if (remember) { try { localStorage.setItem(KEY, pw); } catch (e) {} }
      show(snap);
    } catch (e) { msg('Ошибка: ' + e.message, 'err'); }
    finally { $('go').disabled = false; }
  }

  $('form').addEventListener('submit', ev => { ev.preventDefault(); const pw = $('pw').value; if (pw) open(pw, $('rem').checked, false); });
  let saved = null; try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved) open(saved, true, true);
})();
