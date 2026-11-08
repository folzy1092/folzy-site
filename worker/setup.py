# -*- coding: utf-8 -*-
"""Установка folzy-music одной командой:  cd worker && python setup.py

1. Создаёт PUSH_TOKEN (общий секрет сайта и selfbot), находит LASTFM_API_KEY и показывает оба.
2. Вход в Cloudflare (откроется браузер, если ещё не вошёл).
3. KV для кэша: создаёт и вписывает id в wrangler.toml.
4. Деплой воркера, секреты LASTFM_API_KEY и PUSH_TOKEN, проверка /now и /stats.
5. Адрес воркера — в assets/js/config.js сайта, коммит и пуш (GitHub Pages обновит folzy.ru).
6. .env контейнера selfbot через API панели Pterodactyl: SITE_NOW_URL и SITE_PUSH_TOKEN
   (до записи — копия /.env.site-backup, после — сверка), затем по твоему «y» — перезапуск сервера.

Ключи берутся из переменных окружения, ../../selfbot/code/.env, ../../lengu/.env и .env на сервере;
чего нет — спросит. Нужны только Python 3.9+ и Node.js (для `npx wrangler`), сторонних пакетов нет.
Секреты на диск не пишутся: временный файл для `wrangler secret bulk` удаляется сразу.
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
PROJECTS = os.path.dirname(SITE)
WRANGLER_TOML = os.path.join(HERE, 'wrangler.toml')
CONFIG_JS = os.path.join(SITE, 'assets', 'js', 'config.js')
LOCAL_ENVS = [os.path.join(PROJECTS, 'selfbot', 'code', '.env'), os.path.join(PROJECTS, 'lengu', '.env')]
KEY_NAMES = ('LASTFM_API_KEY', 'PTERO_API_KEY', 'PTERO_PANEL_URL', 'PTERO_SERVER_ID')
PANEL_DEFAULT = 'https://p.host.rooni.dev'
SERVER_DEFAULT = 'b77aca45'
REMOTE_ENV = '/.env'
REMOTE_BACKUP = '/.env.site-backup'
KV_NAME = 'folzy-music-cache'


# ── Чистые помощники (их проверяет test/test_setup.py) ──────────────────

_ENV_LINE = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')


def parse_env(text):
    out = {}
    for line in (text or '').splitlines():
        m = _ENV_LINE.match(line)
        if not m:
            continue
        value = m.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        out[m.group(1)] = value
    return out


def merge_env(text, updates):
    """Меняет только строки нужных ключей (повторы — тоже), недостающие дописывает в конец.
    Переносы строк файла (\\n или \\r\\n) сохраняются."""
    eol = '\r\n' if '\r\n' in text else '\n'
    lines = re.split(r'\r?\n', text) if text else []
    seen = set()
    out = []
    for line in lines:
        m = _ENV_LINE.match(line)
        if m and m.group(1) in updates:
            seen.add(m.group(1))
            out.append(f'{m.group(1)}={updates[m.group(1)]}')
        else:
            out.append(line)
    while out and out[-1] == '':
        out.pop()
    out += [f'{k}={v}' for k, v in updates.items() if k not in seen]
    return eol.join(out) + eol


_KV_BLOCK = re.compile(r'^\[\[kv_namespaces\]\]\nbinding = "CACHE"\nid = "([0-9a-f]{32})"$', re.M)


def kv_id_from_toml(toml):
    m = _KV_BLOCK.search(toml)
    return m.group(1) if m else None


def set_kv_id(toml, kv_id):
    block = f'[[kv_namespaces]]\nbinding = "CACHE"\nid = "{kv_id}"'
    if _KV_BLOCK.search(toml):
        return _KV_BLOCK.sub(block, toml)
    commented = '# [[kv_namespaces]]\n# binding = "CACHE"\n# id = "..."'
    if commented in toml:
        return toml.replace(commented, block)
    return f'{toml.rstrip()}\n\n{block}\n'


def set_endpoint(config_js, url):
    return re.sub(r"musicEndpoint: '[^']*'", f"musicEndpoint: '{url}'", config_js)


def workers_url(output):
    m = re.search(r'https://folzy-music\.[a-z0-9-]+\.workers\.dev', output or '', re.I)
    return m.group(0) if m else None


def kv_id_from_output(output):
    m = re.search(r'id"?\s*[:=]\s*"([0-9a-f]{32})"', output or '', re.I)
    return m.group(1) if m else None


def kv_id_from_list(output):
    """id из `wrangler kv namespace list` (JSON-массив где-то в выводе)."""
    start, end = (output or '').find('['), (output or '').rfind(']')
    if start < 0 or end < start:
        return None
    try:
        items = json.loads(output[start:end + 1])
    except ValueError:
        return None
    for item in items:
        title = str(item.get('title', ''))
        if 'folzy-music' in title.lower() and 'cache' in title.lower():
            return item.get('id')
    return None


# ── Вывод и команды ────────────────────────────────────────────────────

def bold(s): return f'\x1b[1m{s}\x1b[0m'
def green(s): return f'\x1b[32m{s}\x1b[0m'
def yellow(s): return f'\x1b[33m{s}\x1b[0m'
def red(s): return f'\x1b[31m{s}\x1b[0m'


def step(n, text): print(f'\n{bold(f"[{n}/6]")} {text}')
def ok(text): print(f'  {green("✓")} {text}')
def warn(text): print(f'  {yellow("!")} {text}')


def fail(text):
    print(f'\n  {red("✗")} {text}')
    sys.exit(1)


def ask(question):
    try:
        return input(f'  {question} ').strip()
    except EOFError:
        return ''


def run(args, cwd=HERE, quiet=False, stdin=None):
    """Команда: вывод — на экран и в строку; stdin — у пользователя (вход, вопросы wrangler)."""
    proc = subprocess.Popen(args, cwd=cwd, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding='utf-8', errors='replace')
    out = []
    for line in proc.stdout:
        out.append(line)
        if not quiet:
            sys.stdout.write(line)
            sys.stdout.flush()
    return proc.wait(), ''.join(out)


NPX = shutil.which('npx') or shutil.which('npx.cmd')


def wrangler(*args, quiet=False, stdin=None):
    return run([NPX, '--yes', 'wrangler', *args], quiet=quiet, stdin=stdin)


def git(*args):
    return run(['git', *args], cwd=SITE, quiet=True, stdin=subprocess.DEVNULL)


def http(url, method='GET', data=None, headers=None, timeout=20):
    """(код, тело) без исключений на 4xx/5xx."""
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


# ── Панель Pterodactyl ─────────────────────────────────────────────────

class Panel:
    def __init__(self, keys):
        url = (keys.get('PTERO_PANEL_URL') or PANEL_DEFAULT).rstrip('/')
        server = keys.get('PTERO_SERVER_ID') or SERVER_DEFAULT
        self.base = f'{url}/api/client/servers/{server}'
        self.headers = {'Authorization': f"Bearer {keys['PTERO_API_KEY']}", 'Accept': 'application/json'}

    def read(self, path):
        code, body = http(f"{self.base}/files/contents?file={urllib.parse.quote(path)}", headers=self.headers)
        if code != 200:
            raise RuntimeError(f'панель: чтение {path} — код {code}')
        return body

    def write(self, path, text):
        code, _ = http(f"{self.base}/files/write?file={urllib.parse.quote(path)}", method='POST',
                       data=text.encode('utf-8'), headers={**self.headers, 'Content-Type': 'text/plain'})
        if code != 204:
            raise RuntimeError(f'панель: запись {path} — код {code}')

    def restart(self):
        code, _ = http(f'{self.base}/power', method='POST', data=json.dumps({'signal': 'restart'}).encode(),
                       headers={**self.headers, 'Content-Type': 'application/json'})
        if code != 204:
            raise RuntimeError(f'панель: перезапуск — код {code}')


# ── Шаги ────────────────────────────────────────────────────────────────

def find_keys():
    keys = {}
    for path in LOCAL_ENVS:
        if os.path.exists(path):
            with open(path, encoding='utf-8', errors='replace') as f:
                found = parse_env(f.read())
            for name in KEY_NAMES:
                if not keys.get(name) and found.get(name):
                    keys[name] = found[name]
    for name in KEY_NAMES:
        if os.environ.get(name):
            keys[name] = os.environ[name]
    return {k: v for k, v in keys.items() if v}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    if os.name == 'nt':
        os.system('')          # включает цвета в консоли Windows
    if not NPX:
        fail('Не нашёл npx. Поставь Node.js (nodejs.org) и запусти снова.')
    print(bold('folzy-music: установка endpoint «сейчас играет» для folzy.ru'))

    # 1. Ключи
    step(1, 'Ключи')
    keys = find_keys()
    if not keys.get('PTERO_API_KEY'):
        keys['PTERO_API_KEY'] = ask('Клиентский ключ панели (ptlc_…, Account → API Credentials; Enter — пропустить шаг с сервером):')
    remote_env = None
    if keys.get('PTERO_API_KEY'):
        try:
            remote_env = Panel(keys).read(REMOTE_ENV)
            ok(f'.env на сервере прочитан ({len(remote_env.splitlines())} строк)')
            keys.setdefault('LASTFM_API_KEY', parse_env(remote_env).get('LASTFM_API_KEY'))
        except Exception as e:
            warn(f'{e}. Шаг с сервером пропущу — строки для .env покажу в конце.')
    if not keys.get('LASTFM_API_KEY'):
        keys['LASTFM_API_KEY'] = ask('Ключ Last.fm (last.fm/api/account/create):')
    if not re.fullmatch(r'[0-9a-fA-F]{32}', keys.get('LASTFM_API_KEY') or ''):
        fail('Ключ Last.fm — 32 символа 0-9a-f. Проверь и запусти снова.')

    push_token = secrets.token_urlsafe(32)
    print(f"""
  {bold('Сохрани себе — эти значения нужны воркеру и боту:')}
    LASTFM_API_KEY  = {keys['LASTFM_API_KEY']}
    PUSH_TOKEN      = {push_token}      {yellow('(новый, создан сейчас)')}""")

    # 2. Cloudflare
    step(2, 'Вход в Cloudflare')
    code, out = wrangler('whoami', quiet=True)
    if code != 0 or re.search(r'not authenticated|You are not', out, re.I):
        warn('Не вошёл — открываю браузер для входа.')
        if wrangler('login')[0] != 0:
            fail('Вход в Cloudflare не удался.')
    ok('Cloudflare: вошёл')

    # 3. KV
    step(3, 'KV для кэша длительностей и статистики')
    with open(WRANGLER_TOML, encoding='utf-8') as f:
        toml = f.read()
    kv_id = kv_id_from_toml(toml)
    if kv_id:
        ok(f'уже есть: {kv_id}')
    else:
        _, out = wrangler('kv', 'namespace', 'create', KV_NAME, '--binding', 'CACHE', stdin=subprocess.DEVNULL)
        kv_id = kv_id_from_output(out)
        if not kv_id:
            _, out = wrangler('kv', 'namespace', 'list', quiet=True, stdin=subprocess.DEVNULL)
            kv_id = kv_id_from_list(out)
        if not kv_id:
            fail('Не удалось создать или найти KV. Вывод wrangler выше.')
        with open(WRANGLER_TOML, 'w', encoding='utf-8', newline='') as f:
            f.write(set_kv_id(toml, kv_id))
        ok(f'KV: {kv_id} — записал в wrangler.toml')

    # 4. Деплой и секреты
    step(4, 'Деплой воркера и секреты')
    code, out = wrangler('deploy')
    if code != 0:
        fail('Деплой не прошёл. Вывод wrangler выше.')
    url = workers_url(out)
    if not url:
        fail('Деплой прошёл, но адрес *.workers.dev не нашёлся. Включи workers.dev в настройках воркера.')
    ok(f'воркер: {url}')

    tmp = tempfile.mkdtemp(prefix='folzy-music-')
    try:
        path = os.path.join(tmp, 'secrets.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'LASTFM_API_KEY': keys['LASTFM_API_KEY'], 'PUSH_TOKEN': push_token}, f)
        code, _ = wrangler('secret', 'bulk', path, stdin=subprocess.DEVNULL)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if code != 0:
        fail('Секреты не записались. Вывод wrangler выше.')
    ok('секреты LASTFM_API_KEY и PUSH_TOKEN записаны')

    print('  проверяю endpoint…')
    time.sleep(4)          # секреты применяются за пару секунд
    for path in ('/now', '/stats'):
        try:
            code, body = http(url + path, timeout=60)
            data = json.loads(body)
            if code != 200:
                warn(f"{path}: код {code} — {data.get('error', '')}")
            elif path == '/now':
                track = data.get('track') or {}
                state = f"играет «{track.get('artist')} — {track.get('title')}»" if data.get('playing') else 'сейчас ничего не играет'
                ok(f"/now: {state} (источник: {data.get('source')})")
            else:
                ok(f"/stats: сегодня {data['today']['tracks']} треков, за месяц {data['month']['tracks']}")
        except Exception as e:
            warn(f'{path}: {e}')

    # 5. Сайт
    step(5, 'Адрес воркера — на сайт')
    with open(CONFIG_JS, encoding='utf-8') as f:
        config = f.read()
    new_config = set_endpoint(config, url)
    if new_config != config:
        with open(CONFIG_JS, 'w', encoding='utf-8', newline='') as f:
            f.write(new_config)
    git('add', 'assets/js/config.js', 'worker/wrangler.toml')
    if git('diff', '--cached', '--quiet')[0] == 0:
        ok('config.js уже с этим адресом — коммитить нечего')
    else:
        code, out = git('commit', '-m', 'Connect folzy-music worker endpoint')
        if code == 0:
            code, out = git('push', 'origin', 'main')
        if code == 0:
            ok('закоммитил и запушил — folzy.ru обновится через минуту')
        else:
            warn(f"git: {out.strip().splitlines()[-1] if out.strip() else code} — закоммить и запушь сам")

    # 6. Бот
    step(6, 'Selfbot: .env на сервере')
    updates = {'SITE_NOW_URL': f'{url}/now', 'SITE_PUSH_TOKEN': push_token}
    if remote_env is None:
        warn('Панель недоступна — добавь в .env контейнера сам и перезапусти сервер:')
        for k, v in updates.items():
            print(f'    {k}={v}')
    else:
        panel = Panel(keys)
        panel.write(REMOTE_BACKUP, remote_env)
        panel.write(REMOTE_ENV, merge_env(remote_env, updates))
        check = parse_env(panel.read(REMOTE_ENV))
        if any(check.get(k) != v for k, v in updates.items()):
            panel.write(REMOTE_ENV, remote_env)
            fail('После записи .env не совпал — вернул как было. Добавь строки руками.')
        ok(f'.env обновлён (копия до правки — {REMOTE_BACKUP})')
        answer = ask('Перезапустить сервер сейчас? Ляжет и LenguBot на ~минуту. [y/N]')
        if re.fullmatch(r'(?i)y(es)?|д(а)?', answer):
            panel.restart()
            ok('сервер перезапускается — через минуту бот начнёт слать трек на сайт')
        else:
            warn('Не перезапускаю. Бот подхватит переменные при следующем рестарте.')

    print(f"\n{green(bold('Готово.'))} Endpoint: {url}\n")


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        fail('Остановлено.')
