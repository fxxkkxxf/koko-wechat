export const modelKey=row=>row?.model||row?.id||'';
export function chooseDefaultModel(models,saved=''){
  if(saved&&models.some(x=>modelKey(x)===saved))return saved;
  const luna=models.filter(x=>/luna/i.test(modelKey(x)));
  const modern=luna.find(x=>modelKey(x)==='gpt-6-luna');
  return modelKey(modern||luna[0]||models.find(x=>x.isDefault)||models[0]);
}
export function fastestEffort(row){const raw=row?.supportedReasoningEfforts||row?.supportedEfforts||row?.reasoning||[];const list=raw.map(x=>typeof x==='string'?x:x.reasoningEffort||x.effort).filter(Boolean);return ['none','minimal','low','medium','high'].find(x=>list.includes(x))||row?.defaultReasoningEffort||row?.defaultEffort||'low';}
