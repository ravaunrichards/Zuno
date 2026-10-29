'use strict';
const { load, validateRequired } = require('../config');
const c = load();
const v = validateRequired(c);
console.log('ZUNO environment check');
console.log('  node env     :', c.nodeEnv);
console.log('  supabase     :', c.configured.supabase ? 'configured' : 'NOT configured');
console.log('  livekit      :', c.configured.livekit ? 'configured' : 'NOT configured');
console.log('  paypal       :', c.configured.paypal ? 'configured' : 'NOT configured');
console.log('  prod payments:', c.features.productionPayments ? 'ENABLED' : 'disabled');
if (!v.ok) { console.log('  problems     :', v.problems.join('; ')); process.exit(1); }
console.log('  base config  : ok');
