"""Mock-only background sends: no native GUI imports, keys or WeChat messages."""
import contextlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

directory = Path(__file__).parents[1] / 'bridge'
sys.path.insert(0,str(directory))
spec = importlib.util.spec_from_file_location('koko_background', directory/'background.py')
bg = importlib.util.module_from_spec(spec); spec.loader.exec_module(bg)
saved_out, saved_err = sys.stdout, sys.stderr
spec = importlib.util.spec_from_file_location('koko_background_worker', directory/'worker.py')
worker = importlib.util.module_from_spec(spec); sys.modules[spec.name] = worker
spec.loader.exec_module(worker); sys.stdout, sys.stderr = saved_out, saved_err


class Desktop:
    def __init__(self, mode='utf16', title='目标聊天'):
        self.mode, self.title, self.value, self.buffer = mode, title, '', []
        self.fg, self.stamp, self.pid, self.exists = 99, 7, 12, True
        self.editor, self.button, self.row = object(), object(), object()
        self.calls, self.rows, self.send_count = [], [], 0
        self.visible, self.after_send = True, None
    def foreground(self): return self.fg
    def last_input(self): return self.stamp
    def valid(self, hwnd, pid): return self.exists and pid == self.pid
    def available(self, hwnd): return self.visible
    def show_inactive(self, hwnd): self.visible = True; self.calls.append('show-inactive')
    def read(self, hwnd):
        return {'pid': self.pid, 'chat': self.title, 'value': self.value,
                'edit': self.editor, 'send': self.button, 'rows': [('目标聊天', self.row)], 'nodes': 30}
    def post(self, hwnd, message, wparam=0, lparam=0):
        self.calls.append(('post', message, wparam))
        if message == 0x102:
            self.buffer.append(wparam)
            raw = b''.join(n.to_bytes(2, 'little') for n in self.buffer) if self.mode == 'utf16' else bytes(n & 255 for n in self.buffer)
            self.value = raw.decode('utf-16-le' if self.mode == 'utf16' else 'gbk', errors='replace')
    def clear(self, editor): self.value=''; self.buffer=[]; self.calls.append('clear')
    def set_text(self, editor, text): self.value=text; self.calls.append('value-pattern')
    def click(self, hwnd, control):
        if control is self.row:
            self.title='目标聊天'; self.calls.append('open'); return
        assert control is self.button
        self.send_count += 1; self.calls.append('send')
        self.rows.append({'local_id': self.send_count, 'shard':'one', 'sender_username':'small', 'content': self.value, 'create_time':time.time()})
        self.value=''; self.buffer=[]
        if self.after_send: self.after_send(self)
    def enable_accessibility(self, hwnd, check): check(); self.calls.append('accessibility')


