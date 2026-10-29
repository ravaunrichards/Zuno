'use strict';
const {createNotificationWorker}=require('./notification-worker');
const {createDeliveryWorker}=require('./notification-delivery-worker');
const {createPrivacyExportWorker}=require('./privacy-export-worker');
const outbox=createNotificationWorker();
const delivery=createDeliveryWorker();
const privacyExports=createPrivacyExportWorker();
let stopped=false;
const shutdown=()=>{stopped=true;outbox.stop();delivery.stop();privacyExports.stop();};
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
Promise.all([outbox.run(),delivery.run(),privacyExports.run()]).catch(error=>{
 console.error('[zuno-workers] startup failed',String(error&&error.code||'WORKER_START_FAILED'));
 process.exitCode=1;
}).finally(()=>{if(stopped)process.exitCode=0;});
