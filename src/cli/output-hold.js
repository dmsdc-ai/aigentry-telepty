'use strict';
// Bounded recent terminal bytes for a temporarily disconnected owner transport.
// Limits count UTF16 units (matching PTY stream offsets), not lossless scrollback.
function createOutputHold({maxChars=256*1024,maxChunks=1024}={}) {
  if(!Number.isSafeInteger(maxChars)||maxChars<1||!Number.isSafeInteger(maxChunks)||maxChunks<1)throw new Error('Invalid output hold limits');
  // V8 substring slices can retain the entire incoming allocation. Encode only an
  // already-bounded range, then decode its owned bytes; UTF16LE preserves code units.
  const owned = value => Buffer.from(value, 'utf16le').toString('utf16le');
  let chunks=[],length=0;
  function consume(count) {
    if(!Number.isSafeInteger(count)||count<0||count>length)throw new Error('Invalid output hold prefix');
    length-=count;
    while(count>0 && chunks.length) {
      if(chunks[0].length<=count)count-=chunks.shift().length;
      else {chunks[0]=owned(chunks[0].slice(count));count=0;}
    }
  }
  function trimPrefix(count) {
    consume(count);
    // An overflow cut may land between a surrogate pair. Keep only complete pairs.
    if(chunks.length && /^[\uDC00-\uDFFF]/.test(chunks[0]))consume(1);
  }
  return {
    push(data) {
      if(typeof data!=='string')throw new Error('Invalid held output');
      if(!data.length)return;
      if(data.length>maxChars) {
        let start=data.length-maxChars;
        if(/[\uDC00-\uDFFF]/.test(data[start]) && /[\uD800-\uDBFF]/.test(data[start-1]))start++;
        data=data.slice(start);chunks=[];length=0;
      }
      if(!data.length)return;
      chunks.push(owned(data));length+=data.length;
      if(length>maxChars)trimPrefix(length-maxChars);
      while(chunks.length>maxChunks)trimPrefix(chunks[0].length);
    },
    consume,
    clear(){chunks=[];length=0;},
    snapshot:()=>chunks.join(''),
    get length(){return length;},
    get chunks(){return chunks.length;}
  };
}
module.exports={createOutputHold};
