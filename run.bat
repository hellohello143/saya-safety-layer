@echo off
setlocal
cd /d "%~dp0"
title AI Agent Payment Safety Layer

echo.
echo  ============================================================
echo    AI Agent Payment Safety Layer  -  launcher
echo  ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js not found. Install Node 22.13+ and re-run this file.
  pause
  exit /b 1
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo  [!] Created .env from the template.
  echo      Open .env, fill in your 3 CDP credentials, then run this file again.
  pause
  exit /b 1
)

rem --- read PORT / NETWORK / SOLANA_NETWORK from .env (eol=# skips comment lines) ---
set "PORT="
set "NETWORK="
set "SOLANA_NETWORK="
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="PORT" set "PORT=%%B"
  if /i "%%A"=="NETWORK" set "NETWORK=%%B"
  if /i "%%A"=="SOLANA_NETWORK" set "SOLANA_NETWORK=%%B"
)
if not defined PORT set "PORT=3000"
set "MAINNET="
if /i "%NETWORK%"=="base" set "MAINNET=1"
if /i "%SOLANA_NETWORK%"=="solana" set "MAINNET=1"

if not exist "node_modules" (
  echo  [*] Installing dependencies ^(first run, about a minute^)...
  call npm install
  if errorlevel 1 (
    echo  [X] npm install failed.
    pause
    exit /b 1
  )
)

echo  [*] Preflight: validating CDP credentials and funding treasuries...
call npm run setup
if errorlevel 1 (
  echo  [X] Preflight failed - fix the .env issues shown above, then re-run.
  pause
  exit /b 1
)

echo.
echo  [*] Starting backend + mock seller in their own windows...
start "Safety Layer - Backend"     /d "%~dp0" cmd /k npm run dev
start "Safety Layer - Mock Seller" /d "%~dp0" cmd /k npm run mock-seller

echo  [*] Waiting for the backend to come up...
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{if((Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%PORT%/health' -TimeoutSec 2).StatusCode -eq 200){exit 0}}catch{}; Start-Sleep 1}; exit 1"
if errorlevel 1 (
  echo  [!] Backend not responding yet - check the "Backend" window for errors.
) else (
  echo  [OK] Backend is up.
)

start "" http://127.0.0.1:%PORT%

echo.
echo  ============================================================
echo    Running.   Dashboard:  http://127.0.0.1:%PORT%
echo    Backend and mock seller are in their own windows.
echo  ============================================================
echo.
echo  Run the definition-of-done scenarios from THIS window:
echo.
echo     Solana (devnet, test money, recommended):
echo        npm run agent-sim -- --network=solana-devnet
echo.
echo     EVM:
echo        npm run agent-sim
echo.
if defined MAINNET (
  echo  ------------------------------------------------------------
  echo   WARNING: your .env targets MAINNET ^(NETWORK=%NETWORK%,
  echo   SOLANA_NETWORK=%SOLANA_NETWORK%^) - the sims move REAL funds.
  echo   Switch to a testnet network ^(base-sepolia / solana-devnet^)
  echo   in .env for safe testing.
  echo  ------------------------------------------------------------
  echo.
)
pause
