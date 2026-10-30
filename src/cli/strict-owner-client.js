'use strict';
// Bind every application frame to this finite owner connection. Output is split
// conservatively in UTF16 units while preserving surrogate pairs and stream offsets.
function bindStrictOwnerClient(ws) {
  const send=ws.send.bind(ws);let connectionId=null,sequence=0,inbound=0,expiresAt=null,advertisedExpiry=null,timer;
  ws.once?.('close',()=>clearTimeout(timer));
  ws.send=data=>{
    let sentUnits=0;
    try {
      if(!connectionId || Date.now()>=expiresAt)throw new Error('STRICT_OWNER_NOT_BOUND');
      const frame=JSON.parse(data);
      const output=frame.type==='output';
      if(output && typeof frame.data!=='string')throw new Error('STRICT_OWNER_OUTPUT_INVALID');
      const length=output?frame.data.length:0;
      do {
        let end=output?Math.min(length,sentUnits+8192):0;
        if(output && end<length && /[\uD800-\uDBFF]/.test(frame.data[end-1]))end--;
        const part=output?{...frame,data:frame.data.slice(sentUnits,end),...(Number.isSafeInteger(frame.stream_offset)?{stream_offset:frame.stream_offset+sentUnits}:{})}:frame;
        const encoded=JSON.stringify({...part,connection_id:connectionId,sequence:sequence+1});
        if(Buffer.byteLength(encoded)>131072 || ws.bufferedAmount>262144)throw new Error('STRICT_OWNER_BACKPRESSURE');
        send(encoded);sequence++;sentUnits=end;
      }while(output && sentUnits<length);
    }catch(error){error.sentUnits=sentUnits;ws.terminate();throw error;}
  };
  return {
    accept(frame) {
      if(!frame || typeof frame.connection_id!=='string' || !/^[a-f0-9-]{36}$/.test(frame.connection_id)
        || !Number.isSafeInteger(frame.sequence) || frame.sequence!==inbound+1
        || !Number.isSafeInteger(frame.expires_at) || frame.expires_at<=Date.now() || frame.expires_at>Date.now()+61000
        || (connectionId && (frame.connection_id!==connectionId || frame.expires_at!==advertisedExpiry || Date.now()>=expiresAt)) || (!connectionId && frame.type!=='owner_token')) {ws.terminate();return false;}
      if(!connectionId){advertisedExpiry=frame.expires_at;expiresAt=Math.min(advertisedExpiry,Date.now()+60000);
        timer=setTimeout(()=>ws.terminate(),Math.max(1,expiresAt-Date.now()));timer.unref();}
      connectionId=frame.connection_id;inbound=frame.sequence;return true;
    }
  };
}
module.exports={bindStrictOwnerClient};
