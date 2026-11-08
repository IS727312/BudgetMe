@echo off
setlocal EnableExtensions DisableDelayedExpansion
title BudgetMe - Local finance
set "BUDGETME_ROOT=%~dp0"
set "BUDGETME_RUNTIME=%BUDGETME_ROOT%.runtime"

if not exist "%BUDGETME_ROOT%app\server.mjs" (
    echo BudgetMe's app folder is missing. Keep this launcher beside the app folder.
    goto failure
)
if not exist "%BUDGETME_ROOT%app\tools\launch.mjs" (
    echo BudgetMe's startup helper is missing. Restore the complete app folder.
    goto failure
)
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. No installation was attempted.
    echo BudgetMe requires the already installed Node.js 24.16 or newer.
    goto failure
)
for %%D in (temp home cache appdata localappdata) do (
    if not exist "%BUDGETME_RUNTIME%\%%D\" mkdir "%BUDGETME_RUNTIME%\%%D" 2>nul
    if not exist "%BUDGETME_RUNTIME%\%%D\" goto runtime_failure
)
ver >nul
set "TEMP=%BUDGETME_RUNTIME%\temp"
set "TMP=%TEMP%"
set "HOME=%BUDGETME_RUNTIME%\home"
set "USERPROFILE=%HOME%"
set "APPDATA=%BUDGETME_RUNTIME%\appdata"
set "LOCALAPPDATA=%BUDGETME_RUNTIME%\localappdata"
set "XDG_CACHE_HOME=%BUDGETME_RUNTIME%\cache"
set "npm_config_cache=%BUDGETME_RUNTIME%\cache\npm"
set "npm_config_update_notifier=false"

cd /d "%BUDGETME_ROOT%app"
if errorlevel 1 goto failure
echo Opening BudgetMe in your default browser.
echo If this starts the server, keep this window open.
echo.
node "%BUDGETME_ROOT%app\tools\launch.mjs"
if errorlevel 1 goto failure
echo.
echo This launcher has finished. You may close this window.
echo An already-running original BudgetMe window must stay open.
pause
exit /b 0

:runtime_failure
echo Cannot create BudgetMe's local cache or temporary folders.

:failure
echo.
echo BudgetMe could not start or reopen, or stopped with an error.
echo No existing lock was removed. PowerShell policy was not changed.
pause
exit /b 1
