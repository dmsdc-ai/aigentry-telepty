'use strict';
// Render local fixed text only; a server error/payload is never terminal markup.
function viewerInputRefusal(frame) {
  if(frame?.type!=='input_refused')return '';
  if(frame.code==='INPUT_WRITE_OUTCOME_UNKNOWN' || frame.bytes_written===null) return 'Input outcome is unknown. Check the receiver before retrying.';
  if(frame.code==='INPUT_FRAME_TOO_LARGE')return 'Input was refused: text exceeds 64 KiB.';
  if(frame.code==='INVALID_INPUT_FRAME')return 'Input was refused: expected text.';
  if(frame.code==='EXTERNAL_APPROVAL_REQUIRED')return 'Input was refused: external approval is required.';
  return 'Input was refused.';
}
module.exports={viewerInputRefusal};
