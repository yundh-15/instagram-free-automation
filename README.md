# instagram-free-automation (종료됨)

이 저장소의 인스타그램 자동 게시 자동화는 **2026-08-27 자로 종료**되었습니다.
더 이상 예약 실행되지 않으며, 게시 관련 코드와 기록 파일은 모두 제거되었습니다.

## 제거된 항목

| 항목 | 내용 |
| --- | --- |
| `.github/workflows/instagram-carousel.yml` | KST 09:00 / 13:00 / 19:00 슬롯을 돌리던 cron 워크플로 (유일한 자동 실행 주체) |
| `scripts/` | 카루셀·릴스·스토리 생성 및 Instagram Graph API 발행 스크립트 |
| `data/` | 중복 방지용 사용 이력 (`used-photos.json`, `used-topics.json`, `used-videos.json`) |
| `tests/`, `docs/`, `.env.example`, `package.json`, `package-lock.json` | 위 스크립트 전용 테스트·문서·의존성 |

## 남은 수동 정리 (저장소 밖 작업)

코드 제거만으로는 외부 서비스의 접근 권한이 사라지지 않습니다. 다음은 직접 처리해 주세요.

1. **Meta / Instagram 액세스 토큰 폐기** — `META_ACCESS_TOKEN`을 Meta 앱 대시보드에서 무효화.
2. **GitHub Actions Secrets 삭제** — Settings → Secrets and variables → Actions 에서
   `META_ACCESS_TOKEN`, `IG_USER_ID`, `CLOUDINARY_*`, `PEXELS_API_KEY`,
   `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY` 등 제거.
3. **Cloudinary 업로드 프리셋 / API 키 정리** (필요 시).

## 되돌리려면

모든 코드는 git 히스토리에 남아 있습니다. 종료 직전 상태는 커밋 `24a8af0` 입니다.

```bash
git checkout 24a8af0 -- .
```

`.gitignore` 는 로컬 작업 파일 보호를 위해 그대로 두었습니다.
