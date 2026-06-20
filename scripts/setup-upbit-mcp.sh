#!/usr/bin/env bash
# Upbit MCP 서버 설치 스크립트.
# 외부 코드를 내려받아 의존성을 설치하므로 내용을 확인한 뒤 직접 실행하세요.
#
# 사용법:
#   bash scripts/setup-upbit-mcp.sh
#
# 사전 준비:
#   1) Upbit 개발자센터에서 Access Key / Secret Key 발급
#   2) .env 에 UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY 설정 (키는 절대 커밋 금지)
#   3) (원격 환경) 네트워크 송신 허용목록에 api.upbit.com 추가
set -euo pipefail

REPO_URL="https://github.com/solangii/upbit-mcp-server.git"
DEST="vendor/upbit-mcp-server"

if ! command -v uv >/dev/null 2>&1; then
  echo "[!] 'uv' 가 필요합니다. https://docs.astral.sh/uv/ 를 참고해 설치하세요." >&2
  exit 1
fi

mkdir -p vendor
if [ -d "$DEST/.git" ]; then
  echo "[*] 이미 존재 → 업데이트: $DEST"
  git -C "$DEST" pull --ff-only
else
  echo "[*] 클론: $REPO_URL → $DEST"
  git clone --depth 1 "$REPO_URL" "$DEST"
fi

echo "[*] 의존성 설치 (uv sync)"
( cd "$DEST" && uv sync )

echo
echo "[OK] 설치 완료."
echo "    - .env 에 UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY 가 설정됐는지 확인하세요."
echo "    - Claude Code 세션을 재시작하면 .mcp.json 의 'upbit' 서버가 로드됩니다."
echo "    - 연결 확인: Claude Code 에서 /mcp 또는 MCP 도구 목록을 확인하세요."
