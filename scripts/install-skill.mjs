import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const skillName='personal-secret-manager';
const source=fileURLToPath(new URL(`../skills/${skillName}`,import.meta.url));
async function files(directory,prefix='') {
  const result=[];
  for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
    const name=join(prefix,entry.name);
    if(entry.isDirectory()) result.push(...await files(join(directory,entry.name),name));
    else if(entry.isFile()) result.push(name);
    else throw new Error('install_conflict');
  }
  return result.sort();
}
async function main() {
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help'){console.log('Usage: npm run skill:install -- [--target SKILLS_DIRECTORY]\nDefault: $CODEX_HOME/skills or ~/.codex/skills. Different existing content is never overwritten.');return;}
  if(args.length!==0 && (args.length!==2 || args[0]!=='--target' || !args[1] || args[1].startsWith('--')))throw new Error('invalid_usage');
  const root=resolve(args[1]??join(process.env.CODEX_HOME||join(homedir(),'.codex'),'skills'));
  try { const info=await fs.lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('install_conflict'); }
  catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(root,{recursive:true});}
  const destination=join(await fs.realpath(root),skillName),names=await files(source);
  try {
    const info=await fs.lstat(destination);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('install_conflict');
    const installed=await files(destination);
    if(JSON.stringify(installed)!==JSON.stringify(names))throw new Error('install_conflict');
    for(const name of names)if(!(await fs.readFile(join(source,name))).equals(await fs.readFile(join(destination,name))))throw new Error('install_conflict');
    console.log(JSON.stringify({path:destination,status:'unchanged',files:names}));return;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const staging=join(dirname(destination),`.psm-skill-${randomUUID()}`);
  try {
    await fs.cp(source,staging,{recursive:true,force:false,errorOnExist:true});
    await fs.rename(staging,destination);
    console.log(JSON.stringify({path:destination,status:'installed',files:names}));
  }finally{await fs.rm(staging,{recursive:true,force:true});}
}
main().catch(error=>{const code=['invalid_usage','install_conflict'].includes(error.message)?error.message:'install_failed';console.error(JSON.stringify({error:{code}}));process.exitCode=1;});
