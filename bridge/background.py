"""Account-pinned, no-foreground text input. Importing does no Windows work.

Uses UIA readback plus PostMessage, as documented by Banan1cee/whale_gril.
This implementation keeps Koko's durable DB confirmation in worker.py; it
never treats an empty input as delivery proof and has no foreground fallback.
"""
from __future__ import annotations
import contextlib
import re
import time


class BackgroundError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def blank(value):
    return isinstance(value, str) and not value.strip()


def equal(actual, expected):
    return isinstance(actual, str) and actual.replace('\r\n', '\n') == expected.replace('\r\n', '\n')


def chat_matches(actual, expected):
    actual = str(actual or '').strip()
    return actual == expected or bool(re.fullmatch(re.escape(expected) + r'(?:长按鼠标\s*|按住鼠标\s*)?语音输入(?:文字)?', actual))


def units(text, mode):
    if mode == 'utf16':
        raw = text.encode('utf-16-le')  # reject unpaired surrogates
        return [int.from_bytes(raw[i:i+2], 'little') for i in range(0, len(raw), 2)]
    if mode == 'gbk':
        return list(text.encode('gbk'))  # never silently drop emoji/unsupported text
    raise BackgroundError('BG_ENCODING', '后台文字编码无效')


class NativeDesktop:
    """Lazy Windows adapter; no keyboard/clipboard/foreground APIs are exposed."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        import uiautomation as auto
        self.ctypes, self.wintypes, self.auto = ctypes, wintypes, auto
        self.u = ctypes.WinDLL('user32', use_last_error=True)
        self.u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        self.u.PostMessageW.restype = wintypes.BOOL
        self.u.GetForegroundWindow.restype = wintypes.HWND
        self.u.IsWindow.argtypes = [wintypes.HWND]
        self.u.IsWindowVisible.argtypes = [wintypes.HWND]
        self.u.IsIconic.argtypes = [wintypes.HWND]
        self.u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.u.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self.u.ScreenToClient.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
        self.u.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, ctypes.c_void_p, wintypes.UINT]
        # UIA rectangle coordinates are physical; match the process before clicking.
        self.dpi_aware = False
        try:
            shcore = ctypes.WinDLL('shcore')
            level = ctypes.c_int()
            if shcore.GetProcessDpiAwareness(None, ctypes.byref(level)) == 0 and level.value:
                self.dpi_aware = True
            elif self.u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
                self.dpi_aware = True
        except Exception:
            pass

    def foreground(self):
        return int(self.u.GetForegroundWindow() or 0)

    def last_input(self):
        class Info(self.ctypes.Structure):
            _fields_ = [('cbSize', self.wintypes.UINT), ('dwTime', self.wintypes.DWORD)]
        info = Info(); info.cbSize = self.ctypes.sizeof(info)
        if not self.u.GetLastInputInfo(self.ctypes.byref(info)):
            raise BackgroundError('BG_INPUT_STATE', '无法核对桌面输入状态，后台发送暂不可用')
        return int(info.dwTime)

    def watch_input(self, hwnd):
        from activity import InputWatch
        try:return InputWatch(hwnd).start()
        except Exception:raise BackgroundError('BG_INPUT_STATE', '微信操作观察暂不可用，后台未输入或发送') from None

    def valid(self, hwnd, pid):
        actual = self.wintypes.DWORD()
        self.u.GetWindowThreadProcessId(hwnd, self.ctypes.byref(actual))
        return bool(self.u.IsWindow(hwnd)) and actual.value == pid

    def available(self, hwnd):
        return bool(self.u.IsWindowVisible(hwnd)) and not self.u.IsIconic(hwnd)

    def restore_background(self, hwnd, pid):
        import win32gui
        original_visible = bool(self.u.IsWindowVisible(hwnd))
        original_iconic = bool(self.u.IsIconic(hwnd))
        if win32gui.GetWindowLong(hwnd, -20) & 8:
            raise BackgroundError('BG_TOPMOST', '微信处于置顶状态，请先取消置顶再使用最小化后台回复')
        self.u.SetWindowPos.argtypes = [self.wintypes.HWND, self.wintypes.HWND, self.ctypes.c_int, self.ctypes.c_int, self.ctypes.c_int, self.ctypes.c_int, self.wintypes.UINT]
        self.u.ShowWindowAsync.argtypes = [self.wintypes.HWND, self.ctypes.c_int]
        flags = 0x213  # NOACTIVATE | NOMOVE | NOSIZE | NOOWNERZORDER
        owned_rectangle = None
        def restore():
            # A user who opened/moved/minimized the window owns the new state.
            if (not self.valid(hwnd, pid) or self.foreground() == hwnd or not self.available(hwnd)
                    or (owned_rectangle is not None and win32gui.GetWindowRect(hwnd) != owned_rectangle)):
                return
            self.u.ShowWindowAsync(hwnd, 7 if original_iconic else 0 if not original_visible else 8)
        try:
            if not self.u.SetWindowPos(hwnd, 1, 0, 0, 0, 0, flags):
                raise BackgroundError('BG_RESTORE', '无法将微信还原到后台，未输入或发送')
            self.u.ShowWindowAsync(hwnd, 4)  # SHOWNOACTIVATE, never SW_RESTORE
            deadline = time.monotonic()+1.5
            while time.monotonic() < deadline and not self.available(hwnd):
                time.sleep(.04)
            if not self.u.SetWindowPos(hwnd, 1, 0, 0, 0, 0, flags):
                raise BackgroundError('BG_RESTORE', '无法保持微信在其他窗口后面，未输入或发送')
            owned_rectangle = win32gui.GetWindowRect(hwnd)
        except Exception:
            with contextlib.suppress(Exception):
                restore()
            raise
        return restore

    def post(self, hwnd, message, wparam=0, lparam=0):
        if not self.u.PostMessageW(hwnd, message, wparam, lparam):
            raise BackgroundError('BG_POST_DENIED', '后台输入被系统拒绝，请核对微信与助手的权限级别')

    def click(self, hwnd, control):
        if not self.dpi_aware:
            raise BackgroundError('BG_DPI', '当前进程DPI坐标不可核验，未点击发送')
        r = control.BoundingRectangle
        point = self.wintypes.POINT((r.left+r.right)//2, (r.top+r.bottom)//2)
        area = self.wintypes.RECT()
        if not self.u.ScreenToClient(hwnd, self.ctypes.byref(point)) or not self.u.GetClientRect(hwnd, self.ctypes.byref(area)):
            raise BackgroundError('BG_RECT', '无法核对后台控件位置')
        if r.right <= r.left or r.bottom <= r.top or not (0 <= point.x < area.right and 0 <= point.y < area.bottom):
            raise BackgroundError('BG_RECT', '后台控件不在微信窗口内，未点击')
        lp = (point.y << 16) | (point.x & 0xffff)
        self.post(hwnd, 0x200, 0, lp)
        self.post(hwnd, 0x201, 1, lp)
        time.sleep(.03)
        self.post(hwnd, 0x202, 0, lp)

    @staticmethod
    def descendants(control):
        from uiautomation.uiautomation import _AutomationClient
        import uiautomation as auto
        uia = _AutomationClient.instance().IUIAutomation
        values = control.Element.FindAll(4, uia.CreateTrueCondition())
        return [auto.Control.CreateControlFromElement(values.GetElement(i)) for i in range(min(values.Length, 5000))]

    def read(self, hwnd):
        root = self.auto.ControlFromHandle(hwnd)
        nodes = self.descendants(root)
        editors, sends, rows = [], [], []
        for control in nodes:
            aid = str(control.AutomationId or '').split('.')
            kind = control.ControlTypeName
            if 'chat_input_field' in aid and kind == 'EditControl':
                editors.append(control)
            if kind == 'ButtonControl' and control.Name == '发送' and not control.IsOffscreen and control.IsEnabled:
                sends.append(control)
            if 'session_list' in aid:
                for item in self.descendants(control):
                    if item.ControlTypeName == 'ListItemControl' and not item.IsOffscreen:
                        rows.append((str(item.Name or '').split('\n', 1)[0].strip(), item))
        editor = editors[0] if len(editors) == 1 else None
        try:
            value = editor.GetValuePattern().Value if editor is not None else None
        except Exception:
            value = None
        return {'edit': editor, 'chat': editor.Name if editor is not None else None,
                'value': value, 'send': sends[0] if len(sends) == 1 else None, 'rows': rows,
                'pid': int(root.ProcessId), 'nodes': len(nodes)}

    def erase_one(self, hwnd):
        # ValuePattern.SetValue('') can activate Qt's window. Post a bounded
        # Backspace only into a verified draft owned by this session instead.
        self.post(hwnd, 7)
        self.post(hwnd, 0x100, 8, 1)
        self.post(hwnd, 0x101, 8, 0xC0000001)
        if self.foreground() != hwnd:
            self.post(hwnd, 8)

    def listen(self, hwnd):
        # Some Qt providers expose their full tree only while a UIA client is
        # subscribed. This subscribes to events; it never invokes the control.
        import comtypes
        from uiautomation.uiautomation import _AutomationClient
        client = _AutomationClient.instance()
        class Listener(comtypes.COMObject):
            _com_interfaces_ = [client.UIAutomationCore.IUIAutomationEventHandler]
            def HandleAutomationEvent(self, sender, event_id):
                return 0
        handler = Listener()
        root = self.auto.ControlFromHandle(hwnd)
        client.IUIAutomation.AddAutomationEventHandler(20009, root.Element, 7, None, handler)
        def remove():
            client.IUIAutomation.RemoveAutomationEventHandler(20009, root.Element, handler)
        return remove

    def enable_accessibility(self, hwnd, check):
        # Keep the standard flag for this send session: restoring it here
        # can collapse Qt's tree before the caller has read the first control.
        previous = self.wintypes.BOOL()
        got = self.u.SystemParametersInfoW(0x46, 0, self.ctypes.byref(previous), 0)
        restored = False
        from accessibility_repair import tree_ready
        def probe():
            check()
            try:return self.read(hwnd)
            except Exception:return {'nodes':0,'edit':None,'rows':[]}
        before=probe()
        self.last_accessibility_diagnostic={'nodesBefore':before.get('nodes',0),'method':'standard','ready':False}
        def restore():
            nonlocal restored
            if got and not restored:
                restored = True
                self.u.SystemParametersInfoW(0x47, int(bool(previous.value)), None, 2)
        try:
            if before.get('nodes',0)>=20 and not tree_ready(before):
                self.last_accessibility_diagnostic.update(method='no_chat_controls',nodesAfter=before['nodes'])
                return restore
            if got:
                self.u.SystemParametersInfoW(0x47, 1, None, 2)
                for _ in range(8):
                    check(); time.sleep(.15)
                    value=probe()
                    if tree_ready(value):
                        self.last_accessibility_diagnostic.update(ready=True,nodesAfter=value.get('nodes',0))
                        return restore
            # Some WeChat builds keep Qt's accessibility runtime gate asleep
            # even with a screen-reader client. Reuse the installed bridge's
            # HWND-scoped wake helper, then verify real controls ourselves.
            self.last_accessibility_diagnostic['method']='wake'
            self.wake_accessibility(hwnd, check)
            for _ in range(8):
                check(); time.sleep(.15)
                value=probe()
                if tree_ready(value):
                    self.last_accessibility_diagnostic.update(ready=True,method='wake',nodesAfter=value.get('nodes',0))
                    return restore
            check()
            self.last_accessibility_diagnostic['method']='provider_rebuild'
            self.last_accessibility_diagnostic.update(self.rebuild_accessibility(hwnd,check))
            return restore
        except Exception as error:
            restore()
            if getattr(error,'code',None):raise
            failure=BackgroundError('BG_ACCESSIBILITY','微信控件连接重建未完成，本条未输入或发送')
            failure.accessibility_diagnostic=self.last_accessibility_diagnostic
            raise failure from None

    def wake_accessibility(self, hwnd, check):
        from wechatauto.accessibility import wake
        check()
        wake([hwnd], set_flag=False, verify=True, max_candidates=4)
        check()

    def rebuild_accessibility(self,hwnd,check):
        from accessibility_repair import RuntimeGate,pulse_candidates
        pid=self.wintypes.DWORD();self.u.GetWindowThreadProcessId(hwnd,self.ctypes.byref(pid))
        check();adapter=RuntimeGate(hwnd,pid.value)
        try:return pulse_candidates(adapter,lambda:self.read(hwnd),check)
        finally:adapter.close()

class BackgroundSession:
    def __init__(self, desktop, hwnd, pid, title, check, encoding='auto', cache=None, sleep=time.sleep):
        if encoding not in ('auto', 'utf16', 'gbk'):
            raise BackgroundError('BG_ENCODING', '请选择自动、UTF-16或GBK编码')
        self.desktop, self.hwnd, self.pid, self.title = desktop, hwnd, pid, title
        self.external_check, self.encoding, self.cache, self.sleep = check, encoding, cache if cache is not None else {}, sleep
        self.initial_foreground = desktop.foreground()
        self.input_stamp = desktop.last_input()
        self.draft = None
        self.restore_accessibility = None
        self.remove_listener = None
        self.restore_visibility = None
        self.activity = None
        self.last_input_diagnostic = None

    def quick_check(self):
        self.external_check()
        if not self.desktop.valid(self.hwnd, self.pid):
            raise BackgroundError('ACCOUNT_CHANGED', '微信账号窗口已变化，后台发送已停止')
        if self.activity is not None:
            if not self.activity.healthy():raise BackgroundError('BG_INPUT_STATE', '微信操作观察已中断，本次未继续发送')
            if self.activity.changed.is_set():raise BackgroundError('USER_TAKEOVER', '检测到微信中的点击、滚动或键入，已停止本轮后续短句')
        else:
            foreground = self.desktop.foreground()
            if foreground == self.hwnd and (self.initial_foreground != self.hwnd or self.desktop.last_input() != self.input_stamp):
                raise BackgroundError('USER_TAKEOVER', '你已操作微信，后台发送已停止')

    def snapshot(self, target=True):
        self.quick_check()
        try:value = self.desktop.read(self.hwnd)
        except Exception:
            self.quick_check()
            raise BackgroundError('BG_ACCESSIBILITY','微信控件连接已失效，本条未继续输入或发送') from None
        self.quick_check()
        if value.get('pid') != self.pid:
            raise BackgroundError('ACCOUNT_CHANGED', '后台控件不属于已绑定的微信进程')
        if target and not chat_matches(value.get('chat'), self.title):
            raise BackgroundError('CHAT_UNAVAILABLE', '后台目标会话已变化，未继续发送')
        return value

    def check(self):
        self.snapshot()

    def prepare(self):
        if self.activity is None and hasattr(self.desktop,'watch_input'):
            self.activity=self.desktop.watch_input(self.hwnd)
        self.quick_check()
        if not self.desktop.available(self.hwnd):
            if not hasattr(self.desktop, 'restore_background'):
                raise BackgroundError('BG_WINDOW_HIDDEN', '当前环境无法后台还原微信窗口，请先打开小号窗口')
            self.restore_visibility = self.desktop.restore_background(self.hwnd, self.pid)
            self.quick_check()
            if not self.desktop.available(self.hwnd):
                raise BackgroundError('BG_WINDOW_HIDDEN', '微信后台还原未完成，未输入或发送')
        if hasattr(self.desktop, 'listen'):
            self.remove_listener = self.desktop.listen(self.hwnd)
            self.quick_check()
        try:value = self.snapshot(target=False)
        except BackgroundError as error:
            if error.code!='BG_ACCESSIBILITY':raise
            value={'edit':None,'rows':[],'nodes':0}
        if value.get('edit') is None and not value.get('rows'):
            self.restore_accessibility = self.desktop.enable_accessibility(self.hwnd, self.quick_check)
            value = self.snapshot(target=False)
            if value.get('edit') is None and not value.get('rows'):
                is_view=value.get('nodes',0)>=20
                error=BackgroundError('BG_CHAT_VIEW' if is_view else 'BG_ACCESSIBILITY','微信当前页面未找到聊天控件，请回到聊天页；本条未发送' if is_view else '微信聊天控件仍未恢复，已尝试重建连接；本条未输入或发送')
                error.accessibility_diagnostic=getattr(self.desktop,'last_accessibility_diagnostic',{'nodesAfter':value.get('nodes',0)})
                raise error
        if value.get('edit') is not None and not blank(value.get('value')):
            raise BackgroundError('HUMAN_DRAFT', '微信当前输入框有草稿或无法读取，后台发送未修改')
        if value.get('edit') is None or not chat_matches(value.get('chat'), self.title):
            matches = [control for name, control in value.get('rows', []) if name == self.title]
            if len(matches) != 1:
                raise BackgroundError('BG_CHAT_NOT_VISIBLE', '后台会话列表中无法唯一找到目标，请在微信打开此会话，或选择前台兼容模式')
            self.quick_check(); self.desktop.click(self.hwnd, matches[0])
            deadline = time.monotonic()+2
            while time.monotonic() < deadline:
                value = self.snapshot(target=False)
                if chat_matches(value.get('chat'), self.title):
                    break
                self.sleep(.08)
        value = self.snapshot()
        if not value.get('edit') or not blank(value.get('value')):
            raise BackgroundError('HUMAN_DRAFT', '目标输入框有草稿或无法读取，后台发送未修改')
        return self

    def wait_text(self, text, timeout=2.5):
        deadline, matched, value = time.monotonic()+timeout, False, {}
        while time.monotonic() < deadline:
            value = self.snapshot()
            hit = equal(value.get('value'), text)
            if hit and matched:
                return value
            matched = hit
            self.sleep(.04)
        observed=value.get('value')
        self.last_input_diagnostic={'expectedChars':len(text),'observedChars':len(observed) if isinstance(observed,str) else None,'readable':isinstance(observed,str),'exact':False}
        raise BackgroundError('INPUT_MISMATCH', '后台文字回读不一致，未点击发送；请查看微信输入框')

    def wait_empty(self):
        deadline,matched=time.monotonic()+2.5,False
        while time.monotonic()<deadline:
            if not blank(self.snapshot().get('value')):
                raise BackgroundError('HUMAN_DRAFT','输入框尚未清空或出现新草稿，本条未输入')
            if matched:return
            matched=True;self.sleep(.04)
        raise BackgroundError('BG_INPUT_STATE','输入框尚未稳定，本条未输入')

    def type_units(self, text, mode):
        try:
            values = units(text, mode)
        except UnicodeError:
            raise BackgroundError('BG_UNSUPPORTED_TEXT', '当前后台编码不能完整输入这条文字，未发送；可切换UTF-16或前台兼容') from None
        self.quick_check(); self.desktop.post(self.hwnd, 7)
        try:
            self.sleep(.10)  # Qt updates editor focus asynchronously.
            self.quick_check()
            for i, unit in enumerate(values):
                if i % 16 == 0:
                    self.quick_check()
                self.desktop.post(self.hwnd, 0x102, unit, 1)
                self.sleep(.005)
        finally:
            # Do not remove the user's real input focus after a takeover.
            if self.desktop.foreground() != self.hwnd:
                self.desktop.post(self.hwnd, 8)

    def clear_owned(self, text):
        value = self.snapshot()
        if not equal(value.get('value'), text):
            raise BackgroundError('HUMAN_DRAFT', '输入内容已变化，后台发送未清空草稿')
        if hasattr(self.desktop, 'erase_one'):
            previous = value['value']
            for _ in range(len(previous.encode('utf-16-le'))//2+2):
                if previous == '':
                    break
                self.quick_check(); self.desktop.erase_one(self.hwnd)
                deadline = time.monotonic()+.5
                current = previous
                while time.monotonic() < deadline:
                    current = self.snapshot()['value']
                    if current != previous:
                        break
                    self.sleep(.02)
                if not isinstance(current, str) or not previous.startswith(current) or len(current) >= len(previous):
                    raise BackgroundError('HUMAN_DRAFT', '草稿已变化或无法精确清理，未继续删除')
                previous = current
            else:
                raise BackgroundError('BG_CLEANUP', '后台草稿未完整清理，请手动核对')
        else:
            self.quick_check(); self.desktop.clear(value['edit'])
        self.wait_text('')
        self.draft = None

    def detect_encoding(self):
        key = (self.pid, self.hwnd)
        if self.encoding != 'auto':
            return self.encoding
        if key in self.cache:
            return self.cache[key]
        # Probe only this verified empty input, never Enter; read then clear the
        # exact observed value while ownership and real user input stay unchanged.
        for mode in ('utf16', 'gbk'):
            if not blank(self.snapshot().get('value')):
                raise BackgroundError('HUMAN_DRAFT', '编码检测前输入框不为空，未修改')
            self.type_units('鲸', mode)
            observed, stable = None, 0
            deadline = time.monotonic()+.8
            while time.monotonic() < deadline:
                value = self.snapshot().get('value')
                stable = stable+1 if value == observed else 0
                observed = value
                if isinstance(value, str) and value and stable >= 2:
                    break
                self.sleep(.05)
            if observed is None:
                raise BackgroundError('BG_ENCODING', '编码检测无法回读，未发送；请检查输入框')
            if observed:
                self.draft = observed
                self.clear_owned(observed)
            if observed == '鲸':
                self.cache[key] = mode
                return mode
        raise BackgroundError('BG_ENCODING', '当前微信不支持已核验的后台编码，请选择前台兼容')

    def input(self, text):
        if not blank(self.snapshot().get('value')):
            raise BackgroundError('HUMAN_DRAFT', '目标输入框有草稿，后台发送未修改')
        self.wait_empty()
        self.last_input_diagnostic = None
        if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', text):
            raise BackgroundError('BG_UNSUPPORTED_TEXT', '文字包含不可发送的控制字符，后台未输入')
        if any(character in text for character in '\r\n\t'):
            raise BackgroundError('BG_MULTILINE', '这条多行文字需要前台兼容模式，后台未输入或发送')
        mode = self.detect_encoding()
        self.draft = text
        self.type_units(text, mode)
        self.wait_text(text)
        return mode

    def submit(self, text, reserve, attempting=lambda: None):
        value = self.wait_text(text)
        button = value.get('send')
        if button is None:
            raise BackgroundError('BG_SEND_BUTTON', '后台无法唯一找到发送按钮，未点击')
        reserve()  # durable ledger before crossing the irreversible boundary
        value = self.snapshot()
        if not equal(value.get('value'), text) or value.get('send') is None:
            raise BackgroundError('INPUT_MISMATCH', '发送前内容或按钮已变化，未点击发送')
        self.quick_check()
        self.draft = None
        attempting()
        self.desktop.click(self.hwnd, value['send'])

    def close(self):
        try:self._close_resources()
        finally:
            if self.activity is not None:
                activity,self.activity=self.activity,None
                activity.close()

    def _close_resources(self):
        # Never erase partial/foreign text or touch a window after user takeover.
        if self.draft is not None:
            try:
                self.clear_owned(self.draft)
            except Exception:
                pass
        if self.restore_visibility is not None:
            restore, self.restore_visibility = self.restore_visibility, None
            if self.activity is None or not self.activity.changed.is_set():
                with contextlib.suppress(Exception):restore()
        if self.restore_accessibility is not None:
            restore, self.restore_accessibility = self.restore_accessibility, None
            try:
                restore()
            finally:
                if self.remove_listener is not None:
                    remove, self.remove_listener = self.remove_listener, None
                    with contextlib.suppress(Exception):
                        remove()
        elif self.remove_listener is not None:
            remove, self.remove_listener = self.remove_listener, None
            with contextlib.suppress(Exception):
                remove()
