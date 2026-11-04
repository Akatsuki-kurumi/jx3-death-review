'use strict';
const path=require('node:path'),os=require('node:os');
function userDataRoot({env=process.env,edition=require('../package.json').distribution,base=env.LOCALAPPDATA||os.homedir()}={}){
 return env.JX3_USER_DATA_DIR||path.join(base,edition==='local'?'ZheZhaSiDe':'ZheZhaSiDe-OpenSource');
}
module.exports={userDataRoot};
