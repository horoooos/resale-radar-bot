// Publish a daily operational snapshot, never listings, cookies or search settings.
const endpoint=`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/data/collector-health.json`;
const headers={Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'};
const previous=await fetch(endpoint,{headers});
let file=null,old={};
if(previous.ok){file=await previous.json();try{old=JSON.parse(Buffer.from(file.content,'base64').toString());}catch{}}
else if(previous.status!==404)throw new Error('Could not read operational snapshot');
const now=new Date().toISOString(),day=now.slice(0,10);
if(old.day===day){console.log('Daily operational snapshot already published.');}
else{
  const status=process.env.COLLECT_RESULT;
  const payload={day,checked_at:now,result:status,last_success:status==='success'?now:(old.last_success||null),run:`https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`};
  const result=await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify({message:'Update daily collector operational snapshot',content:Buffer.from(JSON.stringify(payload,null,2)+'\n').toString('base64'),...(file?{sha:file.sha}:{})})});
  if(!result.ok)throw new Error('Could not publish operational snapshot');
  console.log('Daily operational snapshot published without private data.');
}
