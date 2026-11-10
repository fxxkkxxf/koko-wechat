import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseDefaultModel,fastestEffort} from '../lib/models.mjs';
const models=[{model:'gpt-6.1-sol',isDefault:true},{model:'gpt-5.6-luna'},{model:'gpt-6-luna'}];
test('fresh install chooses available modern Luna instead of CLI default',()=>assert.equal(chooseDefaultModel(models),'gpt-6-luna'));
test('user model choice survives restart',()=>assert.equal(chooseDefaultModel(models,'gpt-6.1-sol'),'gpt-6.1-sol'));
test('unavailable ID is never invented or kept as an active selection',()=>assert.equal(chooseDefaultModel([{model:'gpt-6.1-sol',isDefault:true}],'missing'),'gpt-6.1-sol'));
test('lowest supported effort is selected for speed',()=>assert.equal(fastestEffort({supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'none'}]}),'none'));
