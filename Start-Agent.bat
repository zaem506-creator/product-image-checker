@echo off
rem Starts the image check page with the agent: double-click this file.
cd /d "%~dp0agent"
where node >nul 2>nul || (echo Node.js is not installed - get it from https://nodejs.org & pause & exit /b)
if not exist node_modules call npm install
if not exist .env (copy .env.example .env >nul & echo Put your API key in agent\.env, save, then run this again. & notepad .env & exit /b)
start "" cmd /c "timeout /t 4 >nul & start http://localhost:8787"
npm start
pause
