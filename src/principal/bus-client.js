'use strict';
const {runPrincipalEffect}=require('./effect-client');
const profile={code:'BUS',namespace:'strict-bus/v1',prefix:'/api/bus/sessions/',action:'session.bus',
  streamSchema:'telepty.bus-effect-stream/v1',receiptSchema:'telepty.bus-effect-receipt/v1',mode:'signed-http-session-effects',
  effects:{state_report:{kind:'state',suffix:'state',action:'session.state'},
    routed_turn:{kind:'inject',suffix:'inject',action:'session.inject'},
    app_publish:{kind:'publish',suffix:'events',action:'session.publish'}}};
const runPrincipalBus=(mode,parameters)=>runPrincipalEffect(profile,mode,parameters);
module.exports={runPrincipalBus};
