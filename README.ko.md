# chirp

[![CI](https://github.com/eigger/chirp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/eigger/chirp/actions/workflows/ci.yml)
[![Docker Release](https://github.com/eigger/chirp/actions/workflows/docker-release.yml/badge.svg)](https://github.com/eigger/chirp/actions/workflows/docker-release.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/eigger/chirp)](https://github.com/eigger/chirp/blob/master/LICENSE)
[![Self-hosted](https://img.shields.io/badge/hosting-self--hosted-2563EB)](proxmox/ct/chirp.sh)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Feigger%2Fchirp-2496ED?logo=docker&logoColor=white)](https://github.com/eigger/chirp/pkgs/container/chirp)

**[English README](./README.md)**

**Proxmox 호스트**의 CPU 온도와 디스크 SMART 상태를 수집해 REST API와 대시보드로 보여주는 작은 모니터링 서버. 탄광의 카나리아처럼, 디스크가 죽기 전에 먼저 알려줍니다.

문서: [`docs/PROJECT.md`](docs/PROJECT.md) · [`docs/api.md`](docs/api.md) · [`docs/deploy.md`](docs/deploy.md)

---

## 기능

- **CPU 온도** — `/sys/class/hwmon`(coretemp, k10temp, zenpower, cpu_thermal) 직접 파싱: 패키지·코어별·경고/임계 온도·기타 센서
- **디스크 SMART** — `smartctl -j`로 SATA HDD/SSD·NVMe 수집: 온도, 가동 시간, 재할당/대기 섹터, 마모, 누적 기록량
- **잠든 디스크를 깨우지 않음** — `smartctl -n standby`; 스핀다운된 디스크는 마지막 값을 유지하고 `standby`로 표시
- **단일 건강 판정**(`ok` / `warning` / `failing` / `unknown`) + 기계가 읽을 수 있는 사유. 판정은 서버 한 곳에서만 수행
- **안정적인 디스크 ID**(WWN, 없으면 모델+시리얼) — `/dev/sdX`는 쓰지 않음
- **24시간 온도 히스토리**(1분 해상도, 메모리)와 같은 프로세스가 서빙하는 웹 대시보드
- **Bearer API 키 인증 REST API**, DB 없음, 순수 JavaScript(네이티브 의존성 없음)
- **Home Assistant 연동** — [`hass-chirp`](https://github.com/eigger/hass-chirp) (통합 도메인 `chirp`)

## 설치

### Proxmox 원클릭 (권장)

Proxmox 호스트 셸에서 실행:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

LXC 컨테이너를 만들고 최신 릴리스 tarball을 설치한 뒤 대시보드 URL과 API 키를 출력합니다.

### Docker

```bash
docker run -d --name chirp \
  --privileged \
  -p 80:80 \
  -v /sys:/sys:ro \
  -v chirp-data:/var/lib/chirp \
  --device /dev/sda --device /dev/sdb --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/sdb,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

`--privileged` 대신 `--cap-add SYS_RAWIO --cap-add SYS_ADMIN`과 `--device`를 함께 써도 됩니다. 호스트의 CPU 센서가 보이도록 `/sys`는 읽기 전용으로 마운트하세요. 자세한 내용은 [`docs/deploy.md`](docs/deploy.md).

### 릴리스 tarball

```bash
tar -xzf chirp-<version>.tar.gz -C /opt/chirp
cd /opt/chirp && CHIRP_PORT=8080 node apps/server/dist/index.js
```

Node.js 24와 `smartmontools`가 필요합니다.

## API 키

첫 기동에 키(`chp_...`)를 생성해 `/var/lib/chirp/api-key`(권한 0600)에 저장하고 로그에 한 번 출력합니다. 모든 `/api/v1/*` 요청에는 `Authorization: Bearer <키>`가 필요합니다.

```bash
node apps/server/dist/cli.js key show     # 키 출력
node apps/server/dist/cli.js key rotate   # 새 키 발급 (즉시 적용)
```

`CHIRP_API_KEY`가 있으면 키 파일보다 우선합니다. 대시보드 HTML/JS는 공개지만 데이터는 모두 키가 필요합니다.

## 설정

모든 설정은 환경 변수입니다 — [`.env.example`](.env.example) 참고. 기본값: 포트 `80`, SMART `300`초, 센서 `10`초 주기.

## Home Assistant

[`hass-chirp`](https://github.com/eigger/hass-chirp)를 설치하고 통합(도메인 `chirp`)을 추가한 뒤 chirp URL과 API 키를 입력합니다. 엔티티는 인스턴스 UUID와 디스크 WWN을 기준으로 만들어져 재부팅이나 장치 이름 변경에도 유지됩니다.

## 보안 주의

- Proxmox 스크립트는 `smartctl`이 호스트 블록 장치에 접근하도록 **privileged LXC** 컨테이너를 만듭니다. privileged 컨테이너가 뚫리면 호스트도 위험하므로 신뢰하는 네트워크에서만 쓰세요.
- 통신은 **HTTP 평문**입니다. API 키가 그대로 전송되므로 신뢰할 수 없는 네트워크라면 TLS 역프록시(또는 Tailscale) 뒤에 두고, `CHIRP_TRUST_PROXY=true`는 직접 관리하는 프록시 뒤에서만 켜세요.
- `POST /api/v1/refresh`는 30초 쿨다운이 있으며 서버는 잠든 디스크를 깨우지 않습니다.

## 개발

```bash
npm install
npm run build:shared
npm run dev:server    # tsx watch
npm test
npm run lint
```

## 라이선스

MIT — [`LICENSE`](LICENSE) 참고.
