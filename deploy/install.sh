#!/usr/bin/env bash
# Установка и обновление «Камень, ножницы, УК РФ» на сервере Ubuntu/Debian.
#
#   sudo git clone https://github.com/ddddsddd/uk-rf.git /opt/uk-rps
#   sudo bash /opt/uk-rps/deploy/install.sh                  # игра на http://IP-сервера
#   sudo bash /opt/uk-rps/deploy/install.sh game.example.ru  # https://game.example.ru (Caddy + Let's Encrypt)
#   sudo bash /opt/uk-rps/deploy/install.sh --port 8080      # если порт 80 уже занят
#   sudo bash /opt/uk-rps/deploy/install.sh --behind-proxy   # за своим nginx: игра на 127.0.0.1:3000
#   sudo bash /opt/uk-rps/deploy/install.sh --no-domain      # вернуться с домена на http://IP
#   sudo bash /opt/uk-rps/deploy/install.sh --uninstall      # удалить сервис (папку потом: sudo rm -r /opt/uk-rps)
#
# Повторный запуск без параметров обновляет игру (git pull) и перезапускает её
# с прежними настройками — они хранятся в /etc/default/uk-rps.
# Прочие параметры: --no-pull (не обновлять код), --help.

set -euo pipefail

APP_USER=ukrps
SERVICE=uk-rps
CONF=/etc/default/uk-rps
UNIT=/etc/systemd/system/uk-rps.service
CADDYFILE=/etc/caddy/Caddyfile
APT_LOCK_CONF=/etc/apt/apt.conf.d/99uk-rps-lock
LOG=/var/log/uk-rps-install.log

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;35m!!  %s\033[0m\n' "$*" >&2; }
die() {
  printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

cleanup() {
  rm -f "$APT_LOCK_CONF"
}

# git в папке игры, даже если её владелец не root
gitq() {
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" "$@"
}

# apt-get ждёт, пока unattended-upgrades на свежем сервере отпустит блокировку
apt_install() {
  apt-get install -y -qq "$@" >>"$LOG" 2>&1
}

apt_update() {
  local i out
  for i in $(seq 1 60); do
    if out="$(apt-get update -qq 2>&1)"; then
      printf '%s\n' "$out" >>"$LOG"
      return 0
    fi
    printf '%s\n' "$out" >>"$LOG"
    # ждём только блокировку; другие ошибки (например, битый сторонний репозиторий) показываем сразу
    printf '%s' "$out" | grep -qiE 'could not get lock|unable to acquire|lists/lock' || return 1
    [ "$i" -eq 1 ] && echo "apt занят (обычно это автообновления на свежем сервере) — жду…"
    sleep 10
  done
  return 1
}

show_log_tail() {
  echo "---- последние строки $LOG ----" >&2
  tail -n 25 "$LOG" >&2 || true
}

# кто слушает TCP-порт (пусто, если никто или это наш же сервис)
port_owner() {
  local line pid name main
  line="$(ss -Hltnp "sport = :$1" 2>/dev/null | head -n1)"
  [ -n "$line" ] || return 0
  name="$(printf '%s' "$line" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p')"
  pid="$(printf '%s' "$line" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
  main="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  if [ -n "$pid" ] && [ "$pid" = "$main" ]; then
    return 0
  fi
  echo "${name:-неизвестный процесс}"
}

# значение ключа из файла настроек (без кавычек)
conf_get() {
  [ -f "$CONF" ] || return 0
  sed -n "s/^$1=//p" "$CONF" | tail -n1 | sed "s/^[\"']//; s/[\"']\$//"
}

# подходит ли этот node для сервиса: версия 18+, рядом есть npm, запускается от пользователя игры
node_usable() {
  local bin="$1" major
  [ -n "$bin" ] && [ -x "$bin" ] || return 1
  case "$bin" in /root/* | /home/* | /snap/*) return 1 ;; esac
  major="$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 18 ] || return 1
  [ -x "$(dirname "$bin")/npm" ] || return 1
  runuser -u "$APP_USER" -- "$bin" -e 0 >/dev/null 2>&1
}

install_nodesource() {
  say "Ставлю Node.js 22 (NodeSource)"
  # старый nodejs из репозитория дистрибутива (и его libnode-dev) конфликтует с пакетом NodeSource
  if dpkg -s nodejs >/dev/null 2>&1 && ! dpkg-query -W -f='${Version}' nodejs 2>/dev/null | grep -q nodesource; then
    apt-get remove -y -qq nodejs npm libnode-dev >>"$LOG" 2>&1 || true
    apt-get autoremove -y -qq >>"$LOG" 2>&1 || true
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh || die "не скачался установщик NodeSource"
  bash /tmp/nodesource_setup.sh >>"$LOG" 2>&1 || {
    show_log_tail
    die "установщик NodeSource завершился с ошибкой"
  }
  rm -f /tmp/nodesource_setup.sh
  apt_install nodejs || {
    show_log_tail
    die "не удалось поставить Node.js"
  }
}

# зависимости ставятся в отдельную папку и подменяют рабочие только при успехе —
# неудачное обновление не ломает запущенную игру
install_deps() {
  local app_dir="$1" target="$2" npm_bin="$3" stage want have
  stage="$app_dir/.deps-new"
  rm -rf "$stage"
  mkdir -p "$stage"
  if [ -n "$target" ]; then
    gitq show "$target:package.json" >"$stage/package.json"
    gitq show "$target:package-lock.json" >"$stage/package-lock.json"
  else
    cp "$app_dir/package.json" "$app_dir/package-lock.json" "$stage/"
  fi
  want="$(sha256sum "$stage/package-lock.json" | awk '{print $1}')"
  have="$(cat "$app_dir/node_modules/.uk-rps-lock" 2>/dev/null || true)"
  if [ "$want" = "$have" ]; then
    echo "Зависимости не изменились"
    rm -rf "$stage"
    return 0
  fi
  if ! (cd "$stage" && "$npm_bin" ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error) >>"$LOG" 2>&1; then
    rm -rf "$stage"
    show_log_tail
    die "зависимости не установились (npm ci). Работающая версия игры не тронута"
  fi
  mkdir -p "$stage/node_modules"
  echo "$want" >"$stage/node_modules/.uk-rps-lock"
  DEPS_STAGED="$stage"
}

swap_deps() {
  local app_dir="$1"
  [ -n "${DEPS_STAGED:-}" ] || return 0
  rm -rf "$app_dir/node_modules.old"
  [ -d "$app_dir/node_modules" ] && mv "$app_dir/node_modules" "$app_dir/node_modules.old"
  mv "$DEPS_STAGED/node_modules" "$app_dir/node_modules"
  rm -rf "$app_dir/node_modules.old" "$DEPS_STAGED"
  DEPS_STAGED=""
}

main() {
  local domain_arg="" port_arg="" pull=1 behind="" remove=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --uninstall) remove=1; shift ;;
      --port) port_arg="${2:-}"; shift 2 || die "после --port нужен номер порта" ;;
      --port=*) port_arg="${1#*=}"; shift ;;
      --no-domain) domain_arg="-"; behind=0; shift ;;
      --behind-proxy) behind=1; shift ;;
      --no-pull) pull=0; shift ;;
      -h | --help) usage; exit 0 ;;
      -*) die "неизвестный параметр $1 (см. --help)" ;;
      *) domain_arg="$1"; shift ;;
    esac
  done
  # новый домен без --behind-proxy означает «HTTPS через Caddy»
  if [ -n "$domain_arg" ] && [ "$domain_arg" != "-" ] && [ -z "$behind" ]; then
    behind=0
  fi

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
  APP_DIR="$app_dir"
  if [ "$remove" -eq 1 ]; then
    uninstall
    return 0
  fi
  [ -f "$app_dir/server.js" ] || die "не найден $app_dir/server.js — запускайте скрипт из папки игры"
  case "$app_dir" in
    /root | /root/* | /home/*) die "игра лежит в $app_dir, а у сервиса нет доступа к домашним папкам. Склонируйте её в /opt/uk-rps" ;;
  esac

  # ---- настройки: параметры командной строки > сохранённые > по умолчанию
  local DOMAIN PORT HOST BEHIND
  DOMAIN="$(conf_get DOMAIN)"
  PORT="$(conf_get PORT)"
  BEHIND="$(conf_get BEHIND_PROXY)"
  if [ "$domain_arg" = "-" ]; then
    DOMAIN=""
  elif [ -n "$domain_arg" ]; then
    DOMAIN="$(printf '%s' "$domain_arg" | tr 'A-Z' 'a-z' | sed 's#^https\?://##; s#/.*$##')"
  fi
  [ -n "$behind" ] && BEHIND="$behind"
  [ "$BEHIND" = 1 ] || BEHIND=0
  # смена режима сбрасывает сохранённый порт
  if [ -n "$domain_arg" ] || [ -n "$behind" ]; then
    PORT=""
  fi
  [ -n "$port_arg" ] && PORT="$port_arg"
  if [ -n "$DOMAIN" ]; then
    printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$' || die "странный домен: $DOMAIN"
  fi

  local mode
  if [ "$BEHIND" = 1 ]; then
    mode=proxy
    PORT="${PORT:-3000}"
    HOST=127.0.0.1
  elif [ -n "$DOMAIN" ]; then
    mode=caddy
    PORT="${PORT:-3000}"
    HOST=127.0.0.1
  else
    mode=plain
    PORT="${PORT:-80}"
    HOST=""
  fi
  case "$PORT" in '' | *[!0-9]*) die "порт должен быть числом: $PORT" ;; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "порт вне диапазона: $PORT"
  if [ "$mode" = caddy ] && { [ "$PORT" = 80 ] || [ "$PORT" = 443 ]; }; then
    die "с доменом порты 80 и 443 занимает Caddy — для игры укажите другой --port (по умолчанию 3000)"
  fi

  : >"$LOG"
  trap cleanup EXIT
  export DEBIAN_FRONTEND=noninteractive
  printf 'DPkg::Lock::Timeout "600";\n' >"$APT_LOCK_CONF"

  # ---- пакеты
  say "Ставлю системные пакеты"
  apt_update || {
    show_log_tail
    die "apt-get update не удался"
  }
  apt_install ca-certificates curl git iproute2 || {
    show_log_tail
    die "не удалось поставить системные пакеты"
  }

  # ---- с доменом нужны свободные 80/443 — проверяем до любых изменений
  if [ "$mode" = caddy ]; then
    local o80 o443
    o80="$(port_owner 80)"
    o443="$(port_owner 443)"
    if { [ -n "$o80" ] && [ "$o80" != caddy ]; } || { [ -n "$o443" ] && [ "$o443" != caddy ]; }; then
      die "для HTTPS по домену нужны порты 80 и 443, а они заняты (${o80:+80: $o80 }${o443:+443: $o443}).
   Варианты:
   • игра без домена на другом порту:   sudo bash $0 --no-domain --port 8080
   • за вашим веб-сервером (nginx и т.п.): sudo bash $0 --behind-proxy
     и настройте проксирование по примеру $app_dir/deploy/nginx.conf.example"
    fi
  fi

  # ---- пользователь сервиса
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$APP_USER"
  fi

  # ---- Node.js
  local node_bin
  node_bin="$(command -v node || true)"
  if ! node_usable "$node_bin"; then
    node_usable /usr/bin/node || install_nodesource
    node_bin=/usr/bin/node
    node_usable "$node_bin" || die "Node.js 18+ с npm так и не появился в /usr/bin — посмотрите $LOG"
  fi
  local npm_bin
  npm_bin="$(dirname "$node_bin")/npm"
  echo "Node.js $("$node_bin" -v) ($node_bin)"

  # ---- код и зависимости: сначала скачиваем и ставим зависимости новой версии, потом переключаем код
  local target=""
  if [ "$pull" -eq 1 ] && [ -d "$app_dir/.git" ]; then
    say "Проверяю обновления"
    if gitq fetch --quiet 2>>"$LOG"; then
      local head up
      head="$(gitq rev-parse HEAD)"
      up="$(gitq rev-parse '@{u}' 2>/dev/null || true)"
      if [ -z "$up" ]; then
        warn "у копии нет отслеживаемой ветки (detached HEAD?) — обновление пропускаю"
      elif [ "$up" != "$head" ]; then
        if gitq merge-base --is-ancestor HEAD "$up"; then
          target="$up"
          echo "Есть новая версия: ${up:0:7}"
        else
          warn "локальная копия разошлась с репозиторием — обновление пропускаю"
        fi
      else
        echo "Код уже последней версии"
      fi
    else
      warn "git fetch не удался (нет сети или доступа к репозиторию) — продолжаю с текущей версией"
    fi
  fi

  say "Ставлю зависимости игры"
  DEPS_STAGED=""
  install_deps "$app_dir" "$target" "$npm_bin"
  if [ -n "$target" ]; then
    gitq merge --ff-only --quiet "$target" || {
      rm -rf "${DEPS_STAGED:-/nonexistent-uk-rps}"
      DEPS_STAGED=""
      warn "не удалось переключить код (есть локальные правки в $app_dir?) — остаюсь на текущей версии."
      warn "Сбросить правки: sudo git -C $app_dir checkout -- .   Не обновлять код: добавьте --no-pull"
    }
  fi
  swap_deps "$app_dir"
  chmod -R a+rX "$app_dir"

  # ---- сервис
  say "Настраиваю сервис $SERVICE"
  # порт проверяем до любых изменений, чтобы неудачный запуск не выключил игру
  local owner
  owner="$(port_owner "$PORT")"
  if [ "$owner" = caddy ] && [ "$mode" != caddy ] && caddy_only_ours; then
    owner="" # Caddy держит порт только ради игры — ниже он будет остановлен
  fi
  if [ -n "$owner" ]; then
    local again alt
    case "$mode" in
      plain) again="--no-domain"; alt=8080 ;;
      proxy) again="--behind-proxy"; alt=3001 ;;
      caddy) again="$DOMAIN"; alt=3001 ;;
    esac
    [ "$PORT" = "$alt" ] && alt=$((alt + 1))
    die "порт $PORT уже занят ($owner). Выберите другой: sudo bash $0 $again --port $alt"
  fi

  # Caddy: уходим с домена — убираем свой блок, чтобы освободить порт 80
  [ "$mode" = caddy ] || remove_caddy_block

  # свои строки в файле настроек (например, MAX_ROOMS=…) сохраняем
  local extra=""
  [ -f "$CONF" ] && extra="$(grep -Ev '^(#|DOMAIN=|PORT=|HOST=|BEHIND_PROXY=|[[:space:]]*$)' "$CONF" || true)"
  {
    echo "# Настройки игры — создано deploy/install.sh"
    echo "DOMAIN=$DOMAIN"
    echo "PORT=$PORT"
    echo "HOST=$HOST"
    echo "BEHIND_PROXY=$BEHIND"
    [ -n "$extra" ] && printf '%s\n' "$extra"
  } >"$CONF"

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
    if curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 0.5
  done
  if [ "$ok" -ne 1 ]; then
    journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
    die "сервис не ответил на http://127.0.0.1:$PORT/api/health — смотрите лог выше"
  fi
  echo "Игровой сервер работает на ${HOST:-всех адресах}:$PORT"

  # ---- HTTPS через Caddy
  if [ "$mode" = caddy ]; then
    setup_caddy "$DOMAIN" "$PORT" || die "Caddy настроить не удалось (подробности выше и в $LOG). Игра работает на 127.0.0.1:$PORT"
  fi

  # ---- файрвол
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    say "Открываю порты в ufw"
    case "$mode" in
      caddy)
        ufw allow 80/tcp >/dev/null
        ufw allow 443/tcp >/dev/null
        ;;
      plain) ufw allow "$PORT/tcp" >/dev/null ;;
    esac
  fi

  # ---- итог
  local ip
  ip="$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  say "Готово!"
  case "$mode" in
    caddy)
      echo "Игра: https://$DOMAIN"
      echo "Сертификат Let's Encrypt выпускается автоматически при первом заходе (DNS-запись A для $DOMAIN должна указывать на ${ip:-этот сервер})."
      ;;
    proxy)
      echo "Игра слушает 127.0.0.1:$PORT — направьте на неё свой веб-сервер (пример для nginx: $app_dir/deploy/nginx.conf.example)."
      ;;
    plain)
      if [ "$PORT" = 80 ]; then
        echo "Игра: http://${ip:-IP-сервера}"
      else
        echo "Игра: http://${ip:-IP-сервера}:$PORT"
      fi
      ;;
  esac
  cat <<EOF

Полезные команды:
  статус:      sudo systemctl status $SERVICE
  логи:        sudo journalctl -u $SERVICE -f
  перезапуск:  sudo systemctl restart $SERVICE
  обновление:  sudo bash $app_dir/deploy/install.sh
  удаление:    sudo bash $app_dir/deploy/install.sh --uninstall

Если игра не открывается снаружи, проверьте файрвол у хостинга (security group / «Сетевой экран»).
EOF
}

# в Caddyfile есть блок игры и больше ни одного сайта
caddy_only_ours() {
  [ -f "$CADDYFILE" ] && grep -q '^# uk-rps begin' "$CADDYFILE" || return 1
  ! awk '/^# uk-rps begin/ { s = 1; next } /^# uk-rps end/ { s = 0; next } !s' "$CADDYFILE" | grep -Eqv '^[[:space:]]*(#|$)'
}

# убрать блок игры из Caddyfile; если других сайтов не осталось — остановить Caddy
remove_caddy_block() {
  [ -f "$CADDYFILE" ] && grep -q '^# uk-rps begin' "$CADDYFILE" || return 0
  say "Убираю игру из настроек Caddy"
  local tmp
  tmp="$(mktemp)"
  awk '/^# uk-rps begin/ { skip = 1; next } /^# uk-rps end/ { skip = 0; next } !skip { print }' "$CADDYFILE" >"$tmp"
  install -m 644 "$tmp" "$CADDYFILE"
  rm -f "$tmp"
  if grep -Eqv '^[[:space:]]*(#|$)' "$CADDYFILE"; then
    systemctl reload caddy 2>/dev/null || true
  else
    systemctl disable --now caddy >/dev/null 2>&1 || true
  fi
}

uninstall() {
  say "Удаляю игру с сервера"
  systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
  rm -f "$UNIT" "$CONF"
  systemctl daemon-reload
  remove_caddy_block
  if id -u "$APP_USER" >/dev/null 2>&1; then
    userdel "$APP_USER" 2>/dev/null || true
  fi
  say "Готово. Осталось удалить папку с игрой: sudo rm -r $APP_DIR"
  if command -v caddy >/dev/null && ! systemctl is-enabled --quiet caddy 2>/dev/null; then
    echo "Caddy больше не нужен? Удалить его: sudo apt purge -y caddy"
  fi
}

# Caddyfile не трогали после установки пакета (сверяем md5 с записью dpkg)
caddyfile_is_stock() {
  local want have
  want="$(dpkg-query -W -f='${Conffiles}\n' caddy 2>/dev/null | awk -v f="$CADDYFILE" '$1 == f { print $2 }')"
  have="$(md5sum "$CADDYFILE" 2>/dev/null | awk '{ print $1 }')"
  [ -n "$want" ] && [ "$want" = "$have" ]
}

setup_caddy() {
  local domain="$1" port="$2"

  if ! command -v caddy >/dev/null; then
    say "Ставлю Caddy (автоматический HTTPS)"
    apt_install debian-keyring debian-archive-keyring apt-transport-https gnupg || {
      show_log_tail
      return 1
    }
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg || return 1
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list || return 1
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt_update || {
      show_log_tail
      return 1
    }
    apt_install caddy || {
      show_log_tail
      return 1
    }
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
  elif [ ! -s "$CADDYFILE" ] || caddyfile_is_stock; then
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
    systemctl reload caddy || return 1
  else
    systemctl restart caddy || return 1
  fi
  return 0
}

# вызов и выход в одной строке: git pull может переписать этот файл во время работы
main "$@"; exit $?
