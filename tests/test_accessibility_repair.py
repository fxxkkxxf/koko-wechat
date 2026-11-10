"""Provider repair state machine, no native process access in these tests."""
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('gate_repair_test',Path(__file__).parents[1]/'bridge/accessibility_repair.py')
repair=importlib.util.module_from_spec(spec);spec.loader.exec_module(repair)

class Gate:
    def __init__(self,values):self.values=dict(values);self.candidates=list(values);self.writes=[]
    def read(self,key):return self.values[key]
    def write(self,key,value):self.values[key]=value;self.writes.append((key,value));return True

class RepairTests(unittest.TestCase):
    def test_already_one_with_empty_provider_requires_zero_one_edge(self):
        gate=Gate({12:1});seen=[]
        def read():
            seen.append(1);ready=gate.writes==[(12,0),(12,1)]
            return {'nodes':178 if ready else 2,'edit':object() if ready else None}
        result=repair.pulse_candidates(gate,read,lambda:None,sleep=lambda _:None)
        self.assertTrue(result['ready']);self.assertEqual(result['nodesAfter'],178);self.assertEqual(gate.values[12],1)
    def test_root_class_or_node_count_alone_is_not_success(self):
        for initial in (0,1):
            gate=Gate({12:initial})
            result=repair.pulse_candidates(gate,lambda:{'nodes':200,'class':'mmui::MainWindow'},lambda:None,sleep=lambda _:None)
            self.assertFalse(result['ready']);self.assertEqual(gate.values[12],initial)
    def test_failed_candidates_restore_before_next_candidate(self):
        gate=Gate({12:0,18:1})
        def read():return {'nodes':100,'rows':[('目标群',object())]} if gate.writes[-2:]==[(18,0),(18,1)] else {'nodes':2}
        result=repair.pulse_candidates(gate,read,lambda:None,sleep=lambda _:None)
        self.assertTrue(result['ready']);self.assertEqual(result['candidatesTried'],2)
        self.assertEqual(gate.values,{12:0,18:1});self.assertIn((12,0),gate.writes)
    def test_unknown_bytes_are_never_modified(self):
        gate=Gate({12:7,18:None});result=repair.pulse_candidates(gate,lambda:{},lambda:None,sleep=lambda _:None)
        self.assertFalse(result['ready']);self.assertEqual(gate.writes,[])
    def test_cancel_after_zero_restores_original(self):
        gate=Gate({12:1})
        def check():
            if gate.writes:raise RuntimeError('cancelled')
        with self.assertRaisesRegex(RuntimeError,'cancelled'):repair.pulse_candidates(gate,lambda:{},check,sleep=lambda _:None)
        self.assertEqual(gate.writes,[(12,0),(12,1)])
    def test_failed_restore_stops_remaining_candidates(self):
        gate=Gate({12:1,18:1});write=gate.write
        gate.write=lambda key,value:False if len(gate.writes)>=2 else write(key,value)
        with self.assertRaisesRegex(RuntimeError,'回滚'):repair.pulse_candidates(gate,lambda:{},lambda:None,sleep=lambda _:None)
        self.assertFalse(any(key==18 for key,value in gate.writes))
    def test_provider_read_errors_are_bounded_and_restore(self):
        gate=Gate({12:0});reads=[]
        def read():reads.append(1);raise RuntimeError('stale element')
        result=repair.pulse_candidates(gate,read,lambda:None,sleep=lambda _:None)
        self.assertFalse(result['ready']);self.assertEqual(len(reads),10);self.assertEqual(gate.values[12],0)
    def test_candidate_work_is_bounded(self):
        gate=Gate(dict.fromkeys(range(10),0));result=repair.pulse_candidates(gate,lambda:{},lambda:None,sleep=lambda _:None)
        self.assertEqual(result['candidatesTried'],4)
    def test_navigation_rows_are_usable_without_an_open_editor(self):
        self.assertTrue(repair.tree_ready({'rows':[('目标群',object())]}))
        self.assertFalse(repair.tree_ready({'nodes':999,'rows':[],'edit':None}))

if __name__=='__main__':unittest.main()
