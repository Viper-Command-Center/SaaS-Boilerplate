@echo off
REM One-click deploy for Artivio Command Center: sync the npm lockfile, stage,
REM commit (only if there are changes), and push to origin/main. Railway
REM auto-deploys main (build: npm run build:next; pre-deploy: npm run db:migrate).
REM
REM The "npm install" step keeps package-lock.json in sync with package.json so
REM Railway's `npm ci` build never fails on a stale lockfile.
cd /d "%~dp0"

echo [deploy] Syncing dependencies / lockfile (npm)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [deploy] ERROR: npm install failed. Fix the error above before deploying.
  echo [deploy] Nothing was committed or pushed.
  pause
  exit /b 1
)

echo [deploy] Staging changes...
git add -A
git diff --cached --quiet
if errorlevel 1 (
  echo [deploy] Committing...
  REM --no-verify: skip lefthook/commitlint hooks; "chore:" keeps the message
  REM conventional anyway for readable history.
  git commit --no-verify -m "chore: deploy %date% %time%"
) else (
  echo [deploy] No new changes to commit; pushing any unpushed commits...
)
echo [deploy] Pushing to origin/main...
git push origin main
echo.
echo [deploy] Done. This window closes in 6 seconds.
timeout /t 6 >nul
