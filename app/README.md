# BudgetMe

A dependency-free, local personal finance app for this Windows PC. The core works
offline: there is no account signup, bank connection, analytics, remote asset,
telemetry client, package installation, or paid service.

## Start

Requires the already installed Node.js 24.16 or newer. Nothing needs installing.

**Easiest: open this BudgetMe folder in File Explorer and double-click
`Launch BudgetMe.cmd`.** It requests your Windows default browser automatically.
If it starts the server, keep that original launcher window open. Create or
unlock your vault in the browser. No terminal link hunting is needed.

To reopen the app, double-click the same launcher again. It asks the existing
server to open its own browser; it does not start a second server or steal a
lock. You may close this second launcher window after its acknowledgement.
To refresh, refresh normally, click **Open BudgetMe**, and unlock in the opened
window or tab. Your browser may open a window, open a tab, or reuse this tab.
An already-authorized reused tab keeps its existing session and unsaved forms;
a refreshed token-free tab still requires your passphrase.
Refresh deliberately locks the old tab rather than
storing credentials in the browser. It is not seamless session restoration.

This launcher does not use PowerShell, change execution policy, or install
anything. It invokes the shared Node startup helper and keeps writable
home/temp/cache settings inside BudgetMe. Windows URL dispatch uses the built-in
`rundll32.exe`, without a command shell, script, or persisted handoff file.
Errors stay visible until you press a key. If no browser appears, check Windows
default-browser settings and double-click the launcher again. A stale lock or
an older running version is an explicit error, not permission to remove locks.

Alternatively, in PowerShell:

```powershell
# Open PowerShell in the repository folder.
.\launch.ps1
```

If scripts are disabled with a `PSSecurityException`, use the double-click
`.cmd` launcher instead; no policy change or bypass is needed.
The plain local address `http://127.0.0.1:47821/` is now an actionable, locked
entry page: **Open BudgetMe** requests a fresh authorized browser opening. It
does not itself grant API or financial access. Keep the original terminal
open; Ctrl+C stops its server. Reopening alone never revokes an existing
session or inherits an unlocked one. Successfully entering your passphrase in
another window still rotates the sole financial session, so a previously
unlocked window must unlock again. There are no cookies, browser-storage auth
tokens, service workers, or automatic financial-session restoration.

**Upgrading from 1.0.2:** do not replace assets while the old server is running.
Save any current form work, press Ctrl+C in the original launcher and allow it
to stop, then close old-version BudgetMe browser tabs. Apply the reviewed update
and double-click `Launch BudgetMe.cmd`. A staged update
does not change the currently running app. No automatic restart or vault reset
is performed.

The launcher keeps writable home, temp and cache settings under BudgetMe.
Source is in `app`. Personal data is in `app\data`; exports in `app\exports`.
Both are excluded by the repository's default-deny source allowlist. Source
control covers reusable app code only, not financial backups. No PR, package
download or timer is configured. No financial data belongs in git.

## First use

Create your vault using a strong passphrase, preferably four or more unrelated
words. There is **no password reset**. Without that passphrase, your encrypted
vault and backups cannot be recovered.

Add accounts with friendly names: Chase checking, Fidelity retirement, Bank of
America savings, American Express card, or cash. These are locally tracked
labels, **not live provider integrations**. Enter card debt as a negative opening
balance. The opening balance should precede the transaction history you enter.

Add expenses, income (including separate salaries or side-income descriptions),
and transfers. Card payments are transfers from checking to the card. Expenses
and income use positive USD amounts; transfers do not affect income or expense
charts. Investments have manual values, not live prices.

Create category budgets on weekly, biweekly, monthly, quarterly, or yearly
schedules. Weekly is Monday-Sunday. Biweekly is exactly 14 days from the chosen
anchor. Other schedules follow the calendar. No rollover or prorating. Multiple
schedules count the same category independently. Select a date to inspect past
periods. Budget and cash-flow totals cover the **whole selected period**, including
scheduled entries; account balances cover transactions through the selected day.

Create savings goals and update their saved amounts. Goals are planning records:
they do not move money or change account balances. The goal pace is an
approximate monthly suggestion, not an investment forecast.

The overview includes 12-month income/expense trends, category shares, current
budget progress, goals, balances and recent entries. Chart values are also
available in an accessible table. Search/filter and paginate transaction history.
To correct a transaction, remove it and enter its replacement.

