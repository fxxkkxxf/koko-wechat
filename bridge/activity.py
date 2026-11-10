"""Scoped input intent, retained as a boolean only; never record key contents."""
import ctypes
from ctypes import wintypes
import threading

class ActivityState:
    def __init__(self, hwnd):
        self.hwnd=hwnd;self.changed=threading.Event()
    def mouse(self, message, root):
        # Moving a pointer, viewing a window and clicks in other apps are fine.
        if root==self.hwnd and message in (0x201,0x204,0x207,0x20B,0x20A,0x20E):self.changed.set()
    def key(self, message, root, key):
        if root==self.hwnd and message in (0x100,0x104) and key not in (16,17,18,91,92,160,161,162,163,164,165):self.changed.set()

class InputWatch(ActivityState):
    """Read-only low-level input notifications on a dedicated message thread.

    Does not inject into WeChat, consume input, store keys or alter focus.
    Koko's PostMessage text/clicks do not enter this input event stream.
    """
    def __init__(self, hwnd):
        super().__init__(hwnd);self.ready=threading.Event();self.stopping=threading.Event();self.error=None;self.thread_id=0
        self.thread=threading.Thread(target=self._run,daemon=True,name='koko-input-intent')
    def start(self):
        self.thread.start()
        if not self.ready.wait(2) or self.error:
            self.close();raise RuntimeError('无法建立微信操作观察，后台未输入')
        return self
    def healthy(self):return self.thread.is_alive() and not self.error and not self.stopping.is_set()
    def close(self):
        self.stopping.set()
        if self.thread_id:
            u=ctypes.WinDLL('user32',use_last_error=True)
            u.PostThreadMessageW.argtypes=[wintypes.DWORD,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]
            u.PostThreadMessageW(self.thread_id,0x12,0,0)
        if self.thread.is_alive():self.thread.join(.8)
    def _run(self):
        hooks=[];u=None
        try:
            u=ctypes.WinDLL('user32',use_last_error=True);k=ctypes.WinDLL('kernel32',use_last_error=True)
            result=ctypes.c_ssize_t
            callback=ctypes.WINFUNCTYPE(result,ctypes.c_int,wintypes.WPARAM,wintypes.LPARAM)
            class Mouse(ctypes.Structure):
                _fields_=[('point',wintypes.POINT),('mouseData',wintypes.DWORD),('flags',wintypes.DWORD),('time',wintypes.DWORD),('extra',ctypes.c_size_t)]
            class Key(ctypes.Structure):
                _fields_=[('vk',wintypes.DWORD),('scan',wintypes.DWORD),('flags',wintypes.DWORD),('time',wintypes.DWORD),('extra',ctypes.c_size_t)]
            u.SetWindowsHookExW.argtypes=[ctypes.c_int,callback,wintypes.HINSTANCE,wintypes.DWORD];u.SetWindowsHookExW.restype=wintypes.HANDLE
            u.CallNextHookEx.argtypes=[wintypes.HANDLE,ctypes.c_int,wintypes.WPARAM,wintypes.LPARAM];u.CallNextHookEx.restype=result
            u.UnhookWindowsHookEx.argtypes=[wintypes.HANDLE]
            u.GetForegroundWindow.restype=wintypes.HWND
            u.GetAncestor.argtypes=[wintypes.HWND,wintypes.UINT];u.GetAncestor.restype=wintypes.HWND
            u.WindowFromPoint.argtypes=[wintypes.POINT];u.WindowFromPoint.restype=wintypes.HWND
            k.GetCurrentThreadId.restype=wintypes.DWORD;k.GetModuleHandleW.restype=wintypes.HMODULE
            self.thread_id=k.GetCurrentThreadId()
            def root(hwnd):
                if hwnd==self.hwnd or u.GetAncestor(hwnd,2)==self.hwnd or u.GetAncestor(hwnd,3)==self.hwnd:return self.hwnd
                return int(hwnd or 0)
            @callback
            def mouse(code,message,data):
                try:
                    if code>=0 and message in (0x201,0x204,0x207,0x20B,0x20A,0x20E):
                        value=ctypes.cast(data,ctypes.POINTER(Mouse)).contents
                        self.mouse(message,root(u.WindowFromPoint(value.point)))
                except Exception:self.error='observer failed'
                return u.CallNextHookEx(None,code,message,data)
            @callback
            def key(code,message,data):
                try:
                    if code>=0 and message in (0x100,0x104):
                        value=ctypes.cast(data,ctypes.POINTER(Key)).contents
                        self.key(message,root(u.GetForegroundWindow()),value.vk)
                except Exception:self.error='observer failed'
                return u.CallNextHookEx(None,code,message,data)
            msg=wintypes.MSG();u.PeekMessageW(ctypes.byref(msg),None,0,0,0)
            for kind,fn in ((14,mouse),(13,key)):
                handle=u.SetWindowsHookExW(kind,fn,k.GetModuleHandleW(None),0)
                if not handle:raise RuntimeError('input observer unavailable')
                hooks.append(handle)
            self.ready.set()
            while not self.stopping.is_set() and u.GetMessageW(ctypes.byref(msg),None,0,0)>0:
                u.TranslateMessage(ctypes.byref(msg));u.DispatchMessageW(ctypes.byref(msg))
        except Exception:self.error='input observer unavailable'
        finally:
            if u:
                for hook in hooks:u.UnhookWindowsHookEx(hook)
            self.ready.set()
