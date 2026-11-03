# chirp — 에이전트 작업 지침

Proxmox 호스트의 CPU 온도·디스크 SMART를 수집해 REST API와 대시보드로 서빙하는 모니터링 서버.

## 먼저 읽을 것

| 문서 | 내용 |
|---|---|
| [`packages/shared/src/schema.ts`](packages/shared/src/schema.ts) | **API 계약의 단일 원천(zod).** 서버·웹·hass-chirp가 모두 따른다 |
| [`docs/PROJECT.md`](docs/PROJECT.md) | 구조·결정 사항 |
| [`docs/api.md`](docs/api.md) | 엔드포인트 명세 |
| [`docs/deploy.md`](docs/deploy.md) | Proxmox·Docker·tarball 배포 |

## 구조

```
packages/shared   zod 스키마 (계약)
apps/server       Fastify 5 서버 (@chirp/server) — 수집·스케줄러·API·정적 서빙
apps/web          대시보드 (정적 빌드, 서버가 서빙)
proxmox/          LXC 설치/업데이트 스크립트
scripts/ci        CI 검사 스크립트
```

## 규약

- Node 24, TypeScript ESM, Fastify 5, zod 4, vitest 4, eslint 9. DB 없음.
- **스키마가 먼저.** 응답 필드를 바꾸면 `schema.ts`부터 고친다. 필드 추가는 호환, 삭제·의미 변경은 `API_VERSION` 증가.
- **건강 판정은 `apps/server/src/health.ts` 한 곳.** 클라이언트(웹, HA)는 판정을 다시 하지 않는다.
- **디스크를 깨우지 않는다.** `smartctl -n standby` 고정. standby면 마지막 값 유지.
- `disk.id`는 WWN 우선(`wwn_<hex>`), 없으면 model+serial 슬러그. `/dev/sdX`를 ID로 쓰지 않는다.
- GET은 수집을 트리거하지 않고 캐시만 반환. 수집은 스케줄러(센서 10s, SMART 300s)와 `POST /refresh`(30s 쿨다운)만.
- 히스토리 포인트는 `[epochMs, value]`.
- 순수 JS 의존성만 쓴다(릴리스 tarball이 네이티브 빌드 없이 동작해야 함).
- 모든 응답은 `@chirp/shared` 스키마를 통과해야 하며 테스트에서 `parse`로 검증한다.

## 명령

```bash
npm install
npm run build:shared
npm run build -w @chirp/server
npm test -w @chirp/server
npm run lint -w @chirp/server
node apps/server/dist/cli.js key show|rotate
```

## 커밋

접두사 `feat:` / `fix:` / `chore:` / `docs:`. 작업 전 `git pull`.
