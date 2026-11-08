(async () => {
  const failures = [];
  const q = selector => document.querySelector(selector);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  window.addEventListener('error', event => failures.push(event.message));
  window.addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
  document.addEventListener('securitypolicyviolation', event => failures.push(`CSP: ${event.violatedDirective}`));
  const nativeError = console.error.bind(console);
  console.error = (...values) => { failures.push('Console error: ' + values.map(String).join(' ')); nativeError(...values); };
  async function waitFor(predicate, label) {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await pause(100); }
    throw new Error(`UI did not reach ${label}. ${q('#notice')?.textContent || ''}`);
  }
  const fill = (selector, value) => {
    const n = q(selector); assert(n, `Missing field ${selector}`); n.value = value;
    n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const click = selector => { assert(q(selector), `Missing control ${selector}`); q(selector).click(); };
  async function submit(id, values, predicate, label) {
    await waitFor(() => !q(`#${id} button[type=submit]`)?.disabled, `${id} ready`);
    for (const [name, value] of Object.entries(values)) fill(`#${id} [name="${name}"]`, value);
    assert(q(`#${id}`).checkValidity(), `Form invalid: ${id}`);
    q(`#${id}`).requestSubmit(); await waitFor(predicate, label);
  }
  try {
    let testPhase = (await (await fetch('/synthetic-phase', { cache: 'no-store' })).json()).phase;
    const password = 'synthetic-only browser test passphrase';
    if (testPhase === 'refresh') {
      await waitFor(() => q('#open-panel') && !q('#open-panel').hidden, 'safe refresh prompt');
      assert(q('#workspace').hidden && q('#auth-form').hidden, 'Refresh retained a usable financial session.');
      assert(launch === '' && session === null && data === null, 'Refresh retained an auth capability or financial state.');
      assert(q('#metrics').children.length === 0 && location.hash === '', 'Refresh retained private DOM or a fragment.');
      const denied = await fetch('/api/state', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: '2026-11-07' }), credentials: 'omit'
      });
      assert(denied.status === 403, 'A token-free refreshed page could access the API.');
      click('#open-budgetme');
      await waitFor(() => q('#open-result').textContent.includes('Requested'), 'reopen request');
      const opening = await (await fetch('/synthetic-open-request', { cache: 'no-store' })).json();
      assert(new URL(opening.url).origin === location.origin, 'Synthetic opener left its isolated loopback server.');
      assert(failures.length === 0, failures.join('; '));
      await fetch('/synthetic-phase', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'reopen' })
      });
      location.assign(opening.url);
      testPhase = 'reopen';
    }
    await waitFor(() => q('#auth-form') && !q('#auth-form').hidden, 'onboarding');
    assert(location.hash === '', 'Launch token was not removed from URL.');
    assert(localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === '', 'Browser auth storage or cookies were written.');
    if (testPhase === 'reopen') {
      assert(initialized && q('#workspace').hidden && session === null && data === null, 'Reopen inherited an unlocked session.');
      assert(q('#auth-title').textContent === 'Welcome back.', 'Reopen did not require fresh passphrase unlock.');
      await submit('auth-form', { password },
        () => !q('#workspace').hidden && q('#transaction-count').textContent.startsWith('12 entries'), 'reopen persistence');
      fill('#view-date', '2026-11-07');
      await waitFor(() => q('#metrics').textContent.includes('$3,600.00'), 'restored income period');
      click('nav [data-page="overview"]');
      assert(q('#metrics').textContent.includes('$1,380.85'), 'Reload/reopen lost saved spending.');
      const draft = 'Synthetic unsaved draft';
      fill('#account-form [name="name"]', draft);
      const originalSession = session, originalData = JSON.stringify(data);
      const metadata = async () => (await (await fetch('/synthetic-phase', { cache: 'no-store' })).json());
      const setProbe = mode => fetch('/synthetic-probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode })
      });
      const changeFragment = async (fragment, expected) => {
        const before = (await metadata()).probes;
        location.hash = fragment;
        await waitFor(() => location.hash === '' && q('#notice').textContent.includes(expected), `fragment handling (${expected})`);
        assert((await metadata()).probes > before || fragment === '#open=junk', 'Fragment was not checked against the private gate.');
      };
      await changeFragment('#open=' + 'a'.repeat(64), 'already open');
      assert(session === originalSession && JSON.stringify(data) === originalData && q('#account-form [name="name"]').value === draft, 'Reopen changed an authorized session or unsaved form.');
      await changeFragment('#open=junk', 'Invalid opening');
      assert(session === originalSession && JSON.stringify(data) === originalData, 'Hostile fragment cleared private state.');
      for (const [mode, expected] of [['busy', 'already open'], ['forbidden', 'blocked'], ['network', 'Cannot confirm']]) {
        q('#notice').textContent = '';
        await setProbe(mode);
        await changeFragment('#open=' + 'b'.repeat(64), expected);
        assert(!q('#workspace').inert && session === originalSession && JSON.stringify(data) === originalData &&
          q('#account-form [name="name"]').value === draft, `${mode} probe altered a working tab.`);
      }
      await setProbe(null);
      const beforeQueue = await metadata();
      location.hash = '#open=' + 'c'.repeat(64);
      location.hash = '#open=' + 'd'.repeat(64);
      await openingQueue;
      // hashchange tasks arrive after the synchronous assignments.
      await waitFor(() => location.hash === '', 'queued URL clearing');
      await openingQueue;
      assert((await metadata()).probes >= beforeQueue.probes + 2, 'Quick fragment tickets were not captured independently.');
      assert(session === originalSession && JSON.stringify(data) === originalData && q('#account-form [name="name"]').value === draft, 'Queued openings changed the authorized tab.');
      await setProbe('invalid');
      q('#notice').textContent = '';
      await changeFragment('#open=' + 'e'.repeat(64), 'expired or was already used');
      assert(q('#workspace').inert && session === originalSession && JSON.stringify(data) === originalData &&
        q('#account-form [name="name"]').value === draft, 'Failed replacement claim wiped stale unsaved work.');
      const replacement = await (await fetch('/synthetic-issue', { cache: 'no-store' })).json();
      await setProbe('invalid');
      location.hash = new URL(replacement.url).hash;
      await waitFor(() => q('#workspace').hidden && !q('#auth-form').hidden, 'authenticated replacement');
      assert(!q('#workspace').inert && data === null && session === null &&
        q('#account-form [name="name"]').value === '', 'Successful replacement did not clear stale private state.');
      await submit('auth-form', { password }, () => !q('#workspace').hidden, 'replacement unlock');
      const late = api('/api/state', { day: '2026-11-07' });
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      let blockedLate = false;
      try { await late; } catch (error) { blockedLate = error.message.includes('browser session closed'); }
      assert(blockedLate && data === null && session === null && launch === '', 'An asynchronous financial response survived pagehide.');
      const finalOpening = await (await fetch('/synthetic-issue', { cache: 'no-store' })).json();
      location.hash = new URL(finalOpening.url).hash;
      await waitFor(() => !q('#auth-form').hidden && launch !== '', 'final fresh opening');
      await submit('auth-form', { password },
        () => !q('#workspace').hidden && q('#transaction-count').textContent.startsWith('12 entries'), 'final persistence');
      fill('#view-date', '2026-11-07');
      await waitFor(() => q('#metrics').textContent.includes('$3,600.00'), 'final income period');
      click('nav [data-page="overview"]');
      assert(localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === '', 'Reopen persisted authentication.');
      assert(document.documentElement.scrollWidth <= innerWidth + 1, 'Reopened page has horizontal overflow.');
      assert(failures.length === 0, failures.join('; '));
      for (const resource of performance.getEntriesByType('resource')) assert(new URL(resource.name).origin === location.origin, 'External reopened application resource.');
      q('#notice').hidden = true;
      document.documentElement.setAttribute('data-budgetme-viewport', `${innerWidth}x${innerHeight}`);
      document.documentElement.setAttribute('data-budgetme-result', 'passed');
      return;
    }
    fill('#password-confirm', password);
    await submit('auth-form', { name: 'Synthetic demo', password },
      () => !q('#workspace').hidden && q('#metrics').children.length === 4, 'vault setup');
    assert(!q('#onboarding').hidden, 'Empty-state onboarding missing.');
    click('nav [data-page="accounts"]');
    for (const [name, institution, kind, opening, count] of [
      ['Chase checking', 'Chase', 'checking', '3000', 1],
      ['Fidelity savings', 'Fidelity', 'savings', '5000', 2],
      ['Amex card', 'American Express', 'credit', '-200', 3]
    ]) await submit('account-form', { name, institution, kind, opening },
      () => q('#account-list').children.length === count, 'account');
    click('nav [data-page="transactions"]'); fill('#view-date', '2026-11-07');
    await waitFor(() => q('#metrics').textContent.includes('$7,800.00'), 'selected date');
    const ids = Object.fromEntries([...q('#tx-account').options].map(o => [o.textContent, o.value]));
    const food = [...q('#tx-category').options].find(o => o.textContent === 'Food').value;
    const housing = [...q('#tx-category').options].find(o => o.textContent === 'Housing').value;
    let count = 0;
    const transaction = async values => {
      count++;
      await submit('transaction-form', { type: 'expense', date: '2026-11-07', accountId: ids['Chase checking'], categoryId: food, amount: '10', description: 'Synthetic purchase', ...values },
        () => q('#transaction-count').textContent.startsWith(`${count} entries`), `transaction ${count}`);
    };
    for (const [month, amount] of [['08', '2900'], ['09', '3100'], ['10', '2800'], ['11', '3200']]) {
      await transaction({ type: 'income', date: `2026-${month}-01`, amount, description: 'Salary' });
      await transaction({ date: `2026-${month}-03`, amount: '1200', categoryId: housing, description: 'Rent' });
    }
    await transaction({ amount: '145.75', accountId: ids['Amex card'], description: 'Groceries' });
    await transaction({ type: 'income', amount: '400', description: 'Freelance' });
    await transaction({ type: 'transfer', amount: '200', toAccountId: ids['Amex card'], description: 'Card payment' });
    assert(q('#metrics').textContent.includes('$1,345.75'), 'Incorrect expense total.');
    click('nav [data-page="budgets"]');
    await submit('budget-form', { categoryId: food, frequency: 'monthly', limit: '450' },
      () => q('#budget-list').children.length === 1, 'monthly budget');
    await submit('budget-form', { categoryId: housing, frequency: 'biweekly', anchor: '2026-11-02', limit: '1500' },
      () => q('#budget-list').children.length === 2, 'biweekly budget');
    click('nav [data-page="goals"]');
    await submit('goal-form', { name: 'Home down payment', target: '25000', saved: '6500', due: '2028-11-07' },
      () => q('#goal-list').children.length === 1, 'goal');
    await submit('goal-form', { name: 'A little adventure', target: '2000', saved: '850', due: '2027-08-01' },
      () => q('#goal-list').children.length === 2, 'second goal');
    click('nav [data-page="tools"]');
    await submit('rule-form', { keyword: 'market', categoryId: food },
      () => q('#rule-list').textContent.includes('market'), 'category rule');
    fill('#csv-text', 'date,type,account,category,amount,description\n2026-11-06,expense,Chase checking,,35.10,Local market');
    click('#import-preview'); await waitFor(() => !q('#import-confirm').hidden, 'CSV preview');
    assert(q('#transaction-count').textContent.startsWith('11 entries'), 'Preview persisted data.');
    click('#import-confirm'); await waitFor(() => q('#transaction-count').textContent.startsWith('12 entries'), 'CSV import');
    await waitFor(() => !q('#import-confirm').disabled, 'import ready');
    click('#backup'); await waitFor(() => q('#export-list').textContent.includes('Encrypted backup'), 'backup');
    await waitFor(() => !q('#backup').disabled, 'backup ready');
    fill('#export-confirm', 'EXPORT'); click('#excel-export');
    await waitFor(() => q('#export-list').textContent.includes('Plaintext Excel'), 'Excel');
    await waitFor(() => !q('#excel-export').disabled, 'Excel ready');
    click('nav [data-page="transactions"]'); fill('#search', 'market');
    assert(q('#transaction-count').textContent.startsWith('1 entries'), 'Search failed.');
    click('#lock'); await waitFor(() => q('#workspace').hidden, 'explicit lock');
    assert(q('#all-transactions').textContent === '', 'Lock retained financial DOM.');
    assert(q('#csv-text').value === '', 'Lock retained CSV data.');
    await submit('auth-form', { password },
      () => !q('#workspace').hidden && q('#transaction-count').textContent.startsWith('12 entries'), 'unlock persistence');
    await waitFor(() => !q('#auth-submit').disabled, 'unlock ready');
    const staleSession = session;
    const again = await api('/api/unlock', { password }, false);
    session = again.session;
    const stale = await fetch('/api/state', {
      method: 'POST', credentials: 'omit', headers: {
        'Content-Type': 'application/json', 'X-BudgetMe-Launch': launch, 'X-BudgetMe-Session': staleSession
      }, body: JSON.stringify({ day: '2026-11-07' })
    });
    assert(stale.status === 401, 'Re-authentication did not invalidate the previous session.');
    await reload(); click('nav [data-page="overview"]');
    assert(q('#metrics').textContent.includes('$3,600.00'), 'Incorrect multi-source income.');
    assert(q('#metrics').textContent.includes('$1,380.85'), 'Incorrect imported spending.');
    assert(q('#trend-chart').querySelectorAll('svg rect').length === 24, 'Historical chart missing.');
    assert(document.documentElement.scrollWidth <= window.innerWidth + 1, 'Page has horizontal overflow.');
    for (const resource of performance.getEntriesByType('resource')) {
      assert(new URL(resource.name).origin === location.origin, 'External application resource requested.');
    }
    assert(failures.length === 0, failures.join('; '));
    window.addEventListener('pagehide', () => {
      fetch('/synthetic-observe-hide', {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cleared: launch === '' && session === null && data === null && q('#metrics').children.length === 0 })
      });
    });
    await fetch('/synthetic-phase', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'refresh' })
    });
    location.reload();
  } catch (error) {
    document.documentElement.setAttribute('data-budgetme-result', 'failed');
    const result = document.createElement('pre'); result.id = 'synthetic-result';
    result.textContent = `${error.message}; ${failures.join('; ')}`; document.body.append(result);
  }
})();
