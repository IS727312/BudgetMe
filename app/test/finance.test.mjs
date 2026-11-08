import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, mutate, money, date, period, summarize, importCSV, parseCSV, excelXML, validateState } from '../lib/finance.mjs';

function fixture() {
  const s = initialState('Synthetic Tester');
  mutate(s, 'account', { name: 'Checking', institution: 'Chase', kind: 'checking', opening: '1000' });
  mutate(s, 'account', { name: 'Card', institution: 'American Express', kind: 'credit', opening: '-100' });
  return s;
}
function tx(s, input = {}) {
  mutate(s, 'transaction', { type: 'expense', date: '2026-11-07', amount: '10', accountId: s.accounts[0].id, categoryId: s.categories[1].id, description: 'Synthetic purchase', ...input });
}
test('decimal amounts remain integer cents; invalid formats rejected', () => {
  assert.equal(money('0.29'), 29); assert.equal(money('123.4'), 12340); assert.equal(money('-1.01', true), -101);
  for (const bad of ['1e5', '1,000', '1.001', '-1', '', 'NaN', '1000000001', ' 1 ', 1]) assert.throws(() => money(bad));
});
test('calendar validation rejects rollover and invalid types', () => {
  assert.equal(date('2024-02-29'), '2024-02-29');
  for (const bad of ['2023-02-29', '2026-04-31', '2026-13-01', '2026-1-1', '1800-01-01', null]) assert.throws(() => date(bad));
});
test('weekly Monday, biweekly floor before anchor, leap month and quarter/year boundaries', () => {
  assert.deepEqual(period('2026-11-08', 'weekly'), { start: '2026-11-02', end: '2026-11-09', lastDay: '2026-11-08' });
  assert.equal(period('2026-11-09', 'weekly').start, '2026-11-09');
  assert.equal(period('2021-01-01', 'weekly').start, '2020-12-28');
  assert.equal(period('2026-11-06', 'biweekly', '2026-11-07').start, '2026-10-24');
  assert.equal(period('2026-11-20', 'biweekly', '2026-11-07').start, '2026-11-07');
  assert.equal(period('2026-11-21', 'biweekly', '2026-11-07').start, '2026-11-21');
  assert.equal(period('2024-02-29', 'monthly').end, '2024-03-01');
  assert.equal(period('2026-03-31', 'quarterly').end, '2026-04-01');
  assert.equal(period('2026-04-01', 'quarterly').start, '2026-04-01');
  assert.equal(period('2026-12-31', 'yearly').end, '2027-01-01');
  assert.throws(() => period('2026-11-01', 'biweekly', 'invalid'));
});
test('multiple incomes, card debt, transfer and future entries produce correct balance and flow', () => {
  const s = fixture();
  tx(s, { type: 'income', amount: '2000', description: 'Salary' });
  tx(s, { type: 'income', amount: '125', description: 'Freelance' });
  tx(s, { accountId: s.accounts[1].id, amount: '50' });
  tx(s, { type: 'transfer', amount: '75', toAccountId: s.accounts[1].id });
  tx(s, { type: 'income', amount: '10', date: '2026-12-01' });
  const result = summarize(s, '2026-11-07');
  assert.equal(result.income, 212500); assert.equal(result.expense, 5000); assert.equal(result.net, 207500);
  assert.equal(result.accounts[0].balance, 305000); assert.equal(result.accounts[1].balance, -7500);
  assert.equal(result.netWorth, 297500);
  assert.equal(result.trends.length, 12);
  assert.equal(summarize(s, '2026-12-01').netWorth, 298500);
});
test('all five budget schedules include first and last day, exclude next period', () => {
  for (const frequency of ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']) {
    const s = fixture(), anchor = '2026-11-02';
    mutate(s, 'budget', { categoryId: s.categories[1].id, frequency, anchor, limit: '100' });
    const p = period('2026-11-07', frequency, anchor);
    tx(s, { date: p.start, amount: '10' }); tx(s, { date: p.lastDay, amount: '20' }); tx(s, { date: p.end, amount: '40' });
    tx(s, { date: p.start, type: 'income', amount: '300' });
    tx(s, { date: p.start, type: 'transfer', toAccountId: s.accounts[1].id, amount: '25' });
    const b = summarize(s, '2026-11-07').budgets[0];
    assert.equal(b.spent, 3000, frequency); assert.equal(b.remaining, 7000, frequency);
  }
});
test('goals update independently of balances; expenses can overrun a budget', () => {
  const s = fixture();
  mutate(s, 'goal', { name: 'Home', target: '10000', saved: '500', due: '2028-01-01' });
  mutate(s, 'goal-progress', { id: s.goals[0].id, saved: '12500' });
  assert.equal(s.goals[0].saved, 1250000); assert.equal(summarize(s, '2026-11-07').netWorth, 90000);
  mutate(s, 'budget', { categoryId: s.categories[1].id, frequency: 'monthly', limit: '5' }); tx(s);
  assert.equal(summarize(s, '2026-11-07').budgets[0].remaining, -500);
});
test('validation and dependent deletion prevent orphan data', () => {
  const s = fixture();
  assert.throws(() => mutate(s, 'account', { name: 'checking', kind: 'cash', opening: '0' }));
  assert.throws(() => tx(s, { amount: '0' }));
  assert.throws(() => tx(s, { type: 'transfer', toAccountId: s.accounts[0].id }));
  assert.throws(() => tx(s, { accountId: '__proto__' }));
  tx(s);
  assert.throws(() => mutate(s, 'delete', { collection: 'accounts', id: s.accounts[0].id }));
  assert.throws(() => mutate(s, 'delete', { collection: 'categories', id: s.categories[1].id }));
  assert.throws(() => mutate(s, 'delete', { collection: '__proto__', id: s.accounts[0].id }));
  mutate(s, 'delete', { collection: 'transactions', id: s.transactions[0].id });
  mutate(s, 'delete', { collection: 'accounts', id: s.accounts[0].id });
  assert.equal(s.accounts.length, 1);
});
test('CSV strict quoting, BOM, multiline fields and transactional rejection', () => {
  const s = fixture(), header = 'date,type,account,category,amount,description\n';
  const result = importCSV(s, '\uFEFF' + header + '2026-11-07,expense,Checking,Food,1.29,"A, ""B""\nC"\r\n');
  assert.equal(result.added, 1); assert.equal(result.state.transactions[0].description, 'A, "B"\nC'); assert.equal(s.transactions.length, 0);
  assert.throws(() => importCSV(s, header + '2026-11-07,income,Checking,,100,Pay\n2026-02-30,expense,Checking,Food,1,Bad'));
  assert.equal(s.transactions.length, 0);
  for (const bad of ['x,y\n1,2', header + '1,2', header + '2026-11-07,income,Checking,,1,"unclosed', header + '2026-11-07,income,Checking,,1,"x"bad']) assert.throws(() => parseCSV(bad));
});
test('CSV duplicate handling and first keyword rule; explicit categories override', () => {
  const s = fixture(), header = 'date,type,account,category,amount,description\n';
  mutate(s, 'rule', { keyword: 'grocery', categoryId: s.categories[1].id });
  const source = header + '2026-11-07,expense,Checking,,3.45,grocery shop\n2026-11-07,income,Checking,,100,Side income';
  const first = importCSV(s, source);
  assert.equal(first.state.transactions[0].categoryId, s.categories[1].id);
  const second = importCSV(first.state, source);
  assert.equal(second.added, 0); assert.equal(second.skipped, 2);
  tx(s, { description: 'grocery', categoryId: s.categories[0].id });
  assert.equal(s.transactions[0].categoryId, s.categories[0].id);
});
test('Excel XML escapes markup, formula-like text and includes every major record', () => {
  const s = fixture();
  tx(s, { description: '=HYPERLINK("<evil>&")' });
  mutate(s, 'goal', { name: '+Goal', target: '100', saved: '0', due: '2027-01-01' });
  const output = excelXML(s);
  assert.ok(output.includes('&apos;=HYPERLINK(&quot;&lt;evil&gt;&amp;&quot;)'));
  assert.ok(output.includes('ss:Type="String"'));
  assert.ok(!output.includes('ss:Formula'));
  for (const name of ['Transactions', 'Accounts', 'Budgets', 'Goals']) assert.ok(output.includes(`ss:Name="${name}"`));
});
test('encrypted state validation rebuilds references and rejects corrupt money/IDs', () => {
  const s = fixture(); tx(s);
  assert.deepEqual(validateState(s), s);
  const wrong = structuredClone(s); wrong.transactions[0].amount = 1.2; assert.throws(() => validateState(wrong));
  const duplicate = structuredClone(s); duplicate.accounts[1].id = duplicate.accounts[0].id; assert.throws(() => validateState(duplicate));
});