## Offline import and export

Export CSV from your financial provider yourself, then adapt it to this exact
header using an offline editor:

```csv
date,type,account,category,amount,description
2026-11-07,expense,Chase checking,Food,24.50,Groceries
2026-11-07,income,Chase checking,,2000.00,Salary
```

Account/category names must already exist and match exactly. Blank expense
category uses the first keyword rule, then Other. Preview before confirming.
The entire import succeeds or fails together. CSV supports quoting, escaped
quotes, UTF-8 BOM and embedded newlines; 1 MB / 2000 rows maximum.
Exact same date/type/account/category/amount/description entries are skipped as
duplicates. Legitimate identical purchases should be entered manually.
Transfers are entered manually. There is no automatic bank/Apple Pay feed.

Save an encrypted backup through Import & privacy. Excel export requires typing
`EXPORT` and writes a **plaintext** multi-sheet SpreadsheetML `.xml` file, not
`.xlsx`. Excel can open it; all cells are literal text and formula-like values
are prefixed defensively. Files remain in `app\exports`, not Downloads.
The UI can remove individual export files. Disk/SSD secure erasure is not
guaranteed. Backups on the same disk do not protect against disk loss.

## Restore and interrupted runs

Stop the server before restoring. From the app folder, run interactively:

```powershell
node tools\restore.mjs exports\<encrypted-backup-name>.json
# Or restore the previous encrypted save:
node tools\restore.mjs data\vault.previous.json
```

The tool hides passphrase input, verifies the backup, and requires `RESTORE`.
Typing anything else, closing input, or pressing Ctrl+C at either prompt cancels
without replacing the current vault and releases the restore's ownership lock.
It retains the old current file in `data\vault.pre-restore.json`, then replaces
only the encrypted current vault. No passphrase is a command-line argument.
If no current vault existed, a verified, explicitly confirmed restore creates it
and reports that there was no previous current file; it does not invent a retained
snapshot. Missing current with previous snapshots still blocks empty setup.
It never restores silently. The backup is of an earlier point in time.

An exclusive `data\process.lock` protects against concurrent writers. A killed
process may leave it behind. Locks are deliberately never stolen automatically,
even for a dead or reused PID. Check Task Manager/the owning terminal to confirm
no BudgetMe server or restore process remains; **only then** remove the specific
`app\data\process.lock` file. Do not delete your data folder. If encrypted `.tmp`
files remain after a crash, preserve them and the current/previous vaults, stop
all instances, and choose a verified encrypted backup to restore. Only remove a
specific leftover temp file once that recovery decision is made. A missing
current vault with a previous snapshot cannot be replaced by a new empty setup.

Each save verifies fresh AES-GCM ciphertext, fsyncs a same-directory temporary
file, and replaces current only after preserving previous. A failed operation
does not commit new in-memory state. Windows rename/flush durability under power
loss is best-effort; no silent rollback recovery is attempted.

## Security boundaries

AES-256-GCM with random 12-byte nonces encrypts the vault. The version, salt and
fixed scrypt parameters are authenticated metadata. Key derivation uses
N=131072, r=8, p=1, a random 32-byte salt and an explicit 256 MiB memory ceiling.
No plaintext passwords or encryption keys are written to the repository or data
files. The process holds decrypted financial data while unlocked; lock wipes the
key buffer best-effort, but JavaScript/OS memory erasure is not guaranteed.

The server binds exclusively to **127.0.0.1**, validates exact Host and Origin,
blocks cross-site Fetch Metadata, requires memory-only launch/session headers,
uses no CORS, rejects oversized requests, throttles password failures, and sends
no-store/CSP/frame isolation headers. Fifteen minutes without an authenticated
action locks the vault. Merely reading an already displayed page does not extend
the session. Rate limits reset on server restart and do not stop offline
password guessing against copied encrypted files.

