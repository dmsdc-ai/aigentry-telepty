'use strict';
const crypto = require('node:crypto');
const { verifiedRequestPrincipal, storedOwningPrincipal } = require('../principal/http');
const { validApplicationBody } = require('../application-publication');
const { localSocket } = require('../transport/strict-owner');
const { publishApplicationEvent } = require('../transport/application-events');
function registerApplicationEventRoute(app,{sessions}) {
  app.post('/api/sessions/:id/events',(req,res)=>{
    const id=req.params.id,session=Object.getOwnPropertyDescriptor(sessions,id)?.value;
    const principal=verifiedRequestPrincipal(req,{action:'session.publish',target:id});
    const fail=(status,code)=>res.status(status).json({success:false,code});
    if(!principal || !localSocket(req.socket))return fail(403,'APPLICATION_PUBLICATION_DENIED');
    if(!session || session.isClosing || typeof session.sessionEpoch!=='string')return fail(409,'APPLICATION_SESSION_UNAVAILABLE');
    const owner=storedOwningPrincipal(session.owningPrincipal);
    if(!owner || owner.id!==principal.id || owner.audience!==principal.audience)return fail(403,'PRINCIPAL_SESSION_OWNER_REQUIRED');
    if(!validApplicationBody(req.body,session.sessionEpoch))return fail(400,'APPLICATION_EVENT_INVALID');
    const publicationId=crypto.randomUUID();
    const event={schema:'telepty.application-event/v1',type:'application_event',session_id:id,session_epoch:session.sessionEpoch,
      publication_id:publicationId,timestamp:new Date().toISOString(),topic:req.body.topic,data:req.body.data,
      actor:{id:principal.id,key_id:principal.keyId,audience:principal.audience,source:'ed25519'},
      trusted_daemon_event:false,data_untrusted:true,foreign_session_identity_verified:false};
    const matched=publishApplicationEvent(session,event);
    res.json({success:true,session_id:id,publication_id:publicationId,matched_socket_count:matched,delivery_ack:false});
  });
}
module.exports={registerApplicationEventRoute};
