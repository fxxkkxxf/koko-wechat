"""Koko's local, account-bound WeChat adapter. JSONL on stdin/stdout.

Windows integration uses wechatauto-replica (Apache-2.0), pinned in requirements.
No upstream bot/server is run. Only the selected conversation is listened to.
"""
from __future__ import annotations
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stdin, 'reconfigure'):
    sys.stdin.reconfigure(encoding='utf-8')
OUTPUT = sys.stdout
OUTPUT_LOCK = threading.Lock()
IMAGE_READ_RETRY_SECONDS = 2.0
IMAGE_READ_RETRY_DELAYS = (0.15, 0.30, 0.60, 0.90)
MEDIA_CFG_RETRY_SECONDS = 10.0
# Third-party libraries can print decrypted paths; keep their output off protocol.
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def emit(value):
    with OUTPUT_LOCK:
        OUTPUT.write(json.dumps(value, ensure_ascii=False) + '\n')
        OUTPUT.flush()


def now_ms():
    return int(time.time() * 1000)


def message_id(chat_id, row):
    return ':'.join(map(str, [chat_id, row.get('shard', ''), row.get('local_id', '')]))


def edit_text_equal(actual, expected):
    # Windows CRLF and UIA LF represent the same line breaks. Do not trim,
    # compare substrings, fold spaces, or change punctuation/user content.
    return isinstance(actual, str) and actual.replace('\r\n', '\n') == expected.replace('\r\n', '\n')


def wait_for_edit(driver, expected, check=lambda: None, timeout=1.6):
    """Qt's ValuePattern SetValue completion can lag behind its return value."""
    deadline = time.monotonic() + timeout
    matched = False
    while time.monotonic() < deadline:
        check()
        # Reacquire the editor/pattern each read rather than trusting a cached value.
        editor = driver._chat_input()
        value = driver._read_edit_value(editor) if editor is not None else None
        equal = edit_text_equal(value, expected)
        if equal and matched:
            return True
        matched = equal
        time.sleep(0.06)
    return False


def focus_window(gui, hwnd):
    """Transfer foreground using scoped input-thread attachment on Windows."""
    if gui.GetForegroundWindow() == hwnd:
        return True
    if not hwnd or not gui.IsWindow(hwnd):
        return False
    import ctypes
    from ctypes import wintypes
    import win32process
    user32 = ctypes.windll.user32
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    current = ctypes.windll.kernel32.GetCurrentThreadId()
    previous = gui.GetForegroundWindow()
    thread_ids = set()
    for handle in (previous, hwnd):
        if handle:
            thread_ids.add(win32process.GetWindowThreadProcessId(handle)[0])
    attached = []
    try:
        for target in thread_ids:
            if target and target != current and user32.AttachThreadInput(current, target, True):
                attached.append(target)
        gui.BringWindowToTop(hwnd)
        gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    finally:
        for target in reversed(attached):
            user32.AttachThreadInput(current, target, False)
    return gui.GetForegroundWindow() == hwnd


def restore_window(gui, hwnd, placement, foreground):
    """Return focus only if automation still owns it; user takeover wins."""
    if gui.GetForegroundWindow() != hwnd:
        return False
    gui.SetWindowPlacement(hwnd, placement)
    if foreground and foreground != hwnd and gui.IsWindow(foreground):
        focus_window(gui, foreground)
    return gui.GetForegroundWindow() == foreground


def confirm_sent(rows, before_ids, account_id, chat_id, text, sent_at):
    """An old identical message, another sender or another shard never confirms."""
    for row in rows:
        if message_id(chat_id, row) in before_ids:
            continue
        if row.get('sender_username') != account_id:
            continue
        if str(row.get('content', '')).replace('\r\n', '\n') != text.replace('\r\n', '\n'):
            continue
        if float(row.get('create_time') or 0) * 1000 < sent_at - 2000:
            continue
        return row
    return None


def mention_evidence(source, text, account_id, aliases):
    """Only the client's source field is trusted for real @ user IDs."""
    if isinstance(source, bytes):
        source = source.decode('utf-8', errors='replace')
    if isinstance(source, str) and len(source) <= 32000:
        try:
            root = ET.fromstring(source)
            node = next((element for element in root.iter()
                         if element.tag.split('}')[-1].lower() == 'atuserlist'), None)
            if node is not None:
                ids = list(dict.fromkeys(x.strip()[:120] for x in (node.text or '').split(',') if x.strip()))[:100]
                return {'atMe': account_id in ids, 'mentionedIds': ids, 'mentionBasis': 'metadata',
                        'hasOtherMention': any(x != account_id for x in ids)}
        except (ET.ParseError, ValueError):
            pass
    normalized = (text or '').replace('\u2005', ' ')
    at_me = False
    remainder = normalized
    for alias in sorted(aliases, key=len, reverse=True):
        if not alias:
            continue
        pattern = r'(?<![\w@])@\s*' + re.escape(alias) + r'(?=$|[\s，,。.!！?？、:：;；~～…—\-])'
        if re.search(pattern, remainder):
            at_me = True
            remainder = re.sub(pattern, ' ', remainder)
    other = bool(re.search(r'(?<![\w@])@\s*[^\s@，,。.!！?？、:：;；~～…—\-]+', remainder))
    return {'atMe': at_me, 'mentionedIds': [], 'mentionBasis': 'alias_text' if at_me else 'none',
            'hasOtherMention': other}


SYSTEM_CONTACTS = frozenset({'filehelper', 'weixin', 'weixinreminder', 'fmessage', 'medianote',
    'floatbottle', 'newsapp', 'masssendapp', 'qqmail', 'tmessage', 'qmessage', 'qqsync', 'weibo',
    'feedsapp', 'linkedinplugin', 'notifymessage', 'brandsessionholder', 'appbrand_notify_message',
    'appbrandcustomerservicemsg', 'helper_entry', 'officialaccounts', 'notification_messages'})


def select_account_windows(windows):
    """A hidden login shell must not replace the main window after Z-order changes."""
    groups = {}
    for window in windows:
        groups.setdefault(window['id'], []).append(window)
    chosen = {}
    for account_id, candidates in groups.items():
        if len({row['pid'] for row in candidates}) != 1:
            continue
        ranked = sorted(candidates, key=lambda row: row.get('normalArea', 0), reverse=True)
        if len(ranked) > 1 and ranked[0].get('normalArea', 0) == ranked[1].get('normalArea', 0):
            continue
        chosen[account_id] = ranked[0]
    return chosen


def private_contact_exclusion(row, account_id, columns):
    """Classify metadata without treating every cached group member as a friend."""
    ident = str(row.get('username') or '')
    if not ident or ident == account_id:
        return 'self'
    if ident in SYSTEM_CONTACTS or ident.startswith(('gh_', 'appbrand_')):
        return 'official' if ident.startswith('gh_') else 'system'
    if row.get('delete_flag'):
        return 'deleted'
    if row.get('verify_flag'):
        return 'official'
    if ident.endswith('@chatroom'):
        return 'group'
    # WeChat 4.x local_type 1 denotes the address-book contact class, 3 is a
    # group-member cache. Older schemas may instead expose the friendship bit.
    if 'local_type' in columns:
        return None if row.get('local_type') == 1 else 'nonFriend'
    if 'flag' in columns:
        return None if int(row.get('flag') or 0) & 1 else 'nonFriend'
    return 'unclassified'


