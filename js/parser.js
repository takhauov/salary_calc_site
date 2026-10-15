/* Чтение экономических отчётов (.xlsm) прямо в браузере.
 *
 * Читаются только готовые (сохранённые в файле) значения из сводных листов:
 *   - лист по артикулам:  «По артикулам» (WB) / «Артикулы» (Озон) / «По Артикулам» (ЯМ)
 *       -> по каждому артикулу: операционная прибыль, реализация до СПП, штуки
 *   - лист «ОПиУ - месяцы» / «ОПиУ»: строка «Валовая маржа» по месяцам
 *
 * ВАЖНО: недели в срезах Excel (Power Pivot) выбираются в самом Excel до сохранения файла.
 * Программа читает то, что сохранено в файле, и показывает итоговую реализацию для контроля.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReportParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const ARTICLE_SHEETS = ['по артикулам', 'артикулы'];
  const OPIU_SHEETS = ['опиу - месяцы', 'опиу – месяцы', 'опиу'];
  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const lower = s => norm(s).toLowerCase();
  const num = v => {
    if (typeof v === 'number') return v;
    if (v == null || v === '') return 0;
    const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
  };

  function findSheet(names, candidates) {
    for (const c of candidates) {
      const hit = names.find(n => lower(n) === c);
      if (hit) return hit;
    }
    return null;
  }

  function sheetRows(XLSX, wb, name) {
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, {header: 1, raw: true, defval: null, blankrows: true});
  }

  // Название юрлица/кабинета, 
  function detectEntity(XLSX, wbAll, names) {
    const info = names.find(n => lower(n).startsWith('информационный'));
    if (!info) return '';
    const rows = sheetRows(XLSX, wbAll, info);
    const re = /^[А-ЯЁA-Z][а-яёa-z]+\d{4,}[А-Яа-яЁёA-Za-z]*$/;
    for (const r of rows) for (const c of r) {
      const s = norm(c);
      if (re.test(s)) return s;
    }
    return '';
  }

  function parseArticles(rows) {
    // шапка: строка, где есть ячейка ровно «Операционная прибыль»
    let h = -1;
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      if (rows[i] && rows[i].some(c => lower(c) === 'операционная прибыль')) { h = i; break; }
    }
    if (h < 0) throw new Error('Не нашёл столбец «Операционная прибыль» на листе по артикулам');
    const head = rows[h].map(norm);
    const idx = pred => head.findIndex(pred);
    const cProfit = idx(c => c.toLowerCase() === 'операционная прибыль');
    const cArt = idx(c => c.toLowerCase() === 'артикул продавца');
    const cRev = idx(c => /^(вся стоимость реализованного товара до спп|реализация до спп)$/i.test(c));
    const cUnits = idx(c => /^(итого кол-во реализованного товара|количество реализованного товара)$/i.test(c));
    const cName = idx(c => c.toLowerCase() === 'наименование товара');
    const cSize = idx(c => c.toLowerCase() === 'размер');
    const cGroup = idx(c => c.toLowerCase() === 'группа товаров');
    const cModel = idx(c => c.toLowerCase() === 'маркет модель');
    if (cArt < 0) throw new Error('Не нашёл столбец «Артикул продавца»');
    if (cRev < 0) throw new Error('Не нашёл столбец с реализацией до СПП');
    let market = 'wb';
    if (cModel >= 0) market = 'ym';
    else if (cGroup >= 0) market = 'oz';

    const byKey = new Map();
    let lastArt = '';
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const art = norm(r[cArt]);
      const profit = r[cProfit];
      if (!art && (profit == null || profit === '')) continue;
      if (/^(общий итог|итого)/i.test(art)) continue;
      // на листе WB строки с размерами идут без названия артикула — относим их к предыдущему артикулу
      let name = art;
      if (!name && cSize >= 0 && norm(r[cSize]) && lastArt) name = lastArt;
      if (!name) continue;
      lastArt = name;
      const key = name.toLowerCase();
      const cur = byKey.get(key) || {key, name, profit: 0, revenue: 0, units: 0, title: ''};
      cur.profit += num(profit);
      cur.revenue += num(r[cRev]);
      if (cUnits >= 0) cur.units += num(r[cUnits]);
      if (cName >= 0 && !cur.title) cur.title = norm(r[cName]);
      byKey.set(key, cur);
    }
    const articles = Array.from(byKey.values()).map(a => ({
      ...a,
      marginPct: a.revenue > 100 ? Math.round(a.profit / a.revenue * 10000) / 100 : 0,
    }));
    return {market, articles};
  }

  // Валовая маржа по месяцам с листа ОПиУ (берём первый блок столбцов — «основной»)
  function parseGross(rows) {
    let monthsRow = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const r = rows[i] || [];
      if (r.slice(0, 20).some(c => MONTHS.includes(lower(c)))) { monthsRow = i; break; }
    }
    if (monthsRow < 0) return {};
    const monthCols = {};
    const hr = rows[monthsRow];
    for (let c = 0; c < Math.min(hr.length, 20); c++) {
      const m = lower(hr[c]);
      if (MONTHS.includes(m) && !(m in monthCols)) monthCols[m] = c;
    }
    let grossRow = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      if (r.slice(0, 6).some(c => lower(c) === 'валовая маржа')) { grossRow = i; break; }
    }
    if (grossRow < 0) return {};
    const out = {};
    Object.keys(monthCols).forEach(m => { out[m] = num(rows[grossRow][monthCols[m]]); });
    return out;
  }

  function parseWorkbook(XLSX, data, fileName, opts) {
    opts = opts || {};
    const type = opts.type || 'array';
    const meta = XLSX.read(data, {type, bookSheets: true});
    const names = meta.SheetNames;
    const artName = findSheet(names, ARTICLE_SHEETS);
    if (!artName) throw new Error('Не нашёл лист «По артикулам» / «Артикулы» — это экономический отчёт?');
    const opiuName = findSheet(names, OPIU_SHEETS);
    const infoName = names.find(n => lower(n).startsWith('информационный'));
    const wanted = [artName, opiuName, infoName].filter(Boolean);
    const wb = XLSX.read(data, {type, sheets: wanted, dense: false, cellFormula: false, cellStyles: false, cellHTML: false});
    const art = parseArticles(sheetRows(XLSX, wb, artName));
    const gross = opiuName ? parseGross(sheetRows(XLSX, wb, opiuName)) : {};
    const entity = detectEntity(XLSX, wb, names);
    const totals = art.articles.reduce((t, a) => ({profit: t.profit + a.profit, revenue: t.revenue + a.revenue}), {profit: 0, revenue: 0});
    return {
      fileName: fileName || '',
      market: art.market,
      entity,
      articleSheet: artName,
      articles: art.articles,
      gross,           // {'сентябрь': 253764.91, ...}
      totals,
    };
  }

  return {parseWorkbook, parseArticles, parseGross, MONTHS};
});
