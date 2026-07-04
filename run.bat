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
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{if((Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/health' -TimeoutSec 2).StatusCode -eq 200){exit 0}}catch{}; Start-Sleep 1}; exit 1"
if errorlevel 1 (
  echo  [!] Backend not responding yet - check the "Backend" window for errors.
) else (
  echo  [OK] Backend is up.
)

start "" http://127.0.0.1:3000

echo.
echo  ============================================================
echo    Running.   Dashboard:  http://127.0.0.1:3000
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
echo  ------------------------------------------------------------
echo   WARNING: your .env has NETWORK=base (EVM MAINNET). The EVM
echo   sim would move REAL USDC. Use the Solana-devnet sim above
echo   for safe testing. (EVM payments are auto-disabled in the
echo   mock seller on mainnet unless MOCK_SELLER_PAY_TO is set.)
echo  ------------------------------------------------------------
echo.
pause
