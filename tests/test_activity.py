"""Intent classification and background integration; no real desktop hooks."""
import importlib.util
from pathlib import Path
import threading
import unittest
from types import SimpleNamespace

bridge=Path(__file__).parents[1]/'bridge'
spec=importlib.util.spec_from_file_location('activity_test',bridge/'activity.py');activity=importlib.util.module_from_spec(spec);spec.loader.exec_module(activity)
spec=importlib.util.spec_from_file_location('activity_bg_test',bridge/'background.py');bg=importlib.util.module_from_spec(spec);spec.loader.exec_module(bg)

class Desktop:
    def __init__(self):self.fg=99;self.stamp=5;self.value='';self.state=activity.ActivityState(10);self.closed=0;self.editor=object()
    def foreground(self):return self.fg
    def last_input(self):return self.stamp
    def valid(self,*a):return True
    def available(self,*a):return True
    def watch_input(self,hwnd):return SimpleNamespace(changed=self.state.changed,healthy=lambda:True,close=self.close)
    def close(self):self.closed+=1
    def read(self,hwnd):return {'pid':12,'chat':'测试群','value':self.value,'edit':self.editor,'send':object()}

class ActivityTests(unittest.TestCase):
    def test_mouse_motion_and_keys_or_clicks_in_other_apps_are_not_takeover(self):
        state=activity.ActivityState(10)
        for root in (10,99):state.mouse(0x200,root)
        for message in (0x201,0x20A,0x204):state.mouse(message,99)
        state.key(0x100,99,65);state.key(0x101,10,65)
        for modifier in (16,17,18,91,92):state.key(0x100,10,modifier)
        self.assertFalse(state.changed.is_set())
    def test_real_editor_keys_clicks_and_scrolling_in_bound_window_stop_the_turn(self):
        for event in ('key','click','scroll','horizontal-scroll'):
            state=activity.ActivityState(10)
            if event=='key':state.key(0x100,10,65)
            else:state.mouse({'click':0x201,'scroll':0x20A,'horizontal-scroll':0x20E}[event],10)
            self.assertTrue(state.changed.is_set())
            self.assertEqual(set(vars(state)),{'hwnd','changed'})
    def test_programmatic_foreground_changes_and_global_mouse_stamp_do_not_abort(self):
        desktop=Desktop();session=bg.BackgroundSession(desktop,10,12,'测试群',lambda:None).prepare()
        desktop.fg=10;desktop.stamp+=10;desktop.state.mouse(0x200,10);session.check()
        session.close();session.close();self.assertEqual(desktop.closed,1)
    def test_detected_intent_still_prevents_send_and_foreign_draft_cleanup(self):
        desktop=Desktop();session=bg.BackgroundSession(desktop,10,12,'测试群',lambda:None).prepare()
        desktop.value='人工输入';session.draft='人工输入';desktop.state.key(0x100,10,65)
        with self.assertRaises(bg.BackgroundError) as error:session.check()
        self.assertEqual(error.exception.code,'USER_TAKEOVER');session.close()
        self.assertEqual(desktop.value,'人工输入');self.assertEqual(desktop.closed,1)
    def test_missing_observer_fails_before_any_text_is_written(self):
        desktop=Desktop();desktop.watch_input=lambda hwnd:SimpleNamespace(changed=threading.Event(),healthy=lambda:False,close=desktop.close)
        session=bg.BackgroundSession(desktop,10,12,'测试群',lambda:None)
        try:
            with self.assertRaises(bg.BackgroundError) as error:session.prepare()
            self.assertEqual(error.exception.code,'BG_INPUT_STATE');self.assertEqual(desktop.value,'')
        finally:session.close()

if __name__=='__main__':unittest.main()
