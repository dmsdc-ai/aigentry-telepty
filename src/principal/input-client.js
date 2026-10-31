'use strict';
const {runPrincipalEffect}=require('./effect-client');
const profile={code:'INPUT',namespace:'strict-input/v1',prefix:'/api/input/sessions/',action:'session.input_stream',
  streamSchema:'telepty.input-stream/v1',receiptSchema:'telepty.input-receipt/v1',mode:'signed-http-inject',
  defaultEffect:'inject',effects:{inject:{kind:'inject',suffix:'inject',action:'session.inject'}}};
const runPrincipalInput=(mode,parameters)=>runPrincipalEffect(profile,mode,parameters);
module.exports={runPrincipalInput};
