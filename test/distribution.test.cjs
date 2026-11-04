'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm'),fs=require('node:fs');
const {userDataRoot}=require('../lib/user-data.cjs');
test('public source and open-source edition never inherit local edition user data',()=>{
 const env={LOCALAPPDATA:path.resolve('synthetic-user')};
 assert.equal(userDataRoot({env,edition:'local'}),path.join(env.LOCALAPPDATA,'ZheZhaSiDe'));
 for(const edition of ['open-source',undefined])assert.equal(userDataRoot({env,edition}),path.join(env.LOCALAPPDATA,'ZheZhaSiDe-OpenSource'));
 assert.equal(userDataRoot({env:{...env,JX3_USER_DATA_DIR:'isolated-test'},edition:'local'}),'isolated-test');
 assert.equal(require('../package.json').distribution,'open-source');
});
test('desktop opens only the same safe video URLs as the report UI; app navigation stays local',()=>{
 const {isVideoSourceUrl,isLocalUrl}=require('../desktop/security.cjs'),scope=vm.createContext({URL});
 vm.runInContext(fs.readFileSync(require.resolve('../public/ai-ui.js'),'utf8'),scope);
 const values=['https://www.bilibili.com/video/BV1d3xs6wEib/?p=1&t=450','https://evil.example/video/BV123/','javascript:alert(1)','file:///C:/secret','https://user@www.bilibili.com/video/BV123/','https://www.bilibili.com:9000/video/BV123/','https://www.bilibili.com.evil.test/video/BV123/'];
 for(const value of values){assert.equal(isVideoSourceUrl(value),!!scope.JclAI.videoUrl(value));assert.equal(isLocalUrl(value,'http://127.0.0.1:4173'),false)}
 assert(isVideoSourceUrl(values[0]));
});
