import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
const install=process.env.FISH_TEST_INSTALL_ROOT
if(!install) throw new Error('Provide isolated installed tarball root')
const {ProfileData,mountProfileData}=await import(pathToFileURL(join(install,'node_modules/fish-brain/internal/profile-data.js')))
const temp=fs.mkdtempSync(join(tmpdir(),'independent-binding-'))
const dir=name=>{const path=join(temp,name);fs.mkdirSync(path,{recursive:true});return path}
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value))
const binding=root=>({schema:'fish-profile-data/v1',root,components:['brain','body'],origin:'legacy'})
for(const order of [['brain','body'],['body','brain']])test('legacy upgrade, old writer and independent switches: '+order.join(' / '),()=>{
 const profile=dir(order.join('-')),old=dir(order.join('-')+'-old'),next=dir(order.join('-')+'-next')
 const shared=join(profile,'fish-data.json');save(shared,binding(old));fs.writeFileSync(join(old,'kept'),'synthetic')
 const first=new ProfileData(profile,order[0]),second=new ProfileData(profile,order[1])
 first.initialize();assert.equal(first.state().root,old)
 const firstBytes=fs.readFileSync(first.file)
 second.initialize();assert.equal(second.state().root,old);assert.deepEqual(fs.readFileSync(first.file),firstBytes)
 save(shared,binding(next));assert.equal(first.state().root,old);assert.equal(second.state().root,old)
 const secondBytes=fs.readFileSync(second.file),sharedBytes=fs.readFileSync(shared)
 first.initialize({root:next,switchRoot:true});assert.equal(first.state().root,next)
 assert.equal(second.state().root,old);assert.deepEqual(fs.readFileSync(second.file),secondBytes);assert.deepEqual(fs.readFileSync(shared),sharedBytes)
 assert.equal(fs.readFileSync(join(old,'kept'),'utf8'),'synthetic');assert(!fs.existsSync(join(next,'kept')))
})
test('only owned structures are supplemented and existing content is preserved',()=>{
 const profile=dir('own'),root=dir('own-root'),brain=new ProfileData(profile,'brain'),body=new ProfileData(profile,'body')
 brain.initialize({root});assert(!fs.existsSync(join(root,'饭')))
 const self=join(root,'鱼的大脑/人格/generated/SELF.compat.md');fs.writeFileSync(self,'synthetic-preserved')
 const before=fs.readFileSync(brain.file);body.initialize({root})
 assert.deepEqual(fs.readFileSync(brain.file),before);assert.equal(fs.readFileSync(self,'utf8'),'synthetic-preserved')
 brain.initialize();assert.equal(fs.readFileSync(self,'utf8'),'synthetic-preserved')
 const bodyOnly=dir('body-only-root');new ProfileData(dir('body-only'),'body').initialize({root:bodyOnly});assert(!fs.existsSync(join(bodyOnly,'鱼的大脑')))
})
test('independent valid binding ignores malformed legacy and explicit inputs',()=>{
 const profile=dir('valid'),root=dir('valid-root'),data=new ProfileData(profile,'brain',{legacyRoots:()=>{throw Error('must not inspect legacy')}})
 save(data.file,binding(root));fs.writeFileSync(join(profile,'fish-data.json'),'{bad')
 assert.equal(data.state().root,root);assert.equal(data.state().status,'ready')
})
test('invalid independent binding never falls back; deliberate manual selection can repair it',()=>{
 const profile=dir('invalid'),root=dir('invalid-root'),data=new ProfileData(profile,'body')
 save(join(profile,'fish-data.json'),binding(root));fs.writeFileSync(data.file,'{bad')
 assert.equal(data.state().status,'invalid-config');assert.match(data.state().error,/FISH_BINDING_INVALID/)
 assert.throws(()=>data.initialize({root}),/FISH_BINDING_INVALID/)
 data.initialize({root,switchRoot:true});assert.equal(data.state().status,'ready')
 save(data.file,binding(join(temp,'missing')));assert.equal(data.state().status,'invalid-root')
 assert.equal(data.state().root,join(temp,'missing'))
})
test('legacy conflicts name every source, leave files intact and can be corrected explicitly',()=>{
 const profile=dir('conflict'),one=dir('conflict-a'),two=dir('conflict-b')
 const shared=join(profile,'fish-data.json');save(shared,binding(one));const before=fs.readFileSync(shared)
 const data=new ProfileData(profile,'body',{legacyRoots:()=>[{source:'config.fishRoot',root:two}]})
 assert.equal(data.state().status,'invalid-config');assert.match(data.state().error,/FISH_BINDING_CONFLICT.*config.fishRoot.*fish-data.json/)
 assert(!fs.existsSync(data.file));assert.deepEqual(fs.readFileSync(shared),before)
 data.initialize({root:two,switchRoot:true});assert.equal(data.state().root,two);assert.deepEqual(fs.readFileSync(shared),before)
})
test('invalid binding keeps data routes available for error detail and explicit repair',async()=>{
 const profile=dir('routes'),root=dir('routes-root'),data=new ProfileData(profile,'brain'),routes=new Map()
 fs.writeFileSync(data.file,'{bad')
 await mountProfileData({effect:fn=>fn(),connection:{fetch:{register:row=>{routes.set(row.path,row);return()=>{}}}}},data)
 const fetch=async(body)=>(await routes.get('/api/fish-brain/data').fetch(new Request('http://local/api/fish-brain/data',body?{method:'POST',body:JSON.stringify(body)}:{}))).json()
 assert.equal((await fetch()).status,'invalid-config');assert.equal((await fetch({action:'select',path:root})).status,'ready')
})

test('existing adapter layout uses the same explicit binding without generating public templates',()=>{
 class ExistingBrain extends ProfileData {
  initializeStructures(paths) { assert(fs.existsSync(join(paths.人格,'existing-self.md'))) }
  inspectBrain(paths) { return {personality:fs.readFileSync(join(paths.人格,'existing-self.md'),'utf8')} }
 }
 const profile=dir('custom-layout'),a=dir('custom-a'),b=dir('custom-b')
 for(const [root,text]of [[a,'existing-a'],[b,'existing-b']]){
  fs.mkdirSync(join(root,'鱼的大脑/人格'),{recursive:true})
  fs.writeFileSync(join(root,'鱼的大脑/人格/existing-self.md'),text)
 }
 const shared=join(profile,'fish-data.json');save(shared,binding(b));const before=fs.readFileSync(shared)
 const data=new ExistingBrain(profile,'brain',{legacyRoot:a})
 assert.equal(data.state().status,'invalid-config')
 data.initialize({root:a,switchRoot:true});assert.equal(data.state().personality,'existing-a')
 assert(!fs.existsSync(join(a,'鱼的大脑/人格/generated/SELF.compat.md')))
 data.initialize({root:b,switchRoot:true});assert.equal(data.state().personality,'existing-b')
 assert.equal(fs.readFileSync(join(a,'鱼的大脑/人格/existing-self.md'),'utf8'),'existing-a')
 assert(fs.readFileSync(shared).equals(before))
})
