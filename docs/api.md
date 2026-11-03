# chirp REST API (apiVersion 1)

계약의 원천은 [`packages/shared/src/schema.ts`](../packages/shared/src/schema.ts). 응답은 모두 해당 zod 스키마를 만족한다.

## 인증

`/api/v1/*`는 `Authorization: Bearer chp_...` 필요. 실패 시:

```
401 {"error":"unauthorized"}
```

키는 첫 기동에 생성되거나 `CHIRP_API_KEY`로 지정한다 (`node apps/server/dist/cli.js key show|rotate`).

**GET은 수집을 트리거하지 않고 항상 캐시를 반환한다.**

## GET /health  (무인증)

```json
{"status":"ok","version":"0.1.0"}
```

## GET /api/v1/status

`StatusSnapshot` — `apiVersion`, `instance`, `cpu`, `sensors[]`, `disks[]`. 예시: [`packages/shared/fixtures/status.sample.json`](../packages/shared/fixtures/status.sample.json).

- 디스크 `standby: true`이면 값은 마지막으로 읽은 것이다(디스크를 깨우지 않는다).
- `disk.health.status`: `ok | warning | failing | unknown`, `reasons[]`는 `{code, value?}`.
- `disk.error`: `open_failed | timeout | parse_error | null`. 오류 시 이전 값은 유지되고 health는 `unknown`.

## GET /api/v1/disks/:id

`DiskDetail` = `Disk` + `raw`(smartctl JSON 원본). 없으면 `404 {"error":"not_found"}`.

## GET /api/v1/history?metric=...&range=24h

- `metric`: `cpu.packageTemp` 또는 `disk.<id>.temperature`
- `range`: `1h | 6h | 12h | 24h` (기본 `24h`)
- 응답: `{"metric":"cpu.packageTemp","points":[[epochMs, value], ...]}` — 1분 해상도, 서버 메모리 보관(재시작 시 초기화)
- 잘못된 파라미터 `400 {"error":"bad_request"}`, 알 수 없는 metric `404 {"error":"not_found"}`

## POST /api/v1/refresh

즉시 재수집을 요청한다(완료를 기다리지 않음). standby 디스크는 여전히 깨우지 않는다.

- `202 {"queued":true}`
- 직전 수락 후 30초 이내면 `429 {"error":"cooldown","retryAfter":<초>}` (`Retry-After` 헤더 포함)

## 대시보드

`GET /`, `/assets/*`는 무인증 정적 파일(SPA 폴백). `CHIRP_WEB_DIR`에 `index.html`이 없으면 서빙하지 않는다. `/api`, `/health` 경로는 폴백 대상이 아니다.
