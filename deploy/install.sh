#!/usr/bin/env bash
# Установка и обновление «Камень, ножницы, УК РФ» на сервере Ubuntu/Debian.
#
#   sudo git clone https://github.com/<аккаунт>/uk-rps.git /opt/uk-rps
#   sudo bash /opt/uk-rps/deploy/install.sh                  # игра на http://IP-сервера
#   sudo bash /opt/uk-rps/deploy/install.sh game.example.ru  # https://game.example.ru (Caddy + Let's Encrypt)
#   sudo bash /opt/uk-rps/deploy/install.sh --port 8080      # если порт 80 уже занят
#
# Повторный запуск без параметров обновляет игру (git pull) и перезапускает её
# с прежними настройками — они хранятся в /etc/default/uk-rps.

set -euo pipefail

APP_USER=ukrps
SERVICE=uk-rps
CONF=/etc/default/uk-rps
UNIT=/etc/systemd/system/uk-rps.service
CADDYFILE=/etc/caddy/Caddyfile

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;35m!!  %s\033[0m\n' "$*" >&2; }
die() {
  printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
}

# кто слушает TCP-порт (пусто, если никто)
port_owner() {
  ss -Hltnp "sport = :$1" 2>/dev/null | head -n1 | sed -n 's/.*users:(("\([^"]*\)".*/\1/p;t;s/.*/неизвестный процесс/p'
}

main() {
  local domain_arg="" port_arg="" pull=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port_arg="${2:-}"; shift 2 || die "после --port нужен номер порта" ;;
      --port=*) port_arg="${1#*=}"; shift ;;
      --no-domain) domain_arg="-"; shift ;;
      --no-pull) pull=0; shift ;;
      -h | --help) usage; exit 0 ;;
      -*) die "неизвестный параметр $1 (см. --help)" ;;
      *) domain_arg="$1"; shift ;;
    esac
  done

  [ "$(id -u)" -eq 0 ] || die "запустите через sudo: sudo bash $0"
  local os_id="" os_like=""
  if [ -r /etc/os-release ]; then
    os_id="$(. /etc/os-release && echo "${ID:-}")"
    os_like="$(. /etc/os-release && echo "${ID_LIKE:-}")"
  fi
  case " $os_id $os_like " in
    *" debian "* | *" ubuntu "*) ;;
    *) die "скрипт рассчитан на Ubuntu/Debian. На другой системе используйте Docker (см. README)" ;;
  esac
  command -v systemctl >/dev/null && [ -d /run/systemd/system ] || die "нужен systemd"

  local app_dir
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [ -f "$app_dir/server.js" ] || die "не найден $app_dir/server.js — запускайте скрипт из папки игры"
  case "$app_dir" in
    /root | /root/* | /home/*) die "игра лежит в $app_dir, а у сервиса нет доступа к домашним папкам. Склонируйте её в /opt/uk-rps" ;;
  esac

  # ---- настройки: параметры командной строки > сохранённые > по умолчанию
  local DOMAIN="" PORT="" HOST=""
  if [ -f "$CONF" ]; then
    DOMAIN="$(sed -n 's/^DOMAIN=//p' "$CONF" | tail -n1)"
    PORT="$(sed -n 's/^PORT=//p' "$CONF" | tail -n1)"
  fi
  if [ "$domain_arg" = "-" ]; then
    DOMAIN=""
    [ -n "$port_arg" ] || PORT=""
  elif [ -n "$domain_arg" ]; then
    DOMAIN="$(printf '%s' "$domain_arg" | tr 'A-Z' 'a-z' | sed 's#^https\?://##; s#/.*$##')"
    [ -n "$port_arg" ] || PORT=""
  fi
  if [ -n "$DOMAIN" ]; then
    printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$' || die "странный домен: $DOMAIN"
  fi
  [ -n "$port_arg" ] && PORT="$port_arg"
  if [ -n "$DOMAIN" ]; then
    PORT="${PORT:-3000}"
    HOST=127.0.0.1
  else
    PORT="${PORT:-80}"
    HOST=0.0.0.0
  fi
  case "$PORT" in '' | *[!0-9]*) die "порт должен быть числом: $PORT" ;; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "порт вне диапазона: $PORT"

  export DEBIAN_FRONTEND=noninteractive

  # ---- пакеты и Node.js
  say "Ставлю системные пакеты"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git iproute2 >/dev/null

  local node_bin="" node_major=0
  node_bin="$(command -v node || true)"
  case "$node_bin" in /root/* | /home/*) node_bin="" ;; esac
  [ -n "$node_bin" ] && node_major="$("$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$node_major" -lt 18 ]; then
    say "Ставлю Node.js 22 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh >/dev/null
    rm -f /tmp/nodesource_setup.sh
    apt-get install -y -qq nodejs >/dev/null
    node_bin="$(command -v node)"
  fi
  echo "Node.js $("$node_bin" -v) ($node_bin)"

  # ---- код игры
  if [ "$pull" -eq 1 ] && [ -d "$app_dir/.git" ]; then
    say "Обновляю код из git"
    git -c safe.directory="$app_dir" -C "$app_dir" pull --ff-only || warn "git pull не удался — продолжаю с текущей версией"
  fi
  say "Ставлю зависимости игры"
  (cd "$app_dir" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  chmod -R a+rX "$app_dir"

  # ---- пользователь и сервис
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$APP_USER"
  fi

  say "Настраиваю сервис $SERVICE"
  systemctl stop "$SERVICE" 2>/dev/null || true
  local owner
  owner="$(port_owner "$PORT")"
  [ -z "$owner" ] || die "порт $PORT уже занят ($owner). Выберите другой: sudo bash $0 --port 8080"

  cat >"$CONF" <<EOF
# Настройки игры — создано deploy/install.sh
DOMAIN=$DOMAIN
PORT=$PORT
HOST=$HOST
EOF

  cat >"$UNIT" <<EOF
[Unit]
Description=Камень, ножницы, УК РФ — игровой сервер
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$app_dir
EnvironmentFile=$CONF
Environment=NODE_ENV=production
ExecStart=$node_bin server.js
Restart=always
RestartSec=2
# порты ниже 1024 без root
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"

  local ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 0.5
  done
  if [ "$ok" -ne 1 ]; then
    journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
    die "сервис не ответил на http://127.0.0.1:$PORT/api/health — смотрите лог выше"
  fi
  echo "Игровой сервер работает на $HOST:$PORT"

  # ---- HTTPS через Caddy
  local caddy_ok=0
  if [ -n "$DOMAIN" ]; then
    setup_caddy "$DOMAIN" "$PORT" && caddy_ok=1
  fi

  # ---- файрвол
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    say "Открываю порты в ufw"
    if [ "$caddy_ok" -eq 1 ]; then
      ufw allow 80/tcp >/dev/null
      ufw allow 443/tcp >/dev/null
    elif [ -z "$DOMAIN" ]; then
      ufw allow "$PORT/tcp" >/dev/null
    fi
  fi

  # ---- итог
  local ip
  ip="$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  say "Готово!"
  if [ "$caddy_ok" -eq 1 ]; then
    echo "Игра: https://$DOMAIN"
    echo "Сертификат Let's Encrypt выпускается автоматически при первом заходе (DNS-запись A для $DOMAIN должна указывать на ${ip:-этот сервер})."
  elif [ -n "$DOMAIN" ]; then
    echo "Игра запущена на 127.0.0.1:$PORT — подключите её к своему веб-серверу (пример для nginx: $app_dir/deploy/nginx.conf.example)."
  elif [ "$PORT" = 80 ]; then
    echo "Игра: http://${ip:-IP-сервера}"
  else
    echo "Игра: http://${ip:-IP-сервера}:$PORT"
  fi
  cat <<EOF

Полезные команды:
  статус:      systemctl status $SERVICE
  логи:        journalctl -u $SERVICE -f
  перезапуск:  sudo systemctl restart $SERVICE
  обновление:  sudo bash $app_dir/deploy/install.sh

Если игра не открывается снаружи, проверьте файрвол у хостинга (security group / «Сетевой экран»).
EOF
}

setup_caddy() {
  local domain="$1" port="$2"
  local owner80 owner443
  owner80="$(port_owner 80)"
  owner443="$(port_owner 443)"
  if { [ -n "$owner80" ] && [ "$owner80" != caddy ]; } || { [ -n "$owner443" ] && [ "$owner443" != caddy ]; }; then
    warn "Порты 80/443 уже заняты (${owner80:-}${owner443:+ $owner443}) — Caddy ставить не буду."
    warn "Добавьте проксирование в свой веб-сервер, пример: deploy/nginx.conf.example"
    return 1
  fi

  if ! command -v caddy >/dev/null; then
    say "Ставлю Caddy (автоматический HTTPS)"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi

  say "Настраиваю Caddy для $domain"
  local block tmp
  block="# uk-rps begin
$domain {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$port
}
# uk-rps end"
  tmp="$(mktemp)"
  if [ -f "$CADDYFILE" ] && grep -q '^# uk-rps begin' "$CADDYFILE"; then
    # заменяем свой прежний блок
    awk -v block="$block" '
      /^# uk-rps begin/ { print block; skip = 1; next }
      /^# uk-rps end/ { skip = 0; next }
      !skip { print }
    ' "$CADDYFILE" >"$tmp"
  elif [ ! -s "$CADDYFILE" ] || grep -q 'The Caddyfile is an easy way to practice' "$CADDYFILE"; then
    # стандартный Caddyfile после установки — заменяем целиком
    printf '%s\n' "$block" >"$tmp"
  else
    # чужая конфигурация — дописываем свой блок в конец
    cp "$CADDYFILE" "$tmp"
    printf '\n%s\n' "$block" >>"$tmp"
  fi
  if ! caddy validate --adapter caddyfile --config "$tmp" >/dev/null 2>&1; then
    caddy validate --adapter caddyfile --config "$tmp" || true
    rm -f "$tmp"
    warn "Новая конфигурация Caddy не прошла проверку — оставил прежнюю."
    return 1
  fi
  [ -f "$CADDYFILE" ] && cp "$CADDYFILE" "$CADDYFILE.bak-uk-rps"
  install -m 644 "$tmp" "$CADDYFILE"
  rm -f "$tmp"
  systemctl enable caddy >/dev/null 2>&1 || true
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy
  else
    systemctl restart caddy
  fi
  return 0
}

# вызов и выход в одной строке: git pull может переписать этот файл во время работы
main "$@"; exit $?
