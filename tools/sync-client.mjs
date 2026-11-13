import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../',import.meta.url),file=new URL('client.js',root);
const snippet=readFileSync(new URL('internal/data-client.js',root),'utf8').replace('export function','function');
const source=readFileSync(file,'utf8');
if(!source.includes('// BEGIN SHARED DATA CLIENT'))throw new Error('shared client marker missing');
writeFileSync(file,source.replace(/\/\/ BEGIN SHARED DATA CLIENT[\s\S]*?\/\/ END SHARED DATA CLIENT/,'// BEGIN SHARED DATA CLIENT\n'+snippet+'\n// END SHARED DATA CLIENT'));
