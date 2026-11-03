# chirp 프로젝트 개요

Proxmox 호스트의 CPU 온도와 디스크 SMART 상태를 수집해 REST API와 웹 대시보드로 제공한다. Home Assistant 연동은 별도 저장소(hass-chirp, 통합 도메인 `chirp`).

## 구성

| 경로 | 역할 |
|---|---|
| `packages/shared` | zod API 계약 (`schema.ts`, `fixtures/status.sample.json`) |
| `apps/server` | Fastify 서버. 수집 → 메모리 캐시 → REST + 정적 대시보드 |
| `apps/web` | 대시보드 (정적 빌드) |
| `proxmox/` | LXC 원클릭 설치·업데이트 |
| `Dockerfile` | 단일 이미지 (서버 + 웹 + smartmontools) |

## 서버 내부 (`apps/server/src`)

| 파일 | 내용 |
|---|---|
| `config.ts` | 환경 변수 → `Config` |
| `apiKey.ts` | `chp_` 키 생성·sha256 + `timingSafeEqual` 검증, 키 파일 변경 자동 반영 |
| `instanceId.ts` | `CHIRP_DATA_DIR/instance-id` (UUIDv4) |
| `hwmon.ts` | `/sys/class/hwmon` 파싱 (coretemp/k10temp/zenpower/cpu_thermal), thermal_zone 폴백, `/proc/cpuinfo` |
| `smartctl.ts` | `smartctl -j -a -n standby` 실행·파싱, 장치 탐색, disk.id 생성 |
| `health.ts` | **유일한** 건강 판정 로직 |
| `scheduler.ts` | `Collector`: 센서 10s / SMART 300s, 동시성 2, standby 값 유지 |
| `history.ts` | 1분 다운샘플 24h 메모리 링버퍼 |
| `app.ts` / `static.ts` | REST 라우트·인증·쿨다운 / 대시보드 서빙 + SPA 폴백 |
| `index.ts` / `cli.ts` | 서버 진입점 / `key show|rotate` |

## 건강 판정

- **failing**: `smart_status.passed=false`, NVMe `critical_warning` 비트 0/2/3, `available_spare < threshold`
- **warning**: 재할당·대기·정정불가 섹터 > 0, `media_errors > 0`, 마모 ≥ 90 %, 온도 ≥ 임계(HDD 55 / SSD 70 / NVMe 75 °C, 환경 변수로 조정)
- **unknown**: 읽지 못함(`not_read`)
- 사유는 `reasons[]`에 `{code, value}`로 모두 담긴다.

## standby 동작

`-n standby` 때문에 잠든 디스크는 측정 없이 즉시 반환된다. 서버는 이전 읽기 값을 유지하고 `standby: true`만 바꾼다. 부팅 직후 처음부터 standby인 디스크는 모델·시리얼을 알 수 없어 임시 ID(`dev_<장치명>`)를 쓰고, 깨어서 읽히면 실제 ID로 바뀐다(`CHIRP_DEVICES`로 지정하고 한 번 읽히기 전까지의 한계).

## 보안 모델

- `/health`와 정적 대시보드는 무인증. 데이터는 `/api/v1/*`의 Bearer 키가 필요.
- HTTP 평문, privileged LXC 전제 — README의 보안 주의 참고.
