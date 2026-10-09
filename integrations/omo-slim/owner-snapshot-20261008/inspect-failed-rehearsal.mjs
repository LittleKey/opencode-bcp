import {controller,json} from './upgrade.mjs';
const root='/tmp/opencode/omo303-upgrade-tDlIlo';
controller(root+'/config',root+'/transaction',json(root+'/transaction/baseline.json')).installed();
console.log('Failed replica now passes installed-state verification; no writes performed.');
