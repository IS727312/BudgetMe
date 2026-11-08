import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {}
export const frequencies = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
const MAX_CENTS = 100_000_000_000;
const DAY = 86400000;

export function text(value, label, max = 120, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ValidationError(`${label} must be text, at most ${max} characters, without control characters.`);
  }
  const result = value.trim();
  if (!allowEmpty && !result) throw new ValidationError(`${label} is required.`);
  return result;
}

export function money(value, signed = false) {
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,10}(?:\.\d{1,2})?$/ : /^\d{1,10}(?:\.\d{1,2})?$/).test(value)) {
    throw new ValidationError('Use a dollar amount with up to two decimal places, without commas.');
  }
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) throw new ValidationError('Amount is too large.');
  return negative ? -cents : cents;
}

export function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31') {
    throw new ValidationError('Date must be between 1900-01-01 and 2200-12-31.');
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new ValidationError('Date is not a valid calendar day.');
  }
  return value;
}

function iso(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }
export function period(day, frequency, anchor) {
  date(day);
  if (!frequencies.includes(frequency)) throw new ValidationError('Unknown budget frequency.');
  const stamp = Date.parse(`${day}T00:00:00Z`);
  const d = new Date(stamp);
  let start;
  let end;
  if (frequency === 'weekly') {
    start = stamp - ((d.getUTCDay() + 6) % 7) * DAY;
    end = start + 7 * DAY;
  } else if (frequency === 'biweekly') {
    date(anchor);
    const reference = Date.parse(`${anchor}T00:00:00Z`);
    start = reference + Math.floor((stamp - reference) / (14 * DAY)) * 14 * DAY;
    end = start + 14 * DAY;
  } else {
    const month = frequency === 'yearly' ? 0 : frequency === 'quarterly' ? Math.floor(d.getUTCMonth() / 3) * 3 : d.getUTCMonth();
    const span = frequency === 'yearly' ? 12 : frequency === 'quarterly' ? 3 : 1;
    start = Date.UTC(d.getUTCFullYear(), month, 1);
    end = Date.UTC(d.getUTCFullYear(), month + span, 1);
  }
  return { start: iso(start), end: iso(end), lastDay: iso(end - DAY) };
}

export function initialState(name, now = new Date().toISOString()) {
  return {
    version: 1, profile: { name: text(name, 'Name', 60), currency: 'USD' }, createdAt: now,
    accounts: [], transactions: [], budgets: [], goals: [], rules: [],
    categories: ['Housing', 'Food', 'Transport', 'Utilities', 'Health', 'Shopping', 'Entertainment', 'Savings', 'Other']
      .map(name => ({ id: randomUUID(), name }))
  };
}

function member(list, id, label) {
  const found = list.find(item => item.id === id);
  if (!found) throw new ValidationError(`Choose an existing ${label}.`);
  return found;
}
function positive(value, label) {
  const amount = money(value);
  if (amount <= 0) throw new ValidationError(`${label} must be greater than zero.`);
  return amount;
}
function capacity(list, limit, label) {
  if (list.length >= limit) throw new ValidationError(`${label} limit reached (${limit}).`);
}
function unique(list, name) {
  if (list.some(item => item.name.toLowerCase() === name.toLowerCase())) throw new ValidationError('This name already exists.');
}

export function addTransaction(state, input) {
  capacity(state.transactions, 20000, 'Transaction');
  if (!['expense', 'income', 'transfer'].includes(input.type)) throw new ValidationError('Choose expense, income, or transfer.');
  member(state.accounts, input.accountId, 'account');
  const tx = {
    id: randomUUID(), type: input.type, date: date(input.date), accountId: input.accountId,
    amount: positive(input.amount, 'Transaction amount'),
    description: text(input.description ?? '', 'Description', 300, true), categoryId: null, toAccountId: null
  };
  if (tx.type === 'transfer') {
    member(state.accounts, input.toAccountId, 'destination account');
    if (input.toAccountId === tx.accountId) throw new ValidationError('Transfer accounts must be different.');
    tx.toAccountId = input.toAccountId;
  } else if (tx.type === 'expense') {
    const rule = state.rules.find(rule => tx.description.toLowerCase().includes(rule.keyword.toLowerCase()));
    const categoryId = input.categoryId || rule?.categoryId || state.categories.find(item => item.name === 'Other')?.id;
    member(state.categories, categoryId, 'category');
    tx.categoryId = categoryId;
  }
  state.transactions.push(tx);
  return tx;
}

