@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Сначала установите Node.js с сайта https://nodejs.org ^(кнопка LTS^), потом запустите этот файл снова. & pause & exit /b)
if not exist node_modules (
  echo Первый запуск: скачиваю зависимости, это займёт минуту...
  call npm install
)
call npm run share
pause
