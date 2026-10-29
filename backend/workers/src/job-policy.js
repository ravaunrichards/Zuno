'use strict';
const TRANSITIONS={queued:['running','cancelled'],retrying:['running','cancelled','dead_letter'],running:['succeeded','retrying','dead_letter'],succeeded:[],dead_letter:['queued'],cancelled:[]};
function canTransition(from,to){return Boolean(TRANSITIONS[from]&&TRANSITIONS[from].includes(to));}
function retryDelayMs(attempt,base=1000,maximum=300000){const n=Number.isInteger(attempt)&&attempt>0?attempt:1;return Math.min(maximum,base*(2**Math.min(n-1,20)));}
function nextState(attempt,maxAttempts){return attempt>=maxAttempts?'dead_letter':'retrying';}
module.exports={TRANSITIONS,canTransition,retryDelayMs,nextState};
