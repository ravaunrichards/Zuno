'use strict';
const {test,ok,eq}=require('../../tools/test-harness');
const {THRESHOLDS,LEVEL_50_THRESHOLD,ULTIMATE_UNIVERSE_MILESTONE,levelFor}=require('../../packages/gift-engine/src/levels');
test('gifter levels start at zero and reach the exact 100 million coin level-50 requirement',()=>{
 eq(THRESHOLDS.length,51);
 eq(THRESHOLDS[0],0);
 eq(THRESHOLDS[50],100000000);
 eq(LEVEL_50_THRESHOLD,100000000);
 eq(levelFor(0).level,0);
 eq(levelFor(99999999).level,49);
 eq(levelFor(100000000).level,50);
 eq(ULTIMATE_UNIVERSE_MILESTONE,1000000);
 ok(THRESHOLDS.every((v,i)=>i===0||v>THRESHOLDS[i-1]));
});
