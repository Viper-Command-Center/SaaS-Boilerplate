@echo off
REM One-click deploy for Artivio Command Center: sync the npm lockfile, TYPECHECK,
REM stage, commit (only if there are changes), and push to origin/main. Railway
REM auto-deploys main (build: npm run build:next; pre-deploy: npm run db:migrate).
REM
REM WHY THE TYPECHECK: Railway is otherwise the first thing that ever compiles the
REM code, so a one-character mistake costs a full failed build + 30-minute cycle
REM (this happened twice). `tsc --noEmit` catches it here in ~30 seconds instead.
REM
REM WHY THE ERROR CHECKS: a corrupt .git once made `git commit` fail silently while
REM the script still printed "Done" and pushed nothing — 12 hours of work looked
REM deployed but wasn't. Every step now fails loudly.
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

echo [deploy] Typechecking (tsc --noEmit)...
call npm run check:types
if errorlevel 1 (
  echo.
  echo [deploy] ERROR: TypeScript errors above. The Railway build would fail too.
  echo [deploy] Nothing was committed or pushed. Fix the errors, then re-run.
  pause
  exit /b 1
)

echo [deploy] Staging changes...
git add -A
if errorlevel 1 (
  echo.
  echo [deploy] ERROR: git add failed - the repository may be corrupt.
  echo [deploy] Try: git fsck --full
  pause
  exit /b 1
)

git diff --cached --quiet
if errorlevel 1 (
  echo [deploy] Committing...
  REM --no-verify: skip lefthook/commitlint hooks; "chore:" keeps the message
  REM conventional anyway for readable history.
  git commit --no-verify -m "chore: deploy %date% %time%"
  if errorlevel 1 (
    echo.
    echo [deploy] ERROR: git commit FAILED. Nothing was pushed.
    echo [deploy] If you see "invalid object" errors, the git object store is corrupt.
    echo [deploy] Recover with:  ren .git git-broken  ^&^&  git init -b main  ^&^&  git remote add origin ^<url^>  ^&^&  git fetch origin main  ^&^&  git reset --mixed FETCH_HEAD
    pause
    exit /b 1
  )
) else (
  echo [deploy] No new changes to commit; pushing any unpushed commits...
)

echo [deploy] Pushing to origin/main...
git push origin main
if errorlevel 1 (
  echo.
  echo [deploy] ERROR: git push failed. See the error above.
  pause
  exit /b 1
)

echo.
echo [deploy] SUCCESS - pushed. Railway is building; migrations run pre-deploy.
echo [deploy] This window closes in 6 seconds.
timeout /t 6 >nul
