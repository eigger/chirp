# chirp

[![CI](https://github.com/eigger/chirp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/eigger/chirp/actions/workflows/ci.yml)
[![Docker Release](https://github.com/eigger/chirp/actions/workflows/docker-release.yml/badge.svg)](https://github.com/eigger/chirp/actions/workflows/docker-release.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/eigger/chirp)](https://github.com/eigger/chirp/blob/master/LICENSE)
[![Self-hosted](https://img.shields.io/badge/hosting-self--hosted-2563EB)](proxmox/ct/chirp.sh)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Feigger%2Fchirp-2496ED?logo=docker&logoColor=white)](https://github.com/eigger/chirp/pkgs/container/chirp)

**[English README](./README.md)**

**Proxmox 호스트**의 CPU 온도와 디스크 SMART 상태를 수집해 REST API와 대시보드로 보여주는 작은 모니터링 서버. 탄광의 카나리아처럼, 디스크가 죽기 전에 먼저 알려줍니다.

문서: [`docs/PROJECT.md`](docs/PROJECT.md) · [`docs/api.md`](docs/api.md) · [`docs/ko/deploy.md`](docs/ko/deploy.md) (배포 가이드 한국어판; 그 밖의 문서는 영어)

---

## 기능

- **CPU 온도** — `/sys/class/hwmon`(coretemp, k10temp, zenpower, cpu_thermal) 직접 파싱: 패키지·코어별·경고/임계 온도·기타 센서
- **디스크 SMART** — `smartctl -j`로 SATA HDD/SSD·NVMe 수집: 온도, 가동 시간, 재할당/대기 섹터, 마모, 누적 기록량
- **잠든 디스크를 깨우지 않음** — `smartctl -n standby`, 장치 탐색은 장치를 열지 않는 `smartctl --scan`; 스핀다운된 디스크는 마지막 값을 유지하고 `standby`로 표시
- **단일 건강 판정**(`ok` / `warning` / `failing` / `unknown`) + 기계가 읽을 수 있는 사유. 판정은 서버 한 곳에서만 수행
- **안정적인 디스크 ID**(WWN, 없으면 모델+시리얼) — `/dev/sdX`는 쓰지 않음. 디스크를 깨우지 않고 도출하며 재시작 후에도 고정
- **24시간 온도 히스토리**(1분 해상도, 메모리)와 같은 프로세스가 서빙하는 웹 대시보드
- 대시보드 **관리자 로그인**(첫 접속 시 생성)과 Home Assistant용 **API 키 1개**(설정 화면에서 확인·재발급), DB 없음, 순수 JavaScript(네이티브 의존성 없음)
- **Home Assistant 연동** — [`hass-chirp`](https://github.com/eigger/hass-chirp) (통합 도메인 `chirp`)

## 설치

### Proxmox 원클릭 (권장)

Proxmox 호스트 셸에서 실행:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

LXC 컨테이너를 만들고 최신 릴리스 tarball을 설치한 뒤, 선택한 디스크를 passthrough하고 대시보드 URL을 출력합니다. **그 주소를 바로 열어 관리자 계정을 만드세요**([처음 실행](#처음-실행) 참고).

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

`--privileged` 대신 `--cap-add SYS_RAWIO --cap-add SYS_ADMIN`과 `--device`를 함께 써도 됩니다. 호스트의 CPU 센서가 보이도록 `/sys`는 읽기 전용으로 마운트하세요. 브라우저 없이 관리자 계정을 만들려면 `-e CHIRP_ADMIN_USER=admin -e CHIRP_ADMIN_PASSWORD=<10자 이상>`을 추가합니다(관리자가 없을 때만 사용. 비밀번호가 `docker inspect`에 계속 보이므로 첫 기동 후 두 변수를 지우고 대시보드에서 비밀번호를 바꾸세요). 자세한 내용은 [`docs/ko/deploy.md`](docs/ko/deploy.md).

### 릴리스 tarball

```bash
tar -xzf chirp-<version>.tar.gz -C /opt/chirp
cd /opt/chirp && CHIRP_PORT=8080 node apps/server/dist/index.js
```

Node.js 24와 `smartmontools`가 필요합니다. `.sha256` 자산은 다운로드 무결성만 확인합니다(진위 확인 아님, 릴리스 서명 없음).

## 처음 실행

1. `http://<chirp 주소>/`를 엽니다. 관리자 계정이 없으면 대시보드가 **관리자 계정 만들기** 화면을 보여 줍니다. 사용자명을 정하고 비밀번호를 두 번(10자 이상) 입력하면 바로 로그인됩니다.
   **설치 직후 바로 하세요:** 관리자가 생기기 전까지는 *대시보드를 먼저 연 사람*이 관리자가 됩니다. (Docker/자동화: 대신 `CHIRP_ADMIN_USER`와 `CHIRP_ADMIN_PASSWORD`를 설정)
2. **설정 -> API 키**에서 **복사**를 눌러 Home Assistant에 붙여 넣습니다(아래 참고).
3. 비밀번호를 잊었다면 Proxmox(호스트에서): `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password`, Docker: `docker exec chirp node apps/server/dist/cli.js admin reset-password`. 새 무작위 비밀번호를 출력하고 모든 세션을 로그아웃합니다. (CLI는 `/etc/chirp/chirp.env`가 있으면 읽습니다. 설정이 다른 파일에 있으면 `--env-file <경로>`를 붙이세요.)

## API 키

첫 기동에 키(`chp_...`)를 생성해 `/var/lib/chirp/api-key`(권한 0600)에 저장합니다. `CHIRP_PRINT_KEY=true`가 아니면 로그에 남지 않습니다. 로그인 후 **설정 -> API 키**에서 보기/숨기기·복사가 되고, **재발급**하면 이전 키는 즉시 동작하지 않으므로 Home Assistant에도 새 키를 넣어야 합니다. 클라이언트는 `Authorization: Bearer <키>`를 보내고, 대시보드는 로그인 세션을 씁니다.

```bash
node apps/server/dist/cli.js key show     # 키 출력
node apps/server/dist/cli.js key rotate   # 새 키 발급 (즉시 적용)
```

`CHIRP_API_KEY`가 있으면 키 파일보다 우선합니다(16자 이상). 이 경우 대시보드에서는 읽기 전용으로 보이고 재발급할 수 없습니다. 이전 릴리스에서 업그레이드해도 기존 키가 그대로 유지되어 Home Assistant가 계속 동작하며, 첫 접속 때 관리자 계정만 만들면 됩니다. 대시보드 HTML/JS는 공개지만 데이터는 모두 로그인이나 키가 필요합니다.

## 설정

모든 설정은 환경 변수입니다 — [`.env.example`](.env.example) 참고. 기본값: 포트 `80`, SMART `300`초, 센서 `10`초, 장치 재탐색 `3600`초 주기. 잘못된 값(예: `CHIRP_PORT=abc`)이면 명확한 메시지를 내고 서버가 시작하지 않습니다.

## Home Assistant

[`hass-chirp`](https://github.com/eigger/hass-chirp)를 설치하고 통합(도메인 `chirp`)을 추가한 뒤 chirp 호스트, 포트, 그리고 chirp 대시보드 **설정 -> API 키**에서 복사한 키를 입력합니다. 엔티티는 인스턴스 UUID와 디스크 WWN을 기준으로 만들어져 재부팅이나 장치 이름 변경에도 유지됩니다.

## 보안 주의

- Proxmox 스크립트는 `smartctl`이 호스트 블록 장치에 접근하도록 **privileged LXC** 컨테이너를 만듭니다. privileged 컨테이너가 뚫리면 호스트도 위험하므로 신뢰하는 네트워크에서만 쓰세요. 장치 규칙은 선택한 디스크의 major에 `rw`만 허용합니다(정확한 minor를 쓰지 않는 이유는 [`docs/ko/deploy.md`](docs/ko/deploy.md#디스크-passthrough와-권한) 참고).
- **설치 직후 관리자 계정을 만드세요.** 계정이 생기기 전까지는 대시보드에 접근할 수 있는 누구나 관리자를 만들 수 있습니다(최초 등록). 서버는 시작할 때마다 로그로 경고합니다.
- 통신은 **HTTP 평문**입니다. 로그인할 때의 관리자 비밀번호, 세션 쿠키, API 키가 그대로 전송되므로 신뢰할 수 없는 네트워크라면 TLS 역프록시(또는 Tailscale) 뒤에 두세요.
- 프록시 뒤라면 `CHIRP_TRUST_PROXY`를 프록시 개수(보통 `1`)나 프록시 주소로 설정하세요. 설정하지 않으면 로그인 지연에서 모든 클라이언트가 프록시 주소 하나를 공유합니다. `true`는 프록시가 `X-Forwarded-For`를 덮어쓸 때만 안전합니다([`docs/ko/deploy.md`](docs/ko/deploy.md#보안) 참고).
- `CHIRP_ADMIN_PASSWORD`는 계정이 생긴 뒤에도 환경 변수에 평문으로 남습니다. 첫 기동 후 지우고 대시보드에서 비밀번호를 바꾸세요.
- 로그인 세션은 HttpOnly, SameSite=Strict 쿠키(12시간 무활동, 최대 7일)이고, 로그인 실패는 지수적으로 지연됩니다. API 키로는 키나 계정을 조회·변경할 수 없습니다.
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
