#!/bin/bash
# Art Hackathon 로컬 판 실행기 (macOS). Finder에서 더블클릭하면 터미널이 열리고,
# 필요한 것을 확인·설치한 뒤 Chrome으로 페이지를 연다.
# 인자는 scripts/local.mjs 로 그대로 넘긴다. 예: ./start.command --preview

cd "$(dirname "$0")" || exit 1
printf '\033]0;Art Hackathon (local)\007'

fail() {
  echo
  read -n 1 -s -r -p "  아무 키나 누르면 창을 닫습니다."
  echo
  exit 1
}

# 더블클릭으로 열면 셸 설정을 읽지 않아 Homebrew·nvm 경로가 빠질 수 있어 직접 더한다.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)"
fi

echo
echo " [1/3] Node.js 확인"
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js가 없습니다. https://nodejs.org 에서 22.9 이상 LTS를 설치한 뒤 다시 실행하세요."
  fail
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=9)?0:1)"; then
  echo "  Node.js $(node -v) 는 너무 오래됐습니다. 22.9 이상이 필요합니다."
  fail
fi
echo "  Node.js $(node -v)"

echo
echo " [2/3] 패키지 확인"
if [ -f node_modules/.modules.yaml ] && [ -d apps/web/node_modules ]; then
  echo "  이미 설치됨"
else
  echo "  처음 실행이라 패키지를 설치합니다. 몇 분 걸릴 수 있습니다."
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install || { echo "  패키지 설치에 실패했습니다. 위 메시지를 확인하세요."; fail; }
  else
    npx -y pnpm@11.25.0 install || { echo "  패키지 설치에 실패했습니다. 위 메시지를 확인하세요."; fail; }
  fi
fi

echo
echo " [3/3] 로컬 서버와 전용 Chrome 프로필 시작"
echo "  이 창을 닫거나 Ctrl+C를 누르면 서버가 꺼집니다."
node scripts/local.mjs "$@" || fail