class Bridge:
    def __init__(self, state=None):
        self.state = Path(state or os.environ.get('KOKO_WECHAT_STATE') or Path(__file__).resolve().parents[1] / 'data')
        self.state.mkdir(parents=True, exist_ok=True)
        self._catalog = {}
        self._dbs = {}
        self._account = None
        self._chat = None
        self._targets = {}
        self._members = {}
        # Successful cfg values live only on their account DB. Failed probes
        # are cooled down, rather than remembered forever until a restart.
        self._media_cfg_checked = {}
        self._listener = None
        self._active = threading.Event()
        self._lock = threading.RLock()
        # Cancellation must remain observable while the UI operation holds
        # _lock, so it uses a separate, short-lived synchronization primitive.
        self._batch_lock = threading.Lock()
        self._batch_cancels = {}
        self._send_generation = 0
        self._background_encoding_cache = {}
        self.error = ''
        self._ledger_path = self.state / 'bridge-sends.json'
        try:
            self._ledger = json.loads(self._ledger_path.read_text('utf-8'))
        except (OSError, ValueError):
            self._ledger = {}
        for entry in self._ledger.values():
            if entry.get('status') == 'sending':
                entry['status'] = 'unconfirmed'
                entry['message'] = '上次发送中断，需人工核对，未自动重发'
            elif entry.get('kind') == 'batch' and entry.get('status') == 'preparing':
                entry['status'] = 'cancelled'
                entry['cancelled'] = True
                entry['message'] = '上次分条发送中断，剩余消息未自动继续'

    def _persist(self):
        tmp = self._ledger_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self._ledger, ensure_ascii=False, indent=2), 'utf-8')
        os.replace(tmp, self._ledger_path)

    def _phase(self, name, job=None):
        progress = {'stage': name, 'at': now_ms(), 'jobId': (job or {}).get('id', '')}
        try:
            path = self.state / 'bridge-progress.json'
            path.write_text(json.dumps(progress), 'utf-8')
        except OSError:
            pass
        emit({'event': 'progress', 'data': progress})

    def status(self, **_):
        return {'available': bool(self._account), 'listening': self._active.is_set(),
                'accountId': self._account['id'] if self._account else '',
                'accountName': self._account['name'] if self._account else '',
                'chatId': self._chat['id'] if self._chat else '',
                'targetName': self._chat['name'] if self._chat else '',
                'targets': list(self._target_map().values()),
                'error': self.error}

    def _target_map(self):
        if self._targets:
            return self._targets
        if self._chat:
            return {self._chat['id']: {**self._chat, 'chatId': self._chat['id'], 'type': 'private'}}
        return {}

    @staticmethod
    def _modules():
        if sys.platform != 'win32':
            raise BridgeError('WINDOWS_REQUIRED', '微信桥接需要 Windows 图形桌面')
        try:
            import psutil
            import win32gui
            import win32process
            import wechatauto.db as dbmod
            return psutil, win32gui, win32process, dbmod
        except ImportError:
            raise BridgeError('DEPENDENCY_MISSING', '微信桥接依赖未安装，请运行安装入口')

    def _detect(self):
        psutil, gui, processes, dbmod = self._modules()
        windows = []
        def collect(hwnd, _):
            try:
                name = gui.GetWindowText(hwnd)
                cls = gui.GetClassName(hwnd)
                rect = gui.GetWindowRect(hwnd)
                pid = processes.GetWindowThreadProcessId(hwnd)[1]
                if name not in ('微信', 'Weixin', 'WeChat') or 'Tool' in cls:
                    return
                if (rect[2] - rect[0] < 200 or rect[3] - rect[1] < 200) and not gui.IsIconic(hwnd):
                    return
                if psutil.Process(pid).name().lower() not in ('weixin.exe', 'wechat.exe'):
                    return
                roots = set()
                for file in psutil.Process(pid).open_files():
                    path = file.path
                    match = re.search(r'(?i)^(.*[\\/])([^\\/]+)[\\/]db_storage[\\/]', path)
                    if match:
                        roots.add((match.group(1).rstrip('\\/'), match.group(2)))
                # A window is bound only by the files actually opened by its PID.
                if len(roots) == 1:
                    root, folder = next(iter(roots))
                    account_id = re.sub(r'_\w{4}$', '', folder)
                    known_name = self._catalog.get(account_id, {}).get('name') or account_id
                    normal = gui.GetWindowPlacement(hwnd)[4]
                    area = max(0, normal[2]-normal[0])*max(0, normal[3]-normal[1])
                    if not gui.IsIconic(hwnd):
                        area = max(area, max(0, rect[2]-rect[0])*max(0, rect[3]-rect[1]))
                    windows.append({'id': account_id, 'account': folder, 'root': root, 'normalArea': area,
                                    'hwnd': hwnd, 'pid': pid, 'name': known_name})
            except Exception:
                return
        gui.EnumWindows(collect, None)
        unique = select_account_windows(windows)
        self._catalog = unique
        return unique

    def _database(self, account):
        account_id = account['id']
        _, _, _, dbmod = self._modules()
        pid = account['pid']
        dbmod._weixin_pids = lambda: [pid]
        if account_id in self._dbs:
            return self._dbs[account_id]
        # Scope the library to the PID proven to hold this account's DB files.
        private = self.state / 'bridge-cache' / account_id
        private.mkdir(parents=True, exist_ok=True)

        class AccountDB(dbmod.WeChatDB):
            def _collect_db_files(self):
                return [(rel,path,size) for rel,path,size in super()._collect_db_files()
                        if os.path.basename(path) in ('contact.db', 'session.db', 'message_resource.db')
                        or re.fullmatch(r'message_\d+\.db', os.path.basename(path))]
            def _try_other_accounts(self):
                return False
            def _select_account_by_keys(self, *_):
                return False
            def _stable_key_file(self, account=None):
                return str(private / 'keys.json')
            def _save_keys(self):
                path = private / 'keys.json'
                tmp = path.with_suffix('.tmp')
                tmp.write_text(json.dumps({k:v.hex() for k,v in self._keys.items()}), 'utf-8')
                os.replace(tmp, path)
            def _load_or_extract_keys(self, master_key=None):
                # Do not read credentials cached by another project/account.
                path = private / 'keys.json'
                if path.exists():
                    for rel, value in self._load_key_cache(str(path)).items():
                        self._keys[rel] = value
                self._keys = {rel:key for rel,key in self._keys.items() if self._key_works(rel)}
                if not self._keys:
                    self._keys.update(self.extract_keys())
                if not self._keys:
                    got = self.extract_master_key()
                    if got:
                        self._keys.update(self.derive_keys_from_master(got[0]))
                self._save_keys()
                self.unkeyed = [rel for rel,_,_ in self._db_files if not self._key_works(rel)]

        db = AccountDB(db_dir=account['root'], account=account['account'],
                       keys_file=str(private / 'keys.json'), workdir=str(private))
        if db.wxid != account_id:
            raise BridgeError('ACCOUNT_MISMATCH', '数据库账号与窗口账号不一致')
        info = db.get_self_info()
        if not info.get('nick_name'):
            raise BridgeError('DATABASE_UNAVAILABLE', '无法读取已登录账号资料；请检查微信登录及桥接权限')
        account['name'] = info['nick_name']
        self._dbs[account_id] = db
        return db

    def accounts(self, **_):
        with self._lock:
            rows = self._detect()
            result = []
            for account in rows.values():
                try:
                    db = self._database(account)
                    info = db.get_self_info()
                    account['name'] = info.get('nick_name') or account['id']
                    result.append({'id': account['id'], 'name': account['name'],
                                   'hwnd': account['hwnd'], 'pid': account['pid'], 'available': True})
                except Exception:
                    result.append({'id': account['id'], 'name': account['name'], 'available': False,
                                   'error': '账号资料暂不可读，请检查权限或重新登录'})
            if not result:
                self.error = '未识别到已登录的微信主窗口，请打开微信并登录小号'
            return {'accounts': result}

    def _resolve_account(self, account_id):
        if account_id in self._catalog:
            return self._catalog[account_id]
        self.accounts()
        hits = [x for x in self._catalog.values() if account_id in (x['id'], x['name'])]
        if len(hits) != 1:
            raise BridgeError('SELECT_ACCOUNT', '请在管理页选择唯一的小号账号')
        return hits[0]

    def contacts(self, accountId='', query='', q='', **_):
        with self._lock:
            account = self._resolve_account(accountId or (self._account or {}).get('id', ''))
            db = self._database(account)
            keyword = str(query or q or '').strip()
            if not keyword:
                return {'accountId': account['id'], 'accountName': account['name'],
                        'contacts': [], 'message': '请输入要绑定的联系人昵称、备注或微信号'}
            if len(keyword) > 80:
                raise BridgeError('INVALID_QUERY', '联系人搜索内容过长')
            contacts = []
            for row in db.search_contact(keyword):
                if row['username'] == account['id'] or '@chatroom' in row['username']:
                    continue
                contacts.append({'id': row['username'], 'name': row.get('remark') or row.get('nick_name') or row['username'],
                                 'nickname': row.get('nick_name') or ''})
            return {'accountId': account['id'], 'accountName': account['name'], 'contacts': contacts}

    def directory(self, accountId='', query='', offset=0, limit=500, **_):
        """Paged metadata directory; never reads sessions, messages or member names."""
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise BridgeError('INVALID_PAGE', '目录起始位置无效')
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 500:
            raise BridgeError('INVALID_PAGE', '每页可读取1—500个会话')
        keyword = str(query or '').strip()
        if len(keyword) > 80:
            raise BridgeError('INVALID_QUERY', '会话搜索内容过长')
        with self._lock:
            account = self._resolve_account(accountId or (self._account or {}).get('id', ''))
            db = self._database(account)
            conn = db._contact_conn()
            if conn is None:
                raise BridgeError('DIRECTORY_UNAVAILABLE', '通讯录资料暂不可读，请检查微信登录')
            excluded = {key: 0 for key in ('self', 'system', 'official', 'nonFriend', 'deleted', 'nonMember', 'unclassified')}
            items = {}
            try:
                columns = {r[1] for r in conn.execute('PRAGMA table_info(contact)')}
                required = {'username', 'nick_name', 'remark'}
                if not required.issubset(columns):
                    raise BridgeError('DIRECTORY_SCHEMA', '当前微信通讯录结构暂不支持')
                fields = ['username', 'nick_name', 'remark'] + [x for x in
                    ('local_type', 'flag', 'delete_flag', 'verify_flag', 'is_in_chat_room') if x in columns]
                contacts = [dict(row) for row in conn.execute('SELECT ' + ','.join(fields) + ' FROM contact')]
                for row in contacts:
                    reason = private_contact_exclusion(row, account['id'], columns)
                    if reason:
                        if reason in excluded:
                            excluded[reason] += 1
                        continue
                    ident = row['username']
                    items[ident] = {'id': ident, 'chatId': ident, 'type': 'private',
                                    'name': row.get('remark') or row.get('nick_name') or ident,
                                    'nickname': row.get('nick_name') or ''}
                rooms = conn.execute("SELECT r.username, c.nick_name, c.remark, "
                    "(SELECT COUNT(*) FROM chatroom_member m WHERE m.room_id=r.id) AS n, "
                    "EXISTS(SELECT 1 FROM chatroom_member m JOIN contact me ON me.id=m.member_id "
                    "WHERE m.room_id=r.id AND me.username=?) AS is_member "
                    "FROM chat_room r LEFT JOIN contact c ON c.username=r.username", (account['id'],)).fetchall()
                by_id = {row['username']: row for row in contacts}
                for row in rooms:
                    ident = row['username']
                    info = by_id.get(ident, {})
                    if not row['is_member'] or info.get('delete_flag') or ('is_in_chat_room' in columns and info.get('is_in_chat_room') not in (None, 0, 1)):
                        excluded['nonMember'] += 1
                        continue
                    items[ident] = {'id': ident, 'chatId': ident, 'type': 'group',
                                    'name': row['remark'] or row['nick_name'] or ident,
                                    'memberCount': int(row['n'] or 0)}
            finally:
                conn.close()
            needle = keyword.casefold()
            values = [x for x in items.values() if not needle or any(needle in str(x.get(k, '')).casefold()
                      for k in ('name', 'nickname', 'chatId'))]
            values.sort(key=lambda x: (x['name'].casefold(), x['type'], x['chatId']))
            page = values[offset:offset + limit]
            next_offset = offset + len(page) if offset + len(page) < len(values) else None
            return {'accountId': account['id'], 'accountName': account['name'], 'items': page,
                    'total': len(values), 'offset': offset, 'limit': limit, 'nextOffset': next_offset,
                    'truncated': next_offset is not None, 'excluded': excluded, 'metadataOnly': True,
                    'contactClassification': 'local_type' if 'local_type' in columns else 'flag' if 'flag' in columns else 'unavailable'}

    @staticmethod
    def _group_metadata(db, keyword=''):
        # get_groups() in the dependency reads every member of every group.
        # This metadata-only query deliberately avoids that broad access.
        conn = db._contact_conn()
        if conn is None:
            return []
        try:
            # Filter before limiting so an exact selected ID beyond the first
            # page remains bindable. Directory pagination is handled separately.
            pattern = '%' + keyword.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
            rows = conn.execute("SELECT r.username, c.nick_name, c.remark, "
                                "(SELECT COUNT(*) FROM chatroom_member m WHERE m.room_id=r.id) AS n "
                                "FROM chat_room r LEFT JOIN contact c ON c.username=r.username "
                                "WHERE ?='' OR r.username LIKE ? ESCAPE '\\' OR c.nick_name LIKE ? ESCAPE '\\' "
                                "OR c.remark LIKE ? ESCAPE '\\' ORDER BY r.username LIMIT 1000",
                                (keyword, pattern, pattern, pattern)).fetchall()
            result = []
            for row in rows:
                ident = row['username']
                name = row['remark'] or row['nick_name'] or ident
                if not keyword or keyword.casefold() in name.casefold() or keyword.casefold() in ident.casefold():
                    result.append({'id': ident, 'chatId': ident, 'name': name, 'type': 'group',
                                   'memberCount': int(row['n'] or 0)})
            return result[:200]
        finally:
            conn.close()

    def groups(self, accountId='', query='', q='', **_):
        with self._lock:
            account = self._resolve_account(accountId or (self._account or {}).get('id', ''))
            db = self._database(account)
            keyword = str(query or q or '').strip()
            if len(keyword) > 80:
                raise BridgeError('INVALID_QUERY', '群名称搜索内容过长')
            return {'accountId': account['id'], 'accountName': account['name'],
                    'groups': self._group_metadata(db, keyword)}

    def _group_members(self, db, chat_id, fresh=False):
        cached = self._members.get(chat_id)
        if not fresh and cached and now_ms() - cached['at'] < 30000:
            return cached['rows']
        rows = db.get_group_members(chat_id)
        # Some client schemas expose a real per-room nickname; retain it when
        # available, without treating a global contact nickname as room metadata.
        conn = db._contact_conn()
        if conn is not None:
            try:
                columns = {r[1] for r in conn.execute('PRAGMA table_info(chatroom_member)')}
                field = next((x for x in ('display_name', 'room_nick_name', 'member_nick_name') if x in columns), None)
                if field:
                    extra = conn.execute('SELECT c.username, m.' + field + ' AS room_name '
                                         'FROM chatroom_member m JOIN contact c ON c.id=m.member_id '
                                         'JOIN chat_room r ON r.id=m.room_id WHERE r.username=?', (chat_id,)).fetchall()
                    names = {x['username']: x['room_name'] for x in extra}
                    rows = [{**row, 'room_name': names.get(row['username']) or ''} for row in rows]
            finally:
                conn.close()
        self._members[chat_id] = {'at': now_ms(), 'rows': rows}
        return rows

    def bind(self, accountId='', chatId='', targets=None, **_):
        with self._lock:
            if self._active.is_set():
                raise BridgeError('PAUSE_FIRST', '请先暂停回复再修改绑定')
            account = self._resolve_account(accountId)
            db = self._database(account)
            if targets is None:
                specs = [{'chatId': chatId, 'type': 'group' if '@chatroom' in chatId else 'private'}]
            elif not isinstance(targets, list) or len(targets) > 30:
                raise BridgeError('INVALID_TARGETS', '请选择最多30个允许会话')
            else:
                # An explicit selection is authoritative. The old primary must
                # not silently rejoin after its checkbox was cleared.
                specs = list(targets)
            bound = {}
            for spec in specs:
                if not isinstance(spec, dict) or spec.get('type') not in ('private', 'group') or not isinstance(spec.get('chatId'), str) or not spec['chatId']:
                    raise BridgeError('INVALID_TARGETS', '会话配置需要真实chatId与private或group类型')
                aliases = spec.get('aliases') or []
                if not isinstance(aliases, list) or len(aliases) > 20 or any(not isinstance(x, str) or len(x) > 80 for x in aliases):
                    raise BridgeError('INVALID_ALIASES', '会话称呼配置无效')
                requested = spec['chatId']
                if spec['type'] == 'group':
                    hits = [x for x in self._group_metadata(db, requested) if requested in (x['id'], x['name'])]
                    if len(hits) != 1:
                        raise BridgeError('SELECT_GROUP', '群名不存在或有重名，请从列表选择唯一群聊')
                    target = hits[0]
                    members = self._group_members(db, target['id'], fresh=True)
                    own = next((x for x in members if x.get('username') == account['id']), None)
                    if own is None:
                        raise BridgeError('NOT_GROUP_MEMBER', '无法确认小号仍是该群成员，未添加监听')
                    actual_aliases = list(dict.fromkeys(x for x in (own.get('room_name'), own.get('nick_name'), account['name']) if x))
                    bound[target['id']] = {**target, 'selfAliases': actual_aliases,
                                           'aliases': list(dict.fromkeys(actual_aliases + [x.strip() for x in aliases if x.strip()]))}
                else:
                    found = db.search_contact(requested)
                    hits = [x for x in found if requested in (x['username'], x.get('remark'), x.get('nick_name'))]
                    if len(hits) != 1 or hits[0]['username'] == account['id'] or '@chatroom' in hits[0]['username']:
                        raise BridgeError('SELECT_CONTACT', '请绑定唯一的私聊联系人，昵称有歧义时选择列表里的联系人')
                    contact = hits[0]
                    bound[contact['username']] = {'id': contact['username'], 'chatId': contact['username'], 'type': 'private',
                                                  'name': contact.get('remark') or contact.get('nick_name') or contact['username'],
                                                  'aliases': list(dict.fromkeys([account['name']] + [x.strip() for x in aliases if x.strip()]))}
            if not bound:
                raise BridgeError('SELECT_TARGET', '请至少选择一个允许会话')
            self._account = account
            self._targets = bound
            self._chat = bound.get(chatId) or next((x for x in bound.values() if x['type'] == 'private'), next(iter(bound.values())))
            self.error = ''
            return self.status()

    def start(self, **_):
        with self._lock:
            if self._active.is_set():
                return self.status()
            if not self._account or not self._chat:
                raise BridgeError('BIND_FIRST', '请先绑定微信小号与回复对象')
            _, _, _, dbmod = self._modules()
            db = self._database(self._account)
            # Fresh baseline every explicit start: never replay old chat history.
            baselines = {}
            for chat_id in self._target_map():
                latest = db.get_messages(chat_id, limit=1)
                baselines[chat_id] = latest[0]['sort_seq'] if latest else 0
            listener = dbmod.Listener(db, interval=0.5, watermark=baselines, watermark_file='')
            for chat_id in baselines:
                listener.add_listener(chat_id, lambda row, source, chat=chat_id: self._on_message({**row, 'username': chat}, source))
            self._listener = listener
            self._active.set()
            listener.start()
            emit({'event': 'status', 'data': self.status()})
            return self.status()

    def stop(self, **_):
        self._active.clear()
        with self._batch_lock:
            self._send_generation += 1
        listener = self._listener
        self._listener = None
        if listener:
            listener.stop()
        emit({'event': 'status', 'data': self.status()})
        return self.status()

    def _image_payload(self, chat_id, row, account=None, db=None, check=None):
        """Decode only this selected incoming image, without opening any UI."""
        account = dict(account if account is not None else self._account or {})
        if not account.get('id') or check is not None and not check():
            return {'images': []}
        # Account selection can change while cfg/media extraction is blocked.
        # Work only from the callback's captured account and database, never
        # mutable self._account belonging to a newer listener.
        if db is None:
            db = self._database(account)
        if check is not None and not check():
            return {'images': []}
        account_id, pid = account['id'], account.get('pid')
        cache_key = (account_id, pid)
        for old_key, old in list(self._media_cfg_checked.items()):
            if old_key != cache_key and old_key[0] == account_id and old['db'] is db:
                # A reused AccountDB must not carry image parameters across a
                # WeChat process replacement, even when the wxid is unchanged.
                db.cfg_dword = None
                del self._media_cfg_checked[old_key]
        now = time.monotonic()
        previous = self._media_cfg_checked.get(cache_key)
        cfg = getattr(db, 'cfg_dword', None)
        valid_cfg = isinstance(cfg, int) and not isinstance(cfg, bool) and 0 < cfg <= 0xFFFFFFFF
        probe_due = (previous is None or previous['db'] is not db
                     or now - previous['attemptedAt'] >= MEDIA_CFG_RETRY_SECONDS)
        if not valid_cfg and probe_due:
            self._media_cfg_checked[cache_key] = {'db': db, 'attemptedAt': now}
            # The account DB's cached SQL keys may bypass upstream cfg setup.
            # Read this one proven PID only. An unavailable first probe can be
            # retried by a later image after the cooldown, never by broad key
            # scans; returned master material is not retained in files/logs.
            if isinstance(pid, int) and not isinstance(pid, bool):
                try:
                    fresh = self._detect().get(account_id)
                    if check is not None and not check():
                        return {'images': []}
                    if fresh and fresh['pid'] == pid and fresh['hwnd'] == account.get('hwnd'):
                        _, _, _, dbmod = self._modules()
                        value = dbmod.extract_master_key_from_cfg(pid)
                        if check is not None and not check():
                            return {'images': []}
                        if value and len(value) == 3 and value[2] == account_id and isinstance(value[1], int) and not isinstance(value[1], bool) and 0 < value[1] <= 0xFFFFFFFF:
                            db.cfg_dword = value[1]
                except Exception:
                    pass
        elif valid_cfg and (previous is None or previous['db'] is not db):
            self._media_cfg_checked[cache_key] = {'db': db, 'attemptedAt': now}
        if check is not None and not check():
            return {'images': []}
        module = sys.modules.get('koko_wechat_vision')
        if module is None:
            spec = importlib.util.spec_from_file_location('koko_wechat_vision', Path(__file__).with_name('vision.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            sys.modules[spec.name] = module
        started = time.monotonic()
        for attempt in range(len(IMAGE_READ_RETRY_DELAYS) + 1):
            if attempt and time.monotonic() - started >= IMAGE_READ_RETRY_SECONDS:
                return result
            if check is not None and not check():
                return {'images': []}
            result = module.receive_image(db, chat_id, row, self.state / 'vision-images', account_id=account_id)
            if check is not None and not check():
                return {'images': []}
            if (result.get('images') or result.get('attachmentRetryable') is not True
                    or attempt == len(IMAGE_READ_RETRY_DELAYS)):
                return result
            # Only the helper's explicit transient classification is retried.
            # Never reinterpret human wording, retry a usable thumbnail, or
            # repeat an expensive unsupported-format/conversion failure.
            remaining = IMAGE_READ_RETRY_SECONDS - (time.monotonic() - started)
            if remaining <= 0:
                return result
            if not self._wait_image_retry(min(IMAGE_READ_RETRY_DELAYS[attempt], remaining), check):
                return {'images': []}
        return result

    def _wait_image_retry(self, seconds, check):
        """Short bounded cache wait; a stopped/replaced listener wins promptly."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if check is not None and not check():
                return False
            time.sleep(min(0.05, max(0, deadline-time.monotonic())))
        return check is None or check()

    def _on_message(self, row, _listener=None):
        if not self._active.is_set() or not self._account or not self._chat:
            return
        if _listener is not None and _listener is not self._listener:
            return
        account_ref, targets_ref, chat_ref = self._account, self._targets, self._chat
        listener_ref, generation = self._listener, self._send_generation
        account = dict(account_ref)
        def current():
            return (self._active.is_set() and self._send_generation == generation
                    and self._listener is listener_ref and self._account is account_ref
                    and self._targets is targets_ref and self._chat is chat_ref
                    and all(account_ref.get(key) == account.get(key) for key in ('id', 'pid', 'hwnd')))
        image_message = row.get('type') == '图片' or (isinstance(row.get('local_type'), int) and row['local_type'] & 0xFFFF == 3)
        if row.get('type') != '文本' and not image_message:
            return
        targets = self._target_map()
        chat_id = row.get('username') or row.get('chatId')
        if not chat_id and len(targets) == 1:
            # Compatibility for old private listener/test payloads only.
            only = next(iter(targets.values()))
            if only['type'] == 'private':
                chat_id = only['id']
        target = targets.get(chat_id)
        if not target:
            return
        sender = row.get('sender_username') or ''
        if not sender:
            return
        if target['type'] == 'private' and sender not in (target['id'], account['id']):
            return
        # Image XML is transport metadata; never send it as conversational text.
        text = '[图片]' if image_message else str(row.get('content') or '')[:12000]
        sender_name = account['name'] if sender == account['id'] else target['name']
        extras = {'atMe': False, 'mentionedIds': [], 'mentionBasis': 'none', 'hasOtherMention': False,
                  'selfAliases': [account['name']]}
        db = None
        if target['type'] == 'group':
            db = self._database(account)
            if not current():
                return
            members = self._group_members(db, chat_id)
            sender_row = next((x for x in members if x.get('username') == sender), None)
            sender_name = ((sender_row or {}).get('room_name') or (sender_row or {}).get('nick_name') or sender)
            actual_aliases = target.get('selfAliases') or [account['name']]
            prefix = sender + ':\n'
            if text.startswith(prefix):
                text = text[len(prefix):]
            source = row.get('source')
            if source is None and row.get('local_id') is not None and row.get('shard'):
                try:
                    raw = db.get_message_row(chat_id, row['local_id'], shard=row['shard'])
                    source = (raw or {}).get('source')
                except Exception:
                    source = None
            extras = {**mention_evidence(source, text, account['id'], actual_aliases),
                      'selfAliases': actual_aliases}
        if not current():
            return
        data = {'id': message_id(chat_id, row), 'accountId': account['id'],
                'chatId': chat_id, 'chatType': target['type'], 'senderId': sender, 'chatName': target['name'],
                'senderName': sender_name, 'text': text, 'isSelf': sender == account['id'],
                'receivedAt': now_ms(), 'createdAt': int(float(row.get('create_time') or 0)*1000)}
        if image_message and sender != account['id']:
            try:
                data.update(self._image_payload(chat_id, row, account=account, db=db, check=current))
            except Exception:
                data.update(images=[], attachmentError='这张图片暂时没有从微信本地缓存读取成功，请重新发送原图')
        if not current():
            return
        emit({'event': 'message', 'data': {**data, **extras}})

    def _check_job(self, job):
        if job.get('_batchId') and self._batch_cancelled(job['_batchId'], job.get('_batchGeneration')):
            raise BridgeError('CANCELLED', '这组消息已停止，剩余内容未发送')
        if not self._active.is_set():
            raise BridgeError('PAUSED', '自动回复已暂停')
        if not self._account or job.get('accountId') != self._account['id'] or job.get('chatId') not in self._target_map():
            raise BridgeError('TARGET_MISMATCH', '发送目标与已绑定账号不一致')
        if not job.get('id') or not isinstance(job.get('text'), str) or not job['text'].strip() or len(job['text']) > 5000:
            raise BridgeError('INVALID_MESSAGE', '发送内容无效或过长')
        if not isinstance(job.get('expiresAt'), (int, float)) or job['expiresAt'] <= now_ms():
            raise BridgeError('EXPIRED', '这条回复已过期，未执行发送')
        if job.get('sendMode', 'background') not in ('background', 'foreground') or job.get('textEncoding', 'auto') not in ('auto', 'utf16', 'gbk'):
            raise BridgeError('INVALID_SEND_MODE', '发送模式或文字编码无效')

    def _batch_cancelled(self, ident, generation):
        with self._batch_lock:
            return ident in self._batch_cancels or generation != self._send_generation

    def cancel_send(self, id='', **_):
        """Stops a queued/in-progress batch without pausing other conversations."""
        if not isinstance(id, str) or not id or len(id) > 4096:
            raise BridgeError('INVALID_BATCH', '要停止的消息批次无效')
        with self._batch_lock:
            self._batch_cancels[id] = now_ms()
            while len(self._batch_cancels) > 2000:
                self._batch_cancels.pop(next(iter(self._batch_cancels)))
        return {'id': id, 'cancelled': True}

    def _wait_batch_gap(self, job, generation, gui, foreground, gap_ms):
        deadline = time.monotonic() + gap_ms / 1000
        while time.monotonic() < deadline:
            if self._batch_cancelled(job['id'], generation) or not self._active.is_set():
                return 'CANCELLED'
            if now_ms() >= job['expiresAt']:
                return 'EXPIRED'
            if gui is not None and gui.GetForegroundWindow() != foreground:
                return 'USER_TAKEOVER'
            time.sleep(min(.05, max(0, deadline-time.monotonic())))
        return None

    def send_batch(self, job=None, **params):
        """A bounded sequence of independently confirmed, non-retried sends.

        Open one verified UI session for every bubble, then restore once.
        Each bubble still reserves its own ledger entry and receives an
        independent acknowledgement before the next bubble can be sent.
        """
        job = job or params
        if not isinstance(job, dict):
            raise BridgeError('INVALID_BATCH', '消息批次格式无效')
        ident, messages = job.get('id'), job.get('messages')
        if not isinstance(ident, str) or not ident or len(ident) > 4096:
            raise BridgeError('INVALID_BATCH', '消息批次标识无效')
        if not isinstance(messages, list) or not 1 <= len(messages) <= 4 or any(
            not isinstance(text, str) or not text.strip() or len(text) > 2400 for text in messages
        ) or sum(map(len, messages)) > 5000:
            raise BridgeError('INVALID_BATCH', '每组需要1—4条非空文字，总长度不超过5000字')
        gap_ms = job.get('gapMs', 250)
        if not isinstance(gap_ms, int) or isinstance(gap_ms, bool) or not 150 <= gap_ms <= 900:
            raise BridgeError('INVALID_BATCH', '分条消息间隔应为150—900毫秒')
        # Hash namespacing prevents overlap with normal message event IDs.
        ledger_id = 'batch:' + hashlib.sha256(ident.encode('utf-8')).hexdigest()
        part_ids = [ledger_id + ':part:' + str(index+1) for index in range(len(messages))]
        hashes = [hashlib.sha256(text.encode('utf-8')).hexdigest() for text in messages]
        with self._batch_lock:
            generation = job.get('_queuedGeneration', self._send_generation)
        if not isinstance(generation, int) or isinstance(generation, bool):
            raise BridgeError('INVALID_BATCH', '消息批次状态无效')

        def response(entry):
            parts = []
            for index, part_id in enumerate(part_ids):
                part = self._ledger.get(part_id)
                if part:
                    parts.append({**part, 'index': index, 'text': messages[index]})
            return {**entry, 'id': ident, 'parts': parts,
                    'confirmed': entry.get('status') == 'confirmed'}

        with self._lock:
            existing = self._ledger.get(ledger_id)
            if existing:
                if existing.get('accountId') != job.get('accountId') or existing.get('chatId') != job.get('chatId') or existing.get('textHashes') != hashes:
                    raise BridgeError('BATCH_MISMATCH', '此消息批次的内容或目标已变化，未重新发送')
                if existing.get('status') == 'preparing':
                    # With _lock held, this can only be an interrupted older
                    # invocation, never an active concurrent batch. Do not
                    # resume an unknown remainder after an RPC/storage error.
                    existing.update(status='cancelled', cancelled=True,
                                    message='上次分条发送未完成，剩余消息未自动继续', finishedAt=now_ms())
                    self._persist()
                return response(existing)
            if self._batch_cancelled(ident, generation) or not self._active.is_set():
                return {'id': ident, 'status': 'cancelled', 'cancelled': True, 'parts': [], 'confirmed': False,
                        'message': '这组消息已停止，剩余内容未发送'}
            # Reuse account/target/deadline validation before any Windows work.
            self._check_job({**job, 'text': messages[0]})
            entry = {'kind': 'batch', 'id': ledger_id, 'accountId': job['accountId'], 'chatId': job['chatId'],
                     'status': 'preparing', 'createdAt': now_ms(), 'textHashes': hashes, 'partIds': part_ids}
            self._ledger[ledger_id] = entry
            self._persist()
            index = 0
            first_job = {**job, 'id': part_ids[0], 'text': messages[0], '_batchId': ident,
                         '_batchGeneration': generation}
            try:
                self._check_pending_send(first_job)
                with self._send_session(first_job) as session:
                    for index, text in enumerate(messages):
                        is_background = session.get('mode') == 'background'
                        reason = self._wait_batch_gap(job, generation, None if is_background else session['gui'], session['hwnd'], gap_ms if index else 0)
                        if self._batch_cancelled(ident, generation) or not self._active.is_set():
                            reason = 'CANCELLED'
                        if not is_background and session['gui'].GetForegroundWindow() != session['hwnd']:
                            reason = 'USER_TAKEOVER'
                        if reason:
                            entry.update(status='cancelled', cancelled=True, code=reason,
                                         message='这组消息已停止，剩余内容未发送', finishedAt=now_ms())
                            break
                        part_job = {**job, 'id': part_ids[index], 'text': text, '_batchId': ident,
                                    '_batchGeneration': generation}
                        part_job.pop('messages', None)
                        part = self._send_in_session(part_job, session)
                        if part.get('status') != 'confirmed':
                            cancelled = part.get('code') in ('CANCELLED', 'USER_TAKEOVER') or self._batch_cancelled(ident, generation)
                            entry.update(status='cancelled' if cancelled else ('partial' if index else part.get('status', 'unconfirmed')),
                                         cancelled=cancelled, code=part.get('code'), message=part.get('message', '分条发送未完成'), finishedAt=now_ms())
                            break
                    else:
                        entry.update(status='confirmed', cancelled=False, message='本组消息均已逐条核对发送', finishedAt=now_ms())
                if session.get('userTakeover'):
                    entry['userTakeover'] = True
            except Exception as error:
                # Session setup and unexpected errors do not re-enter a send
                # path. Already reserved parts remain uncertain, never retried.
                code = error.code if isinstance(error, BridgeError) else 'UI_ERROR'
                cancelled = code in ('CANCELLED', 'USER_TAKEOVER') or self._batch_cancelled(ident, generation)
                if part_ids[index] not in self._ledger:
                    self._ledger[part_ids[index]] = {
                        'id': part_ids[index], 'accountId': job['accountId'], 'chatId': job['chatId'],
                        'status': 'blocked', 'code': code,
                        'message': str(error) if isinstance(error, BridgeError) else '微信操作未完成，未按发送',
                        'finishedAt': now_ms()}
                    if getattr(error,'accessibility_diagnostic',None):self._ledger[part_ids[index]]['accessibilityDiagnostic']=error.accessibility_diagnostic
                entry.update(status='cancelled' if cancelled else ('partial' if index else 'blocked'),
                             cancelled=cancelled, code=code, message=self._ledger[part_ids[index]].get('message', '分条发送未完成'), finishedAt=now_ms())
            self._persist()
            return response(entry)

    def _verify_private_target(self, db, target):
        # The interface opens a display title, so a unique ID in the selection
        # alone is insufficient if two contacts/groups share that title.
        matches = [row for row in db.search_contact(target['id']) if row.get('username') == target['id']]
        if len(matches) != 1:
            raise BridgeError('PRIVATE_CHANGED', '所选联系人资料已变化，请重新读取会话目录')
        row = matches[0]
        title = row.get('remark') or row.get('nick_name') or row['username']
        if title != target['name']:
            raise BridgeError('PRIVATE_CHANGED', '联系人昵称或备注已变化，未通过目标核验')
        collisions = [row for row in db.search_contact(title) if row.get('username') != target['id'] and
                      (row.get('remark') or row.get('nick_name') or row.get('username')) == title]
        groups = [row for row in self._group_metadata(db, title) if row['name'] == title]
        if collisions or groups:
            raise BridgeError('AMBIGUOUS_PRIVATE', '存在同名联系人或群，请先设置不同的微信备注，未执行发送')

    def send(self, job=None, **params):
        job = job or params
        self._check_job(job)
        self._phase('send-check', job)
        with self._lock:
            self._check_job(job)
            if job['id'] in self._ledger:
                return self._ledger[job['id']]
            self._check_pending_send(job)
            session = None
            try:
                with self._send_session(job) as session:
                    entry = self._send_in_session(job, session)
                if session.get('userTakeover'):
                    entry['userTakeover'] = True
                self._ledger[job['id']] = entry
                self._persist()
                return entry
            except Exception as error:
                # Setup failed before _send_in_session could reserve/attempt
                # anything. Return durable proof of no send, not an ambiguous
                # RPC exception which the controller cannot safely retry past.
                if job['id'] in self._ledger:
                    return self._ledger[job['id']]
                entry = {'id':job['id'], 'accountId':job['accountId'], 'chatId':job['chatId'],
                         'status':'blocked', 'notSent':True, 'code':getattr(error,'code','UI_ERROR'),
                         'message':str(error) if getattr(error,'code',None) else '微信准备未完成，本次未输入或发送', 'finishedAt':now_ms()}
                if getattr(error,'accessibility_diagnostic',None):entry['accessibilityDiagnostic']=error.accessibility_diagnostic
                self._ledger[job['id']] = entry
                self._persist()
                return entry

    def _check_pending_send(self, job):
        for entry in list(self._ledger.values()):
            if entry.get('kind') == 'batch' or entry.get('reviewed'):
                continue
            if entry.get('accountId') == job['accountId'] and entry.get('chatId') == job['chatId'] and entry.get('status') in ('sending', 'unconfirmed'):
                if self._reconcile_pending(entry):
                    continue
                raise BridgeError('NEEDS_REVIEW', '此会话上一条发送结果不明，请先人工核对')

    def _pending_text(self, entry):
        if isinstance(entry.get('text'), str) and entry['text']:
            return entry['text']
        # Some releases kept texts only in parent batch delivery snapshots.
        ident = entry.get('id', '')
        parent_id, sep, index = ident.rpartition(':part:')
        parent = self._ledger.get(parent_id, {}) if sep else {}
        parts = parent.get('parts') or []
        for part in parts if isinstance(parts, list) else []:
            if isinstance(part, dict) and part.get('id') == ident and isinstance(part.get('text'), str):
                return part['text']
        if sep and index.isdigit() and isinstance(parent.get('messages'), list):
            position = int(index)-1
            if 0 <= position < len(parent['messages']) and isinstance(parent['messages'][position], str):
                return parent['messages'][position]
        return ''

    def _reconcile_pending(self, entry):
        """Read-only proof may clear uncertainty; it never invokes the UI."""
        if not self._account or entry.get('accountId') != self._account['id'] or entry.get('chatId') not in self._target_map():
            return False
        text = self._pending_text(entry)
        sent_at = entry.get('sentAt')
        before = entry.get('beforeIds')
        # A stable pre-send ID baseline is required for automatic resolution.
        # Legacy records without it stay available for explicit human review.
        if not text or not isinstance(sent_at, (int, float)) or not isinstance(before, list):
            return False
        if len(text) > 5000 or len(before) > 100 or any(not isinstance(value, str) for value in before):
            return False
        try:
            db = self._database(self._account)
            rows = db.get_messages(entry['chatId'], limit=100)
            candidates = [row for row in rows
                          if float(row.get('create_time') or 0)*1000 <= sent_at+10000]
            row = confirm_sent(candidates, set(before), entry['accountId'], entry['chatId'], text, sent_at)
            if row is None:
                return False
            entry.update(status='confirmed', reconciled=True, message='已只读核对到原发送记录，未重新发送',
                         messageId=message_id(entry['chatId'], row), finishedAt=now_ms())
            self._persist()
            return True
        except Exception:
            return False

    def pending_sends(self, accountId='', chatId='', reconcile=True, **_):
        if not self._account or accountId and accountId != self._account['id']:
            raise BridgeError('TARGET_MISMATCH', '请先绑定正确的微信小号')
        targets = self._target_map()
        if chatId and chatId not in targets:
            raise BridgeError('TARGET_MISMATCH', '仅可核对已选择的会话')
        with self._lock:
            items = []
            for entry in list(self._ledger.values()):
                if entry.get('kind') == 'batch' or entry.get('reviewed') or entry.get('status') not in ('sending', 'unconfirmed'):
                    continue
                if entry.get('accountId') != self._account['id'] or entry.get('chatId') not in targets or chatId and entry['chatId'] != chatId:
                    continue
                if reconcile is True and self._reconcile_pending(entry):
                    continue
                items.append({key:entry.get(key) for key in ('id','accountId','chatId','status','createdAt','sentAt','message')})
                items[-1].update(text=self._pending_text(entry), chatName=targets[entry['chatId']]['name'])
            return {'items':items, 'count':len(items), 'pausedRequired':True}

    def review_send(self, id='', accountId='', chatId='', action='acknowledge', **_):
        if self._active.is_set():
            raise BridgeError('PAUSE_REQUIRED', '请先暂停自动回复，再确认待核对记录')
        if action != 'acknowledge':
            raise BridgeError('INVALID_REVIEW', '仅支持人工核对后跳过旧回复，不会重发')
        with self._lock:
            entry = self._ledger.get(id)
            if not self._account or not entry or entry.get('kind') == 'batch' or accountId != self._account['id'] or entry.get('accountId') != accountId or entry.get('chatId') != chatId or chatId not in self._target_map():
                raise BridgeError('TARGET_MISMATCH', '待核对记录与已绑定账号或会话不一致')
            if entry.get('status') not in ('sending', 'unconfirmed'):
                raise BridgeError('INVALID_REVIEW', '这条记录已经有确定结果，无需跳过')
            entry.update(reviewed=True, reviewedAt=now_ms(), reviewAction='acknowledge',
                         message='已由用户确认跳过这条旧回复，保留原发送不明记录，不会重发')
            self._persist()
            return {'id':id,'accountId':accountId,'chatId':chatId,'status':entry['status'],'reviewed':True,'resent':False}

    @contextlib.contextmanager
    def _send_session(self, job):
        if job.get('sendMode', 'background') == 'background':
            try:
                with self._background_session(job) as session:
                    yield session
            except Exception as error:
                if isinstance(error, BridgeError):
                    raise
                if getattr(error, 'code', None):
                    translated=BridgeError(error.code,str(error))
                    translated.accessibility_diagnostic=getattr(error,'accessibility_diagnostic',None)
                    raise translated from None
                raise BridgeError('BG_UNAVAILABLE', '后台输入通道不可用，未切换前台；请查看微信或选择前台兼容') from None
        else:
            with self._foreground_session(job) as session:
                yield session

    @contextlib.contextmanager
    def _background_session(self, job):
        import background
        import uiautomation as automation
        automation.InitializeUIAutomationInCurrentThread()
        session = None
        try:
            self._check_job(job)
            self._phase('background-account-check', job)
            fresh = self._detect().get(job['accountId'])
            if not fresh or fresh['pid'] != self._account['pid'] or fresh['hwnd'] != self._account['hwnd']:
                raise BridgeError('ACCOUNT_CHANGED', '微信账号窗口已变化，请重新绑定')
            target = self._target_map()[job['chatId']]
            db = self._database(self._account)
            if target['type'] == 'group':
                members = self._group_members(db, target['id'], fresh=True)
                if not any(row.get('username') == job['accountId'] for row in members):
                    raise BridgeError('NOT_GROUP_MEMBER', '小号已不在这个群或成员状态不可核验，未发送')
                matches = [row for row in self._group_metadata(db, target['name']) if row['name'] == target['name']]
                if len(matches) != 1 or matches[0]['id'] != target['id']:
                    raise BridgeError('AMBIGUOUS_GROUP', '群名已变化或存在重名，后台未执行发送')
                if any(row.get('username') != target['id'] and (row.get('remark') or row.get('nick_name') or row.get('username')) == target['name'] for row in db.search_contact(target['name'])):
                    raise BridgeError('AMBIGUOUS_GROUP', '存在与该群同名的联系人，后台未执行发送')
            else:
                self._verify_private_target(db, target)
            self._phase('background-prepare', job)
            for attempt in range(2):
                channel = background.BackgroundSession(background.NativeDesktop(), fresh['hwnd'], fresh['pid'], target['name'],
                    check=lambda: self._check_job(job), encoding=job.get('textEncoding', 'auto'), cache=self._background_encoding_cache)
                session = {'mode': 'background', 'background': channel, 'target': target, 'db': db, 'hwnd': fresh['hwnd'], 'seen': set()}
                try:
                    channel.prepare()
                    break
                except Exception as error:
                    # Only this pre-input accessibility error gets one fresh
                    # subscription. Never retry typing, a click or any send.
                    if getattr(error, 'code', None) != 'BG_ACCESSIBILITY' or attempt:
                        raise
                    channel.close()
                    self._check_job(job)
                    self._phase('background-preflight-retry', job)
                    time.sleep(.25)
            yield session
        finally:
            if session is not None:
                try:
                    session['background'].close()
                except Exception:
                    self._phase('background-cleanup-failed', job)
            automation.UninitializeUIAutomationInCurrentThread()

    @contextlib.contextmanager
    def _foreground_session(self, job):
        """A single account-bound foreground visit; caller owns _lock."""
        target = self._target_map()[job['chatId']]
        self._phase('import-modules', job)
        _, gui, _, _ = self._modules()
        self._phase('import-uia-driver', job)
        from wechatauto.uia_driver import WeChatUIA
        self._phase('import-automation', job)
        import uiautomation as automation
        self._phase('initialize-automation', job)
        automation.InitializeUIAutomationInCurrentThread()
        session = None
        try:
            self._check_job(job)
            # Fresh proof that hwnd's process still holds the same account files.
            self._phase('account-window-check', job)
            fresh = self._detect().get(job['accountId'])
            if not fresh or fresh['pid'] != self._account['pid'] or fresh['hwnd'] != self._account['hwnd']:
                raise BridgeError('ACCOUNT_CHANGED', '微信账号窗口已变化，请重新绑定')
            hwnd = fresh['hwnd']
            foreground = gui.GetForegroundWindow()
            placement = gui.GetWindowPlacement(hwnd)
            db = self._database(self._account)
            if target['type'] == 'group':
                members = self._group_members(db, target['id'], fresh=True)
                if not any(x.get('username') == self._account['id'] for x in members):
                    raise BridgeError('NOT_GROUP_MEMBER', '小号已不在这个群或成员状态不可核验，未发送')
                matching_groups = [x for x in self._group_metadata(db, target['name']) if x['name'] == target['name']]
                if len(matching_groups) != 1 or matching_groups[0]['id'] != target['id']:
                    raise BridgeError('AMBIGUOUS_GROUP', '群名已变化或存在重名，未通过界面目标核验')
                same_title_contacts = [x for x in db.search_contact(target['name'])
                                       if x.get('username') != target['id'] and
                                       (x.get('remark') or x.get('nick_name') or x.get('username')) == target['name']]
                if same_title_contacts:
                    raise BridgeError('AMBIGUOUS_GROUP', '存在与该群同名的其他联系人，未执行界面发送')
            else:
                self._verify_private_target(db, target)
            self._phase('driver-initialize', job)
            driver = WeChatUIA(timeout=3, search_timeout=0.4, hwnd=hwnd)
            # No unexpected clipboard fallback; ValuePattern input is required.
            def no_clipboard(_text):
                raise BridgeError('CLIPBOARD_REQUIRED', '当前输入控件需要剪贴板通道，先暂停以保护剪贴板')
            driver._clip_set = no_clipboard
            session = {'driver': driver, 'gui': gui, 'hwnd': hwnd, 'db': db, 'target': target,
                       'foreground': foreground, 'placement': placement, 'opened': False,
                       'draftText': None, 'edit': None, 'seen': set()}
            self._phase('ensure-window', job)
            if not driver.ensure_window():
                raise BridgeError('WINDOW_UNAVAILABLE', '微信界面不可用，请解锁桌面并打开小号窗口')
            # open_chat calls ensure_window again upstream. Keep that check,
            # but never reactivate or add another activation delay after the
            # initial foreground handoff; a user's focus change must win.
            def retain_foreground(_window):
                self._check_job(job)
                if gui.GetForegroundWindow() != hwnd:
                    raise BridgeError('USER_TAKEOVER', '你切换了窗口，剩余消息未继续发送')
            driver._activate = retain_foreground
            self._phase('check-draft', job)
            current = driver._chat_input()
            if current is not None:
                value = driver._read_edit_value(current)
                if value is None or value.strip():
                    raise BridgeError('HUMAN_DRAFT', '微信当前输入框有草稿或不可核对，未修改')
            self._check_job(job)
            if gui.GetForegroundWindow() != hwnd:
                raise BridgeError('USER_TAKEOVER', '你切换了窗口，这组回复暂未发送')
            self._phase('open-chat', job)
            if driver.current_chat() != target['name'] and not driver.open_chat(target['name'], retries=1):
                raise BridgeError('CHAT_UNAVAILABLE', '无法核对目标聊天窗口，未发送')
            if driver.current_chat() != target['name']:
                raise BridgeError('CHAT_UNAVAILABLE', '无法核对目标聊天窗口，未发送')
            session['opened'] = True
            self._check_send_session(job, session)
            yield session
        finally:
            if session is not None:
                self._phase('restore-window', job)
                # Restore only while we still own foreground; user takeover wins.
                try:
                    if gui.GetForegroundWindow() != hwnd or (session['opened'] and driver.current_chat() != target['name']):
                        session['userTakeover'] = True
                    if gui.GetForegroundWindow() == hwnd:
                        edit, draft = session['edit'], session['draftText']
                        if draft is not None and edit is not None and driver.current_chat() == target['name']:
                            if edit_text_equal(driver._read_edit_value(edit), draft):
                                driver._set_text(edit, '')
                        if not session.get('userTakeover'):
                            restore_window(gui, hwnd, placement, foreground)
                except Exception:
                    pass
            automation.UninitializeUIAutomationInCurrentThread()

    def _check_send_session(self, job, session):
        self._check_job(job)
        if session.get('mode') == 'background':
            try:
                session['background'].check()
            except Exception as error:
                if getattr(error, 'code', None):
                    raise BridgeError(error.code, str(error)) from None
                raise
            return
        if session['gui'].GetForegroundWindow() != session['hwnd'] or session['driver'].current_chat() != session['target']['name']:
            raise BridgeError('USER_TAKEOVER', '微信焦点或聊天已变化，剩余消息未发送')

    def _send_in_session(self, job, session):
        """Send exactly one bubble without activating/opening/restoring a UI."""
        if job['id'] in self._ledger:
            return self._ledger[job['id']]
        if session.get('mode') == 'background':
            return self._send_background_in_session(job, session)
        driver, db = session['driver'], session['db']
        attempted = False
        entry = {'id': job['id'], 'accountId': job['accountId'], 'chatId': job['chatId'],
                 'status': 'preparing', 'createdAt': now_ms()}
        try:
            self._check_send_session(job, session)
            edit = driver._chat_input()
            if edit is None:
                raise BridgeError('INPUT_UNAVAILABLE', '无法定位微信输入框')
            value = driver._read_edit_value(edit)
            if value is None or value.strip():
                raise BridgeError('HUMAN_DRAFT', '目标输入框有人工草稿或不可核对，未发送')
            session['edit'] = edit
            self._phase('message-baseline', job)
            before = session['seen'] | {message_id(job['chatId'], row) for row in db.get_messages(job['chatId'], limit=10)}
            self._check_send_session(job, session)
            self._phase('input-text', job)
            driver._click_ctrl(edit)
            self._check_send_session(job, session)
            session['draftText'] = job['text']
            if not driver._set_text(edit, job['text']):
                raise BridgeError('INPUT_UNSUPPORTED', '当前微信不支持直接文字输入，未发送')
            if not wait_for_edit(driver, job['text'], check=lambda: self._check_send_session(job, session)):
                raise BridgeError('INPUT_MISMATCH', '文字回读不一致，未按发送')
            edit = driver._chat_input()
            self._check_send_session(job, session)
            # Reserve durably before exactly one send action.
            sent_at = now_ms()
            entry['status'] = 'sending'
            entry.update(text=job['text'], beforeIds=sorted(before), sentAt=sent_at)
            self._ledger[job['id']] = entry
            self._persist()
            self._phase('press-send', job)
            # Disk/UIA work above can yield long enough for cancellation or a
            # human edit/focus change. Revalidate immediately before Enter,
            # while the durable reservation is still definitely unsent.
            self._check_send_session(job, session)
            edit = driver._chat_input()
            if edit is None or not edit_text_equal(driver._read_edit_value(edit), job['text']):
                raise BridgeError('INPUT_MISMATCH', '发送前文字已变化，未按发送')
            self._check_send_session(job, session)
            attempted = True
            session['draftText'] = None
            edit.SendKeys('{Enter}', waitTime=0.05)
            self._phase('confirm-message', job)
            deadline = min(job['expiresAt'], now_ms()+6500)
            while now_ms() < deadline:
                row = confirm_sent(db.get_messages(job['chatId'], limit=10), before, job['accountId'], job['chatId'], job['text'], sent_at)
                if row:
                    ident = message_id(job['chatId'], row)
                    session['seen'].add(ident)
                    entry.update(status='confirmed', message='已在本地核对新的本人发送记录',
                                 messageId=ident, finishedAt=now_ms())
                    break
                time.sleep(0.20)
            else:
                entry.update(status='unconfirmed', message='发送已尝试但结果未确认，未自动重发', finishedAt=now_ms())
        except Exception as error:
            if attempted:
                entry.update(status='unconfirmed', message='发送后中断，需要人工核对，未自动重发', finishedAt=now_ms())
            else:
                entry.update(status='blocked', message=str(error) if isinstance(error, BridgeError) else '微信操作未完成，未按发送',
                             code=error.code if isinstance(error, BridgeError) else 'UI_ERROR', finishedAt=now_ms())
        self._ledger[job['id']] = entry
        self._persist()
        self._phase(entry['status'], job)
        return entry

    def _send_background_in_session(self, job, session):
        entry = {'id': job['id'], 'accountId': job['accountId'], 'chatId': job['chatId'],
                 'status': 'preparing', 'transport': 'background', 'createdAt': now_ms()}
        attempted = False
        try:
            channel, db = session['background'], session['db']
            self._check_send_session(job, session)
            before = session['seen'] | {message_id(job['chatId'], row) for row in db.get_messages(job['chatId'], limit=10)}
            self._phase('background-input', job)
            mode = channel.input(job['text'])
            def reserve():
                self._check_send_session(job, session)
                fresh = self._detect().get(job['accountId'])
                if not fresh or fresh['pid'] != self._account['pid'] or fresh['hwnd'] != session['hwnd']:
                    raise BridgeError('ACCOUNT_CHANGED', '发送前账号窗口已变化，未点击发送')
                entry.update(status='sending', text=job['text'], beforeIds=sorted(before), sentAt=now_ms(), encoding=mode)
                self._ledger[job['id']] = entry
                self._persist()
                self._phase('background-submit', job)
                self._check_send_session(job, session)
            def attempting():
                nonlocal attempted
                attempted = True
            channel.submit(job['text'], reserve, attempting)
            self._phase('confirm-message', job)
            deadline = min(job['expiresAt'], now_ms()+6500)
            while now_ms() < deadline:
                row = confirm_sent(db.get_messages(job['chatId'], limit=10), before, job['accountId'], job['chatId'], job['text'], entry['sentAt'])
                if row:
                    ident = message_id(job['chatId'], row); session['seen'].add(ident)
                    entry.update(status='confirmed', message='已后台发送并核对新的本人发送记录', messageId=ident, finishedAt=now_ms())
                    break
                time.sleep(.20)
            else:
                entry.update(status='unconfirmed', message='后台发送已尝试但本机记录未确认，未重发或转前台', finishedAt=now_ms())
        except Exception as error:
            if attempted:
                entry.update(status='unconfirmed', message='后台发送后中断，需人工核对，未重发或转前台', finishedAt=now_ms())
            else:
                entry.update(status='blocked', code=getattr(error, 'code', 'BG_ERROR'),
                             message=str(error) if getattr(error, 'code', None) else '后台发送未完成，未切换前台', finishedAt=now_ms())
                diagnostic=getattr(session.get('background'),'last_input_diagnostic',None)
                if diagnostic:entry['inputDiagnostic']=diagnostic
        self._ledger[job['id']] = entry
        self._persist(); self._phase(entry['status'], job)
        return entry

    def _background_probe(self):
        """Check the actual long-lived bridge client; never navigate/type/send."""
        import background
        import uiautomation as automation
        from accessibility_repair import tree_ready
        with self._lock:
            account=self._account
            if not account:raise BridgeError('ACCOUNT_REQUIRED','请先绑定微信小号')
            fresh=self._detect().get(account['id'])
            if not fresh or fresh['pid']!=account['pid'] or fresh['hwnd']!=account['hwnd']:raise BridgeError('ACCOUNT_CHANGED','微信窗口已变化，请重新绑定小号')
            automation.InitializeUIAutomationInCurrentThread()
            remove=restore_access=restore_window=None
            try:
                desktop=background.NativeDesktop();hwnd=fresh['hwnd'];foreground=desktop.foreground()
                def check():
                    if not self._account or self._account['id']!=account['id'] or not desktop.valid(hwnd,account['pid']):raise BridgeError('ACCOUNT_CHANGED','微信窗口或绑定已变化')
                check()
                if not desktop.available(hwnd):restore_window=desktop.restore_background(hwnd,account['pid'])
                if hasattr(desktop,'listen'):remove=desktop.listen(hwnd)
                def read():
                    check()
                    try:return desktop.read(hwnd)
                    except Exception:return {'nodes':0,'edit':None,'rows':[]}
                value=read();before=value.get('nodes',0)
                if not tree_ready(value):restore_access=desktop.enable_accessibility(hwnd,check);value=read()
                return {'ready':tree_ready(value),'editorFound':value.get('edit') is not None,'sessionRows':len(value.get('rows',[])),
                        'nodesBefore':before,'nodesAfter':value.get('nodes',0),'method':getattr(desktop,'last_accessibility_diagnostic',{}).get('method','already_ready'),
                        'foregroundUnchanged':foreground==desktop.foreground(),'textInputsWritten':0,'messagesSent':0}
            finally:
                try:
                    if restore_access:restore_access()
                    if remove:remove()
                    if restore_window:restore_window()
                finally:automation.UninitializeUIAutomationInCurrentThread()

    def doctor(self, ui=False, **_):
        versions = {}
        for name in ('wechatauto-replica', 'uiautomation', 'pywin32', 'psutil'):
            try:
                versions[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                versions[name] = None
        try:
            windows = self._detect()
            extra = {}
            if ui=='background' and self._account:
                extra={'controls':self._background_probe()}
            elif ui and self._account:
                self._phase('probe-import-uia')
                from wechatauto.uia_driver import WeChatUIA
                self._phase('probe-driver')
                driver = WeChatUIA(timeout=3, search_timeout=0.4, hwnd=self._account['hwnd'])
                # Upstream ensure_window activates an existing window even when
                # wake=False. A read-only connection check must not steal focus.
                driver._activate = lambda _window: None
                self._phase('probe-ensure')
                ok = driver.ensure_window(wake=False, timeout=3)
                edit = driver._chat_input() if ok else None
                extra = {'uia': ok, 'inputReadable': edit is not None and driver._read_edit_value(edit) is not None}
                self._phase('probe-complete')
            return {**self.status(), **extra, 'python': sys.executable, 'dependencies': versions,
                    'windowCount': len(windows), 'available': bool(windows),
                    'message': '已发现微信窗口，选择小号和联系人后连接' if windows else '请打开微信并登录小号'}
        except BridgeError as error:
            return {**self.status(), 'available': False, 'dependencies': versions,
                    'error': str(error), 'code': error.code}


def main():
    bridge = Bridge()
    # NumPy/OpenBLAS native initialization can deadlock when first imported by
    # a worker on Windows. Import GUI prerequisites on this process's main thread.
    os.environ['OPENBLAS_NUM_THREADS'] = '1'
    os.environ['OMP_NUM_THREADS'] = '1'
    try:
        import numpy
        from wechatauto.uia_driver import WeChatUIA
    except ImportError:
        pass
    if os.environ.get('KOKO_BRIDGE_DEBUG') == '1':
        import faulthandler
        debug = open(bridge.state / 'bridge-stack.txt', 'w', encoding='utf-8')
        faulthandler.enable(file=debug)
        faulthandler.dump_traceback_later(10, file=debug)
    operations = ThreadPoolExecutor(max_workers=1, thread_name_prefix='wechat-operation')
    def handle(request):
        ident = request.get('id')
        try:
            method = request.get('method')
            if method not in {'doctor', 'status', 'accounts', 'contacts', 'groups', 'directory', 'bind', 'start', 'stop', 'send', 'send_batch', 'cancel_send', 'pending_sends', 'review_send'}:
                raise BridgeError('METHOD_NOT_FOUND', '未知桥接操作')
            params = request.get('params') or {}
            if not isinstance(params, dict):
                raise BridgeError('INVALID_ARGUMENT', '参数格式不正确')
            if method == 'send_batch':
                # Generation was captured as soon as this RPC was read, not
                # when its queued UI operation eventually starts.
                params = dict(params)
                if isinstance(params.get('job'), dict):
                    params['job'] = {**params['job'], '_queuedGeneration': request['_queuedGeneration']}
                else:
                    params['_queuedGeneration'] = request['_queuedGeneration']
            result = getattr(bridge, method)(**params)
            emit({'id': ident, 'ok': True, 'result': result})
        except BridgeError as error:
            emit({'id': ident, 'ok': False, 'error': str(error), 'code': error.code})
        except Exception:
            emit({'id': ident, 'ok': False, 'error': '桥接操作失败，请检查微信登录和桥接权限', 'code': 'BRIDGE_ERROR'})
    try:
        for line in sys.stdin:
            if len(line) > 100000:
                continue
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    continue
            except ValueError:
                continue
            # Pause is observable even while an operation is in progress.
            if request.get('method') in ('stop', 'status', 'cancel_send'):
                handle(request)
            else:
                if request.get('method') == 'send_batch':
                    with bridge._batch_lock:
                        request['_queuedGeneration'] = bridge._send_generation
                operations.submit(handle, request)
    finally:
        bridge.stop()
        operations.shutdown(wait=False, cancel_futures=True)


if __name__ == '__main__':
    main()
