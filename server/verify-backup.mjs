import {resolve} from 'node:path';
import {verifyBackup} from './backup.mjs';

// Uso: node server/verify-backup.mjs <carpeta-del-respaldo> [directorio-de-datos]
const [backup,data]=process.argv.slice(2);
if(!backup){console.error('Uso: node server/verify-backup.mjs <carpeta-del-respaldo> [directorio-de-datos]');process.exit(2);}
const result=verifyBackup(resolve(backup),data?resolve(data):null);
console.log(JSON.stringify(result,null,1));
process.exit(result.ok?0:1);
