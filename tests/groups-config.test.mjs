import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeGroup} from '../lib/groups.mjs';
test('group config defaults are addressed with a bounded cooldown',()=>{const x=normalizeGroup({chatId:'123@chatroom'});assert.equal(x.mode,'addressed');assert.equal(x.cooldownSeconds,8);assert.equal(x.followupSeconds,90);});
test('non-group IDs and invalid trigger modes are rejected',()=>{assert.throws(()=>normalizeGroup({chatId:'owner'}));assert.throws(()=>normalizeGroup({chatId:'123@chatroom',mode:'always'}));});
test('group toggles retain the explicit trigger and alias settings',()=>{const old=normalizeGroup({chatId:'123@chatroom',mode:'mention',aliases:['可可']});const x=normalizeGroup({chatId:old.chatId,enabled:false},old);assert.deepEqual(x.aliases,['可可']);assert.equal(x.mode,'mention');assert.equal(x.enabled,false);});
test('unsafe timing and malformed aliases cannot reach bridge config',()=>{assert.throws(()=>normalizeGroup({chatId:'123@chatroom',cooldownSeconds:0}));assert.throws(()=>normalizeGroup({chatId:'123@chatroom',aliases:['@所有人']}));});
