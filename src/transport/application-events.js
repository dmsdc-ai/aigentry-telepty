'use strict';
const { createScopedReadTransport } = require('./scoped-read');
// This map is intentionally distinct from trusted session events and legacy busClients.
const subscribers = new WeakMap();
function publishApplicationEvent(session, event) {
  let matched = 0;
  for (const send of subscribers.get(session) || []) if (send(event)) matched++;
  return matched;
}
function createApplicationEventTransport(deps) {
  return createScopedReadTransport(deps,{prefix:'/api/application-events/',subscribers,
    authorize:(auth,req)=>auth.authorizeApplicationEvents(req),codePrefix:'APPLICATION_EVENTS',refusalMessage:'Application event reader refused.',
    secureTransport:true,type:'application_events',schema:'telepty.read-only-application-events/v1',maxFrameBytes:8192});
}
module.exports={createApplicationEventTransport,publishApplicationEvent};
