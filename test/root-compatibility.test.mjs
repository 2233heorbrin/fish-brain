import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
const install=process.env.FISH_TEST_INSTALL_ROOT
if(!install)throw Error('Provide installed candidate')
const {apply}=await import(pathToFileURL(join(install,'node_modules/fish-brain/index.js')))
const temp=fs.mkdtempSync(join(tmpdir(),'brain-root-compatibility-'))
const dir=name=>{const path=join(temp,name);fs.mkdirSync(path,{recursive:true});return path}
async function mount(profile,config){const routes=new Map();await apply({profileContext:{dir:profile},effect:fn=>fn(),get:()=>null,connection:{fetch:{register:row=>{routes.set(row.path,row);return()=>{}}}}},config);return (await routes.get('/api/fish-brain/data').fetch(new Request('http://local/api/fish-brain/data'))).json()}
test('real brain entry reports brainRoot / fishRoot conflicts without choosing a source',async()=>{
 const profile=dir('conflict'),one=dir('one'),two=dir('two')
 const state=await mount(profile,{brainRoot:join(one,'鱼的大脑'),fishRoot:two})
 assert.equal(state.status,'invalid-config');assert.match(state.error,/config.brainRoot.*config.fishRoot/)
 assert(!fs.existsSync(join(profile,'fish-brain-data.json')))
})
test('real brain entry keeps explicit old root and supplements only brain',async()=>{
 const profile=dir('legacy'),root=dir('legacy-root')
 const state=await mount(profile,{brainRoot:join(root,'鱼的大脑')})
 assert.equal(state.root,root);assert.equal(state.dependencies.status,'host-blocked');assert(!fs.existsSync(join(root,'饭')))
 const bytes=fs.readFileSync(join(profile,'fish-brain-data.json'))
 const next=await mount(profile,{brainRoot:'invalid-no-longer-used',fishRoot:'invalid-no-longer-used'})
 assert.equal(next.root,root);assert.deepEqual(fs.readFileSync(join(profile,'fish-brain-data.json')),bytes)
})
