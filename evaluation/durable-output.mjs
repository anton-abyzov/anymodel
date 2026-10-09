import { appendFileSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// Hold incomplete lines so a credential split across OS chunks is never written
// partially. Completed JSON events are persisted immediately, even on interruption.
export function durableOutput(path, secrets=[]) {
  writeFileSync(path,'');
  const decoder=new StringDecoder('utf8');
  const values=secrets.filter(Boolean).sort((a,b)=>b.length-a.length);
  const redact=value=>values.reduce((text,secret)=>text.split(secret).join('[REDACTED]'),value);
  let pending='',captured='';
  const append=value=>{const safe=redact(value);appendFileSync(path,safe);captured+=safe;};
  return {
    write(chunk){pending+=decoder.write(chunk);const end=pending.lastIndexOf('\n');if(end>=0){append(pending.slice(0,end+1));pending=pending.slice(end+1);}},
    finish(){pending+=decoder.end();let safe=redact(pending);for(const secret of values){for(let size=secret.length-1;size>0;size--){if(safe.endsWith(secret.slice(0,size))){safe=safe.slice(0,-size)+'[REDACTED_PARTIAL]';break;}}}append(safe);pending='';return captured;},
  };
}