Browser openings use random 256-bit, single-use codes that expire after
60 seconds. The frontend removes the URL fragment immediately, then redeems
the code through an exact-origin POST body for a RAM-only launch capability.
The code grants no financial session; the vault passphrase remains required.
Nothing writes the code to a handoff file, query string, application log,
cookie, localStorage, sessionStorage, or browser history state. It does not use
history to restore authentication and clears the current fragment synchronously.
Rapid fragment navigations and browser internals may still briefly record
one-use URLs; clearing the address is not a guarantee of OS/browser erasure.
The launcher
never prints a capability or returns one over its trigger-only named pipe.
There are at most two pending grants, one for HTTP and one for the launcher.
Repeated triggers reuse an unclaimed grant rather than invalidating someone
else's opening. Separate cooldowns prevent HTTP popups from consuming the
launcher's quota. Claim replay, expiry, malformed input, and hostile requests
fail closed.

If native opening reuses a tab, fragment delivery is handled without reloading
its existing forms. A launch-only status probe preserves an authorized tab on
success or a busy response. Network, Host/Origin and unrelated forbidden errors
do not wipe it. Only a machine-coded invalid launch gate marks a stale view
inactive; failed replacement claims preserve unsaved work, and a successful
claim clears stale private state before the passphrase prompt. Queued openings
capture each code by value. Pagehide invalidates pending client work so late
responses cannot repopulate private state after refresh.

The unauthenticated reopen endpoint is a bounded new side effect: a local
process can forge HTTP headers or trigger the pipe and cause a browser popup,
but receives no code, capability, session, or financial data. HTTP reopening
requires POST, JSON, exact Host/Origin, same-origin Fetch Metadata and a custom
header; there is no CORS. Native dispatch briefly places the **one-use code**
in a process command line. Windows/EDR or browser internals may record it even
though the frontend strips the fragment; first redemption or 60-second expiry
limits reuse. Long-lived launch/session capabilities and the passphrase are
not native-opener arguments. OS/browser logging, extensions and compromised
Windows cannot be made safe by this app.

**No app can promise immunity to data leaks.** Windows malware, administrators,
same-user process/memory access, browser extensions, screen capture, file
sharing and cloud-synced Documents folders remain risks. Check that this folder
is not synced or shared. Use a trusted browser profile, screen lock, strong
Windows password and disk encryption. A copied encrypted vault can be attacked
offline; plaintext exports are readable by anyone with filesystem access.
This app makes no outbound financial requests and cannot control Windows or
your browser's own networking. Do not enter real data into an agent conversation.

The app intentionally supports USD only, at most 100 accounts/categories/goals/
rules, 200 budgets and 20000 transactions. Explicit errors signal limits.
External linking would require separate user consent and architecture review.

## Version checks and custom agents

Repository custom agents **Security Agent** and **Test Agent** live in
the repository-root `.github\agents`. Run the following commands from `app`.
They define real review scope and executable checks; they are
not permanently running processes. Every changed version must run:

```powershell
node tools\release-gate.mjs
node tools\browser-check.mjs
```

The first checks syntax, zero-dependency policy, local assets/DOM policy,
tracked private files, and synthetic finance/vault/HTTP tests. The second uses
the preinstalled Edge browser with a workspace-only synthetic profile and
same-origin application-resource verification. No browser/package download is allowed.
Both save evidence under ignored `.runtime\release`; the UI screenshot has only
synthetic fixtures under `.runtime\ui`.

Installed Edge's isolated headless renderer does not expose a debugger in this
environment. The runnable check instead injects a driver through a separate,
synthetic-only loopback adapter (no production test routes). Direct HTTP tests
verify real Host/Origin guards independently of that adapter. Actual viewport
widths are measured and recorded rather than inferred from requested windows:
the checks require a desktop width of at least 1000px and a narrow width from
320px to 600px. Edge clamps minimum sizes and subtracts native borders; smaller
mobile layouts are not claimed as browser-verified. The driver captures early
window errors, console errors, unhandled rejections and CSP violations.

Invoke both reviewers on the printed source fingerprint. After their actual
passing results, the owning agent records each with:

```powershell
node tools\record-review.mjs security <fingerprint> "<actual reviewer>" "<actual result>"
node tools\record-review.mjs test <fingerprint> "<actual reviewer>" "<actual result>"
node tools\release-gate.mjs --publication
```

Any changed source invalidates the attestations/browser evidence. These local
attestations record workflow, not independent cryptographic guarantees. The
publication gate must pass **before** any user-authorized commit or push; no
commit or push should occur without explicit user authorization. There are no git hooks pretending to invoke
AI reviews silently. A periodic schedule remains unspecified: choose a cadence
before configuring timed scans. Per-version checks are implemented now.

