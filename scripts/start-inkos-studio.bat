@echo off
chcp 65001 >nul
cd /d "%~dp0.."
node "%~dp0start-studio.mjs"
if errorlevel 1 (
  echo.
  echo [InkOS] 启动失败，请查看上方报错。
  pause
  exit /b 1
)
