"""Bounded repair of a stale Qt accessibility provider; never input or send."""
import time

def tree_ready(value):
    return value.get('edit') is not None or bool(value.get('rows'))

def pulse_candidates(adapter, read, check, sleep=time.sleep):
    """Try one validated runtime flag at a time; roll failures back exactly."""
    tried=0;last={}
    for candidate in list(adapter.candidates)[:4]:
        check();original=adapter.read(candidate)
        if original not in (0,1):continue
        tried+=1;keep=False;touched=False
        try:
            if original==1:
                touched=True
                if not adapter.write(candidate,0):continue
                sleep(.10);check()
            touched=True
            if not adapter.write(candidate,1):continue
            for _ in range(10):
                check();sleep(.15);check()
                try:last=read()
                except Exception:last={}
                if tree_ready(last):
                    keep=True
                    return {'ready':True,'method':'provider_rebuild','candidatesTried':tried,'nodesAfter':last.get('nodes',0)}
        finally:
            if touched and not keep:
                if not adapter.write(candidate,original):
                    raise RuntimeError('无障碍状态回滚未完成，已停止后续尝试')
    return {'ready':False,'method':'provider_rebuild','candidatesTried':tried,'nodesAfter':last.get('nodes',0)}

class RuntimeGate:
    """Use the installed bridge's PE-validated candidates for one pinned PID."""
    def __init__(self,hwnd,pid):
        import ctypes
        from ctypes import wintypes
        from wechatauto.accessibility import AccessibilityGate
        self.gate=AccessibilityGate;self.handle=None
        if self.gate._pid_from_hwnd(hwnd)!=pid:raise RuntimeError('微信窗口进程已变化')
        module=self.gate._weixin_dll_module(pid)
        if not module:raise RuntimeError('无法核对微信无障碍模块')
        self.base,self.size,dll=module
        self.candidates=list(dict.fromkeys(rva for rva in self.gate._qaccessible_candidate_rvas(dll) if type(rva) is int and 0<rva<self.size))[:4]
        self.kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        self.kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];self.kernel.OpenProcess.restype=wintypes.HANDLE
        self.kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        if self.gate._pid_from_hwnd(hwnd)!=pid:raise RuntimeError('微信窗口进程已变化')
        self.handle=self.kernel.OpenProcess(0x438,False,pid)
        if not self.handle:raise RuntimeError('无法访问已绑定微信的无障碍状态')
    def read(self,candidate):return self.gate._read_process_byte(self.handle,self.base+candidate)
    def write(self,candidate,value):
        return candidate in self.candidates and value in (0,1) and self.gate._write_process_byte(self.handle,self.base+candidate,value) and self.read(candidate)==value
    def close(self):
        if self.handle:self.kernel.CloseHandle(self.handle);self.handle=None
