# Phase 2 Code Review Fixes Specification (작업 지시서)

**Status:** Completed  
**Branch:** `feat/phase2-host-collector`  
**PR:** https://github.com/eigger/chirp/pull/8  
**Audience:** Maintainers and reviewing agents  

---

## 1. Overview & Context

This specification documents the root cause analysis, corrective actions, and verification procedures for the 6 issues identified during the 3rd code review of commit `1342d0c` on PR #8 (Phase 2: Host Collector and Unprivileged LXC Support).

### Review Feedback Summary

- **Blocker 1 (Collector Download):** `chirp-passthrough.sh` looked for the container version at `/opt/chirp/package.json` instead of `/opt/chirp/current/package.json`. Furthermore, release `v0.2.0` lacks `proxmox/host/`, resulting in HTTP 404 when attempting downloads from older releases before a new version is published.
- **Blocker 2 (Boot Order Race):** `chirp-collector.service` lacked `Before=pve-guests.service`, allowing `onboot: 1` containers to start before `/run/chirp` was initialized by the collector service, failing the read-only bind mount.
- **Issue 3 (Device Types Guidance):** Unprivileged containers do not run `smartctl` directly. Post-install updates to `CHIRP_DEVICE_TYPES` in the container's `/etc/chirp/chirp.env` are ignored by the host collector. Comments and scripts needed explicit guidance directing host-side configuration.
- **Issue 4 (Hwmon Label Discrepancy on Whitespace):** A sysfs label file containing only whitespace evaluated truthy in Python (`"   " or default`), stripping to `""`, whereas TypeScript performed `?.trim() || default`, producing different sensor IDs.
- **Issue 5 (Non-Atomic 0600 Host Env Write):** Creating `/etc/chirp/chirp.env` via `touch` followed by `chmod 0600` left a window where the file was readable under default umask before permissions were tightened.
- **Issue 6 (.env.example & Config Documentation):** `.env.example` still described the snapshot path as "if it exists, else null" and lacked mention of the `none`/`0`/`false` disable flags.

---

## 2. Root Cause Analysis & Detailed Fixes

### 2.1 Blocker 1: Collector Download Candidate Refs & Fallback (`chirp-passthrough.sh`)
- **Root Cause:**
  1. Chirp installs into `/opt/chirp/current` inside LXC containers. Querying `/opt/chirp/package.json` always returned empty.
  2. The fallback to GitHub API `releases/latest` resolved to `v0.2.0`, which predates Phase 2 and does not contain `proxmox/host/chirp-collector.py`.
- **Implementation:**
  - Query `/opt/chirp/current/package.json` first, then `/opt/chirp/package.json`.
  - Assemble ordered `candidate_refs`: container version (e.g. `v0.2.0`) $\rightarrow$ GitHub latest release $\rightarrow$ `master`.
  - Sequentially attempt download. If a release tag returns HTTP 404 (because Phase 2 is not yet released in that tag), the script automatically falls back to `master`. Once `v0.3.0+` is published, candidate release tags succeed on the first attempt without fallback.
- **Files Modified:**
  - `proxmox/install/chirp-passthrough.sh`

### 2.2 Blocker 2: Host Boot Ordering (`chirp-collector.service`)
- **Root Cause:**
  - Systemd started `chirp-collector.service` after `local-fs.target` with no ordering relative to `pve-guests.service`.
  - Proxmox starts all auto-start containers (`onboot: 1`) via `pve-guests.service`. If a container booted before `chirp-collector` executed, `/run/chirp` did not exist on the host, causing the container's bind mount to fail.
- **Implementation:**
  - Added `Before=pve-guests.service` to `[Unit]` in `proxmox/host/chirp-collector.service`.
  - When combined with `RuntimeDirectory=chirp` and `RuntimeDirectoryPreserve=yes`, `/run/chirp` is guaranteed to exist before any guest container initializes.
- **Files Modified:**
  - `proxmox/host/chirp-collector.service`

