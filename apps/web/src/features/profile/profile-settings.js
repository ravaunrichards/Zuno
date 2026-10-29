import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';

const CONSENT_PURPOSES = [
  ['personalization','Personalized recommendations'],
  ['analytics','Product analytics'],
  ['personalized_ads','Personalized advertising'],
  ['marketing','Marketing messages'],
  ['third_party_measurement','Third-party measurement'],
  ['notifications','Notification processing']
];
const POLICY_VERSION = 'zuno-privacy-v1';
const RELATIONSHIPS = [
  { kind:'blocks', label:'Blocked' },
  { kind:'mutes', label:'Muted' },
  { kind:'restrictions', label:'Restricted' }
];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
function showStatus(id, message, isError = false) {
  const target = $(id);
  if (!target) return;
  target.textContent = message || '';
  target.classList.toggle('is-error', Boolean(isError));
}
function key() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2,'0')).join('');
  }
  throw new Error('Secure request IDs are not available in this browser. Use an up-to-date browser over HTTPS.');
}
function requireSession() {
  if (getSession()) return true;
  showStatus('profile-settings-status','Sign in to manage profile settings.');
  $('auth-state-button')?.click();
  return false;
}
function openDialog() {
  const dialog = $('profile-settings-dialog');
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
  else dialog.setAttribute('open','');
}
function closeDialog() {
  const dialog = $('profile-settings-dialog');
  if (typeof dialog?.close === 'function' && dialog.open) dialog.close();
  else dialog?.removeAttribute('open');
}

async function loadProfile() {
  const result = await requestJson('/api/profile/me');
  const profile = result.profile || {};
  $('settings-display-name').value = profile.displayName || profile.username || '';
  $('settings-bio').value = profile.bio || '';
  $('settings-visibility').value = ['public','private','restricted'].includes(profile.visibility) ? profile.visibility : 'public';
}
async function saveProfile(event) {
  event.preventDefault();
  if (!requireSession()) return;
  const button = $('profile-settings-save');
  if (button) button.disabled = true;
  showStatus('profile-settings-status','Saving profile…');
  try {
    const result = await requestJson('/api/profile/me', {
      method:'PATCH',
      body:{
        display_name:$('settings-display-name').value.trim(),
        bio:$('settings-bio').value,
        visibility:$('settings-visibility').value
      }
    });
    $('settings-display-name').value = result.profile?.displayName || $('settings-display-name').value.trim();
    showStatus('profile-settings-status','Profile saved to your account.');
  } catch (error) {
    showStatus('profile-settings-status',error.message || 'Profile could not be saved.',true);
  } finally { if (button) button.disabled = false; }
}

async function loadNotificationPreferences() {
  const result = await requestJson('/api/notifications/preferences');
  const prefs = result.preferences?.values || {};
  document.querySelectorAll('[data-notification-flag]').forEach(input => {
    input.checked = typeof prefs[input.dataset.notificationFlag] === 'boolean' ? prefs[input.dataset.notificationFlag] : false;
  });
  $('settings-quiet-start').value = result.preferences?.quietHoursStart || '';
  $('settings-quiet-end').value = result.preferences?.quietHoursEnd || '';
}
async function saveNotificationPreferences(event) {
  event.preventDefault();
  if (!requireSession()) return;
  const start = $('settings-quiet-start').value || null;
  const end = $('settings-quiet-end').value || null;
  if (Boolean(start) !== Boolean(end)) {
    showStatus('notification-settings-status','Set both quiet-hours times or leave both empty.',true);
    return;
  }
  const preferences = {};
  document.querySelectorAll('[data-notification-flag]').forEach(input => { preferences[input.dataset.notificationFlag] = input.checked; });
  const button = $('notification-settings-save');
  if (button) button.disabled = true;
  showStatus('notification-settings-status','Saving notification preferences…');
  try {
    await requestJson('/api/notifications/preferences',{method:'PATCH',body:{preferences,quietHoursStart:start,quietHoursEnd:end}});
    showStatus('notification-settings-status','Notification preferences saved.');
  } catch (error) {
    showStatus('notification-settings-status',error.message || 'Notification preferences could not be saved.',true);
  } finally { if (button) button.disabled = false; }
}