export function mutate(state, action, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Expected an input object.');
  if (action === 'account') {
    capacity(state.accounts, 100, 'Account');
    const name = text(input.name, 'Account name', 80);
    unique(state.accounts, name);
    if (!['checking', 'savings', 'credit', 'investment', 'cash'].includes(input.kind)) throw new ValidationError('Choose an account type.');
    state.accounts.push({
      id: randomUUID(), name, institution: text(input.institution || 'Local', 'Institution', 80),
      kind: input.kind, opening: money(input.opening || '0', true)
    });
  } else if (action === 'category') {
    capacity(state.categories, 100, 'Category');
    const name = text(input.name, 'Category name', 60);
    unique(state.categories, name);
    state.categories.push({ id: randomUUID(), name });
  } else if (action === 'transaction') {
    addTransaction(state, input);
  } else if (action === 'budget') {
    capacity(state.budgets, 200, 'Budget');
    member(state.categories, input.categoryId, 'category');
    if (!frequencies.includes(input.frequency)) throw new ValidationError('Choose a budget frequency.');
    const anchor = input.frequency === 'biweekly' ? date(input.anchor) : null;
    if (state.budgets.some(b => b.categoryId === input.categoryId && b.frequency === input.frequency && b.anchor === anchor)) {
      throw new ValidationError('This category already has that budget schedule. Remove the old budget to replace it.');
    }
    state.budgets.push({ id: randomUUID(), categoryId: input.categoryId, frequency: input.frequency, anchor, limit: positive(input.limit, 'Budget limit') });
  } else if (action === 'goal') {
    capacity(state.goals, 100, 'Goal');
    const name = text(input.name, 'Goal name', 80);
    unique(state.goals, name);
    const target = positive(input.target, 'Goal target');
    const saved = money(input.saved || '0');
    const due = date(input.due);
    state.goals.push({ id: randomUUID(), name, target, saved, due });
  } else if (action === 'goal-progress') {
    const goal = member(state.goals, input.id, 'goal');
    goal.saved = money(input.saved);
  } else if (action === 'rule') {
    capacity(state.rules, 100, 'Rule');
    member(state.categories, input.categoryId, 'category');
    const keyword = text(input.keyword, 'Keyword', 80);
    if (state.rules.some(r => r.keyword.toLowerCase() === keyword.toLowerCase())) throw new ValidationError('This keyword already has a rule.');
    state.rules.push({ id: randomUUID(), keyword, categoryId: input.categoryId });
  } else if (action === 'delete') {
    const collections = ['accounts', 'transactions', 'budgets', 'goals', 'rules', 'categories'];
    if (!collections.includes(input.collection)) throw new ValidationError('Unknown item type.');
    member(state[input.collection], input.id, 'item');
    if (input.collection === 'accounts' && state.transactions.some(t => t.accountId === input.id || t.toAccountId === input.id)) {
      throw new ValidationError('Remove this account\'s transactions first.');
    }
    if (input.collection === 'categories' && (state.transactions.some(t => t.categoryId === input.id) || state.budgets.some(b => b.categoryId === input.id) || state.rules.some(r => r.categoryId === input.id))) {
      throw new ValidationError('Remove transactions, budgets, and rules using this category first.');
    }
    if (input.collection === 'categories' && state.categories.find(c => c.id === input.id)?.name === 'Other') throw new ValidationError('Keep the Other fallback category.');
    state[input.collection] = state[input.collection].filter(item => item.id !== input.id);
  } else throw new ValidationError('Unknown action.');
  return state;
}