### 2.3 Issue 3: Clarifying `CHIRP_DEVICE_TYPES` for Unprivileged LXC
- **Root Cause:**
  - Unprivileged containers do not possess raw disk access; all SMART queries are performed host-side by `chirp-collector`.
  - Documentation and script comments advised setting `CHIRP_DEVICE_TYPES` inside the container's `/etc/chirp/chirp.env`, which is only read by privileged containers.
- **Implementation:**
  - Updated header comments in `proxmox/ct/chirp.sh` and `proxmox/install/chirp-passthrough.sh` distinguishing between unprivileged (host `/etc/chirp/chirp.env`) and privileged CTs.
  - Added clear completion notice in `chirp-passthrough.sh`: `"Note: For unprivileged CTs, configure CHIRP_DEVICE_TYPES in /etc/chirp/chirp.env on this host."`
- **Files Modified:**
  - `proxmox/ct/chirp.sh`
  - `proxmox/install/chirp-passthrough.sh`

### 2.4 Issue 4: Sysfs Label Whitespace Normalization (`chirp-collector.py`)
- **Root Cause:**
  - TypeScript: `readText(...)?.trim() || default` evaluates `""` as falsy, using `default`.
  - Python: `(read_text(...) or default).strip()` treated `"   "` as truthy, keeping `"   "`, which `.strip()` converted to `""`, resulting in missing labels and mismatched sensor IDs.
- **Implementation:**
  - Implemented `hwmon_label(chip_path, prefix, idx)`:
    ```python
    def hwmon_label(chip_path: str, prefix: str, idx: Any) -> str:
        txt = read_text(os.path.join(chip_path, f"{prefix}{idx}_label"))
        return (txt.strip() if txt else "") or f"{prefix}{idx}"
    ```
  - Replaced label reading across `temp`, `fan`, `in`, and `power` sensor collections.
- **Files Modified:**
  - `proxmox/host/chirp-collector.py`

### 2.5 Issue 5: Atomic, Permission-Safe `chirp.env` Synchronization (`chirp-passthrough.sh`)
- **Root Cause:**
  - `touch "$host_env"` created the file with default umask (0644), followed later by `chmod 0600`, leaving a time window with relaxed permissions.
- **Implementation:**
  - Create a temporary file via `mktemp` and immediately enforce `chmod 0600` before writing any data.
  - Populate contents and atomically replace destination via `mv -f "$tmp_env" "$host_env"`.
- **Files Modified:**
  - `proxmox/install/chirp-passthrough.sh`

### 2.6 Issue 6: Documentation Consistency (`.env.example` & `config.ts`)
- **Root Cause:**
  - `.env.example` had not been synchronized with the updated `defaultHostSnapshot` behavior introduced in commit `503e0a3`.
- **Implementation:**
  - Documented default `/run/chirp/host.json` and explicit disabling values (`none`, `0`, `false`) in both `.env.example` and `apps/server/src/config.ts`.
- **Files Modified:**
  - `.env.example`
  - `apps/server/src/config.ts`

---

## 3. Verification Matrix

| Check | Target / Command | Result |
|---|---|---|
| Python Syntax | `python -m py_compile proxmox/host/chirp-collector.py` | Passed (0 errors) |
| Shared Build | `npm.cmd run build:shared` | Passed |
| Server Build | `npm.cmd run build -w @chirp/server` | Passed |
| Server Lint | `npm.cmd run lint -w @chirp/server` | Passed (0 errors/warnings) |
| Snapshot Unit Tests | `vitest run test/hostSnapshot.test.ts` | Passed (8/8) |
| Snapshot Integration Tests | `vitest run test/hostSnapshotIntegration.test.ts` | Passed (5/5) |
| CI Passthrough Suite | `bash scripts/ci/test-passthrough.sh` | Passed (178/178) |

---

## 4. Next Steps for Maintainer

1. Verify commit on `feat/phase2-host-collector`.
2. Push and verify GitHub Actions CI run.
3. Merge PR #8 into `master`.