function renderConsents(consents) {
  const box = $('privacy-consent-list');
  if (!box) return;
  box.replaceChildren();
  const latest = new Map();
  for (const item of consents) if (!latest.has(item.purpose)) latest.set(item.purpose,item);
  for (const [purpose,label] of CONSENT_PURPOSES) {
    const row = el('div','privacy-consent-row');
    const copy = el('div','privacy-consent-copy');
    copy.append(el('strong','',label));
    const current = latest.get(purpose);
    copy.append(el('small','',current ? 'Latest: '+current.status+' · '+new Date(current.recordedAt).toLocaleDateString() : 'No decision recorded'));
    const control = el('div','privacy-consent-control');
    const select = el('select','');
    select.setAttribute('aria-label',label+' consent status');
    for (const [value,text] of [['granted','Allow'],['denied','Deny'],['withdrawn','Withdraw']]) {
      const option = el('option','',text); option.value=value; select.append(option);
    }
    select.value = current && ['granted','denied','withdrawn'].includes(current.status) ? current.status : 'denied';
    const save = el('button','button button-secondary button-small','Record');
    save.type='button';
    save.addEventListener('click',async()=>{
      save.disabled=true;
      showStatus('privacy-consent-status','Recording consent choice…');
      try {
        await requestJson('/api/privacy/consents',{
          method:'POST',headers:{'Idempotency-Key':key()},
          body:{purpose,status:select.value,policyVersion:POLICY_VERSION}
        });
        showStatus('privacy-consent-status','Consent decision recorded in your history.');
        await loadConsents();
      } catch (error) {
        showStatus('privacy-consent-status',error.message||'Consent decision could not be recorded.',true);
      } finally { save.disabled=false; }
    });
    control.append(select,save); row.append(copy,control); box.append(row);
  }
}
async function loadConsents() {
  const result = await requestJson('/api/privacy/consents');
  renderConsents(Array.isArray(result.consents)?result.consents:[]);
}

function renderRelationshipList(kind, records) {
  const box = $('relationship-list-'+kind);
  if (!box) return;
  box.replaceChildren();
  if (!records.length) { box.append(el('p','settings-inline-status','No '+(kind==='blocks'?'blocked profiles':kind==='mutes'?'muted profiles':'restricted profiles')+'.')); return; }
  for (const record of records) {
    const row = el('div','relationship-row');
    const profile = record.profile || {};
    const copy = el('div','relationship-row-copy');
    copy.append(el('strong','',profile.displayName || profile.username || 'Profile unavailable'));
    copy.append(el('small','',profile.username ? '@'+profile.username : record.profileId));
    if (record.reasonCode) copy.append(el('small','','Reason: '+record.reasonCode));
    const remove = el('button','button button-secondary button-small','Remove');
    remove.type='button';
    remove.addEventListener('click',async()=>{
      remove.disabled=true;
      try {
        await requestJson('/api/relationships/'+kind+'?profileId='+encodeURIComponent(record.profileId),{method:'DELETE'});
        showStatus('relationship-settings-status','Relationship removed.');
        await loadRelationships();
      } catch (error) {
        showStatus('relationship-settings-status',error.message||'Relationship could not be removed.',true);
      } finally { remove.disabled=false; }
    });
    row.append(copy,remove); box.append(row);
  }
}
async function loadRelationships() {
  for (const item of RELATIONSHIPS) {
    try {
      const result = await requestJson('/api/relationships/'+item.kind);
      renderRelationshipList(item.kind,Array.isArray(result.relationships)?result.relationships:[]);
    } catch (error) {
      const box=$('relationship-list-'+item.kind);
      if(box)box.replaceChildren(el('p','settings-inline-status',error.message||item.label+' list unavailable.'));
    }
  }
}
async function addRelationship(event) {
  event.preventDefault();
  if (!requireSession()) return;
  const profileId=$('relationship-profile-id').value.trim();
  const kind=$('relationship-kind').value;
  const reasonCode=$('relationship-reason').value.trim();
  const button=$('relationship-add');
  if(button)button.disabled=true;
  showStatus('relationship-settings-status','Applying safety action…');
  try {
    await requestJson('/api/relationships/'+kind,{method:'POST',body:{profileId,reasonCode:reasonCode||null}});
    showStatus('relationship-settings-status',kind==='blocks'?'Profile blocked. Existing follows in both directions were removed.':kind==='mutes'?'Profile muted.':'Profile restricted.');
    $('relationship-profile-id').value='';
    $('relationship-reason').value='';
    await loadRelationships();
  } catch(error) {
    showStatus('relationship-settings-status',error.message||'Safety action could not be applied.',true);
  } finally {if(button)button.disabled=false;}
}