The double-click launcher's own executable regression tests run in synthetic
folders (including a path with spaces), use a separate loopback port, and never
touch an active user server or vault.
Simultaneous CMD startup verifies the required directories actually exist
rather than treating another launcher's successful creation as an error.

Access tests cover start/reopen races, stale and legacy owners, real named-pipe
triggers, single-use/expiry/cooldown boundaries, opener errors, unauthorized
HTTP requests, and no session inheritance/revocation on reopening. The real
isolated Edge check reloads the actual page, observes private state/DOM clearing,
uses its token-free Open button, re-enters with a fresh code, and requires the
passphrase again. Its in-memory synthetic opener navigates the isolated
renderer instead of launching another native default-browser window.
The same test exercises fragment-only tab reuse, working-session and unsaved
form preservation, busy/forbidden/network/invalid-gate branches, rapid and
hostile fragments, unsuccessful and successful replacement claims, and blocking
late financial responses after a pagehide event.
**The actual Windows default-browser association is not developer-tested:**
executing it could write to an outside-folder user profile. The user's first
manual launch after adoption is the remaining integration check. No production
vault or live user browser is inspected for that check.

## Material design decisions

Confidence is an evidence-based design judgment, **not** a statistical guarantee
or a security certification. Decisions at or below 95% were debated with the
user-requested Sonnet 5.5 architecture/testing peer; agreement does not imply
immunity. There were no unresolved architecture blockers.

| Decision | Confidence | Rationale / review |
| --- | --- | --- |
| Local web rather than desktop | 92% | Existing Node capabilities; desktop alternatives needed unapproved downloads. Sonnet peer agreed. |
| Zero third-party packages | 98% | Built-in HTTP, crypto, tests and filesystem meet this scoped core; no package install or supply-chain bootstrap is needed. |
| Authenticated encrypted JSON snapshots | 92% | Single-user bounded data; tested replacement failures and abrupt crashes, with explicit recovery and Windows durability limits. Peer agreed. |
| Strong scrypt + AES-GCM | 94% | Fixed authenticated KDF metadata, explicit memory ceiling, random salt/nonce and tamper tests; peer strengthened the initial proposal. |
| Memory-only launch/session headers, no cookies | 94% | Avoids localhost cookie port sharing; exact-origin guards, idle lock and re-authentication; peer agreed with browser/OS limitations. |
| UTC date-only boundaries and integer cents | 97% | Exact decimal parsing and synthetic boundary/transfer tests, including leap years and pre-anchor biweekly dates. |
| Offline CSV + literal Excel XML | 94% | Atomic preview/import, explicit duplicate semantics, formula-safe text export with typed plaintext acknowledgement. Peer agreed. |
| Installed headless browser adapter | 80% | Peer accepted a bounded alternative to unavailable debugger with disclosed coverage limits; actual viewport checks prevent overstating mobile coverage. |
| Per-version gates without a timer | 98% | Matches authorized release checking; no timed cadence was chosen, so no automation was created. |
| Policy-independent Windows launcher | 98% | Shared Node entry point, no PowerShell policy changes or installs; executable CMD tests cover spaces, confinement, errors, reopening and simultaneous directory/startup races. Required directory existence is verified after creation attempts. |
| RAM-only reopen / refresh recovery | 85% | Sonnet 5.5 peer agreed on the proposal, not a code review: one-use codes, trigger-only IPC, no storage, no inherited session, no revocation on reopen. Refresh requires one Open click and a fresh passphrase. |
| Native default-browser dispatch | 70% | Peer preferred direct built-in dispatch over PowerShell logging; fixed loopback-only argv, shell disabled, bounded owned helper. Real OS association remains a user integration check, not a claimed test success. |
| Reused-tab fragment handling | 85% | A real Edge test exposed fragment-only navigation; the Sonnet peer agreed to synchronous cleanup, serialized claims, machine-coded gate classification, preserving valid sessions/forms and wiping stale work only after claim succeeds. |
| Blocking responses after pagehide | 97% | A captured lifecycle generation prevents late API/opening completions from repopulating a closed tab; synthetic browser response-after-hide regression verifies the exact behavior. |
