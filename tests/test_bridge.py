"""Behavioral checks for duplicate/uncertain sends, identity and fresh messages."""
import importlib.util
import contextlib
from pathlib import Path
import sys
import tempfile
import time
import unittest
import sqlite3
import threading
from unittest.mock import patch
from types import SimpleNamespace

stdout, stderr = sys.stdout, sys.stderr
spec = importlib.util.spec_from_file_location('koko_bridge', Path(__file__).parents[1] / 'bridge/worker.py')
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)
sys.stdout, sys.stderr = stdout, stderr


class BridgeTests(unittest.TestCase):
    def test_explicit_rebind_resolves_current_process_instead_of_cached_window(self):
        self.b._catalog={'small':{'id':'small','name':'小号','pid':10,'hwnd':20}}
        fresh={'id':'small','name':'小号','pid':30,'hwnd':40}
        self.b._detect=lambda:{'small':fresh}
        self.assertIs(self.b._resolve_account('small'),fresh)

    def test_missing_selected_account_never_falls_back_to_cached_or_other_login(self):
        self.b._catalog={'small':{'id':'small','name':'小号','pid':10,'hwnd':20}}
        self.b._detect=lambda:{'other':{'id':'other','name':'别的账号','pid':30,'hwnd':40}}
        with self.assertRaises(bridge.BridgeError) as caught:self.b._resolve_account('small')
        self.assertEqual(caught.exception.code,'SELECT_ACCOUNT')

    def test_database_cache_follows_process_instance_but_not_window_size_or_handle(self):
        created=[]
        class DB:
            def __init__(self,**kwargs):self.wxid='small';created.append(kwargs)
            def get_self_info(self):return {'nick_name':'小号'}
        dbmod=SimpleNamespace(WeChatDB=DB)
        self.b._modules=lambda:(None,None,None,dbmod)
        account={'id':'small','name':'小号','pid':10,'hwnd':20,'processStartedAt':1,'root':'test-root','account':'small_abcd'}
        first=self.b._database(account)
        self.assertIs(self.b._database({**account,'hwnd':21}),first)
        second=self.b._database({**account,'pid':30,'processStartedAt':2})
        self.assertIsNot(first,second)
        self.assertEqual(dbmod._weixin_pids(),[30])
        third=self.b._database({**account,'pid':30,'processStartedAt':3})
        self.assertIsNot(second,third)
        self.assertEqual(len(created),3)

    def test_main_window_choice_survives_z_order_and_minimized_login_shell(self):
        main={'id':'small','pid':10,'hwnd':20,'normalArea':790*591}
        login={'id':'small','pid':10,'hwnd':21,'normalArea':440*556}
        for windows in ([main,login],[login,main]):
            self.assertEqual(bridge.select_account_windows(windows)['small']['hwnd'],20)
        self.assertEqual(bridge.select_account_windows([main,{**main,'hwnd':22}]),{})
        self.assertEqual(bridge.select_account_windows([main,{**main,'pid':11,'hwnd':22}]),{})

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.b = bridge.Bridge(self.directory.name)
        self.b._account = {'id':'small', 'name':'小号'}
        self.b._chat = {'id':'owner', 'name':'大号'}
        self.b._active.set()

    def tearDown(self):
        self.directory.cleanup()

    def job(self):
        return {'id':'job-1', 'accountId':'small', 'chatId':'owner', 'text':'你好', 'sendMode':'foreground', 'expiresAt':bridge.now_ms()+10000}

    def test_paused_send_never_reaches_windows(self):
        self.b._active.clear()
        with self.assertRaises(bridge.BridgeError) as caught:
            self.b.send(self.job())
        self.assertEqual(caught.exception.code, 'PAUSED')

    def test_wrong_recipient_is_rejected(self):
        job = self.job(); job['chatId'] = 'stranger'
        with self.assertRaises(bridge.BridgeError) as caught:
            self.b.send(job)
        self.assertEqual(caught.exception.code, 'TARGET_MISMATCH')

    def test_expired_generation_is_rejected(self):
        job = self.job(); job['expiresAt'] = bridge.now_ms()-1
        with self.assertRaises(bridge.BridgeError) as caught:
            self.b.send(job)
        self.assertEqual(caught.exception.code, 'EXPIRED')

    def test_same_job_does_not_send_twice(self):
        self.b._ledger['job-1'] = {'id':'job-1', 'status':'confirmed'}
        self.assertEqual(self.b.send(self.job())['status'], 'confirmed')

    def test_uncertain_send_quarantines_chat(self):
        self.b._ledger['old'] = {'id':'old', 'accountId':'small', 'chatId':'owner', 'status':'unconfirmed'}
        with self.assertRaises(bridge.BridgeError) as caught:
            self.b.send(self.job())
        self.assertEqual(caught.exception.code, 'NEEDS_REVIEW')

    def test_restart_never_replays_in_progress_job(self):
        self.b._ledger['old'] = {'id':'old', 'status':'sending'}
        self.b._persist()
        other = bridge.Bridge(self.directory.name)
        self.assertEqual(other._ledger['old']['status'], 'unconfirmed')

    def test_old_identical_message_cannot_confirm(self):
        row = {'shard':'a', 'local_id':1, 'sender_username':'small', 'content':'你好', 'create_time':time.time()}
        self.assertIsNone(bridge.confirm_sent([row], {'owner:a:1'}, 'small', 'owner', '你好', bridge.now_ms()))

    def test_other_sender_cannot_confirm(self):
        row = {'shard':'a', 'local_id':2, 'sender_username':'owner', 'content':'你好', 'create_time':time.time()}
        self.assertIsNone(bridge.confirm_sent([row], set(), 'small', 'owner', '你好', bridge.now_ms()))

    def test_new_own_message_in_another_shard_can_confirm(self):
        row = {'shard':'b', 'local_id':1, 'sender_username':'small', 'content':'你好', 'create_time':time.time()}
        self.assertEqual(bridge.confirm_sent([row], {'owner:a:1'}, 'small', 'owner', '你好', bridge.now_ms()), row)

    def test_sender_identity_and_pause_filter_events(self):
        captured = []
        original = bridge.emit
        bridge.emit = captured.append
        try:
            row = {'type':'文本', 'sender_username':'stranger', 'content':'测试', 'shard':'a', 'local_id':1}
            self.b._on_message(row)
            self.assertEqual(captured, [])
            row['sender_username'] = 'owner'
            self.b._on_message(row)
            self.assertEqual(captured[-1]['data']['senderId'], 'owner')
            self.b._active.clear()
            self.b._on_message(row)
            self.assertEqual(len(captured), 1)
        finally:
            bridge.emit = original

    def test_user_switching_windows_prevents_focus_restoration(self):
        class Desktop:
            def GetForegroundWindow(self): return 99
            def SetWindowPlacement(self, *_): raise AssertionError('must not override user takeover')
        self.assertFalse(bridge.restore_window(Desktop(), 10, (0, 1, 0, 0, 0), 20))

    def test_closed_original_window_does_not_trigger_foreground_call(self):
        class Desktop:
            restored = False
            def GetForegroundWindow(self): return 10
            def SetWindowPlacement(self, *_): self.restored = True
            def IsWindow(self, _): return False
        desktop = Desktop()
        self.assertFalse(bridge.restore_window(desktop, 10, (0, 1, 0, 0, 0), 20))
        self.assertTrue(desktop.restored)

    def test_qt_delayed_input_is_waited_for_until_exact(self):
        class Editor:
            readings = ['', '', '收到～', '收到～']
            def _chat_input(self): return self
            def _read_edit_value(self, _):
                return self.readings.pop(0) if len(self.readings)>1 else self.readings[0]
        self.assertTrue(bridge.wait_for_edit(Editor(), '收到～', timeout=.6))

    def test_partial_or_extra_input_never_passes_readback(self):
        class Editor:
            def _chat_input(self): return self
            def _read_edit_value(self, _): return '收到～还有人工草稿'
        self.assertFalse(bridge.wait_for_edit(Editor(), '收到～', timeout=.1))
        self.assertFalse(bridge.edit_text_equal(' 收到～', '收到～'))
        self.assertFalse(bridge.edit_text_equal('收到～\n', '收到～'))
        self.assertTrue(bridge.edit_text_equal('一\r\n二', '一\n二'))

    def test_pause_during_readback_prevents_send_readiness(self):
        class Editor:
            def _chat_input(self): return self
            def _read_edit_value(self, _): return ''
        def stop():
            raise bridge.BridgeError('PAUSED', 'paused')
        with self.assertRaises(bridge.BridgeError):
            bridge.wait_for_edit(Editor(), '收到～', check=stop, timeout=.1)

    def test_real_at_metadata_is_authoritative_over_text_alias(self):
        xml = '<msgsource><atuserlist><![CDATA[other]]></atuserlist></msgsource>'
        evidence = bridge.mention_evidence(xml, '@小号 你来回答', 'small', ['小号'])
        self.assertFalse(evidence['atMe'])
        self.assertEqual(evidence['mentionedIds'], ['other'])
        self.assertEqual(evidence['mentionBasis'], 'metadata')
        self.assertTrue(evidence['hasOtherMention'])

    def test_metadata_at_self_and_other_members_keep_separate_ids(self):
        xml = '<msgsource><atuserlist>small,other</atuserlist></msgsource>'
        evidence = bridge.mention_evidence(xml, '你们怎么看', 'small', ['小号'])
        self.assertTrue(evidence['atMe'])
        self.assertEqual(evidence['mentionedIds'], ['small', 'other'])

    def test_alias_fallback_requires_complete_at_name(self):
        self.assertFalse(bridge.mention_evidence(None, '@小号的朋友 你好', 'small', ['小号'])['atMe'])
        evidence = bridge.mention_evidence(None, '@小号\u2005你好 @其他人', 'small', ['小号'])
        self.assertTrue(evidence['atMe'])
        self.assertEqual(evidence['mentionBasis'], 'alias_text')
        self.assertEqual(evidence['mentionedIds'], [])
        self.assertTrue(evidence['hasOtherMention'])
        self.assertFalse(bridge.mention_evidence(None, '小号是谁', 'small', ['小号'])['atMe'])

    def fake_group_db(self):
        class DB:
            reads = []
            def search_contact(self, key):
                return [{'username':'owner','nick_name':'大号','remark':''}] if key in ('owner', '大号') else []
            def get_messages(self, key, limit=1):
                self.reads.append(key)
                return [{'sort_seq':17 if key=='owner' else 41}]
        return DB()

    def setup_group_binding(self):
        self.b._active.clear()
        db = self.fake_group_db()
        self.b._resolve_account = lambda ident: {'id':'small', 'name':'小号'}
        self.b._database = lambda account: db
        self.b._group_metadata = lambda database, keyword='': [{'id':'chosen@chatroom','chatId':'chosen@chatroom','name':'选中群','type':'group','memberCount':3}]
        self.b._group_members = lambda database, chat, fresh=False: [
            {'username':'small','nick_name':'小号','room_name':'群内小号'},
            {'username':'other','nick_name':'另一成员'},
            {'username':'owner','nick_name':'大号'}]
        return db

    def test_group_binding_retains_explicit_primary_private_chat(self):
        db = self.setup_group_binding()
        result = self.b.bind(accountId='small',chatId='owner',targets=[
            {'chatId':'owner','type':'private'},
            {'chatId':'chosen@chatroom','type':'group','name':'不可信的外部群名','aliases':['可可']}])
        self.assertEqual(result['chatId'],'owner')
        self.assertEqual(len(result['targets']),2)
        group = self.b._target_map()['chosen@chatroom']
        self.assertEqual(group['name'],'选中群')
        self.assertEqual(group['selfAliases'],['群内小号','小号'])
        self.assertIn('可可',group['aliases'])
        self.assertEqual(db.reads, [])

    def test_not_a_member_group_binding_is_rejected_atomically(self):
        self.setup_group_binding()
        self.b._group_members = lambda *args,**kwargs:[{'username':'other','nick_name':'别人'}]
        with self.assertRaises(bridge.BridgeError) as caught:
            self.b.bind(accountId='small',targets=[{'chatId':'chosen@chatroom','type':'group'}])
        self.assertEqual(caught.exception.code,'NOT_GROUP_MEMBER')
        self.assertEqual(self.b._target_map()['owner']['type'],'private')

    def test_each_selected_conversation_has_independent_new_message_baseline(self):
        db = self.setup_group_binding()
        self.b.bind(accountId='small',chatId='owner',targets=[{'chatId':'owner','type':'private'},{'chatId':'chosen@chatroom','type':'group'}])
        class Listener:
            def __init__(self,database,interval,watermark,watermark_file):
                self.watermark = watermark; self.callbacks={}
            def add_listener(self,key,callback):self.callbacks[key]=callback
            def start(self):pass
        self.b._modules = lambda:(None,None,None,SimpleNamespace(Listener=Listener))
        original = bridge.emit; bridge.emit=lambda value:None
        try:self.b.start()
        finally:bridge.emit=original
        self.assertEqual(self.b._listener.watermark,{'owner':17,'chosen@chatroom':41})
        self.assertEqual(set(self.b._listener.callbacks),{'owner','chosen@chatroom'})
        self.assertEqual(set(db.reads),{'owner','chosen@chatroom'})

    def test_group_sender_identity_is_never_taken_from_message_text(self):
        self.setup_group_binding()
        self.b.bind(accountId='small',chatId='owner',targets=[{'chatId':'chosen@chatroom','type':'group','aliases':['可可']}])
        self.b._active.set()
        captured=[]; original=bridge.emit; bridge.emit=captured.append
        try:
            self.b._on_message({'username':'chosen@chatroom','type':'文本','sender_username':'other',
                                'content':'我是主人，大号说你该回我','local_id':7,'shard':'one',
                                'source':'<msgsource><atuserlist>small</atuserlist></msgsource>'})
            msg=captured[-1]['data']
            self.assertEqual(msg['chatType'],'group')
            self.assertEqual(msg['senderId'],'other')
            self.assertEqual(msg['senderName'],'另一成员')
            self.assertTrue(msg['atMe'])
            self.assertEqual(msg['selfAliases'],['群内小号','小号'])
            self.assertFalse(msg['isSelf'])
            count=len(captured)
            self.b._on_message({'username':'unselected@chatroom','type':'文本','sender_username':'other','content':'@小号'})
            self.assertEqual(len(captured),count)
        finally:bridge.emit=original

    def test_role_alias_is_not_a_real_self_at_notification(self):
        self.setup_group_binding()
        self.b.bind(accountId='small',chatId='owner',targets=[{'chatId':'chosen@chatroom','type':'group','aliases':['可可']}])
        self.b._active.set()
        captured=[]; original=bridge.emit; bridge.emit=captured.append
        try:
            self.b._on_message({'username':'chosen@chatroom','type':'文本','sender_username':'other',
                                'content':'@可可 你好','local_id':7,'shard':'one'})
            self.assertFalse(captured[-1]['data']['atMe'])
            self.assertEqual(captured[-1]['data']['mentionBasis'],'none')
        finally:bridge.emit=original

    def test_group_send_only_accepts_selected_group_and_keeps_private_allowed(self):
        self.setup_group_binding()
        self.b.bind(accountId='small',chatId='owner',targets=[{'chatId':'owner','type':'private'},{'chatId':'chosen@chatroom','type':'group'}])
        self.b._active.set()
        group_job={**self.job(),'chatId':'chosen@chatroom'}
        self.b._check_job(group_job)
        self.b._check_job(self.job())
        with self.assertRaises(bridge.BridgeError):
            self.b._check_job({**group_job,'chatId':'another@chatroom'})

    def test_explicit_targets_do_not_readd_deselected_primary(self):
        self.setup_group_binding()
        result=self.b.bind(accountId='small',chatId='owner',targets=[{'chatId':'chosen@chatroom','type':'group'}])
        self.assertEqual([x['id'] for x in result['targets']],['chosen@chatroom'])
        self.b._active.set()
        with self.assertRaises(bridge.BridgeError):self.b._check_job(self.job())

    def test_multiple_private_targets_are_independently_allowed(self):
        self.setup_group_binding()
        db=self.fake_group_db()
        db.search_contact=lambda key:[{'username':key,'nick_name':'好友'+key,'remark':''}] if key in ('owner','second') else []
        self.b._database=lambda account:db
        result=self.b.bind(accountId='small',chatId='owner',targets=[{'chatId':'owner','type':'private'},{'chatId':'second','type':'private'}])
        self.assertEqual({x['id'] for x in result['targets']},{'owner','second'})
        self.b._active.set()
        self.b._check_job({**self.job(),'chatId':'second'})
        captured=[];old=bridge.emit;bridge.emit=captured.append
        try:self.b._on_message({'username':'second','sender_username':'second','type':'文本','content':'你好','local_id':1,'shard':'one'})
        finally:bridge.emit=old
        self.assertEqual(captured[0]['data']['chatId'],'second')
        self.assertEqual(captured[0]['data']['senderName'],'好友second')

    def metadata_db(self):
        dbfile=Path(self.directory.name)/'contacts.sqlite'
        conn=sqlite3.connect(dbfile)
        conn.executescript('CREATE TABLE contact(id INTEGER PRIMARY KEY,username TEXT,nick_name TEXT,remark TEXT,local_type INTEGER,flag INTEGER,delete_flag INTEGER,verify_flag INTEGER,is_in_chat_room INTEGER);'
                           'CREATE TABLE chat_room(id INTEGER PRIMARY KEY,username TEXT,owner TEXT);'
                           'CREATE TABLE chatroom_member(room_id INTEGER,member_id INTEGER);')
        values=[(1,'small','小号','',1,3,0,0,0),(2,'friend','好友','备注好友',1,3,0,0,0),
                (3,'outsider','仅群成员','',3,4,0,0,0),(4,'filehelper','文件传输助手','',1,3,0,0,0),
                (5,'gh_official','公众号','',1,3,0,0,0),(6,'verified','认证公众号','',1,3,0,24,0),
                (7,'deleted','已删除','',1,3,1,0,0),(8,'one@chatroom','测试群','',2,2,0,0,1),
                (9,'left@chatroom','已退群','',2,2,0,0,2),(10,'other@chatroom','不在群里','',2,2,0,0,1)]
        conn.executemany('INSERT INTO contact VALUES (?,?,?,?,?,?,?,?,?)',values)
        conn.executemany('INSERT INTO chat_room VALUES (?,?,?)',[(1,'one@chatroom','friend'),(2,'left@chatroom','friend'),(3,'other@chatroom','friend')])
        conn.executemany('INSERT INTO chatroom_member VALUES (?,?)',[(1,1),(1,2),(1,3),(2,1),(2,2),(3,2),(3,3)])
        conn.commit();conn.close()
        class DB:
            def _contact_conn(self):
                c=sqlite3.connect(dbfile);c.row_factory=sqlite3.Row;return c
            def get_messages(self,*args,**kwargs):raise AssertionError('directory must never read messages')
            def get_group_members(self,*args,**kwargs):raise AssertionError('directory must never read member profiles')
            def get_sessions(self,*args,**kwargs):raise AssertionError('directory must never read session summaries')
        db=DB();self.b._resolve_account=lambda ident:{'id':'small','name':'小号'};self.b._database=lambda account:db
        return db,dbfile

    def test_directory_only_offers_friends_and_current_groups_not_cached_strangers(self):
        self.metadata_db()
        out=self.b.directory(accountId='small')
        self.assertEqual({x['chatId'] for x in out['items']},{'friend','one@chatroom'})
        group=next(x for x in out['items'] if x['type']=='group')
        self.assertEqual(group['memberCount'],3)
        self.assertEqual(out['excluded'],{'self':1,'system':1,'official':2,'deleted':1,'nonFriend':1,'nonMember':2,'unclassified':0})
        self.assertTrue(out['metadataOnly']);self.assertFalse(out['truncated']);self.assertIsNone(out['nextOffset'])
        self.assertEqual(next(x for x in out['items'] if x['type']=='private')['name'],'备注好友')

    def test_directory_pagination_and_search_are_explicit_and_stable(self):
        _,file=self.metadata_db();conn=sqlite3.connect(file)
        conn.executemany('INSERT INTO contact(username,nick_name,remark,local_type,flag,delete_flag,verify_flag) VALUES (?,?,?,1,3,0,0)',[(f'friend_{i}',f'Abc {i:04d}','') for i in range(505)])
        conn.commit();conn.close()
        first=self.b.directory(accountId='small',query='ABC',limit=500)
        self.assertEqual(first['total'],505);self.assertEqual(len(first['items']),500);self.assertTrue(first['truncated']);self.assertEqual(first['nextOffset'],500)
        second=self.b.directory(accountId='small',query='abc',offset=500,limit=500)
        self.assertEqual(len(second['items']),5);self.assertFalse(second['truncated']);self.assertIsNone(second['nextOffset'])
        self.assertFalse({x['chatId'] for x in first['items']}&{x['chatId'] for x in second['items']})

    def test_group_exact_lookup_after_first_thousand_entries_remains_bindable(self):
        db,file=self.metadata_db();conn=sqlite3.connect(file)
        conn.executemany('INSERT INTO chat_room(id,username,owner) VALUES (?,?,?)',[(i+10,f'room{i:04d}@chatroom','friend') for i in range(1005)])
        conn.commit();conn.close()
        out=self.b._group_metadata(db,'room1004@chatroom')
        self.assertEqual(len(out),1);self.assertEqual(out[0]['id'],'room1004@chatroom')

    def test_directory_rejects_bad_page_arguments_before_database_access(self):
        for args in ({'limit':0},{'limit':501},{'offset':-1},{'limit':True},{'offset':False}):
            with self.assertRaises(bridge.BridgeError):self.b.directory(accountId='small',**args)

    def test_private_target_title_never_redirects_to_same_named_contact_or_group(self):
        self.setup_group_binding()
        target={'id':'owner','name':'大号','type':'private'}
        db=SimpleNamespace(search_contact=lambda key:[{'username':'owner','nick_name':'大号'}])
        self.b._group_metadata=lambda database,keyword='':[]
        self.b._verify_private_target(db,target)
        db.search_contact=lambda key:[{'username':'owner','nick_name':'大号'},{'username':'second','nick_name':'大号'}]
        with self.assertRaises(bridge.BridgeError) as caught:self.b._verify_private_target(db,target)
        self.assertEqual(caught.exception.code,'AMBIGUOUS_PRIVATE')
        db.search_contact=lambda key:[{'username':'owner','nick_name':'大号'}]
        self.b._group_metadata=lambda database,keyword='':[{'id':'chosen@chatroom','name':'大号'}]
        with self.assertRaises(bridge.BridgeError):self.b._verify_private_target(db,target)
        db.search_contact=lambda key:[{'username':'owner','nick_name':'换名后'}]
        with self.assertRaises(bridge.BridgeError) as caught:self.b._verify_private_target(db,target)
        self.assertEqual(caught.exception.code,'PRIVATE_CHANGED')

    def batch_job(self):
        return {'id':'batch-1','accountId':'small','chatId':'owner','sendMode':'foreground',
                'messages':['我刚刚想了想','这样会好一点','你觉得怎么样'],
                'expiresAt':bridge.now_ms()+60000,'gapMs':250}

    def fake_batch_sender(self, statuses=None, after_send=None):
        calls=[]
        desktop=SimpleNamespace(foreground=20)
        desktop.GetForegroundWindow=lambda:desktop.foreground
        self.b._modules=lambda:(None,desktop,None,None)
        @contextlib.contextmanager
        def session(job):
            desktop.foreground=10
            try:yield {'gui':desktop,'hwnd':10}
            finally:
                if desktop.foreground==10:desktop.foreground=20
        self.b._send_session=session
        original_check=self.b._check_job
        def send(job):
            original_check(job)
            calls.append(job.copy())
            index=len(calls)-1
            value={'id':job['id'],'accountId':job['accountId'],'chatId':job['chatId'],
                   'status':statuses[index] if statuses else 'confirmed','messageId':'own:'+str(index+1)}
            self.b._ledger[job['id']]=value
            self.b._persist()
            if after_send:after_send(index,value,desktop)
            return value
        self.b._send_in_session=lambda job,session:send(job)
        return calls,desktop

    def test_batch_sends_distinct_parts_and_durably_replays_without_sending_twice(self):
        calls,_=self.fake_batch_sender()
        with patch.object(bridge.time,'sleep',lambda _:None):
            # Stub the real delay only, keeping every check between parts.
            self.b._wait_batch_gap=lambda *args:None
            result=self.b.send_batch(self.batch_job())
            again=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'confirmed')
        self.assertTrue(result['confirmed'])
        self.assertEqual([p['text'] for p in result['parts']],self.batch_job()['messages'])
        self.assertEqual([p['index'] for p in result['parts']],[0,1,2])
        self.assertEqual(len({call['id'] for call in calls}),3)
        self.assertEqual(len(calls),3)
        self.assertEqual(again['parts'],result['parts'])
        other=bridge.Bridge(self.directory.name)
        other._account=self.b._account;other._chat=self.b._chat;other._active.set()
        other.send=lambda job: self.fail('a confirmed batch must never send again')
        self.assertEqual(other.send_batch(self.batch_job())['status'],'confirmed')

    def test_batch_rejects_mutated_content_or_recipient_for_a_used_identifier(self):
        self.fake_batch_sender();self.b._wait_batch_gap=lambda *args:None
        self.b.send_batch(self.batch_job())
        for change in ({'messages':['changed']},{'chatId':'elsewhere'}):
            with self.assertRaises(bridge.BridgeError) as caught:self.b.send_batch({**self.batch_job(),**change})
            self.assertEqual(caught.exception.code,'BATCH_MISMATCH')

    def test_batch_partial_result_stops_after_first_unconfirmed_part(self):
        calls,_=self.fake_batch_sender(['confirmed','unconfirmed','confirmed'])
        self.b._wait_batch_gap=lambda *args:None
        result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'partial');self.assertFalse(result['confirmed'])
        self.assertEqual([p['status'] for p in result['parts']],['confirmed','unconfirmed'])
        self.assertEqual(len(calls),2)
        self.assertEqual(self.b.send_batch(self.batch_job())['status'],'partial')
        self.assertEqual(len(calls),2)

    def test_batch_first_blocked_part_has_no_confirmed_messages(self):
        calls,_=self.fake_batch_sender(['blocked','confirmed'])
        self.b._wait_batch_gap=lambda *args:None
        result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'blocked');self.assertEqual(len(calls),1)
        self.assertFalse(any(p['status']=='confirmed' for p in result['parts']))

    def test_cancel_send_stops_remaining_parts_but_does_not_pause_other_chats(self):
        def cancel(index,value,desktop):
            if index==0:self.b.cancel_send(id='batch-1')
        calls,_=self.fake_batch_sender(after_send=cancel)
        self.b._wait_batch_gap=lambda *args:None
        result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'cancelled');self.assertTrue(result['cancelled'])
        self.assertEqual([p['status'] for p in result['parts']],['confirmed'])
        self.assertEqual(len(calls),1);self.assertTrue(self.b._active.is_set())
        self.b._check_job(self.job())
        with self.assertRaises(bridge.BridgeError) as caught:self.b._check_job({**self.job(),'_batchId':'batch-1','_batchGeneration':self.b._send_generation})
        self.assertEqual(caught.exception.code,'CANCELLED')

    def test_cancel_queued_batch_never_reaches_windows(self):
        self.b.cancel_send(id='batch-1')
        self.b._modules=lambda:self.fail('cancelled batch must never inspect windows')
        result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'cancelled');self.assertEqual(result['parts'],[])

    def test_stop_then_quick_restart_cannot_resume_old_batch(self):
        def pause_restart(index,value,desktop):
            if index==0:self.b.stop();self.b._active.set()
        calls,_=self.fake_batch_sender(after_send=pause_restart)
        self.b._wait_batch_gap=lambda *args:None
        result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'cancelled');self.assertEqual(len(calls),1)
        self.assertTrue(self.b._active.is_set())

    def test_user_focus_takeover_between_parts_stops_the_batch(self):
        def switch(index,value,desktop):
            if index==0:desktop.foreground=99
        calls,_=self.fake_batch_sender(after_send=switch)
        self.b._wait_batch_gap=lambda *args:None
        result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'cancelled');self.assertEqual(result['code'],'USER_TAKEOVER')
        self.assertEqual(len(calls),1)

    def test_batch_does_not_steal_send_lock_from_another_operation(self):
        calls,_=self.fake_batch_sender();self.b._wait_batch_gap=lambda *args:None
        started=threading.Event();finished=threading.Event();result=[]
        def run():
            started.set();result.append(self.b.send_batch(self.batch_job()));finished.set()
        with self.b._lock:
            thread=threading.Thread(target=run);thread.start();self.assertTrue(started.wait(.5))
            self.assertFalse(finished.wait(.05));self.assertEqual(calls,[])
        thread.join(2)
        self.assertTrue(finished.is_set());self.assertEqual(result[0]['status'],'confirmed')

    def test_batch_gap_cancellation_remains_responsive_while_send_lock_is_owned(self):
        desktop=SimpleNamespace(GetForegroundWindow=lambda:20)
        finished=threading.Event();result=[]
        def wait():
            with self.b._lock:
                result.append(self.b._wait_batch_gap(self.batch_job(),self.b._send_generation,desktop,20,900))
            finished.set()
        thread=threading.Thread(target=wait);thread.start()
        self.b.cancel_send(id='batch-1')
        self.assertTrue(finished.wait(.3));thread.join(1)
        self.assertEqual(result,['CANCELLED'])

    def test_restart_cancels_incomplete_batch_and_preserves_confirmed_parts(self):
        import hashlib
        key='batch:'+hashlib.sha256(b'batch-1').hexdigest()
        self.b._ledger[key]={'id':key,'kind':'batch','accountId':'small','chatId':'owner','status':'preparing',
                            'textHashes':[hashlib.sha256(text.encode()).hexdigest() for text in self.batch_job()['messages']]}
        self.b._ledger[key+':part:1']={'id':key+':part:1','status':'confirmed'}
        self.b._ledger[key+':part:2']={'id':key+':part:2','status':'sending'}
        self.b._persist()
        other=bridge.Bridge(self.directory.name)
        other._account=self.b._account;other._chat=self.b._chat;other._active.set()
        other.send=lambda job:self.fail('a restarted batch must not resume')
        result=other.send_batch(self.batch_job())
        self.assertEqual(result['status'],'cancelled')
        self.assertEqual([p['status'] for p in result['parts']],['confirmed','unconfirmed'])

    def test_queued_batch_generation_cannot_survive_stop_then_enable(self):
        job={**self.batch_job(),'_queuedGeneration':self.b._send_generation}
        self.b.stop();self.b._active.set()
        self.b._modules=lambda:self.fail('an old queued batch must never inspect windows')
        result=self.b.send_batch(job)
        self.assertEqual(result['status'],'cancelled');self.assertEqual(result['parts'],[])

    def test_interrupted_in_process_batch_never_resumes_unknown_remainder(self):
        import hashlib
        key='batch:'+hashlib.sha256(b'batch-1').hexdigest()
        self.b._ledger[key]={'id':key,'kind':'batch','accountId':'small','chatId':'owner','status':'preparing',
                            'textHashes':[hashlib.sha256(text.encode()).hexdigest() for text in self.batch_job()['messages']]}
        self.b._ledger[key+':part:1']={'id':key+':part:1','status':'confirmed'}
        self.b.send=lambda job:self.fail('interrupted batches must not resume')
        result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'cancelled');self.assertEqual(len(result['parts']),1)

    def test_batch_validation_rejects_excessive_or_invalid_parts_before_windows(self):
        self.b._modules=lambda:self.fail('invalid batch must never inspect windows')
        for update in ({'messages':[]},{'messages':['a']*5},{'messages':['']},{'messages':[None]},
                       {'messages':['a'*2401]},{'gapMs':0},{'gapMs':1000},{'gapMs':True},
                       {'expiresAt':bridge.now_ms()-1},{'chatId':'stranger'}):
            with self.assertRaises(bridge.BridgeError):self.b.send_batch({**self.batch_job(),**update})

    @contextlib.contextmanager
    def native_send_fixture(self, after_enter=None, initial_chat='其他会话'):
        """Exercise real session/send code with no installed/native GUI calls."""
        state=SimpleNamespace(foreground=20,chat=initial_chat,value='',rows=[],
                              activations=0,opens=0,restores=0,enters=0,init=0,uninit=0,gaps=[])
        self.b._account.update(pid=12,hwnd=10)
        state.GetForegroundWindow=lambda:state.foreground
        state.GetWindowPlacement=lambda hwnd:(0,1,0,0,0)
        state.IsWindow=lambda hwnd:True
        def placement(hwnd,value):state.restores+=1
        state.SetWindowPlacement=placement
        self.b._modules=lambda:(None,state,None,None)
        self.b._detect=lambda:{'small':self.b._account}
        self.b._group_metadata=lambda *args:[]
        db=SimpleNamespace(search_contact=lambda key:[{'username':'owner','nick_name':'大号'}],
                           get_messages=lambda *args,**kwargs:list(reversed(state.rows)))
        self.b._database=lambda account:db
        self.b._phase=lambda *args:None
        self.b._wait_batch_gap=lambda job,generation,gui,hwnd,gap:state.gaps.append(gap)
        case=self
        class Driver:
            def __init__(self,**kwargs):pass
            def _activate(self,_):state.activations+=1;state.foreground=10
            def ensure_window(self):self._activate(None);return True
            def current_chat(self):return state.chat
            def open_chat(self,title,**kwargs):
                self.ensure_window();state.opens+=1;state.chat=title;return True
            def _chat_input(self):return self
            def _read_edit_value(self,edit):return state.value
            def _click_ctrl(self,edit):pass
            def _set_text(self,edit,text):state.value=text;return True
            def SendKeys(self,keys,**kwargs):
                case.assertEqual(keys,'{Enter}')
                # Verify a durable reservation exists before each Enter.
                saved=__import__('json').loads(case.b._ledger_path.read_text('utf-8'))
                case.assertTrue(any(x.get('status')=='sending' for x in saved.values()))
                state.enters+=1
                state.rows.append({'local_id':state.enters,'shard':'message_0.db',
                                   'sender_username':'small','content':state.value,'create_time':time.time()})
                state.value=''
                if after_enter:after_enter(state)
        def init():state.init+=1
        def uninit():state.uninit+=1
        automation=SimpleNamespace(InitializeUIAutomationInCurrentThread=init,UninitializeUIAutomationInCurrentThread=uninit)
        def focus(gui,hwnd):state.foreground=hwnd;return True
        with patch.dict(sys.modules,{'wechatauto.uia_driver':SimpleNamespace(WeChatUIA=Driver),'uiautomation':automation}),patch.object(bridge,'focus_window',focus):
            yield state

    def test_native_batch_has_one_activation_one_target_open_and_one_restore(self):
        with self.native_send_fixture() as ui:
            job=self.batch_job();job.pop('gapMs')
            result=self.b.send_batch(job)
        self.assertEqual(result['status'],'confirmed')
        self.assertEqual((ui.activations,ui.opens,ui.restores,ui.enters),(1,1,1,3))
        self.assertEqual((ui.init,ui.uninit),(1,1))
        self.assertEqual(ui.foreground,20)
        self.assertEqual(ui.gaps,[0,250,250])

    def test_native_batch_reuses_already_open_target_without_searching(self):
        with self.native_send_fixture(initial_chat='大号') as ui:
            result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'confirmed')
        self.assertEqual((ui.activations,ui.opens,ui.restores),(1,0,1))

    def test_native_identical_bubbles_have_distinct_confirmed_message_ids(self):
        with self.native_send_fixture() as ui:
            result=self.b.send_batch({**self.batch_job(),'messages':['同一句','同一句','同一句']})
        self.assertEqual(result['status'],'confirmed')
        self.assertEqual(len({x['messageId'] for x in result['parts']}),3)

    def test_native_foreground_takeover_stops_tail_without_restoring(self):
        def takeover(ui):ui.foreground=99
        with self.native_send_fixture(after_enter=takeover) as ui:
            result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'cancelled')
        self.assertEqual((ui.activations,ui.enters,ui.restores,ui.foreground),(1,1,0,99))
        self.assertEqual([x['status'] for x in result['parts']],['confirmed'])

    def test_native_chat_takeover_stops_tail_without_reopening_target(self):
        def takeover(ui):ui.chat='人工切到的其他聊天'
        with self.native_send_fixture(after_enter=takeover) as ui:
            result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'cancelled')
        self.assertEqual(result['code'],'USER_TAKEOVER')
        self.assertEqual((ui.opens,ui.enters,ui.restores),(1,1,0))

    def test_native_cancel_after_first_bubble_restores_once_and_never_resends(self):
        def cancel(ui):self.b.cancel_send(id='batch-1')
        with self.native_send_fixture(after_enter=cancel) as ui:
            result=self.b.send_batch(self.batch_job())
            replay=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'cancelled')
        self.assertEqual(replay['status'],'cancelled')
        self.assertEqual((ui.activations,ui.enters,ui.restores),(1,1,1))

    def test_native_cancel_during_reservation_prevents_the_unsent_enter(self):
        persist = self.b._persist
        cancelled = False
        def cancel_after_reservation():
            nonlocal cancelled
            persist()
            if not cancelled and any(value.get('status') == 'sending' for value in self.b._ledger.values()):
                cancelled = True
                self.b.cancel_send(id='batch-1')
        self.b._persist = cancel_after_reservation
        with self.native_send_fixture() as ui:
            result = self.b.send_batch(self.batch_job())
        self.assertTrue(cancelled)
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(ui.enters, 0)
        self.assertFalse(any(part['status'] == 'confirmed' for part in result['parts']))
        self.assertEqual(ui.value, '')
        self.assertEqual((ui.activations, ui.restores), (1, 1))

    def test_native_human_change_during_reservation_prevents_the_unsent_enter(self):
        for change in ('focus', 'draft'):
            with self.subTest(change=change):
                persist = self.b._persist
                changed = False
                with self.native_send_fixture() as ui:
                    def change_after_reservation():
                        nonlocal changed
                        persist()
                        if not changed and any(value.get('status') == 'sending' for value in self.b._ledger.values()):
                            changed = True
                            if change == 'focus':
                                ui.foreground = 99
                            else:
                                ui.value = '我临时修改的人工草稿'
                    self.b._persist = change_after_reservation
                    result = self.b.send_batch({**self.batch_job(), 'id':'reservation-'+change})
                self.b._persist = persist
                self.assertTrue(changed)
                self.assertEqual(ui.enters, 0)
                self.assertEqual(result['parts'][0]['status'], 'blocked')
                if change == 'focus':
                    self.assertEqual(result['status'], 'cancelled')
                    self.assertEqual(ui.foreground, 99)
                    self.assertEqual(ui.restores, 0)
                else:
                    self.assertEqual(result['status'], 'blocked')
                    self.assertEqual(ui.value, '我临时修改的人工草稿')
                    self.assertEqual(ui.restores, 1)

    def test_native_human_draft_between_bubbles_is_preserved(self):
        def draft(ui):ui.value='我手动写的草稿'
        with self.native_send_fixture(after_enter=draft) as ui:
            result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'partial')
        self.assertEqual([x['status'] for x in result['parts']],['confirmed','blocked'])
        self.assertEqual(ui.value,'我手动写的草稿')
        self.assertEqual((ui.enters,ui.restores),(1,1))

    def test_native_single_send_uses_same_verified_session_and_restores_once(self):
        with self.native_send_fixture() as ui:
            result=self.b.send(self.job())
        self.assertEqual(result['status'],'confirmed')
        self.assertEqual((ui.activations,ui.opens,ui.restores,ui.enters),(1,1,1,1))

    def test_native_changed_account_never_activates_and_releases_automation(self):
        with self.native_send_fixture() as ui:
            self.b._detect=lambda:{'small':{**self.b._account,'pid':999}}
            result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'blocked')
        self.assertEqual(result['code'],'ACCOUNT_CHANGED')
        self.assertEqual((ui.activations,ui.enters,ui.restores,ui.init,ui.uninit),(0,0,0,1,1))

    def test_native_initial_draft_is_not_changed_or_sent(self):
        with self.native_send_fixture() as ui:
            ui.value='原有的人工草稿'
            result=self.b.send_batch(self.batch_job())
        self.assertEqual(result['status'],'blocked')
        self.assertEqual(result['code'],'HUMAN_DRAFT')
        self.assertEqual(ui.value,'原有的人工草稿')
        self.assertEqual((ui.enters,ui.opens,ui.restores),(0,0,1))

    def test_incoming_image_has_native_attachment_and_hides_transport_xml(self):
        calls=[];captured=[]
        self.b._image_payload=lambda chat,row,**kwargs:calls.append((chat,row['local_id'])) or {'images':[{'path':'C:/local/picture.png','mimeType':'image/png','source':'original'}]}
        with patch.object(bridge,'emit',captured.append):
            self.b._on_message({'username':'owner','sender_username':'owner','type':'图片','local_id':4,'shard':'message_0.db','content':'<msg secret="transport">'} )
        self.assertEqual(calls,[('owner',4)])
        self.assertEqual(captured[0]['data']['text'],'[图片]')
        self.assertEqual(captured[0]['data']['images'][0]['mimeType'],'image/png')
        self.assertNotIn('transport',str(captured))

    def test_unselected_or_self_images_are_never_read(self):
        self.b._image_payload=lambda *args:self.fail('unselected/self media must not be read')
        with patch.object(bridge,'emit',lambda _:None):
            for chat,sender in [('stranger','stranger'),('owner','small'),('owner','stranger')]:
                self.b._on_message({'username':chat,'sender_username':sender,'type':'图片','local_id':1,'shard':'message_0.db'})

    def test_failed_incoming_image_emits_explicit_attachment_error(self):
        def fail(*args,**kwargs):raise ValueError('private/path/must/not/leak')
        self.b._image_payload=fail;captured=[]
        with patch.object(bridge,'emit',captured.append):
            self.b._on_message({'username':'owner','sender_username':'owner','type':'图片','local_id':4,'shard':'message_0.db'})
        msg=captured[0]['data']
        self.assertEqual(msg['images'],[])
        self.assertIn('没有',msg['attachmentError'])
        self.assertNotIn('private',msg['attachmentError'])

    def test_stale_listener_callback_is_dropped_before_media_or_database_reads(self):
        self.b._listener = object()
        self.b._image_payload = lambda *args,**kwargs: self.fail('stale media must not be read')
        self.b._database = lambda *args: self.fail('stale callback must not read a database')
        captured = []
        with patch.object(bridge, 'emit', captured.append):
            self.b._on_message({'username':'owner','sender_username':'owner','type':'图片','local_id':4,'shard':'message_0.db'}, object())
        self.assertEqual(captured, [])

    def test_inflight_image_is_discarded_after_stop_or_same_account_listener_restart(self):
        for restart in (False, True):
            with self.subTest(restart=restart):
                self.b._active.set()
                original_listener = object()
                self.b._listener = original_listener
                captured = []
                def finish_old_image(*args, **kwargs):
                    self.b._active.clear()
                    self.b._send_generation += 1
                    self.b._listener = object() if restart else None
                    if restart:
                        self.b._active.set()
                    return {'images':[{'path':'unused-old-image.png','mimeType':'image/png','source':'original'}]}
                self.b._image_payload = finish_old_image
                with patch.object(bridge, 'emit', captured.append):
                    self.b._on_message({'username':'owner','sender_username':'owner','type':'图片','local_id':4,'shard':'message_0.db'}, original_listener)
                self.assertEqual(captured, [])

    def test_inflight_image_keeps_captured_account_and_is_discarded_on_account_change(self):
        captured, accounts = [], []
        original_listener = object()
        self.b._listener = original_listener
        def finish_old_image(chat, row, **kwargs):
            accounts.append(kwargs['account']['id'])
            self.b._account = {'id':'new-small','name':'另一个小号'}
            return {'images':[{'path':'unused-old-image.png','mimeType':'image/png','source':'original'}]}
        self.b._image_payload = finish_old_image
        with patch.object(bridge, 'emit', captured.append):
            self.b._on_message({'username':'owner','sender_username':'owner','type':'图片','local_id':4,'shard':'message_0.db'}, original_listener)
        self.assertEqual(accounts, ['small'])
        self.assertEqual(captured, [])

    def test_image_payload_uses_explicit_account_snapshot_instead_of_new_selection(self):
        original = {'id':'small','name':'原小号','pid':12,'hwnd':10}
        db = SimpleNamespace(cfg_dword=1234)
        database_accounts, received_accounts = [], []
        self.b._account = {'id':'new-small','name':'另一个小号','pid':99,'hwnd':100}
        self.b._database = lambda account: database_accounts.append(account['id']) or db
        image = SimpleNamespace(receive_image=lambda database,chat,row,output,**kwargs:
                                received_accounts.append(kwargs['account_id']) or {'images':[]})
        with patch.dict(sys.modules, {'koko_wechat_vision':image}):
            self.b._image_payload('owner', {}, account=original)
        self.assertEqual(database_accounts, ['small'])
        self.assertEqual(received_accounts, ['small'])

    def test_media_database_delay_cannot_continue_after_callback_is_invalidated(self):
        valid = True
        def database(account):
            nonlocal valid
            valid = False
            return SimpleNamespace(cfg_dword=None)
        self.b._database = database
        self.b._detect = lambda: self.fail('invalidated media must not extract cfg')
        image = SimpleNamespace(receive_image=lambda *args,**kwargs:self.fail('invalidated media must not decode'))
        with patch.dict(sys.modules, {'koko_wechat_vision':image}):
            result = self.b._image_payload('owner', {}, account={'id':'small','pid':12,'hwnd':10}, check=lambda:valid)
        self.assertEqual(result['images'], [])

    def test_group_image_keeps_authoritative_sender_and_at_evidence(self):
        self.setup_group_binding()
        self.b.bind(accountId='small',targets=[{'chatId':'chosen@chatroom','type':'group'}])
        self.b._active.set();captured=[]
        self.b._image_payload=lambda chat,row,**kwargs:{'images':[],'attachmentError':'尚未下载'}
        with patch.object(bridge,'emit',captured.append):
            self.b._on_message({'username':'chosen@chatroom','sender_username':'other','local_type':3,'local_id':3,
                                'shard':'message_0.db','source':'<msgsource><atuserlist>small</atuserlist></msgsource>'})
        self.assertEqual(captured[0]['data']['senderId'],'other')
        self.assertTrue(captured[0]['data']['atMe'])
        self.assertEqual(captured[0]['data']['text'],'[图片]')

    def test_image_cfg_reads_only_verified_selected_pid_once(self):
        db=SimpleNamespace(cfg_dword=None);calls=[]
        self.b._account.update(pid=12,hwnd=10)
        self.b._database=lambda account:db
        self.b._detect=lambda:{'small':self.b._account}
        dbmod=SimpleNamespace(extract_master_key_from_cfg=lambda pid:calls.append(pid) or ('unused',1234,'small'))
        self.b._modules=lambda:(None,None,None,dbmod)
        image=SimpleNamespace(receive_image=lambda *args,**kwargs:{'images':[],'attachmentError':'fixture'})
        with patch.dict(sys.modules,{'koko_wechat_vision':image}):
            self.b._image_payload('owner',{})
            self.b._image_payload('owner',{})
        self.assertEqual(calls,[12]);self.assertEqual(db.cfg_dword,1234)

    def test_image_cfg_rejects_a_different_returned_account(self):
        db=SimpleNamespace(cfg_dword=None)
        self.b._account.update(pid=12,hwnd=10)
        self.b._database=lambda account:db
        self.b._detect=lambda:{'small':self.b._account}
        dbmod=SimpleNamespace(extract_master_key_from_cfg=lambda pid:('unused',1234,'other'))
        self.b._modules=lambda:(None,None,None,dbmod)
        image=SimpleNamespace(receive_image=lambda *args,**kwargs:{'images':[]})
        with patch.dict(sys.modules,{'koko_wechat_vision':image}):self.b._image_payload('owner',{})
        self.assertIsNone(db.cfg_dword)

    def test_image_that_materializes_after_its_event_is_read_once_ready(self):
        db=SimpleNamespace(cfg_dword=1234);calls=[];waits=[]
        self.b._database=lambda account:db
        picture={'path':'C:/fixture/current.png','mimeType':'image/png','source':'thumbnail'}
        def receive(database,chat,row,output,**kwargs):
            calls.append((chat,row['local_id'],kwargs['account_id']))
            return ({'images':[],'attachmentError':'尚未下载','attachmentRetryable':True}
                    if len(calls)==1 else {'images':[picture]})
        self.b._wait_image_retry=lambda seconds,check:waits.append(seconds) or True
        with patch.dict(sys.modules,{'koko_wechat_vision':SimpleNamespace(receive_image=receive)}):
            result=self.b._image_payload('owner',{'local_id':7})
        self.assertEqual(result['images'],[picture])
        self.assertEqual(calls,[('owner',7,'small'),('owner',7,'small')])
        self.assertEqual(waits,[.15])

    def test_retry_budget_and_polling_remain_bounded_to_current_image(self):
        db=SimpleNamespace(cfg_dword=1234);clock=[10.0];sleeps=[];calls=[]
        self.b._database=lambda account:db
        def receive(database,chat,row,output,**kwargs):
            calls.append((chat,row['local_id']))
            return {'images':[],'attachmentError':'本机尚未有附件','attachmentRetryable':True}
        def sleep(seconds):
            sleeps.append(seconds);clock[0]+=seconds
        with patch.dict(sys.modules,{'koko_wechat_vision':SimpleNamespace(receive_image=receive)}), \
             patch.object(bridge.time,'monotonic',lambda:clock[0]),patch.object(bridge.time,'sleep',sleep):
            result=self.b._image_payload('owner',{'local_id':8})
        self.assertEqual(len(calls),5)
        self.assertTrue(all(x==('owner',8) for x in calls))
        self.assertLessEqual(clock[0]-10.0,2.0)
        self.assertTrue(all(0<=x<=.05 for x in sleeps))
        self.assertEqual(result['images'],[])

    def test_slow_transient_read_does_not_start_another_read_after_deadline(self):
        db=SimpleNamespace(cfg_dword=1234);clock=[10.0];calls=[]
        self.b._database=lambda account:db
        def receive(*args,**kwargs):
            calls.append(True);clock[0]+=.8
            return {'images':[],'attachmentRetryable':True}
        def sleep(seconds):clock[0]+=seconds
        with patch.dict(sys.modules,{'koko_wechat_vision':SimpleNamespace(receive_image=receive)}), \
             patch.object(bridge.time,'monotonic',lambda:clock[0]),patch.object(bridge.time,'sleep',sleep):
            self.b._image_payload('owner',{})
        self.assertEqual(len(calls),2)
        self.assertLessEqual(clock[0]-10.0,2.00001)

    def test_stopping_during_image_retry_discards_it_without_another_decode(self):
        db=SimpleNamespace(cfg_dword=1234);clock=[0.0];calls=[];sleeps=[];active=[True]
        self.b._database=lambda account:db
        def receive(*args,**kwargs):
            calls.append(True);return {'images':[],'attachmentRetryable':True}
        def sleep(seconds):
            sleeps.append(seconds);clock[0]+=seconds;active[0]=False
        with patch.dict(sys.modules,{'koko_wechat_vision':SimpleNamespace(receive_image=receive)}), \
             patch.object(bridge.time,'monotonic',lambda:clock[0]),patch.object(bridge.time,'sleep',sleep):
            result=self.b._image_payload('owner',{},check=lambda:active[0])
        self.assertEqual(result,{'images':[]});self.assertEqual(len(calls),1)
        self.assertEqual(len(sleeps),1);self.assertLessEqual(sleeps[0],.05)

    def test_permanent_image_errors_and_usable_thumbnails_never_wait_or_retry(self):
        db=SimpleNamespace(cfg_dword=1234);self.b._database=lambda account:db
        self.b._wait_image_retry=lambda *args:self.fail('permanent failures and valid thumbnails do not wait')
        for value in ({'images':[],'attachmentError':'发送者不一致','attachmentRetryable':False},
                      {'images':[],'attachmentError':'WXGF转换超时'},
                      {'images':[{'path':'C:/fixture/thumb.jpg','source':'thumbnail'}],'attachmentRetryable':True}):
            calls=[]
            def receive(*args,**kwargs):calls.append(True);return value
            with patch.dict(sys.modules,{'koko_wechat_vision':SimpleNamespace(receive_image=receive)}):
                self.assertEqual(self.b._image_payload('owner',{}),value)
            self.assertEqual(len(calls),1)

    def test_image_cfg_failed_first_probe_can_recover_after_cooldown(self):
        db=SimpleNamespace(cfg_dword=None);calls=[];clock=[100.0]
        self.b._account.update(pid=12,hwnd=10)
        self.b._database=lambda account:db;self.b._detect=lambda:{'small':self.b._account}
        def extract(pid):calls.append(pid);return None if len(calls)==1 else ('unused',1234,'small')
        self.b._modules=lambda:(None,None,None,SimpleNamespace(extract_master_key_from_cfg=extract))
        image=SimpleNamespace(receive_image=lambda *args,**kwargs:{'images':[]})
        with patch.dict(sys.modules,{'koko_wechat_vision':image}),patch.object(bridge.time,'monotonic',lambda:clock[0]):
            self.b._image_payload('owner',{});self.assertIsNone(db.cfg_dword)
            clock[0]=101.0;self.b._image_payload('owner',{})
            self.assertEqual(calls,[12])
            clock[0]=111.0;self.b._image_payload('owner',{})
            self.assertEqual(db.cfg_dword,1234)
            clock[0]=112.0;self.b._image_payload('owner',{})
        self.assertEqual(calls,[12,12])

    def test_cfg_from_old_wechat_pid_is_not_reused_by_replacement_process(self):
        db=SimpleNamespace(cfg_dword=None);calls=[]
        self.b._account.update(pid=12,hwnd=10)
        self.b._database=lambda account:db;self.b._detect=lambda:{'small':self.b._account}
        def extract(pid):calls.append(pid);return ('unused',1234 if pid==12 else 5678,'small')
        self.b._modules=lambda:(None,None,None,SimpleNamespace(extract_master_key_from_cfg=extract))
        image=SimpleNamespace(receive_image=lambda *args,**kwargs:{'images':[]})
        with patch.dict(sys.modules,{'koko_wechat_vision':image}):
            self.b._image_payload('owner',{});self.assertEqual(db.cfg_dword,1234)
            self.b._account.update(pid=13,hwnd=11)
            self.b._image_payload('owner',{})
        self.assertEqual(calls,[12,13]);self.assertEqual(db.cfg_dword,5678)

    def test_cfg_extraction_finishing_after_listener_stop_is_not_cached_or_decoded(self):
        db=SimpleNamespace(cfg_dword=None);active=[True]
        self.b._account.update(pid=12,hwnd=10)
        self.b._database=lambda account:db;self.b._detect=lambda:{'small':self.b._account}
        def extract(pid):active[0]=False;return ('unused',1234,'small')
        self.b._modules=lambda:(None,None,None,SimpleNamespace(extract_master_key_from_cfg=extract))
        image=SimpleNamespace(receive_image=lambda *args,**kwargs:self.fail('stopped listener must not decode'))
        with patch.dict(sys.modules,{'koko_wechat_vision':image}):
            result=self.b._image_payload('owner',{},check=lambda:active[0])
        self.assertEqual(result,{'images':[]});self.assertIsNone(db.cfg_dword)

    def pending_entry(self,**extra):
        value={'id':'pending','accountId':'small','chatId':'owner','status':'unconfirmed',
               'text':'已发送的原句','createdAt':bridge.now_ms()-600,'sentAt':bridge.now_ms()-400,
               'beforeIds':['owner:message_0.db:1']}
        return {**value,**extra}

    def test_exact_pending_message_reconciles_readonly_without_new_send(self):
        entry=self.pending_entry();self.b._ledger[entry['id']]=entry
        row={'sender_username':'small','content':entry['text'],'create_time':entry['sentAt']/1000,
             'shard':'message_0.db','local_id':2}
        self.b._database=lambda account:SimpleNamespace(get_messages=lambda chat,limit:[row])
        self.b._modules=lambda:self.fail('reconciliation must never inspect UI')
        self.b._check_pending_send(self.job())
        self.assertEqual(entry['status'],'confirmed')
        self.assertEqual(entry['messageId'],'owner:message_0.db:2')
        self.assertTrue(entry['reconciled'])

    def test_pending_does_not_confirm_old_other_sender_or_later_duplicate(self):
        for changed in ({'local_id':1},{'sender_username':'owner'},{'content':'别的话'},
                        {'create_time':time.time()+60}):
            entry=self.pending_entry();self.b._ledger={'pending':entry}
            row={'sender_username':'small','content':entry['text'],'create_time':entry['sentAt']/1000,
                 'shard':'message_0.db','local_id':2,**changed}
            self.b._database=lambda account:SimpleNamespace(get_messages=lambda chat,limit:[row])
            with self.assertRaises(bridge.BridgeError) as caught:self.b._check_pending_send(self.job())
            self.assertEqual(caught.exception.code,'NEEDS_REVIEW')
            self.assertEqual(entry['status'],'unconfirmed')

    def test_legacy_pending_missing_baseline_stays_uncertain(self):
        entry=self.pending_entry();entry.pop('beforeIds');self.b._ledger={'pending':entry}
        self.b._database=lambda account:self.fail('legacy uncertainty must not trigger a broad DB search')
        self.assertEqual(self.b.pending_sends()['count'],1)
        self.assertEqual(entry['status'],'unconfirmed')

    def test_pending_list_excludes_unselected_accounts_chats_batches_and_reviewed(self):
        self.b._ledger={str(i):self.pending_entry(id=str(i),**change) for i,change in enumerate([
            {},{'accountId':'another'},{'chatId':'unselected'},{'kind':'batch'},{'reviewed':True}])}
        out=self.b.pending_sends(reconcile=False)
        self.assertEqual([x['id'] for x in out['items']],['0'])

    def test_manual_review_requires_pause_and_retains_uncertainty_without_replay(self):
        entry=self.pending_entry();self.b._ledger={'pending':entry}
        with self.assertRaises(bridge.BridgeError) as caught:self.b.review_send(id='pending',accountId='small',chatId='owner')
        self.assertEqual(caught.exception.code,'PAUSE_REQUIRED')
        self.b._active.clear()
        result=self.b.review_send(id='pending',accountId='small',chatId='owner')
        self.assertTrue(result['reviewed']);self.assertFalse(result['resent'])
        self.assertEqual(entry['status'],'unconfirmed')
        self.b._active.set();self.b._check_pending_send(self.job())
        self.b._modules=lambda:self.fail('acknowledged old reply must never resend')
        self.assertEqual(self.b.send({**self.job(),'id':'pending'})['status'],'unconfirmed')

    def test_review_cannot_acknowledge_another_account_chat_or_successful_send(self):
        self.b._active.clear();self.b._ledger={'pending':self.pending_entry()}
        for args in ({'accountId':'other','chatId':'owner'},{'accountId':'small','chatId':'other'}):
            with self.assertRaises(bridge.BridgeError):self.b.review_send(id='pending',**args)
        self.b._ledger['pending']['status']='confirmed'
        with self.assertRaises(bridge.BridgeError):self.b.review_send(id='pending',accountId='small',chatId='owner')


if __name__ == '__main__':
    unittest.main()