async function loadDataRequests() {
  const result = await requestJson('/api/privacy/data-requests');
  const box=$('data-request-history');
  if(!box)return;
  box.replaceChildren();
  const requests=Array.isArray(result.requests)?result.requests:[];
  if(!requests.length){box.append(el('p','settings-inline-status','No data rights requests have been submitted.'));return;}
  requests.forEach(item=>{
    const row=el('div','data-request-row');
    const name=({export:'Data export',deletion:'Account deletion',correction:'Data correction',restriction:'Processing restriction'})[item.requestType]||item.requestType;
    const details=el('div','data-request-row-copy');
    details.append(el('strong','',name));
    details.append(el('small','',String(item.state||'submitted')+' · '+new Date(item.requestedAt).toLocaleString()));
    if(item.resolutionCode)details.append(el('small','','Resolution: '+item.resolutionCode));
    if(item.resultAvailable)details.append(el('small','','A result is recorded for this request. A downloadable link is not shown unless the server provides one.'));
    row.append(details);box.append(row);
  });
}
async function submitDataRequest(event) {
  event.preventDefault();
  if (!requireSession()) return;
  const type=$('data-request-type').value;
  if (type==='deletion' && !window.confirm('Submit a formal request to delete your ZUNO account and personal data? This records a request; it does not delete the account instantly.')) return;
  const reason=$('data-request-reason').value.trim();
  const button=$('data-request-submit');
  if(button)button.disabled=true;
  showStatus('data-request-status','Submitting your privacy request…');
  try {
    const result=await requestJson('/api/privacy/data-requests',{
      method:'POST',headers:{'Idempotency-Key':key()},body:{requestType:type,reason}
    });
    showStatus('data-request-status',result.existingOpenRequest?'An open request of this type already exists.':result.idempotent?'This request was already recorded.':'Your privacy request was recorded. Completion is tracked separately.');
    $('data-request-reason').value='';
    await loadDataRequests();
  } catch(error) {
    showStatus('data-request-status',error.message||'Privacy request could not be submitted.',true);
  } finally {if(button)button.disabled=false;}
}

let mounted=false;
let loadBusy=false;
async function openSettings() {
  if (!requireSession()) return;
  openDialog();
  if(loadBusy)return;
  loadBusy=true;
  showStatus('profile-settings-status','Loading account settings…');
  const results=await Promise.allSettled([loadProfile(),loadNotificationPreferences(),loadConsents(),loadRelationships(),loadDataRequests()]);
  const failed=results.filter(result=>result.status==='rejected');
  if(failed.length)showStatus('profile-settings-status','Some settings could not load. Check the status shown in each section and retry.',true);
  else showStatus('profile-settings-status','Account settings loaded from ZUNO.');
  loadBusy=false;
}
export function mountProfileSettings() {
  if(mounted)return;
  mounted=true;
  document.querySelectorAll('[data-action="profile-info"]').forEach(button=>button.addEventListener('click',openSettings));
  document.querySelectorAll('[data-close-profile-settings]').forEach(button=>button.addEventListener('click',closeDialog));
  $('profile-settings-form')?.addEventListener('submit',saveProfile);
  $('notification-settings-form')?.addEventListener('submit',saveNotificationPreferences);
  $('relationship-settings-form')?.addEventListener('submit',addRelationship);
  $('data-request-form')?.addEventListener('submit',submitDataRequest);
  $('profile-settings-dialog')?.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  window.addEventListener('zuno:session-change',()=>{if(!getSession())closeDialog();});
}
