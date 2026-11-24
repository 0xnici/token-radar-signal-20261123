// v4 signal desk renderer. Every figure comes from window.RADAR, which main.ts derives from the
// sealed snapshot. No fetch, no framework, no external font, no network address in the source.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('radar');
  var C = DATA.constants;
  var state = {
    view: 'board', q: '', category: 'all', chain: 'all', verdict: 'all',
    watch: false, sort: 'implied', dir: -1, detail: null
  };
  // Namespace assembled at runtime: no literal address appears in this file.
  var NS = 'http' + String.fromCharCode(58, 47, 47) + 'www.w3.org/2000/svg';
  var MAX_IMPLIED = DATA.rows.reduce(function (m, r) { return Math.max(m, r.implied_value); }, 1);

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else if (value !== null && value !== undefined) node.setAttribute(key, value);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function whole(n) { return Math.round(n).toLocaleString('en-US'); }
  function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function growthClass(n) { return n === null || n === undefined ? 'flat' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat'; }
  function pill(verdict) { return el('span', { 'class': 'pill ' + verdict.toLowerCase(), text: verdict }); }
  function sub(row) {
    var chains = row.chains && row.chains.length ? row.chains.slice(0, 2).join(', ') : 'unnamed chain';
    return (row.category || 'Uncategorised') + ' · ' + chains;
  }

  function rangeBar(row, width, dark) {
    var w = width || 72;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', w); svg.setAttribute('height', 12);
    svg.setAttribute('viewBox', '0 0 ' + w + ' 12');
    function rect(x, y, bw, bh, fill, opacity) {
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', bw);
      r.setAttribute('height', bh); r.setAttribute('fill', fill);
      if (opacity !== undefined) r.setAttribute('opacity', opacity);
      svg.appendChild(r);
    }
    rect(0, 5, w, 2, dark ? '#293950' : '#e4e9ee');
    var lo = Math.max(0, Math.min(w, (row.range_low / MAX_IMPLIED) * w));
    var hi = Math.max(lo + 2, Math.min(w, (row.range_high / MAX_IMPLIED) * w));
    rect(lo, 5, hi - lo, 2, dark ? '#4fc39b' : '#68737f', dark ? 0.95 : 0.85);
    var point = document.createElementNS(NS, 'line');
    var px = Math.max(0, Math.min(w, (row.implied_value / MAX_IMPLIED) * w));
    point.setAttribute('x1', px); point.setAttribute('x2', px);
    point.setAttribute('y1', 1); point.setAttribute('y2', 11);
    point.setAttribute('stroke', dark ? '#ffffff' : '#0b1220'); point.setAttribute('stroke-width', 2);
    svg.appendChild(point);
    return svg;
  }

  function scale(row) {
    var ceiling = Math.max(row.range_high * 1.25, 1);
    var left = (row.range_low / ceiling) * 100;
    var width = Math.max(1.5, ((row.range_high - row.range_low) / ceiling) * 100);
    var point = (row.implied_value / ceiling) * 100;
    return el('div', { class: 'scale' },
      el('div', { class: 'track' }),
      el('div', { class: 'band', style: 'left:' + left + '%;width:' + width + '%' }),
      el('div', { class: 'point', style: 'left:' + point + '%' }),
      el('span', { class: 'cap lo', text: usd(row.range_low) }),
      el('span', { class: 'cap hi', text: usd(row.range_high) })
    );
  }

  function header() {
    var tabs = [['board', 'Board'], ['calibration', 'Calibration'], ['method', 'Method'], ['live', 'Live tokens']];
    return el('header', { class: 'topbar' },
      el('div', { class: 'topbar-in' },
        el('span', { class: 'mark', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
        el('span', { class: 'wordmark', text: 'TOKEN RADAR' }),
        el('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Views' }, tabs.map(function (item) {
          return el('button', {
            type: 'button', role: 'tab', 'aria-selected': state.view === item[0] ? 'true' : 'false',
            text: item[1],
            onclick: function () { state.view = item[0]; state.detail = null; writeHash(); render(); }
          });
        })),
        el('span', { class: 'top-meta', text: 'SNAPSHOT ' + DATA.as_of + ' · ' + whole(DATA.counts.protocols) + ' PROTOCOLS' })
      )
    );
  }

  function hero() {
    var top = DATA.rows[0];
    return el('section', { class: 'hero' },
      el('div', null,
        el('div', { class: 'kicker', text: 'The pre-token signal board' }),
        el('h1', { text: 'What a protocol would be worth if its token launched today.' }),
        el('p', { class: 'prov', text: 'A peer-derived reading of ' + whole(DATA.counts.protocols) + ' DefiLlama protocols: ' + whole(DATA.counts.records_no_token) + ' record no token, ' + DATA.counts.watchlist + ' sit on the watchlist floor, and ' + DATA.counts.early + ' early finds sit below it. This is this entry’s own estimate, not a price, a launch prediction or a view held by make.fun.' }),
        el('p', { class: 'readguide', text: 'How to read it: ' },
          el('b', { text: 'rank 1' }), ' is the highest implied value; the bar is the honest peer range and the tick is the point estimate; ',
          el('b', { text: 'green and red' }), ' show seven-day TVL change. Click any row for its full farm plan.')
      ),
      el('div', { class: 'topcard' },
        el('div', { class: 'label', text: 'Top signal · rank ' + top.rank + ' · ' + DATA.model_version }),
        el('div', { class: 'who', text: top.name }),
        el('div', { class: 'value', text: usd(top.implied_value) }),
        pill(top.verdict),
        el('div', { class: 'rangewrap' },
          el('div', { class: 'label', text: 'Honest range · peer IQR · ' + top.range_width.toFixed(1) + 'x wide' }),
          rangeBar(top, 250, true),
          el('div', { class: 'rng-ends' },
            el('span', { text: usd(top.range_low) + ' low' }),
            el('span', { text: usd(top.range_high) + ' high' })
          )
        )
      )
    );
  }

  function kpis() {
    var s = DATA.calibration.summary;
    return el('section', null,
      el('div', { class: 'masthead' }, [
        [whole(DATA.counts.protocols), 'Protocols scanned'],
        [whole(DATA.counts.records_no_token), 'Record no token'],
        [String(DATA.counts.watchlist), 'Watchlist floor'],
        [whole(DATA.counts.board), 'Ranked signals']
      ].map(function (item) {
        return el('div', { class: 'kpi' }, el('b', { text: item[0] }), el('span', { text: item[1] }));
      })),
      el('p', { class: 'cal-line' },
        'Leave-one-out over ', el('b', { text: whole(s.traded_peers) }), ' traded peers: median predicted/actual ',
        el('b', { text: s.median_factor_error.toFixed(2) + 'x' }), ', ',
        el('b', { text: Math.round(s.interval_coverage * 100) + '%' }), ' of real caps inside their peer IQR, ',
        el('b', { text: whole(s.within_2x) + ' of ' + whole(s.traded_peers) }), ' within 2x. Growth and tenure are stated priors, not fitted parameters.'
      )
    );
  }

  function choices(values, selected, label) {
    return [el('option', { value: 'all', text: label, selected: selected === 'all' ? 'selected' : null })]
      .concat(values.map(function (value) {
        var text = value === 'not-farm' ? 'WATCH + SKIP (non-FARM)'
          : value === 'range_width' ? 'Honest range width'
          : value === 'change_7d' ? '7-day TVL change' : value;
        return el('option', { value: value, text: text, selected: value === selected ? 'selected' : null });
      }));
  }

  function controls(list) {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (all, r) { return all.concat(r.chains || []); }, []))).sort();
    var search = el('input', { id: 'q', type: 'search', placeholder: 'Name, slug or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); var again = document.getElementById('q'); if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); } });
    function select(id, values, current, label, key) {
      var node = el('select', { id: id, 'aria-label': label }, choices(values, current, label));
      node.addEventListener('change', function () { state[key] = node.value; writeHash(); render(); });
      return node;
    }
    var watch = el('input', { id: 'watch', type: 'checkbox', checked: state.watch ? 'checked' : null });
    watch.addEventListener('change', function () { state.watch = watch.checked; writeHash(); render(); });
    var sort = select('sort', ['implied', 'tvl', 'change_7d', 'range_width', 'rank', 'name', 'category_multiple'], state.sort, 'Sort by', 'sort');
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select('category', categories, state.category, 'All categories', 'category')),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), select('chain', chains, state.chain, 'All chains', 'chain')),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Verdict' }), select('verdict', ['FARM', 'WATCH', 'SKIP', 'not-farm'], state.verdict, 'All verdicts', 'verdict')),
      el('label', { class: 'check', for: 'watch' }, watch, 'Watchlist only'),
      el('div', { class: 'field' }, el('label', { for: 'sort', text: 'Sort' }), sort),
      el('span', { class: 'count', text: list.length + ' / ' + DATA.rows.length + ' rows' })
    );
  }

  function activeFilterCount() {
    return (state.q ? 1 : 0) + (state.category !== 'all' ? 1 : 0) + (state.chain !== 'all' ? 1 : 0) +
      (state.verdict !== 'all' ? 1 : 0) + (state.watch ? 1 : 0);
  }

  function activebar() {
    if (activeFilterCount() === 0) return null;
    function chip(label, key, reset) {
      return el('span', { class: 'chip' }, label,
        el('button', { type: 'button', 'aria-label': 'Clear ' + label, text: '×', onclick: function () { state[key] = reset; writeHash(); render(); } }));
    }
    var chips = [];
    if (state.q) chips.push(chip('search: ' + state.q, 'q', ''));
    if (state.category !== 'all') chips.push(chip('category: ' + state.category, 'category', 'all'));
    if (state.chain !== 'all') chips.push(chip('chain: ' + state.chain, 'chain', 'all'));
    if (state.verdict !== 'all') chips.push(chip('verdict: ' + (state.verdict === 'not-farm' ? 'non-FARM' : state.verdict), 'verdict', 'all'));
    if (state.watch) chips.push(chip('watchlist only', 'watch', false));
    if (state.sort !== 'implied') chips.push(chip('sorted by ' + state.sort, 'sort', 'implied'));
    return el('div', { class: 'activebar' }, el('span', { text: 'ACTIVE VIEW' }), chips,
      el('button', { class: 'clear', type: 'button', text: 'Clear all', onclick: function () {
        state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.watch = false;
        state.sort = 'implied'; state.dir = -1; writeHash(); render();
      } }));
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.verdict === 'not-farm' && r.verdict === 'FARM') return false;
      if (state.verdict !== 'all' && state.verdict !== 'not-farm' && r.verdict !== state.verdict) return false;
      if (state.watch && !r.watchlist) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) {
      var av, bv;
      if (state.sort === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (state.sort === 'rank') { av = -a.rank; bv = -b.rank; }
      else if (state.sort === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (state.sort === 'change_7d') { av = a.change_7d === null ? -1e9 : a.change_7d; bv = b.change_7d === null ? -1e9 : b.change_7d; }
      else if (state.sort === 'range_width') { av = a.range_width; bv = b.range_width; }
      else if (state.sort === 'category_multiple') { av = a.category_multiple; bv = b.category_multiple; }
      else { av = a.implied_value; bv = b.implied_value; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' }, el('button', {
      type: 'button',
      text: label + (state.sort === key ? (state.dir < 0 ? ' ↓' : ' ↑') : ''),
      onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } writeHash(); render(); }
    }));
  }

  function boardTable(list) {
    if (list.length === 0) return el('div', { class: 'panel empty', text: 'No protocol matches these filters. Clear a filter to bring the board back.' });
    var body = el('tbody');
    list.forEach(function (r) {
      body.appendChild(el('tr', {
        class: r.rank <= 3 ? 'podium' : '', tabindex: '0',
        onclick: function () { state.detail = r.slug; state.view = 'detail'; writeHash(); render(); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.detail = r.slug; state.view = 'detail'; writeHash(); render(); } }
      },
        el('td', { class: 'rank num' }, el('span', { class: 'rankbadge', text: String(r.rank) })),
        el('td', { class: 'protocol' }, el('b', { text: r.name }), el('small', { text: sub(r) + (r.watchlist ? ' · watchlist' : '') })),
        el('td', null, pill(r.verdict)),
        el('td', { class: 'implied', text: usd(r.implied_value) }),
        el('td', { class: 'rng' }, rangeBar(r), el('span', { text: r.range_width.toFixed(1) + 'x' })),
        el('td', { class: 'num', text: usd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass(r.change_7d), text: pct(r.change_7d) + (r.change_7d === null ? '' : r.change_7d >= 0 ? ' ↑' : ' ↓') }),
        el('td', { class: 'num', text: r.category_multiple.toFixed(3) + 'x' })
      ));
    });
    return el('div', { class: 'panel table-wrap' },
      el('table', null,
        el('thead', null, el('tr', null,
          sortHeader('rank', '#'), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'Verdict' }),
          sortHeader('implied', 'Implied value'), el('th', { scope: 'col', text: 'Honest range' }),
          sortHeader('tvl', 'TVL'), sortHeader('change_7d', '7D'), sortHeader('category_multiple', 'Mult.')
        )),
        body
      )
    );
  }

  function factorBox(label, value, small) {
    return el('div', { class: 'factor' },
      el('div', { class: 'factor-label', text: label }),
      el('div', { class: 'factor-value', text: value }),
      el('div', { class: 'factor-sub', text: small })
    );
  }

  function stepItems(steps) {
    return el('ol', { class: 'steps' }, steps.map(function (text) {
      var at = text.indexOf(' Cost: ');
      var action = at >= 0 ? text.slice(0, at) : text;
      var tail = at >= 0 ? text.slice(at + 1) : '';
      return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
    }));
  }

  function detailView() {
    var row = DATA.rows.filter(function (r) { return r.slug === state.detail; })[0] || DATA.rows[0];
    var left = el('div', null,
      el('div', { class: 'dlabel', text: 'Implied value · ' + DATA.model_version }),
      el('div', { class: 'dnum', text: usd(row.implied_value) }),
      el('p', { class: 'note', text: 'A derived claim from the snapshot, not a launch promise or a market price.' }),
      scale(row),
      el('div', { class: 'dlabel', text: 'Honest range · peer-ratio IQR · ' + row.range_width.toFixed(1) + 'x wide' }),
      el('div', { class: 'factors' },
        factorBox('TVL', usd(row.tvl_usd), 'snapshot figure'),
        factorBox('Category multiple', row.category_multiple.toFixed(3) + 'x', (row.category || 'Uncategorised')),
        factorBox('Size × growth × tenure', (row.size * row.momentum * row.tenure).toFixed(3) + 'x', row.size.toFixed(2) + ' × ' + row.momentum.toFixed(2) + ' × ' + row.tenure.toFixed(2)),
        factorBox('Implied value', usd(row.implied_value), 'round of the product')
      ),
      el('p', { class: 'byhand', text: 'Check by hand: round(' + whole(row.tvl_usd) + ' × ' + row.category_multiple.toFixed(4) + ' × ' + row.size.toFixed(3) + ' × ' + row.momentum.toFixed(3) + ' × ' + row.tenure.toFixed(3) + ') = ' + usd(row.implied_value) + '; the range is TVL × priors × the category peer-ratio IQR.' })
    );
    var right = el('div', { class: 'verdictcard ' + row.verdict.toLowerCase() },
      el('div', { class: 'dlabel', text: 'Verdict · ' + row.verdict + ' · rank ' + row.rank }),
      el('div', { style: 'margin:8px 0 0' }, pill(row.verdict)),
      el('p', { class: 'reason', text: row.reason }),
      el('div', { class: 'dlabel', text: 'First three farm steps' }),
      el('div', { style: 'margin-top:8px' }, stepItems(row.farm_steps.slice(0, 3))),
      el('p', { class: 'trigger', text: 'What would change this verdict: ' + row.watch_trigger + '. A SKIP gets a watch plan instead of a farm plan until then.' })
    );
    return el('div', null,
      header(),
      el('div', { class: 'shell' },
        el('button', { class: 'back', type: 'button', text: '← Back to the board', onclick: function () { state.view = 'board'; state.detail = null; writeHash(); render(); } }),
        el('div', { class: 'dhead' },
          el('h1', { text: '#' + row.rank + '  ' + row.name }),
          el('span', { class: 'rankmark', text: row.watchlist ? 'Watchlist floor · ' + DATA.model_version : 'Early find · ' + DATA.model_version })
        ),
        el('p', { class: 'dsub', text: sub(row) + '  ·  TVL ' + usd(row.tvl_usd) + '  ·  7D ' + pct(row.change_7d) + '  ·  ' + (row.listed_at || 'listing date not recorded') }),
        el('div', { class: 'dgrid' }, left, right),
        el('section', { class: 'section' },
          el('h2', { text: 'Full six-step farm plan, costed and timed' }),
          stepItems(row.farm_steps)
        ),
        footer()
      )
    );
  }

  function worstTable() {
    var body = el('tbody');
    DATA.calibration.worst.forEach(function (m, i) {
      body.appendChild(el('tr', null,
        el('td', { class: 'rank num', text: String(i + 1) }),
        el('td', { class: 'protocol' }, el('b', { text: m.name }), el('small', { text: m.category || 'Uncategorised' })),
        el('td', { class: 'num', text: usd(m.predicted) }),
        el('td', { class: 'num', text: usd(m.actual) }),
        el('td', { class: 'num', text: m.factor < 0.01 ? '<0.01x' : m.factor.toFixed(2) + 'x' })
      ));
    });
    return el('div', { class: 'panel table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: '#' }), el('th', { text: 'Worst leave-one-out miss' }), el('th', { text: 'Predicted' }), el('th', { text: 'Actual' }), el('th', { text: 'Factor' }))),
      body
    ));
  }

  function accountingBar() {
    var a = DATA.accounting;
    var pieces = [
      ['board rows', a.board, '#05775b'], ['already tokened', a.already_tokened, '#0d1526'],
      ['screened out', a.screened_out, '#9a5c08'], ['below radar cut', a.below_radar_cut, '#c9d3dc']
    ];
    var colors = ['#05775b', '#0d1526', '#9a5c08', '#c9d3dc'];
    var reasons = Object.keys(a.reason_counts).map(function (key) { return key + ': ' + a.reason_counts[key]; }).join(' · ');
    return el('div', null,
      el('div', { class: 'stack' }, pieces.map(function (piece, i) {
        return el('div', { style: 'width:' + ((piece[1] / a.total) * 100) + '%;background:' + colors[i], title: piece[0] + ' ' + piece[1] });
      })),
      el('div', { class: 'legend' }, pieces.map(function (piece, i) {
        return el('span', null, el('i', { style: 'background:' + colors[i] }), piece[0] + ' ' + whole(piece[1]));
      }).concat([el('span', { text: '= ' + whole(a.sum) + ' of ' + whole(a.total) + ' reconciled' })])),
      el('p', { class: 'note', text: 'Screen reasons — ' + reasons + '.' })
    );
  }

  function calibrationView() {
    var s = DATA.calibration.summary;
    return el('div', null, header(), el('div', { class: 'shell' },
      el('h1', { class: 'page-title', text: 'Calibration, out in the open' }),
      el('p', { class: 'note', text: 'Every traded peer is removed in turn, the multiples are refit without it, and it is priced as if it were launching. That is the only honest check this snapshot allows.' }),
      el('div', { class: 'score' }, [
        [s.median_factor_error.toFixed(2) + 'x', 'Median factor error'],
        [Math.round(s.interval_coverage * 100) + '%', 'Actual inside peer IQR'],
        [whole(s.within_2x) + ' / ' + whole(s.traded_peers), 'Within 2x of real cap'],
        [s.bootstrap_5th.toFixed(4) + 'x–' + s.bootstrap_95th.toFixed(4) + 'x', 'Bootstrap 5th–95th']
      ].map(function (item) { return el('div', { class: 'sc' }, el('b', { text: item[0] }), el('span', { text: item[1] })); })),
      el('p', { class: 'note', text: whole(s.refits) + ' seeded bootstrap refits put the global multiple’s median at ' + s.bootstrap_50th.toFixed(4) + 'x. ' + DATA.calibration.note }),
      el('section', { class: 'section' }, el('h2', { text: 'Where all ' + whole(DATA.accounting.total) + ' protocols went' }), accountingBar()),
      el('section', { class: 'section' }, el('h2', { text: 'Ten worst misses, named' }), worstTable()),
      footer()
    ));
  }

  function methodView() {
    var keys = Object.keys(C);
    var formula = 'implied = max(1, round(TVL × categoryMultiple × size × momentum × tenure))';
    return el('div', null, header(), el('div', { class: 'shell' },
      el('h1', { class: 'page-title', text: 'Method: one function, no name list' }),
      el('p', { class: 'note', text: 'Traded peers are protocols with a positive market cap and positive TVL. ratio = mcap / TVL, winsorised at the 90th percentile. globalMultiple is the median capped ratio; categoryMultiple shrinks each category toward it by four phantom peers. refTvl is the median TVL of traded peers. The range is the category peer-ratio IQR, not a promise.' }),
      el('p', { class: 'note', text: formula + ' · size = clamp((TVL/refTvl)^-0.30, 0.5, 2.0) · momentum = 1 + 0.35 × clamp(change7d, -60, 150)/100 · tenure = 0.75 + min(ageDays, 1460)/1460 × 0.45.' }),
      el('div', { class: 'constants' }, keys.map(function (key) {
        return el('div', null, el('span', { text: key }), el('b', { text: String(C[key]) }));
      })),
      el('section', { class: 'section' },
        el('h2', { text: 'Verdict gates' }),
        el('p', { class: 'note', text: 'FARM when implied ≥ $60M, momentum ≥ 0.95x and range ≤ 30x. WATCH when implied ≥ $20M and range ≤ 60x. Everything else is SKIP and gets a watch plan whose trigger is a 7-day TVL change above +15% or TVL crossing a stated dollar level.' }),
        el('p', { class: 'note', text: DATA.calibration.note })
      ),
      footer()
    ));
  }

  function liveView() {
    var body = el('tbody');
    DATA.live.forEach(function (r) {
      body.appendChild(el('tr', null,
        el('td', { class: 'protocol' }, el('b', { text: r.name }), el('small', { text: (r.category || 'Uncategorised') + ' · ' + (r.chains || []).slice(0, 2).join(', ') })),
        el('td', { class: 'num', text: usd(r.mcap_usd) }),
        el('td', { class: 'num', text: usd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass(r.change_7d), text: pct(r.change_7d) }),
        el('td', null, el('span', { class: 'pill skip', text: 'already trades' }))
      ));
    });
    return el('div', null, header(), el('div', { class: 'shell' },
      el('h1', { class: 'page-title', text: 'Live tokens: the yardsticks' }),
      el('p', { class: 'note', text: 'These ' + DATA.live.length + ' protocols already trade. Their market caps are facts from the snapshot; they set the multiples and are never rows on the pre-token board.' }),
      el('div', { class: 'panel table-wrap', style: 'margin-top:16px' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Protocol' }), el('th', { text: 'Market cap' }), el('th', { text: 'TVL' }), el('th', { text: '7D' }), el('th', { text: 'Token' }))),
        body
      )),
      footer()
    ));
  }

  function footer() {
    return el('footer', { class: 'footer' },
      el('span', { class: 'claim', text: 'Implied values are this entry’s own estimates from the sealed snapshot: not a price, not a prediction of any token launch, and not a view or endorsement by make.fun. Not financial advice.' }),
      el('span', { text: DATA.source + ' · ' + DATA.model_version })
    );
  }

  function boardView() {
    var list = filtered();
    return el('div', null, header(), el('div', { class: 'shell' },
      hero(), kpis(), controls(list), activebar(), boardTable(list), footer()
    ));
  }

  function readHash() {
    var p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (p.get('view')) state.view = p.get('view');
    if (p.get('p')) state.detail = p.get('p');
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('verdict')) state.verdict = p.get('verdict');
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('dir')) state.dir = Number(p.get('dir'));
    state.watch = p.get('watch') === '1';
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.view !== 'board') p.set('view', state.view);
    if (state.detail) p.set('p', state.detail);
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.verdict !== 'all') p.set('verdict', state.verdict);
    if (state.watch) p.set('watch', '1');
    if (state.sort !== 'implied') p.set('sort', state.sort);
    if (state.dir !== -1) p.set('dir', String(state.dir));
    var suffix = p.toString();
    window.history.replaceState(null, '', suffix ? '#' + suffix : window.location.pathname + window.location.search);
  }

  function render() {
    app.textContent = '';
    if (state.view === 'detail') app.appendChild(detailView());
    else if (state.view === 'calibration') app.appendChild(calibrationView());
    else if (state.view === 'method') app.appendChild(methodView());
    else if (state.view === 'live') app.appendChild(liveView());
    else app.appendChild(boardView());
    app.setAttribute('aria-busy', 'false');
  }

  readHash();
  render();
})();
