const base = process.env.JIRA_BASE_URL, email = process.env.JIRA_EMAIL, token = process.env.JIRA_API_TOKEN
const auth = 'Basic ' + Buffer.from(email + ':' + token).toString('base64')
const H = { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' }
const key = process.argv[2]
const testText = process.argv[3]
const jput = (p,b)=>fetch(`${base}/rest/api/3/${p}`,{method:'PUT',headers:H,body:JSON.stringify(b)})
async function avail(){ return (await (await fetch(`${base}/rest/api/3/issue/${key}/transitions`,{headers:H})).json()).transitions }
async function move(namePart){
  const t = (await avail()).find(x=>x.name.toLowerCase().includes(namePart.toLowerCase()))
  if(!t){ console.log('no transition for', namePart, '- have:', (await avail()).map(x=>x.name).join(',')); return null }
  const r = await fetch(`${base}/rest/api/3/issue/${key}/transitions`,{method:'POST',headers:H,body:JSON.stringify({transition:{id:t.id}})})
  return `${t.name}:${r.status}`
}
// find Микола accountId
const us = await (await fetch(`${base}/rest/api/3/user/assignable/search?issueKey=${key}&maxResults=50`,{headers:H})).json()
const nick = us.find(u=>/микол|mykol|nikol|kolya|нікол/i.test(u.displayName||''))
console.log('assignee candidates:', us.map(u=>u.displayName).join(' | '))
// transitions: To Do -> In Progress (TDtIP) -> AI Testing (IPtAT)
console.log('move1', await move('TDtIP'))
console.log('move2', await move('IPtAT'))
if(nick){ const ar = await jput(`issue/${key}/assignee`,{accountId:nick.accountId}); console.log('assignee', nick.displayName, ar.status) }
// comment (ADF)
if(testText){
  const adf={type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:testText}]}]}
  const cr=await fetch(`${base}/rest/api/3/issue/${key}/comment`,{method:'POST',headers:H,body:JSON.stringify({body:adf})})
  console.log('comment', cr.status)
}
console.log('final status:', (await (await fetch(`${base}/rest/api/3/issue/${key}?fields=status,assignee`,{headers:H})).json()).fields.status.name)