export function summarize(state, day) {
  date(day);
  const balances = new Map(state.accounts.map(a => [a.id, a.opening]));
  for (const t of state.transactions.filter(t => t.date <= day)) {
    balances.set(t.accountId, balances.get(t.accountId) + (t.type === 'income' ? t.amount : -t.amount));
    if (t.type === 'transfer') balances.set(t.toAccountId, balances.get(t.toAccountId) + t.amount);
  }
  const month = period(day, 'monthly');
  const monthTx = state.transactions.filter(t => t.date >= month.start && t.date < month.end);
  const income = monthTx.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
  const expense = monthTx.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
  const budgets = state.budgets.map(b => {
    const range = period(day, b.frequency, b.anchor);
    const spent = state.transactions.filter(t => t.type === 'expense' && t.categoryId === b.categoryId && t.date >= range.start && t.date < range.end)
      .reduce((sum, t) => sum + t.amount, 0);
    return { ...b, ...range, spent, remaining: b.limit - spent };
  });
  const trends = [];
  const selected = new Date(`${day}T00:00:00Z`);
  for (let i = 11; i >= 0; i--) {
    const start = iso(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth() - i, 1));
    const end = iso(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth() - i + 1, 1));
    const items = state.transactions.filter(t => t.date >= start && t.date < end);
    trends.push({
      month: start.slice(0, 7),
      income: items.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0),
      expense: items.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
    });
  }
  const byCategory = state.categories.map(c => ({
    ...c, amount: monthTx.filter(t => t.type === 'expense' && t.categoryId === c.id).reduce((s, t) => s + t.amount, 0)
  })).filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);
  return {
    day, month, income, expense, net: income - expense,
    netWorth: [...balances.values()].reduce((sum, n) => sum + n, 0),
    accounts: state.accounts.map(a => ({ ...a, balance: balances.get(a.id) })),
    budgets, trends, byCategory
  };
}

export function parseCSV(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1_000_000) throw new ValidationError('CSV must be at most 1 MB.');
  source = source.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; } else { quoted = false; afterQuote = true; }
      } else field += ch;
    } else if (ch === '"' && !field && !afterQuote) quoted = true;
    else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(field); field = ''; afterQuote = false;
      if (ch !== ',') {
        if (ch === '\r' && source[i + 1] === '\n') i++;
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      }
    } else {
      if (afterQuote || ch === '"') throw new ValidationError('Malformed CSV quoting.');
      field += ch;
    }
  }
  if (quoted) throw new ValidationError('CSV has an unclosed quote.');
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  if (rows.length < 2 || rows.length > 2001) throw new ValidationError('CSV needs a header and 1 to 2000 rows.');
  const header = ['date', 'type', 'account', 'category', 'amount', 'description'];
  if (rows[0].length !== 6 || rows[0].some((v, i) => v !== header[i])) {
    throw new ValidationError('CSV header must be: date,type,account,category,amount,description');
  }
  return rows.slice(1).map((r, i) => {
    if (r.length !== 6) throw new ValidationError(`CSV row ${i + 2} needs six columns.`);
    return Object.fromEntries(header.map((key, j) => [key, r[j]]));
  });
}

export function importCSV(state, source) {
  const rows = parseCSV(source);
  const copy = structuredClone(state);
  let added = 0, skipped = 0;
  for (const [index, row] of rows.entries()) {
    try {
      if (!['income', 'expense'].includes(row.type)) throw new ValidationError('CSV type must be income or expense; add transfers manually.');
      const account = copy.accounts.find(a => a.name === row.account);
      if (!account) throw new ValidationError(`Unknown account "${row.account}". Create accounts before importing.`);
      const category = row.category ? copy.categories.find(c => c.name === row.category) : null;
      if (row.category && !category) throw new ValidationError(`Unknown category "${row.category}".`);
      const input = { ...row, accountId: account.id, categoryId: category?.id };
      const before = copy.transactions.length;
      const tx = addTransaction(copy, input);
      const duplicate = copy.transactions.slice(0, before).some(t =>
        t.date === tx.date && t.type === tx.type && t.accountId === tx.accountId && t.amount === tx.amount &&
        t.categoryId === tx.categoryId && t.description === tx.description);
      if (duplicate) { copy.transactions.pop(); skipped++; } else added++;
    } catch (error) {
      if (error instanceof ValidationError) throw new ValidationError(`CSV row ${index + 2}: ${error.message}`);
      throw error;
    }
  }
  return { state: copy, added, skipped };
}

