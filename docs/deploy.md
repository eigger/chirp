# chirp 배포 가이드

## 요구 사항

- Linux 호스트(Proxmox VE 권장), Node.js 24, `smartmontools`
- 포트 80 (변경: `CHIRP_PORT`)
- 호스트의 블록 장치·`/sys` 접근 권한

## 1. Proxmox 원클릭

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

privileged LXC를 만들고 릴리스 tarball을 설치한다. 스크립트 상세는 `proxmox/` 참고.

## 2. Docker

```bash
docker run -d --name chirp \
  --privileged -p 80:80 \
  -v /sys:/sys:ro -v chirp-data:/var/lib/chirp \
  --device /dev/sda --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

- `--privileged` 대신 `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` + `--device` 조합 가능.
- `/sys`를 읽기 전용으로 마운트해야 호스트 CPU 센서(hwmon)가 보인다.
- `chirp-data` 볼륨에 API 키(`api-key`)와 `instance-id`가 저장된다. 볼륨을 잃으면 키·인스턴스 ID가 바뀌어 HA 엔티티가 새로 생긴다.
- 키 확인: `docker exec chirp node apps/server/dist/cli.js key show`
- 장치 이름이 달라지는 환경이면 `CHIRP_DEVICES`에 `/dev/disk/by-id/...` 경로를 쓰는 것이 안전하다. RAID/USB 브리지는 `CHIRP_DEVICE_TYPES=/dev/sda=sat`.

## 3. 릴리스 tarball

릴리스에는 `chirp-<version>.tar.gz`와 `.sha256`이 올라간다.

```bash
sha256sum -c chirp-<version>.tar.gz.sha256
mkdir -p /opt/chirp && tar -xzf chirp-<version>.tar.gz -C /opt/chirp
cd /opt/chirp && node apps/server/dist/index.js
```

tarball 구조: `package.json`, `node_modules`(prod), `packages/shared/{package.json,dist}`, `apps/server/{package.json,dist}`, `apps/web/dist`. 순수 JS이므로 네이티브 빌드가 필요 없다.

systemd 예시:

```ini
[Service]
EnvironmentFile=-/etc/chirp/chirp.env
WorkingDirectory=/opt/chirp
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=on-failure
```

## 환경 변수

[`.env.example`](../.env.example) 참고. 핵심: `CHIRP_API_KEY`(우선) / `CHIRP_API_KEY_FILE`, `CHIRP_DATA_DIR`, `CHIRP_DEVICES`, `CHIRP_DEVICE_TYPES`, `CHIRP_SMART_INTERVAL`, `CHIRP_SENSOR_INTERVAL`, `CHIRP_TEMP_WARN_{HDD,SSD,NVME}`, `CHIRP_WEB_DIR`, `CHIRP_TRUST_PROXY`, `CHIRP_CORS_ORIGINS`.

## 릴리스 절차

1. 루트·`packages/shared`·`apps/server`·`apps/web`의 `package.json` version을 모두 맞춘다(`release.yml`이 검사).
2. GitHub Release를 `v<version>` 태그로 publish.
3. `release.yml`이 태그·버전 일치를 검사하고 tarball + sha256을 업로드, `docker-release.yml`이 `ghcr.io/eigger/chirp`에 semver/latest를 푸시한다.

## 보안

HTTP 평문 + privileged 컨테이너 전제. 신뢰하지 않는 네트워크에서는 TLS 역프록시/Tailscale 뒤에 둘 것.
