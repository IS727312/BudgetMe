'use strict';
let openingCode = window.location.hash.startsWith('#open=') ? window.location.hash.slice(6) : '';
let launch = '';
history.replaceState(null, '', '/');
let openingQueue = Promise.resolve();
let lifecycle = 0;
let session = null, data = null, summary = null, initialized = false;
let page = 'overview', historyPage = 0, lastAction = 0, noticeTimer, previewCSV = null;
const $ = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];
const usd = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dollars = n => (n / 100).toFixed(2);
function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}
function svg(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
function message(text, error = false) {
  const notice = $('#notice');
  notice.textContent = text;
  notice.className = error ? 'notice error' : 'notice';
  notice.setAttribute('role', error ? 'alert' : 'status');
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, error ? 14000 : 6500);
}
function clearPrivateUI() {
  data = null; summary = null; session = null; previewCSV = null;
  for (const id of ['metrics', 'trend-chart', 'category-chart', 'overview-budgets', 'overview-goals',
    'recent-transactions', 'all-transactions', 'pagination', 'account-list', 'income-sources', 'budget-list',
    'goal-list', 'rule-list', 'category-list', 'export-list']) $(`#${id}`).replaceChildren();
  all('#workspace form').forEach(form => form.reset());
  $('#csv-text').value = ''; $('#csv-file').value = ''; $('#search').value = ''; $('#import-result').textContent = '';
  $('#export-confirm').value = ''; $('#import-confirm').hidden = true;
  $('#workspace').hidden = true; $('#entry').hidden = false;
  $('#workspace').inert = false; $('#auth-form').inert = false;
  $('#name').value = '';
  $('#greeting').textContent = 'YOUR MONEY AT A GLANCE';
  $('#confirm-dialog').close();
  all('#workspace select').filter(node => ['tx-account', 'tx-category', 'tx-destination', 'budget-category', 'rule-category'].includes(node.id))
    .forEach(node => node.replaceChildren());
}
function authUI() {
  $('#open-panel').hidden = true;
  $('#auth-title').textContent = initialized ? 'Welcome back.' : 'A fresh start for your finances.';
  $('#auth-description').textContent = initialized
    ? 'Unlock your encrypted vault. Your passphrase stays on this PC.'
    : 'Create a private vault. No email, account signup, or bank password required.';
  $('#name-label').hidden = initialized;
  $('#name').required = !initialized;
  $('#confirm-label').hidden = initialized;
  $('#password-confirm').required = !initialized;
  $('#recovery-note').hidden = initialized;
  $('#password').setAttribute('autocomplete', initialized ? 'current-password' : 'new-password');
  $('#auth-submit').textContent = initialized ? 'Unlock vault' : 'Create my vault';
  $('#auth-form').hidden = false;
  $('#password').value = ''; $('#password-confirm').value = '';
}
function openUI(description) {
  clearPrivateUI();
  $('#auth-form').hidden = true;
  $('#password').value = ''; $('#password-confirm').value = '';
  $('#auth-title').textContent = 'Your vault stays private.';
  $('#auth-description').textContent = description || 'Click below to open BudgetMe in your default browser, then create or unlock your vault. No old private link needed.';
  $('#open-panel').hidden = false;
}
async function accessRequest(path, body = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BudgetMe-Open': '1' },
      body: JSON.stringify(body), credentials: 'omit', cache: 'no-store'
    });
  } catch { throw new Error('The local server is not reachable. Double-click Launch BudgetMe.cmd to start it.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not open BudgetMe. Try the Windows launcher.');
  return result;
}
function openingFailure(error) {
  message(error.message, true);
  if ($('#workspace').inert || $('#auth-form').inert) {
    clearTimeout(noticeTimer);
    const retry = el('button', 'Open BudgetMe', { class: 'secondary', type: 'button' });
    retry.addEventListener('click', () => requestOpening(retry));
    $('#notice').append(retry);
  }
}
async function requestOpening(button) {
  if (button.disabled) return;
  button.disabled = true;
  const generation = lifecycle;
  try {
    await accessRequest('/access/reopen');
    if (generation !== lifecycle) return;
    $('#open-result').textContent = 'Requested your default browser. Continue in the opened BudgetMe window or tab.';
    if ($('#workspace').inert || $('#auth-form').inert) openingFailure(new Error('Requested BudgetMe. Continue in the opened window or tab; this stopped-server view stays inactive.'));
    setTimeout(() => {
      if (!$('#open-panel').hidden) $('#open-result').textContent = 'If BudgetMe did not open, double-click Launch BudgetMe.cmd and check Windows default-browser settings.';
    }, 60000);
  } catch (error) { if (generation === lifecycle) openingFailure(error); }
  finally { button.disabled = false; }
}
$('#open-budgetme').addEventListener('click', () => requestOpening($('#open-budgetme')));
async function api(path, body = {}, authenticated = true) {
  const generation = lifecycle;
  const headers = { 'Content-Type': 'application/json', 'X-BudgetMe-Launch': launch };
  if (authenticated) headers['X-BudgetMe-Session'] = session || '';
  let response;
  try { response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store' }); }
  catch { throw new Error('Cannot reach the local app. Check that the BudgetMe launcher is still running.'); }
  const result = await response.json();
  if (generation !== lifecycle) throw new Error('This browser session closed. Reopen BudgetMe before continuing.');
  if (!response.ok) {
    if (response.status === 401 && authenticated) { clearPrivateUI(); authUI(); }
    throw new Error(result.error || 'The local operation failed.');
  }
  if (authenticated) lastAction = Date.now();
  return result;
}
async function reload() {
  const result = await api('/api/state', { day: $('#view-date').value });
  data = result.state; summary = result.summary;
  render();
}
async function saving(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  try { await action(); }
  catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
}
function bindForm(id, action, after) {
  $(`#${id}`).addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button[type=submit]');
    const input = Object.fromEntries(new FormData(form));
    saving(button, async () => {
      await api('/api/change', { action, input });
      form.reset();
      if (after) after();
      await reload(); message('Saved in your encrypted vault.');
    });
  });
}
function go(name, focus = true) {
  page = name;
  all('.page').forEach(node => { node.hidden = node.id !== `page-${name}`; });
  all('nav [data-page]').forEach(node => {
    node.classList.toggle('active', node.dataset.page === name);
    if (node.dataset.page === name) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  });
  const titles = { overview: 'Overview', transactions: 'Transactions', accounts: 'Accounts & income', budgets: 'Budgets', goals: 'Savings goals', tools: 'Import & privacy' };
  $('#page-title').textContent = titles[name];
  $('#page-title').setAttribute('tabindex', '-1');
  if (focus) { $('#page-title').focus(); window.scrollTo(0, 0); }
  if (name === 'tools' && session) loadExports().catch(error => message(error.message, true));
}
function choice(select, items, blank) {
  const previous = select.value;
  select.replaceChildren();
  if (blank) select.append(el('option', blank, { value: '' }));
  items.forEach(item => select.append(el('option', item.name, { value: item.id })));
  if (items.some(item => item.id === previous)) select.value = previous;
}
const accountName = id => data.accounts.find(a => a.id === id)?.name || '';
const categoryName = id => data.categories.find(c => c.id === id)?.name || '';
function empty(container, text) { container.append(el('p', text, { class: 'empty' })); }
function deleteButton(collection, id, name) {
  const button = el('button', 'Remove', { class: 'text-button remove', type: 'button', 'aria-label': `Remove ${name}` });
  button.addEventListener('click', async () => {
    const dialog = $('#confirm-dialog');
    $('#confirm-title').textContent = `Remove ${name}?`;
    $('#confirm-message').textContent = collection === 'transactions'
      ? 'This changes your balances and budget totals. Your previous encrypted snapshot remains available for offline recovery.'
      : 'This removes the planning record. Accounts or categories with dependent records cannot be removed.';
    dialog.showModal();
    const answer = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (answer !== 'remove') return;
    saving(button, async () => { await api('/api/change', { action: 'delete', input: { collection, id } }); await reload(); message('Removed and saved.'); });
  });
  return button;
}
function progress(value, max, label) {
  return el('progress', `${Math.round(value / max * 100)}%`, { value: Math.min(Math.max(value, 0), max), max, 'aria-label': label });
}
function budgetItem(b, full = false) {
  const item = el('div', null, { class: full ? 'card budget-item' : 'budget-item' });
  const heading = el('div', null, { class: 'card-heading' });
  heading.append(el('h3', categoryName(b.categoryId)), el('span', b.frequency, { class: 'pill' }));
  item.append(heading, el('p', `${b.start} - ${b.lastDay}`, { class: 'muted' }),
    el('p', `${usd(b.spent)} of ${usd(b.limit)}`, { class: 'budget-amount' }),
    progress(b.spent, b.limit, `${categoryName(b.categoryId)} budget usage`),
    el('p', b.remaining >= 0 ? `${usd(b.remaining)} remaining` : `${usd(-b.remaining)} over budget`, { class: b.remaining < 0 ? 'negative' : 'positive' }));
  if (full) item.append(deleteButton('budgets', b.id, `${categoryName(b.categoryId)} ${b.frequency} budget`));
  return item;
}
function goalItem(g, full = false) {
  const item = el('div', null, { class: full ? 'card goal-item' : 'goal-item' });
  const remaining = Math.max(0, g.target - g.saved);
  const days = Math.ceil((Date.parse(`${g.due}T00:00:00Z`) - Date.parse(`${summary.day}T00:00:00Z`)) / 86400000);
  item.append(el('h3', g.name), el('p', `${usd(g.saved)} saved of ${usd(g.target)}`),
    progress(g.saved, g.target, `${g.name} progress`),
    el('p', remaining === 0 ? 'Goal reached. You did it!' : `${usd(remaining)} to go`, { class: remaining === 0 ? 'positive' : '' }),
    el('p', `Target: ${g.due}`, { class: 'muted' }));
  if (remaining > 0) item.append(el('p', days > 0 ? `About ${usd(Math.ceil(remaining / Math.max(1, days / 30.4375)))} per month to stay on pace.` : 'Target date reached. Update your plan or keep saving at your pace.', { class: 'muted' }));
  if (full) {
    const form = el('form', null, { class: 'inline-form' }), label = el('label', 'Total saved (USD)');
    label.append(el('input', null, { name: 'saved', value: dollars(g.saved), inputmode: 'decimal', required: '', pattern: '\\d{1,10}(\\.\\d{1,2})?' }));
    const button = el('button', 'Update', { type: 'submit', class: 'secondary' });
    form.append(label, button);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const saved = new FormData(form).get('saved');
      saving(button, async () => { await api('/api/change', { action: 'goal-progress', input: { id: g.id, saved } }); await reload(); message('Goal progress saved.'); });
    });
    item.append(form, deleteButton('goals', g.id, g.name));
  }
  return item;
}
function transactionsTable(items, editable) {
  const wrap = el('div', null, { class: 'table-wrap' });
  if (!items.length) { empty(wrap, 'No transactions yet. Add your first entry to start seeing your picture.'); return wrap; }
  const table = el('table'), head = el('thead'), tr = el('tr');
  for (const name of ['Date', 'Description', 'Account', 'Category / type', 'Amount', ...(editable ? [''] : [])]) tr.append(el('th', name, { scope: 'col' }));
  head.append(tr); table.append(head);
  const body = el('tbody');
  for (const t of items) {
    const row = el('tr');
    row.append(el('td', t.date), el('td', t.description || (t.type === 'income' ? 'Income' : t.type === 'transfer' ? 'Transfer' : 'Expense')),
      el('td', accountName(t.accountId) + (t.type === 'transfer' ? ` → ${accountName(t.toAccountId)}` : '')),
      el('td', t.type === 'expense' ? categoryName(t.categoryId) : t.type === 'income' ? 'Income' : 'Transfer'),
      el('td', `${t.type === 'income' ? '+' : t.type === 'expense' ? '-' : ''}${usd(t.amount)}`, { class: t.type === 'income' ? 'positive amount' : 'amount' }));
    if (editable) { const cell = el('td'); cell.append(deleteButton('transactions', t.id, t.description || t.type)); row.append(cell); }
    body.append(row);
  }
  table.append(body); wrap.append(table); return wrap;
}
function renderTransactions() {
  if (!data) return;
  const query = $('#search').value.toLowerCase(), from = $('#filter-from').value, to = $('#filter-to').value, type = $('#filter-type').value;
  const items = [...data.transactions].reverse().sort((a, b) => b.date.localeCompare(a.date)).filter(t =>
    (!type || t.type === type) && (!from || t.date >= from) && (!to || t.date <= to) &&
    `${t.description} ${accountName(t.accountId)} ${accountName(t.toAccountId)} ${categoryName(t.categoryId)}`.toLowerCase().includes(query));
  const totalPages = Math.max(1, Math.ceil(items.length / 50));
  historyPage = Math.min(historyPage, totalPages - 1);
  $('#all-transactions').replaceChildren(transactionsTable(items.slice(historyPage * 50, (historyPage + 1) * 50), true));
  $('#transaction-count').textContent = `${items.length} entries`;
  const previous = el('button', 'Previous', { class: 'secondary' }), next = el('button', 'Next', { class: 'secondary' });
  previous.disabled = historyPage === 0; next.disabled = historyPage === totalPages - 1;
  previous.addEventListener('click', () => { historyPage--; renderTransactions(); });
  next.addEventListener('click', () => { historyPage++; renderTransactions(); });
  $('#pagination').replaceChildren(previous, el('span', `Page ${historyPage + 1} of ${totalPages}`), next);
}
function renderTrend() {
  const container = $('#trend-chart'); container.replaceChildren();
  const chart = svg('svg', { viewBox: '0 0 720 250', role: 'img', 'aria-label': 'Monthly income and expense bar chart. Exact values follow in an expandable table.' });
  const max = Math.max(100, ...summary.trends.flatMap(t => [t.income, t.expense]));
  for (let i = 0; i <= 3; i++) {
    const y = 20 + 175 * i / 3;
    chart.append(svg('line', { x1: 60, y1: y, x2: 708, y2: y, stroke: '#e5eae6' }));
    const label = svg('text', { x: 54, y: y + 4, 'text-anchor': 'end', fill: '#68776c', 'font-size': 11 });
    label.textContent = `$${Math.round(max / 100 * (3 - i) / 3).toLocaleString('en-US')}`; chart.append(label);
  }
  summary.trends.forEach((t, i) => {
    for (const [key, offset, color] of [['income', 0, '#236c4c'], ['expense', 20, '#e2b574']]) {
      const height = t[key] / max * 175;
      const bar = svg('rect', { x: 68 + i * 53 + offset, y: 195 - height, width: 16, height, rx: 3, fill: color });
      const title = svg('title', {}); title.textContent = `${t.month} ${key}: ${usd(t[key])}`; bar.append(title); chart.append(bar);
    }
    const label = svg('text', { x: 86 + i * 53, y: 219, 'text-anchor': 'middle', fill: '#68776c', 'font-size': 11 });
    label.textContent = t.month.slice(5); chart.append(label);
  });
  container.append(chart);
  const details = el('details'), title = el('summary', 'View exact monthly values'), table = el('table'), head = el('tr');
  ['Month', 'Income', 'Expenses', 'Net'].forEach(name => head.append(el('th', name, { scope: 'col' })));
  table.append(head);
  summary.trends.forEach(t => { const row = el('tr'); [t.month, usd(t.income), usd(t.expense), usd(t.income - t.expense)].forEach(v => row.append(el('td', v))); table.append(row); });
  details.append(title, table); container.append(details);
  if (!summary.trends.some(t => t.income || t.expense)) container.append(el('p', 'Add transactions to bring your cash flow to life.', { class: 'muted' }));
}
function render() {
  $('#greeting').textContent = `YOUR PRIVATE PICTURE, ${data.profile.name.toUpperCase()}`;
  choice($('#tx-account'), data.accounts, data.accounts.length ? null : 'Add an account first');
  choice($('#tx-destination'), data.accounts, 'Choose destination');
  choice($('#tx-category'), data.categories, 'Automatic (rules / Other)');
  choice($('#budget-category'), data.categories);
  choice($('#rule-category'), data.categories);
  $('#transaction-form button[type=submit]').disabled = !data.accounts.length;
  $('#onboarding').hidden = data.accounts.length > 0;
  const metricValues = [['Net worth', summary.netWorth, 'Balances through selected day'], ['Income', summary.income, 'Selected calendar month'], ['Expenses', summary.expense, 'Selected calendar month'], ['Cash flow', summary.net, 'Income minus expenses']];
  $('#metrics').replaceChildren(...metricValues.map(([name, amount, note]) => {
    const card = el('article', null, { class: 'metric card' });
    card.append(el('p', name), el('strong', usd(amount), { class: amount < 0 ? 'negative' : '' }), el('span', note, { class: 'muted' }));
    return card;
  }));
  renderTrend();
  $('#category-chart').replaceChildren();
  if (!summary.byCategory.length) empty($('#category-chart'), 'A fresh slate. Your spending categories will appear here.');
  summary.byCategory.slice(0, 8).forEach(c => {
    const block = el('div', null, { class: 'category-row' }), heading = el('div', null, { class: 'card-heading' });
    heading.append(el('span', c.name), el('strong', usd(c.amount)));
    block.append(heading, progress(c.amount, Math.max(summary.expense, 1), `${c.name} share of expenses`));
    $('#category-chart').append(block);
  });
  if (summary.byCategory.length > 8) $('#category-chart').append(el('p', `Plus ${summary.byCategory.length - 8} other categories. See transaction history for details.`, { class: 'muted' }));
  for (const [id, items] of [['overview-budgets', summary.budgets.slice(0, 3).map(b => budgetItem(b))], ['budget-list', summary.budgets.map(b => budgetItem(b, true))],
    ['overview-goals', data.goals.slice(0, 2).map(g => goalItem(g))], ['goal-list', data.goals.map(g => goalItem(g, true))]]) {
    const container = $(`#${id}`); container.replaceChildren(...items);
    if (!items.length) empty(container, id.includes('budget') ? 'Create a budget to see how your spending compares with your plan.' : 'Set a savings goal and give your money a direction.');
  }
  $('#recent-transactions').replaceChildren(transactionsTable([...data.transactions].reverse().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5), false));
  renderTransactions();
  $('#account-list').replaceChildren(...summary.accounts.map(a => {
    const card = el('article', null, { class: 'card account-card' });
    card.append(el('p', a.institution, { class: 'eyebrow' }), el('h2', a.name), el('p', a.kind, { class: 'muted' }),
      el('strong', usd(a.balance), { class: `account-balance ${a.balance < 0 ? 'negative' : ''}` }),
      el('p', `Opening: ${usd(a.opening)}`, { class: 'muted' }), deleteButton('accounts', a.id, a.name));
    return card;
  }));
  if (!data.accounts.length) empty($('#account-list'), 'No accounts yet. Add a checking account, savings account, card, investment, or cash.');
  const incomes = new Map();
  data.transactions.filter(t => t.type === 'income' && t.date >= summary.month.start && t.date < summary.month.end).forEach(t => {
    const name = `${t.description || 'Income'} · ${accountName(t.accountId)}`;
    incomes.set(name, (incomes.get(name) || 0) + t.amount);
  });
  $('#income-sources').replaceChildren();
  if (!incomes.size) empty($('#income-sources'), 'No income in this month yet.');
  for (const [name, amount] of incomes) {
    const row = el('div', null, { class: 'card-heading list-row' });
    row.append(el('span', name), el('strong', usd(amount), { class: 'positive' })); $('#income-sources').append(row);
  }
  $('#category-list').replaceChildren(...data.categories.map(c => {
    const chip = el('div', null, { class: 'chip' }); chip.append(el('span', c.name));
    if (c.name !== 'Other') chip.append(deleteButton('categories', c.id, c.name)); return chip;
  }));
  $('#rule-list').replaceChildren(...data.rules.map(r => {
    const row = el('div', null, { class: 'list-row card-heading' });
    row.append(el('span', `${r.keyword} → ${categoryName(r.categoryId)}`), deleteButton('rules', r.id, r.keyword)); return row;
  }));
  if (!data.rules.length) empty($('#rule-list'), 'No rules yet. Expenses with Automatic selected use Other.');
}
function updateTransactionType() {
  const type = $('#tx-type').value;
  $('#tx-category-label').hidden = type !== 'expense';
  $('#tx-destination-label').hidden = type !== 'transfer';
  $('#tx-destination').required = type === 'transfer';
}
async function loadExports() {
  const { files } = await api('/api/exports');
  const list = $('#export-list'); list.replaceChildren(el('h3', 'Files in app\\exports'));
  if (!files.length) empty(list, 'No exports yet.');
  files.forEach(file => {
    const row = el('div', null, { class: 'export-row' });
    row.append(el('span', `${file.encrypted ? 'Encrypted backup' : 'Plaintext Excel'} · ${new Date(Number(file.name.split('-')[1])).toLocaleString()} · ${Math.ceil(file.bytes / 1024)} KB`));
    row.append(el('code', file.name));
    const button = el('button', 'Delete file', { class: 'text-button remove' });
    button.addEventListener('click', () => saving(button, async () => { await api('/api/export-delete', { name: file.name }); await loadExports(); message('Export file removed. Secure erasure cannot be guaranteed.'); }));
    row.append(button); list.append(row);
  });
}
$('#auth-form').addEventListener('submit', event => {
  event.preventDefault();
  const password = $('#password').value;
  if (!initialized && password !== $('#password-confirm').value) { message('Passphrases do not match.', true); return; }
  const name = $('#name').value;
  saving($('#auth-submit'), async () => {
    try {
      const result = await api(initialized ? '/api/unlock' : '/api/setup', { password, name }, false);
      session = result.session; initialized = true; lastAction = Date.now();
      $('#entry').hidden = true; $('#workspace').hidden = false;
      $('#tx-date').value = today(); $('#budget-anchor').value = today();
      await reload(); go(page, false); message('Vault unlocked. Your data stays on this PC.');
    } finally { $('#password').value = ''; $('#password-confirm').value = ''; }
  });
});
all('[data-page]').forEach(button => button.addEventListener('click', () => go(button.dataset.page)));
$('#quick-add').addEventListener('click', () => { go('transactions'); $('#tx-type').focus(); });
$('#add-income').addEventListener('click', () => { go('transactions'); $('#tx-type').value = 'income'; updateTransactionType(); $('#tx-date').focus(); });
$('#tx-type').addEventListener('change', updateTransactionType);
$('#budget-frequency').addEventListener('change', () => {
  const biweekly = $('#budget-frequency').value === 'biweekly';
  $('#budget-anchor-label').hidden = !biweekly; $('#budget-anchor').required = biweekly;
});
bindForm('transaction-form', 'transaction', () => { $('#tx-date').value = today(); updateTransactionType(); historyPage = 0; });
bindForm('account-form', 'account');
bindForm('category-form', 'category');
bindForm('budget-form', 'budget', () => { $('#budget-anchor').value = today(); $('#budget-anchor-label').hidden = true; $('#budget-anchor').required = false; });
bindForm('goal-form', 'goal');
bindForm('rule-form', 'rule');
$('#view-date').value = today(); $('#tx-date').value = today(); $('#budget-anchor').value = today();
$('#view-date').addEventListener('change', () => { if ($('#view-date').validity.valid && $('#view-date').value && session) reload().catch(e => message(e.message, true)); });
for (const id of ['search', 'filter-from', 'filter-to', 'filter-type']) $(`#${id}`).addEventListener('input', () => { historyPage = 0; renderTransactions(); });
async function doLock() {
  try { if (session) await api('/api/lock'); }
  catch (error) { message(error.message, true); }
  finally { clearPrivateUI(); authUI(); $('#password').focus(); }
}
for (const id of ['lock', 'privacy-lock']) $(`#${id}`).addEventListener('click', doLock);
function invalidatePreview() { previewCSV = null; $('#import-confirm').hidden = true; $('#import-result').textContent = ''; }
$('#csv-text').addEventListener('input', invalidatePreview);
$('#csv-file').addEventListener('change', async event => {
  invalidatePreview();
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 1_000_000) { message('CSV must be at most 1 MB.', true); event.target.value = ''; return; }
  try { $('#csv-text').value = await file.text(); }
  catch { message('Unable to read that local file.', true); }
});
$('#import-preview').addEventListener('click', () => saving($('#import-preview'), async () => {
  invalidatePreview();
  const source = $('#csv-text').value;
  const result = await api('/api/import', { csv: source, preview: true });
  if ($('#csv-text').value !== source) throw new Error('CSV changed during preview. Preview again.');
  previewCSV = source;
  $('#import-result').textContent = `${result.added} new entries; ${result.skipped} exact duplicates skipped. Nothing saved yet.`;
  $('#import-confirm').hidden = result.added === 0;
}));
$('#import-confirm').addEventListener('click', () => saving($('#import-confirm'), async () => {
  if (previewCSV === null || previewCSV !== $('#csv-text').value) throw new Error('Preview this CSV again before importing.');
  const result = await api('/api/import', { csv: previewCSV, confirm: 'IMPORT' });
  $('#csv-text').value = ''; $('#csv-file').value = ''; invalidatePreview();
  await reload(); message(`Imported ${result.added} entries; skipped ${result.skipped} exact duplicates.`);
}));
$('#backup').addEventListener('click', () => saving($('#backup'), async () => {
  await api('/api/export', { kind: 'backup' }); await loadExports(); message('Encrypted backup saved in BudgetMe\\app\\exports.');
}));
$('#excel-export').addEventListener('click', () => saving($('#excel-export'), async () => {
  await api('/api/export', { kind: 'excel', confirm: $('#export-confirm').value });
  $('#export-confirm').value = ''; await loadExports(); message('Plaintext Excel XML saved in BudgetMe\\app\\exports. Keep this file private.');
}));
setInterval(() => {
  if (session && Date.now() - lastAction >= 15 * 60 * 1000) { clearPrivateUI(); authUI(); message('Auto-locked after 15 minutes without an action. Unlock to continue.'); }
}, 1000);
window.addEventListener('pagehide', () => { lifecycle++; session = null; launch = ''; openingCode = ''; clearPrivateUI(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
async function openFromCode(code, generation) {
  if (generation !== lifecycle) return;
  let replaced = false;
  try {
    if (/^[a-f0-9]{64}$/.test(launch)) {
      let response;
      try {
        response = await fetch('/api/status', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BudgetMe-Launch': launch },
          body: '{}', credentials: 'omit', cache: 'no-store'
        });
      } catch { throw new Error('Cannot confirm this local server. Your current tab is unchanged. Try Launch BudgetMe.cmd again.'); }
      const status = await response.json();
      if (generation !== lifecycle) return;
      if (response.status === 200 || response.status === 409) {
        if (response.status === 200 && $('#workspace').hidden && $('#auth-form').hidden) {
          initialized = status.initialized; authUI();
        }
        message('BudgetMe is already open. Your current session and forms are unchanged.');
        return;
      }
      if (response.status !== 403 || status.gate !== 'launch_invalid') {
        throw new Error('This opening request was blocked. Your current tab is unchanged. Try Launch BudgetMe.cmd again.');
      }
      $('#workspace').inert = true; $('#auth-form').inert = true;
    }
    const claimed = await accessRequest('/access/claim', { code });
    if (generation !== lifecycle) return;
    if (!/^[a-f0-9]{64}$/.test(claimed.launch)) throw new Error('Invalid response from the local app. Try the Windows launcher.');
    launch = claimed.launch;
    // A stale tab is replaced only after a new one-use opening is authenticated.
    clearPrivateUI(); replaced = true;
    $('#auth-form').hidden = true; $('#open-panel').hidden = true;
    $('#auth-title').textContent = 'Opening your vault...';
    const status = await api('/api/status', {}, false);
    if (generation !== lifecycle) return;
    initialized = status.initialized; authUI();
  } catch (error) {
    if (generation !== lifecycle) return;
    if (replaced || !/^[a-f0-9]{64}$/.test(launch)) openUI(error.message);
    openingFailure(error);
  }
}
function queueOpening(code) {
  const generation = lifecycle;
  openingQueue = openingQueue.then(() => openFromCode(code, generation)).catch(error => {
    if (generation === lifecycle) openingFailure(error);
  });
}
window.addEventListener('hashchange', event => {
  let code = '';
  try {
    const url = new URL(event.newURL);
    if (url.origin === location.origin && url.pathname === '/' && !url.search && /^#open=[a-f0-9]{64}$/.test(url.hash)) code = url.hash.slice(6);
  } catch { /* Invalid navigation is reported below without echoing its contents. */ }
  history.replaceState(null, '', '/');
  if (code) queueOpening(code);
  else openingFailure(new Error('Invalid opening request. Double-click Launch BudgetMe.cmd to reopen safely.'));
});
if (/^[a-f0-9]{64}$/.test(openingCode)) queueOpening(openingCode);
else openUI();
openingCode = '';
