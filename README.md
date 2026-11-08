# BudgetMe

A dependency-free local finance app. Source control contains only reusable code,
tests, launchers, documentation and review-agent definitions. The vault, backups,
exports, credentials, runtime state, browser profiles and generated evidence
stay local and are excluded by a default-deny source allowlist.

Requires preinstalled Node.js 24.16 or newer; no dependency installation is needed.
On Windows, double-click **Launch BudgetMe.cmd** in this repository folder and
keep the original server window open. Data remains under `app\data`; temporary
state stays within this folder. See [the app guide](app/README.md) for secure
access, budgeting, backups, exports and limitations.

To check a clean checkout, open PowerShell in the repository folder:

```powershell
Set-Location .\app
node tools\release-gate.mjs
node tools\browser-check.mjs
```

The browser check requires an already installed Edge; it uses an isolated
synthetic profile and injected opener, not your real vault or default browser.
Never launch a development checkout against real financial data.

Security Agent and Test Agent live in `.github\agents`. Actual fingerprint-bound
review results and fresh browser evidence are required by
`node tools\release-gate.mjs --publication` before each authorized commit/push.
Ignored review evidence is regenerated locally, not committed as an approval.
No timed reviews or PR workflow are configured.

The source-path allowlist is shared by the fingerprint and index gate in
`app\tools\source-control.mjs`. Add new reusable files deliberately to both that
list and `.gitignore`; never force-add private files. `.gitignore` does not remove
anything already tracked. The gate rejects disallowed tracked paths before
reading any Git blobs and compares staged bytes with the reviewed source.
Git blobs use LF. Windows CMD launchers must check out with CRLF for reliable
label jumps; the gate enforces that and canonicalizes only those newlines when
comparing blobs and fingerprints. Other source uses LF.

Git history protects source code, **not financial data**. Use separately managed
encrypted vault backups for that. No financial data, passwords or authorization
tokens belong in an issue, review conversation or public commit. Loopback access
and encryption do not protect against a compromised Windows account, malicious
extensions, screen capture or copied encrypted vaults.
