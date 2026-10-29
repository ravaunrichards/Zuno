'use strict';
const {server,config}=require('../backend/api/src/server');
if(!server.listening){
 server.listen(config.apiPort,'0.0.0.0',()=>console.log('ZUNO API listening on port '+config.apiPort));
}
