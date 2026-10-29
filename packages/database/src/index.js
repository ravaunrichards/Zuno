'use strict';
/** Reusable database access — re-exports the Supabase client factory and offers
 *  a repository layer the backend services call. Service-role client is created
 *  only inside trusted server processes. */
const supabase = require('../../../integrations/supabase');

function serverClient(config) {
  return supabase.createClient(config.supabase, { serviceRole: true });
}
function userClient(config) {
  return supabase.createClient(config.supabase, { serviceRole: false });
}
module.exports = { serverClient, userClient };
