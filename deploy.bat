@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM One-click deploy for Artivio Command Center: sync the lockfile, TYPECHECK,
REM stage, commit (only if there are changes), push to origin/main.
REM Railway auto-deploys main (build: npm run build:next; pre-deploy: npm run db:migrate).
REM
REM USAGE
REM   deploy.bat          interactive - pauses on error so you can read it
REM   deploy.bat auto     unattended  - NEVER pauses. USE THIS IN TASK SCHEDULER.
REM
REM WHY THE TYPECHECK: Railway is otherwise the first thing that ever compiles
REM this code (the Cowork sandbox can't - virtiofs serves truncated reads of
REM freshly-edited files, so a tsc run there is clean on code it didn't touch and
REM lies about code it did). `tsc --noEmit` catches it here in ~30s instead of a
REM 30-minute failed-build cycle. It has already caught real errors more than once.
REM
REM WHY THE ERROR CHECKS: a corrupt .git once made `git commit` fail silently
REM while the script still printed "Done" and pushed nothing - 12 hours of work
REM looked deployed but wasn't. Every step now fails loudly.
REM
REM WHY `auto` EXISTS: `pause` under Task Scheduler waits forever for a keypress
REM nobody will press. That leaves a zombie process every 30 minutes, and a
REM zombie mid-git can hold .git/index.lock - which is how the `web` repo got
REM corrupted and stranded a day of SEO work. Scheduled runs must never block.
REM ============================================================================
cd /d "%~dp0"

set "NOPAUSE="
if /i "%~1"=="auto" set "NOPAUSE=1"

echo [deploy] Repo: %CD%

set "BRANCH="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH (
  echo [deploy] ERROR: not a git repository, or .git is unreadable.
  echo [deploy] Try: git status   /   git fsck --full
  call :die
)
if /i not "!BRANCH!"=="main" (
  echo [deploy] ERROR: you are on branch "!BRANCH!", not main. Railway deploys main.
  echo [deploy] Nothing was committed or pushed.
  call :die
)

echo [deploy] Syncing dependencies / lockfile (npm)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [deploy] ERROR: npm install failed. Fix the error above before deploying.
  echo [deploy] Nothing was committed or pushed.
  call :die
)

echo [deploy] Typechecking (tsc --noEmit)...
call npm run check:types
if errorlevel 1 (
  echo.
  echo [deploy] ==========================================================
  echo [deploy] TYPE ERRORS ABOVE - nothing was committed or pushed.
  echo [deploy] This is the script doing its job: the Railway build would
  echo [deploy] have failed too, 30 minutes from now, for the same reason.
  echo [deploy] Fix the errors ^(or send them to Claude^), then re-run.
  echo [deploy] ==========================================================
  call :die
)

echo [deploy] Staging changes...
git add -A
if errorlevel 1 (
  echo.
  echo [deploy] ERROR: git add failed - the repository may be corrupt.
  echo [deploy] Try: git fsck --full
  call :die
)

REM ---------------------------------------------------------------------------
REM Show what's about to be committed. Without this you can't tell "nothing
REM changed" from "Cline already committed my work" from "my edits never landed
REM on disk" - and those need completely different responses.
REM ---------------------------------------------------------------------------
git diff --cached --quiet
if errorlevel 1 (
  echo.
  echo [deploy] Changes to be committed:
  git diff --cached --stat
  echo.
  echo [deploy] Committing...
  git commit --no-verify -m "chore: deploy %date% %time%"
  if errorlevel 1 (
    echo.
    echo [deploy] ERROR: git commit FAILED. Nothing was pushed.
    echo [deploy] If you see "invalid object" errors, the object store is corrupt.
    echo [deploy] Recover with:  ren .git git-broken  ^&^&  git init -b main  ^&^&  git remote add origin ^<url^>  ^&^&  git fetch origin main  ^&^&  git reset --mixed FETCH_HEAD
    call :die
  )
  goto :push
)

REM Clean tree. Usually means Cline already committed, or the last run pushed
REM everything. Say WHICH, instead of leaving you to guess.
echo [deploy] Working tree is clean - nothing new to commit.
git fetch origin main --quiet 2>nul
set "LOCAL="
set "REMOTE="
for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "LOCAL=%%h"
for /f "delims=" %%h in ('git rev-parse origin/main 2^>nul') do set "REMOTE=%%h"
if /i "!LOCAL!"=="!REMOTE!" (
  echo [deploy] Local and origin/main are identical - everything is already deployed.
  echo [deploy] If you expected changes, they were probably committed by Cline
  echo [deploy] already, or your edits never saved to disk. Last 3 commits:
  git log -3 --oneline
  echo.
  goto :done
)
echo [deploy] Local has unpushed commits - pushing them now.

:push
echo [deploy] Pushing to origin/main...
git push origin main
if errorlevel 1 (
  echo.
  echo [deploy] ERROR: git push failed. See the error above.
  echo [deploy] If it says "non-fast-forward", something else pushed first. Run:
  echo [deploy]   git pull --rebase origin main
  call :die
)

echo.
echo [deploy] SUCCESS - pushed. Railway is building; migrations run pre-deploy.
git log -1 --oneline

:done
if defined NOPAUSE goto :eof
echo [deploy] This window closes in 6 seconds.
timeout /t 6 >nul
goto :eof

:die
REM Interactive: hold the window so the error is readable.
REM Scheduled (auto): exit immediately - a pause here hangs forever and can leave
REM a zombie holding .git/index.lock.
if not defined NOPAUSE pause
exit /b 1
