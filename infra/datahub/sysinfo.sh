#!/usr/bin/env bash
# Server system information for IRD checklist item 11(ज). Run on the box:
#   sudo infra/datahub/sysinfo.sh
set -uo pipefail
section() { printf '\n== %s ==\n' "$1"; }
section "Host";     hostnamectl 2>/dev/null || hostname
section "OS";       lsb_release -a 2>/dev/null || cat /etc/os-release; uname -a
section "CPU";      lscpu | grep -E 'Model name|^CPU\(s\)|Architecture'
section "Memory";   free -h
section "Disks";    lsblk -o NAME,SIZE,TYPE,MOUNTPOINT; df -h / /data 2>/dev/null
section "Network interfaces (MAC)"; ip -br link
section "Addresses"; ip -br addr
section "Public IP"; curl -s --max-time 5 https://ifconfig.me || echo "(unavailable)"
section "PostgreSQL"; sudo -u postgres psql -Atc 'select version()' 2>/dev/null
section "Go Serve";  curl -s --max-time 5 http://127.0.0.1:8080/healthz; echo
section "Uptime";    uptime
section "Generated"; date -u +%Y-%m-%dT%H:%M:%SZ