class BackgroundTests(unittest.TestCase):
    def session(self, desktop=None, **kwargs):
        return bg.BackgroundSession(desktop or Desktop(),10,12,'目标聊天',lambda:None,sleep=lambda _:None,**kwargs)

    def test_import_has_no_native_work_and_windows_adapter_exposes_no_foreground_or_clipboard_method(self):
        for name in ('SetForegroundWindow','focus','SendInput','SendKeys','clipboard','_activate'):
            self.assertFalse(hasattr(bg.NativeDesktop,name))

    def test_utf16_preserves_chinese_emoji_and_every_character(self):
        desktop=Desktop(); session=self.session(desktop,encoding='utf16').prepare()
        text='收到🫧 一共￥12.50'; session.input(text)
        events=[]; session.submit(text,lambda:events.append('reserved'),lambda:events.append('attempting'))
        self.assertEqual(events,['reserved','attempting']); self.assertEqual(desktop.rows[0]['content'],text)
        self.assertEqual(desktop.fg,99); self.assertEqual(desktop.send_count,1)
        self.assertNotIn('value-pattern',desktop.calls)

    def test_multiline_or_tabs_are_rejected_before_typing_or_sending(self):
        for text in ('第一行\n第二行','第一行\r第二行','第一行\t第二行'):
            desktop=Desktop();session=self.session(desktop).prepare()
            with self.assertRaises(bg.BackgroundError) as caught:session.input(text)
            self.assertEqual(caught.exception.code,'BG_MULTILINE')
            self.assertEqual(desktop.calls,[]);self.assertEqual(desktop.send_count,0)

    def test_single_line_utf16_keeps_surrogate_pairs_and_no_control_character_is_posted(self):
        desktop=Desktop(); session=self.session(desktop,encoding='utf16').prepare()
        session.input('收到🫧你好'); session.submit('收到🫧你好',lambda:None)
        self.assertEqual(desktop.rows[0]['content'],'收到🫧你好')
        self.assertTrue(all(x[2] >= 32 for x in desktop.calls if isinstance(x,tuple) and x[1]==0x102))
        with self.assertRaises(bg.BackgroundError): session.input('不能\x08退格')

    def test_auto_probe_selects_legacy_gbk_clears_probe_and_caches_per_window(self):
        desktop=Desktop('gbk'); cache={}; session=self.session(desktop,cache=cache).prepare()
        self.assertEqual(session.input('你好，世界'),'gbk'); session.submit('你好，世界',lambda:None)
        self.assertEqual(cache,{(12,10):'gbk'}); self.assertEqual(desktop.rows[0]['content'],'你好，世界')
        self.assertEqual(desktop.send_count,1); before=desktop.calls.count('clear')
        session.input('第二句'); self.assertEqual(desktop.calls.count('clear'),before)
        session.close(); self.assertEqual(desktop.value,'')

    def test_gbk_never_drops_unencodable_characters(self):
        desktop=Desktop('gbk'); session=self.session(desktop,encoding='gbk').prepare()
        with self.assertRaises(bg.BackgroundError): session.input('你好🫧')
        self.assertFalse(any(isinstance(x,tuple) for x in desktop.calls)); self.assertEqual(desktop.send_count,0)

    def test_drafts_unknown_values_and_wrong_account_block_before_typing(self):
        for value in ('人工草稿',None):
            desktop=Desktop(); desktop.value=value
            with self.assertRaises(bg.BackgroundError): self.session(desktop).prepare()
            self.assertEqual(desktop.calls,[])
        desktop=Desktop(); desktop.pid=25
        with self.assertRaises(bg.BackgroundError): self.session(desktop).prepare()
        self.assertEqual(desktop.calls,[])

    def test_hidden_window_without_restore_support_is_blocked(self):
        desktop=Desktop(); desktop.visible=False
        with self.assertRaises(bg.BackgroundError) as caught: self.session(desktop).prepare()
        self.assertEqual(caught.exception.code,'BG_WINDOW_HIDDEN'); self.assertEqual(desktop.calls,[])

    def test_large_tree_without_chat_controls_is_view_error_not_a_human_draft(self):
        desktop=Desktop();read=desktop.read
        desktop.read=lambda hwnd:{**read(hwnd),'edit':None,'nodes':200,'rows':[]}
        with self.assertRaises(bg.BackgroundError) as caught:self.session(desktop).prepare()
        self.assertEqual(caught.exception.code,'BG_CHAT_VIEW');self.assertEqual(desktop.send_count,0)

    def test_visible_exact_session_can_open_when_no_chat_editor_is_currently_shown(self):
        desktop=Desktop(title='联系人');read=desktop.read
        desktop.read=lambda hwnd:{**read(hwnd),'edit':desktop.editor if desktop.title=='目标聊天' else None}
        session=self.session(desktop).prepare();session.close()
        self.assertEqual(desktop.calls,['open']);self.assertEqual(desktop.send_count,0);self.assertEqual(desktop.fg,99)

    def test_stale_initial_element_can_recover_before_any_input(self):
        desktop=Desktop();read=desktop.read;seen=[]
        def stale(hwnd):
            seen.append(1)
            if len(seen)==1:raise RuntimeError('stale UIA element')
            return read(hwnd)
        desktop.read=stale;session=self.session(desktop).prepare();session.close()
        self.assertEqual(desktop.calls,['accessibility']);self.assertEqual(desktop.send_count,0)

    def test_minimized_batch_uses_one_restore_and_returns_to_original_state_once(self):
        desktop=Desktop();desktop.visible=False
        def restore(hwnd,pid):
            desktop.calls.append('restore-behind');desktop.visible=True
            def close():desktop.calls.append('minimize-inactive');desktop.visible=False
            return close
        desktop.restore_background=restore
        session=self.session(desktop,encoding='utf16')
        try:
            session.prepare()
            for text in ('第一句','第二句','第三句'):
                session.input(text);session.submit(text,lambda:None)
        finally:session.close()
        session.close()
        self.assertEqual(desktop.calls.count('restore-behind'),1)
        self.assertEqual(desktop.calls.count('minimize-inactive'),1)
        self.assertEqual(desktop.send_count,3);self.assertEqual(desktop.fg,99)
        self.assertFalse(desktop.visible)

    def test_restore_lease_is_closed_after_preflight_or_send_failure(self):
        for failure in ('draft','missing-window','send'):
            desktop=Desktop();desktop.visible=False;events=[]
            def restore(hwnd,pid):
                desktop.visible=failure!='missing-window'
                events.append('restore')
                return lambda:events.append('close')
            desktop.restore_background=restore
            if failure=='draft':desktop.value='人工草稿'
            if failure=='send':desktop.click=lambda *a:(_ for _ in ()).throw(bg.BackgroundError('BG_POST_DENIED','denied'))
            session=self.session(desktop,encoding='utf16')
            try:
                with self.assertRaises(bg.BackgroundError):
                    session.prepare();session.input('回复');session.submit('回复',lambda:None)
            finally:session.close()
            self.assertEqual(events,['restore','close'])

    def test_owned_draft_erased_with_bounded_posts_and_stops_on_foreign_change(self):
        for foreign in (False,True):
            desktop=Desktop();desktop.value=' 自检🫧 ';deleted=[]
            def erase(hwnd):
                deleted.append(hwnd)
                desktop.value=desktop.value[:-1] if not foreign else desktop.value+'人工'
            desktop.erase_one=erase
            session=self.session(desktop);session.draft=desktop.value
            if foreign:
                with self.assertRaises(bg.BackgroundError):session.clear_owned(desktop.value)
                self.assertEqual(len(deleted),1);self.assertTrue(desktop.value.endswith('人工'))
            else:
                session.clear_owned(desktop.value);self.assertEqual(desktop.value,'');self.assertIsNone(session.draft)
            self.assertNotIn('clear',desktop.calls);self.assertEqual(desktop.fg,99)

    def test_native_restore_stays_inactive_and_respects_user_takeover(self):
        import ctypes
        from ctypes import wintypes
        for initial in ('minimized','hidden'):
            for takeover in ('none','foreground','moved','account'):
                desktop=bg.NativeDesktop.__new__(bg.NativeDesktop)
                desktop.ctypes,desktop.wintypes=ctypes,wintypes
                desktop.u=SimpleNamespace(IsWindowVisible=Mock(return_value=initial=='minimized'),
                    IsIconic=Mock(return_value=initial=='minimized'),SetWindowPos=Mock(return_value=True),ShowWindowAsync=Mock())
                desktop.available=lambda hwnd:True
                desktop.valid=lambda hwnd,pid:takeover!='account'
                desktop.foreground=lambda:10 if takeover=='foreground' else 99
                native=SimpleNamespace(GetWindowLong=lambda *a:0,GetWindowRect=Mock(return_value=(1,2,300,400)))
                with patch.dict(sys.modules,{'win32gui':native}):
                    restore=desktop.restore_background(10,12)
                    if takeover=='moved':native.GetWindowRect.return_value=(2,2,301,400)
                    restore()
                shows=[x.args[1] for x in desktop.u.ShowWindowAsync.call_args_list]
                self.assertEqual(shows,[4,7 if initial=='minimized' else 0] if takeover=='none' else [4])
                for call in desktop.u.SetWindowPos.call_args_list:
                    self.assertEqual(call.args[1],1);self.assertTrue(call.args[-1]&0x10)

    def test_native_restore_rolls_back_after_second_position_failure(self):
        import ctypes
        from ctypes import wintypes
        desktop=bg.NativeDesktop.__new__(bg.NativeDesktop);desktop.ctypes,desktop.wintypes=ctypes,wintypes
        desktop.u=SimpleNamespace(IsWindowVisible=Mock(return_value=True),IsIconic=Mock(return_value=True),
            SetWindowPos=Mock(side_effect=[True,False]),ShowWindowAsync=Mock())
        desktop.available=lambda hwnd:True;desktop.valid=lambda *a:True;desktop.foreground=lambda:99
        with patch.dict(sys.modules,{'win32gui':SimpleNamespace(GetWindowLong=lambda *a:0)}):
            with self.assertRaises(bg.BackgroundError):desktop.restore_background(10,12)
        self.assertEqual([x.args[1] for x in desktop.u.ShowWindowAsync.call_args_list],[4,7])

    def test_uia_listener_lifetime_is_scoped_and_cleanup_is_idempotent(self):
        desktop=Desktop(); events=[]
        desktop.listen=lambda hwnd:(events.append('listen') or (lambda:events.append('remove')))
        session=self.session(desktop).prepare();self.assertEqual(events,['listen'])
        session.close();session.close();self.assertEqual(events,['listen','remove'])

    def test_screen_reader_flag_is_held_until_cleanup_and_restored_on_cancel(self):
        import ctypes
        from ctypes import wintypes
        for cancel in (False,True):
            calls=[]; desktop=bg.NativeDesktop.__new__(bg.NativeDesktop)
            desktop.ctypes,desktop.wintypes=ctypes,wintypes
            def spi(action,enabled,pointer,flags):
                if action==0x46:pointer._obj.value=0
                else:calls.append(bool(enabled))
                return True
            desktop.u=SimpleNamespace(SystemParametersInfoW=spi)
            desktop.read=lambda hwnd:{'nodes':30,'edit':object()}
            def check():
                if cancel:raise bg.BackgroundError('CANCELLED','已取消')
            with patch.object(bg.time,'sleep',lambda _:None):
                if cancel:
                    with self.assertRaises(bg.BackgroundError):desktop.enable_accessibility(10,check)
                    self.assertEqual(calls,[])
                else:
                    restore=desktop.enable_accessibility(10,check);self.assertEqual(calls,[True])
                    restore();restore();self.assertEqual(calls,[True,False])

    def test_accessibility_uses_scoped_wake_only_when_standard_tree_stays_empty(self):
        import ctypes
        from ctypes import wintypes
        desktop=bg.NativeDesktop.__new__(bg.NativeDesktop);desktop.ctypes,desktop.wintypes=ctypes,wintypes
        woke=[];flags=[]
        def spi(action,enabled,pointer,options):
            if action==0x46:pointer._obj.value=0
            else:flags.append(bool(enabled))
            return True
        desktop.u=SimpleNamespace(SystemParametersInfoW=spi)
        desktop.read=lambda hwnd:{'nodes':200 if woke else 2,'edit':object() if woke else None}
        desktop.wake_accessibility=lambda hwnd,check:(check(),woke.append(hwnd))
        with patch.object(bg.time,'sleep',lambda _:None):restore=desktop.enable_accessibility(10,lambda:None)
        self.assertEqual(woke,[10]);self.assertEqual(flags,[True]);restore();self.assertEqual(flags,[True,False])

    def test_native_repair_checks_real_controls_even_when_ordinary_wake_reports_success(self):
        import ctypes
        from ctypes import wintypes
        desktop=bg.NativeDesktop.__new__(bg.NativeDesktop);desktop.ctypes,desktop.wintypes=ctypes,wintypes;rebuilt=[]
        def spi(action,enabled,pointer,options):
            if action==0x46:pointer._obj.value=0
            return True
        desktop.u=SimpleNamespace(SystemParametersInfoW=spi)
        desktop.read=lambda hwnd:{'nodes':178 if rebuilt else 2,'edit':object() if rebuilt else None}
        desktop.wake_accessibility=lambda hwnd,check:True
        def rebuild(hwnd,check):check();rebuilt.append(hwnd);return {'ready':True,'method':'provider_rebuild','nodesAfter':178}
        desktop.rebuild_accessibility=rebuild
        with patch.object(bg.time,'sleep',lambda _:None):restore=desktop.enable_accessibility(10,lambda:None)
        self.assertEqual(rebuilt,[10]);self.assertEqual(desktop.last_accessibility_diagnostic['nodesAfter'],178);restore()

    def test_target_requires_exact_unique_row_not_prefix_or_unread_suffix_guess(self):
        desktop=Desktop(title='目标聊天2'); original=desktop.read
        desktop.read=lambda hwnd:{**original(hwnd),'rows':[('目标聊天2',desktop.row)]}
        with self.assertRaises(bg.BackgroundError): self.session(desktop).prepare()
        self.assertEqual(desktop.calls,[])
        desktop.read=lambda hwnd:{**original(hwnd),'rows':[('目标聊天',desktop.row),('目标聊天',object())]}
        with self.assertRaises(bg.BackgroundError): self.session(desktop).prepare()
        self.assertFalse(bg.chat_matches('目标聊天2','目标聊天'))
        self.assertFalse(bg.chat_matches('目标聊天(2)','目标聊天'))

    def test_exact_target_can_open_without_changing_foreground(self):
        desktop=Desktop(title='其他聊天'); self.session(desktop).prepare()
        self.assertEqual(desktop.calls,['open']); self.assertEqual(desktop.fg,99)

    def test_using_another_app_does_not_cancel_but_operating_wechat_does(self):
        desktop=Desktop(); session=self.session(desktop).prepare()
        desktop.fg=77; desktop.stamp+=1; session.check()
        desktop.fg=10
        with self.assertRaises(bg.BackgroundError) as caught: session.check()
        self.assertEqual(caught.exception.code,'USER_TAKEOVER')

    def test_reservation_cancel_or_changed_text_cannot_click_send_or_clear_foreign_draft(self):
        for change in ('cancel','draft','chat'):
            desktop=Desktop(); session=self.session(desktop,encoding='utf16').prepare(); session.input('准备回复')
            def reserve():
                if change=='cancel': session.external_check=lambda:(_ for _ in ()).throw(bg.BackgroundError('CANCELLED','取消'))
                elif change=='draft': desktop.value+='人工文字'
                else: desktop.title='别的群'
            with self.assertRaises(bg.BackgroundError): session.submit('准备回复',reserve)
            session.close(); self.assertEqual(desktop.send_count,0)
            if change=='draft': self.assertEqual(desktop.value,'准备回复人工文字')

    def test_account_or_user_takeover_mid_typing_prevents_any_submit(self):
        desktop=Desktop(); session=self.session(desktop,encoding='utf16').prepare()
        post=desktop.post
        def takeover(*args):
            post(*args)
            if args[1]==0x102: desktop.fg=10; desktop.stamp+=1
        desktop.post=takeover
        with self.assertRaises(bg.BackgroundError): session.input('超过十六个字用于核对中途人工接管后程序不会继续发送')
        self.assertEqual(desktop.send_count,0)

    def test_typing_waits_for_qt_focus_before_character_messages(self):
        desktop=Desktop();sleeps=[]
        session=bg.BackgroundSession(desktop,10,12,'目标聊天',lambda:None,encoding='utf16',sleep=lambda delay:sleeps.append((delay,len(desktop.buffer)))).prepare()
        session.input('焦点稳定后输入')
        self.assertIn((.10,0),sleeps);self.assertTrue(any(delay==.005 for delay,count in sleeps))

    def test_readback_failure_contains_only_counts_for_diagnostics(self):
        desktop=Desktop();desktop.value='缺字';session=self.session(desktop)
        with self.assertRaises(bg.BackgroundError):session.wait_text('计划完整文字',timeout=.001)
        self.assertEqual(session.last_input_diagnostic,{'expectedChars':6,'observedChars':2,'readable':True,'exact':False})

    def test_draft_appearing_during_empty_settle_is_never_typed_over(self):
        desktop=Desktop();session=self.session(desktop,encoding='utf16').prepare();read=desktop.read;checks=[]
        def incoming(hwnd):
            checks.append(1)
            if len(checks)>=3:desktop.value='人工草稿'
            return read(hwnd)
        desktop.read=incoming
        with self.assertRaises(bg.BackgroundError) as error:session.input('程序回复')
        self.assertEqual(error.exception.code,'HUMAN_DRAFT');self.assertEqual(desktop.value,'人工草稿')
        self.assertFalse(any(isinstance(x,tuple) and x[1]==0x102 for x in desktop.calls))


class IntegratedBackgroundTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.b=worker.Bridge(self.temp.name)
        self.b._account={'id':'small','name':'小号','pid':12,'hwnd':10}
        self.b._chat={'id':'owner','name':'目标聊天','type':'private'}; self.b._active.set()
        self.b._phase=lambda *a:None; self.b._detect=lambda:{'small':dict(self.b._account)}
        self.b._group_metadata=lambda *a:[]
    def tearDown(self): self.temp.cleanup()
    def job(self,**kwargs):
        return {'id':'test','accountId':'small','chatId':'owner','text':'你好','expiresAt':worker.now_ms()+10000,**kwargs}
    @contextlib.contextmanager
    def fixture(self,desktop=None):
        desktop=desktop or Desktop()
        db=SimpleNamespace(search_contact=lambda key:[{'username':'owner','nick_name':'目标聊天'}],get_messages=lambda *a,**k:list(reversed(desktop.rows)))
        self.b._database=lambda a:db
        actual=bg.BackgroundSession
        def channel(*args,**kwargs): return actual(*args,**kwargs,sleep=lambda _:None)
        api=SimpleNamespace(NativeDesktop=lambda:desktop,BackgroundSession=channel)
        automation=SimpleNamespace(InitializeUIAutomationInCurrentThread=lambda:None,UninitializeUIAutomationInCurrentThread=lambda:None)
        self.b._foreground_session=lambda *a:(_ for _ in ()).throw(AssertionError('foreground fallback forbidden'))
        with patch.dict(sys.modules,{'background':api,'uiautomation':automation}): yield desktop
    def test_default_single_send_is_background_and_requires_durable_db_record(self):
        with self.fixture() as desktop:
            click=desktop.click
            def durable(hwnd,control):
                if control is desktop.button:
                    ledger=json.loads(self.b._ledger_path.read_text('utf8'))
                    self.assertEqual(ledger['test']['status'],'sending')
                click(hwnd,control)
            desktop.click=durable
            result=self.b.send(self.job()); again=self.b.send(self.job())
        self.assertEqual(result['status'],'confirmed'); self.assertEqual(again['status'],'confirmed')
        self.assertEqual(result['transport'],'background'); self.assertEqual(desktop.send_count,1); self.assertEqual(desktop.fg,99)
    def test_accessibility_preflight_is_retried_once_before_any_input_or_send(self):
        attempts=[]
        def build(*args,**kwargs):
            channel=bg.BackgroundSession(*args,**kwargs,sleep=lambda _:None);prepare=channel.prepare
            def retry():
                attempts.append(1)
                if len(attempts)==1:raise bg.BackgroundError('BG_ACCESSIBILITY','控件未就绪')
                return prepare()
            channel.prepare=retry;return channel
        with self.fixture() as desktop:
            with patch.object(sys.modules['background'],'BackgroundSession',build):result=self.b.send(self.job())
        self.assertEqual(result['status'],'confirmed');self.assertEqual(len(attempts),2);self.assertEqual(desktop.send_count,1)
    def test_persistent_preflight_failure_is_durable_blocked_proof_without_sending(self):
        attempts=[]
        def build(*args,**kwargs):
            channel=bg.BackgroundSession(*args,**kwargs,sleep=lambda _:None)
            def fail():attempts.append(1);raise bg.BackgroundError('BG_ACCESSIBILITY','控件未就绪')
            channel.prepare=fail;return channel
        with self.fixture() as desktop:
            with patch.object(sys.modules['background'],'BackgroundSession',build):
                result=self.b.send(self.job());again=self.b.send(self.job())
        self.assertEqual(result['status'],'blocked');self.assertTrue(result['notSent']);self.assertEqual(result['code'],'BG_ACCESSIBILITY')
        self.assertEqual(len(attempts),2);self.assertEqual(result,again);self.assertEqual(desktop.send_count,0);self.assertEqual(desktop.value,'')
    def test_post_click_error_is_uncertain_and_never_reenters_preflight(self):
        def fail(desktop):raise bg.BackgroundError('BG_ACCESSIBILITY','发送后控件失效')
        desktop=Desktop();desktop.after_send=fail
        with self.fixture(desktop):result=self.b.send(self.job())
        self.assertEqual(result['status'],'unconfirmed');self.assertEqual(desktop.send_count,1)
    def test_actual_bridge_probe_reads_controls_without_input_or_click(self):
        with self.fixture() as desktop:result=self.b._background_probe()
        self.assertTrue(result['ready']);self.assertTrue(result['editorFound']);self.assertEqual(result['nodesAfter'],30)
        self.assertEqual(result['messagesSent'],0);self.assertEqual(desktop.send_count,0);self.assertEqual(desktop.calls,[])
    def test_preflight_diagnostics_survive_single_and_batch_errors(self):
        def build(*args,**kwargs):
            channel=bg.BackgroundSession(*args,**kwargs,sleep=lambda _:None)
            def fail():
                error=bg.BackgroundError('BG_ACCESSIBILITY','控件未恢复')
                error.accessibility_diagnostic={'method':'provider_rebuild','nodesBefore':2,'nodesAfter':2,'ready':False}
                raise error
            channel.prepare=fail;return channel
        for batch in (False,True):
            with self.fixture() as desktop:
                with patch.object(sys.modules['background'],'BackgroundSession',build):
                    result=self.b.send_batch(self.job(id='batch-diag',messages=['一','二'])) if batch else self.b.send(self.job(id='single-diag'))
            entry=result['parts'][0] if batch else result
            self.assertEqual(entry['accessibilityDiagnostic']['nodesBefore'],2);self.assertEqual(desktop.send_count,0)
    def test_batch_switches_once_and_confirms_identical_bubbles_independently(self):
        desktop=Desktop(title='其他聊天')
        with self.fixture(desktop):
            result=self.b.send_batch(self.job(messages=['同一句','同一句','同一句']))
        self.assertEqual(result['status'],'confirmed'); self.assertEqual(desktop.calls.count('open'),1)
        self.assertEqual(len({row['messageId'] for row in result['parts']}),3); self.assertEqual(desktop.fg,99)
    def test_empty_input_without_new_db_record_is_uncertain_and_never_retried(self):
        desktop=Desktop(); desktop.after_send=lambda d:d.rows.clear()
        with self.fixture(desktop):
            result=self.b.send(self.job(expiresAt=worker.now_ms()+180))
            again=self.b.send(self.job())
        self.assertEqual(result['status'],'unconfirmed'); self.assertEqual(again['status'],'unconfirmed'); self.assertEqual(desktop.send_count,1)
    def test_cancel_at_durable_reservation_blocks_click_and_preserves_batch_result(self):
        persist=self.b._persist
        def cancel():
            persist()
            if any(x.get('status')=='sending' for x in self.b._ledger.values()): self.b.cancel_send(id='test')
        self.b._persist=cancel
        with self.fixture() as desktop:
            result=self.b.send_batch(self.job(messages=['第一句','第二句']))
        self.assertEqual(result['status'],'cancelled'); self.assertEqual(desktop.send_count,0)
    def test_human_opens_wechat_after_first_bubble_stops_tail_without_restoring_focus(self):
        desktop=Desktop(); desktop.after_send=lambda d:setattr(d,'fg',10)
        with self.fixture(desktop): result=self.b.send_batch(self.job(messages=['第一句','第二句']))
        self.assertEqual(result['status'],'cancelled'); self.assertEqual(desktop.send_count,1); self.assertEqual(desktop.fg,10)
    def test_programmatic_activation_after_first_bubble_keeps_batch_running_with_intent_observer(self):
        import threading
        desktop=Desktop();changed=threading.Event();closed=[]
        desktop.watch_input=lambda hwnd:SimpleNamespace(changed=changed,healthy=lambda:True,close=lambda:closed.append(True))
        desktop.after_send=lambda d:(setattr(d,'fg',10),setattr(d,'stamp',d.stamp+1))
        with self.fixture(desktop):result=self.b.send_batch(self.job(messages=['第一句','第二句','第三句']))
        self.assertEqual(result['status'],'confirmed');self.assertEqual(desktop.send_count,3);self.assertEqual(len(closed),1)
    def test_inactive_pause_and_invalid_mode_never_construct_native_adapter(self):
        with self.fixture() as desktop:
            for mode in ('auto','bad',True):
                with self.assertRaises(worker.BridgeError): self.b.send(self.job(sendMode=mode))
            self.b._active.clear()
            with self.assertRaises(worker.BridgeError): self.b.send(self.job())
        self.assertEqual(desktop.calls,[])


if __name__=='__main__': unittest.main()
