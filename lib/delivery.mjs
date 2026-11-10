/** Only matching, ordered acknowledgements may enter the spoken conversation. */
export function deliveryResult(result,messages){
  const cancelled=result?.cancelled===true||result?.status==='cancelled';
  if(messages.length===1){
    const confirmed=result?.status==='confirmed'||result?.confirmed===true;
    return {confirmed,cancelled,parts:result?.status==='blocked'||cancelled?[]:[{index:0,text:messages[0],status:confirmed?'confirmed':'unconfirmed'}]};
  }
  const parts=[];
  for(const row of Array.isArray(result?.parts)?result.parts:[]){
    const index=parts.length;
    if(!row||row.index!==index||row.text!==messages[index]||index>=messages.length)break;
    const status=row.status==='confirmed'||row.confirmed===true?'confirmed':row.status==='blocked'?'blocked':'unconfirmed';
    parts.push({index,text:row.text,status,...(row.code?{code:row.code}:{}),...(row.message?{message:row.message}:{})});
    if(status!=='confirmed')break;
  }
  return {cancelled,parts,confirmed:result?.status==='confirmed'&&parts.length===messages.length&&parts.every(p=>p.status==='confirmed')};
}