function xml(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
export function excelXML(state) {
  const row = cells => `<Row>${cells.map(value => `<Cell><Data ss:Type="String">${xml(/^[=+\-@]/.test(String(value)) ? `'${value}` : value)}</Data></Cell>`).join('')}</Row>`;
  const sheet = (name, rows) => `<Worksheet ss:Name="${name}"><Table>${rows.map(row).join('')}</Table></Worksheet>`;
  const amounts = n => (n / 100).toFixed(2);
  const account = id => state.accounts.find(a => a.id === id)?.name || '';
  const category = id => state.categories.find(c => c.id === id)?.name || '';
  return '<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    sheet('Transactions', [['Date', 'Type', 'Account', 'To account', 'Category', 'Amount USD', 'Description'],
      ...state.transactions.map(t => [t.date, t.type, account(t.accountId), account(t.toAccountId), category(t.categoryId), amounts(t.amount), t.description])]) +
    sheet('Accounts', [['Name', 'Institution', 'Type', 'Opening balance USD'], ...state.accounts.map(a => [a.name, a.institution, a.kind, amounts(a.opening)])]) +
    sheet('Budgets', [['Category', 'Schedule', 'Biweekly anchor', 'Limit USD'], ...state.budgets.map(b => [category(b.categoryId), b.frequency, b.anchor || '', amounts(b.limit)])]) +
    sheet('Goals', [['Goal', 'Target USD', 'Saved USD', 'Due date'], ...state.goals.map(g => [g.name, amounts(g.target), amounts(g.saved), g.due])]) +
    '</Workbook>';
}

export function validateState(state) {
  if (!state || state.version !== 1 || !state.profile || state.profile.currency !== 'USD') throw new ValidationError('Unsupported vault contents.');
  text(state.profile.name, 'Name', 60);
  const arrays = ['accounts', 'transactions', 'budgets', 'goals', 'rules', 'categories'];
  for (const key of arrays) if (!Array.isArray(state[key])) throw new ValidationError('Invalid vault collections.');
  const rebuilt = initialState(state.profile.name, state.createdAt);
  rebuilt.categories = [];
  const ids = new Set();
  const restoreId = (item, added) => {
    if (typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || ids.has(item.id)) throw new ValidationError('Invalid or duplicate vault ID.');
    ids.add(item.id); added.id = item.id;
  };
  for (const c of state.categories) { mutate(rebuilt, 'category', c); restoreId(c, rebuilt.categories.at(-1)); }
  const dollars = n => {
    if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_CENTS) throw new ValidationError('Invalid stored money.');
    return (n / 100).toFixed(2);
  };
  for (const a of state.accounts) { mutate(rebuilt, 'account', { ...a, opening: dollars(a.opening) }); restoreId(a, rebuilt.accounts.at(-1)); }
  for (const t of state.transactions) { mutate(rebuilt, 'transaction', { ...t, amount: dollars(t.amount) }); restoreId(t, rebuilt.transactions.at(-1)); }
  for (const b of state.budgets) { mutate(rebuilt, 'budget', { ...b, limit: dollars(b.limit) }); restoreId(b, rebuilt.budgets.at(-1)); }
  for (const g of state.goals) { mutate(rebuilt, 'goal', { ...g, target: dollars(g.target), saved: dollars(g.saved) }); restoreId(g, rebuilt.goals.at(-1)); }
  for (const r of state.rules) { mutate(rebuilt, 'rule', r); restoreId(r, rebuilt.rules.at(-1)); }
  if (!rebuilt.categories.some(c => c.name === 'Other')) throw new ValidationError('Vault needs the Other category.');
  return rebuilt;
}
