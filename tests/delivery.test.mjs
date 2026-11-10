import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryResult} from '../lib/delivery.mjs';
test('batch acknowledgements preserve only matching ordered bubbles',()=>{assert.deepEqual(deliveryResult({status:'partial',parts:[{index:0,text:'第一句',status:'confirmed'},{index:1,text:'第二句',status:'unconfirmed'}]},['第一句','第二句']).parts.map(x=>x.status),['confirmed','unconfirmed']);assert.equal(deliveryResult({status:'confirmed'},['一','二']).confirmed,false);assert.equal(deliveryResult({status:'confirmed',parts:[{index:0,text:'不是要发的',status:'confirmed'}]},['一','二']).parts.length,0);});
test('a cancelled batch retains delivered prefix and never fabricates its tail',()=>{const r=deliveryResult({status:'cancelled',cancelled:true,parts:[{index:0,text:'一',status:'confirmed'}]},['一','二','三']);assert(r.cancelled);assert(!r.confirmed);assert.equal(r.parts.length,1);});
test('single send remains compatible and blocked sends do not become spoken history',()=>{assert(deliveryResult({confirmed:true},['一']).confirmed);assert.equal(deliveryResult({status:'blocked'},['一']).parts.length,0);});
