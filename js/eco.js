/* Данные из Оцифровки (data/economics.json): их раз в сутки кладёт в репозиторий GitHub Actions.
 * Общий загрузчик для вкладки «Загрузка отчётов» и для расчёта ассистента (объём закупки). */
(function () {
  const E = {data: null, error: '', loaded: false, _p: null};
  async function run() {
    E.error = '';
    try {
      if (!window.GitSync || !GitSync.configured()) throw new Error('подключите GitHub (кнопка «GitHub» сверху), тогда данные подтянутся сами');
      const text = await GitSync.readFile('data/economics.json');
      E.data = text ? JSON.parse(text) : null;
      if (!E.data) E.error = 'файл data/economics.json пока не создан — запустите «Экономика из Оцифровки» в Actions репозитория';
    } catch (e) { E.error = e.message || String(e); }
    E.loaded = true;
    window.dispatchEvent(new Event('eco-loaded'));
  }
  E.load = function () { return E._p || (E._p = run().finally(() => { E._p = null; })); };
  E.month = ym => (E.data && E.data.months && E.data.months[ym]) || null;
  // объём закупки за месяц: {total, byStage, to, full} или null
  E.purchases = ym => {
    const m = E.month(ym);
    return m && m.purchases && typeof m.purchases.total === 'number'
      ? {total: m.purchases.total, byStage: m.purchases.byStage || {}, to: m.to, full: !!m.full} : null;
  };
  window.EcoStore = E;
  const start = () => { E.load(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);
})();
