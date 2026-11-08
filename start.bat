@echo off
rem Art Hackathon 로컬 판 실행기. 더블클릭하면 필요한 것을 확인하고 설치한 뒤 Chrome으로 페이지를 연다.
rem 인자는 scripts\local.mjs 로 그대로 넘긴다. 예: start.bat --preview
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Art Hackathon (local)

echo.
echo  [1/3] Node.js 확인
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js가 없습니다. https://nodejs.org 에서 22.9 이상 LTS를 설치한 뒤 다시 실행하세요.
  goto fail
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=9)?0:1)"
if errorlevel 1 (
  for /f %%v in ('node -v') do echo   Node.js %%v 는 너무 오래됐습니다. 22.9 이상이 필요합니다.
  goto fail
)
for /f %%v in ('node -v') do echo   Node.js %%v

echo.
echo  [2/3] 패키지 확인
if exist "node_modules\.modules.yaml" if exist "apps\web\node_modules" (
  echo   이미 설치됨
  goto run
)
echo   처음 실행이라 패키지를 설치합니다. 몇 분 걸릴 수 있습니다.
where pnpm >nul 2>nul
if errorlevel 1 (
  call npx -y pnpm@11.25.0 install
) else (
  call pnpm install
)
if errorlevel 1 (
  echo   패키지 설치에 실패했습니다. 위 메시지를 확인하세요.
  goto fail
)

:run
echo.
echo  [3/3] 로컬 서버와 전용 Chrome 프로필 시작
echo   이 창을 닫으면 서버가 꺼집니다.
node scripts\local.mjs %*
if errorlevel 1 goto fail
goto end

:fail
echo.
pause
exit /b 1

:end
endlocal
