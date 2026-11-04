(function(root){
 'use strict';
 function draft(config={}){return {baseUrl:config.baseUrl||'',model:config.model||'',protocol:config.protocol||'auto',stream:config.stream===true,tokenParameter:config.tokenParameter||'auto',maxOutputTokens:config.maxOutputTokens??null}}
 function mount(form,config,saved){
  const find=id=>form.querySelector('#'+id),providers=root.JclAIProviders;
  const group=document.createElement('div');group.className='llm-field';group.innerHTML='<label for="llm-provider">模型供应商</label><select id="llm-provider"></select><small id="llm-provider-hint">选择后填入常用地址，也可以自行修改。请使用与密钥所属平台一致的地址。</small>';
  find('llm-base-url').closest('.llm-field').before(group);
  const select=find('llm-provider');for(const p of providers.presets){const option=document.createElement('option');option.value=p.id;option.textContent=p.label;select.append(option)}select.value=providers.identify(config.baseUrl);
  const options=document.createElement('details');options.className='llm-options';options.innerHTML=`<summary>高级连接选项</summary><div class="llm-field"><label for="llm-protocol">接口协议</label><select id="llm-protocol"><option value="auto">自动识别（推荐）</option><option value="chat-completions">OpenAI Chat Completions / 兼容接口</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages / Claude</option></select><small>中转服务请选择它提供的协议；模型名称不能决定中转服务的接口。</small></div><label class="llm-stream"><input type="checkbox" id="llm-stream"> 使用流式传输</label><small class="llm-option-note">适用于要求流式请求的兼容模型；报告仍在生成完成后显示。</small><div class="llm-field"><label for="llm-token-parameter">输出参数名称</label><select id="llm-token-parameter"><option value="auto">自动选择（推荐）</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></div><div class="llm-field"><label for="llm-output-limit">单次输出上限（tokens）</label><input id="llm-output-limit" type="number" min="1024" max="65536" step="1" placeholder="留空使用应用预算"><small>模型提示输出超限时，按服务商限制填写。总分析预算仍由应用控制。</small></div></details>`;
  form.querySelector('.llm-session-note').before(options);
  find('llm-protocol').value=config.protocol||'auto';find('llm-token-parameter').value=config.tokenParameter||'auto';find('llm-stream').checked=config.stream===true;find('llm-output-limit').value=config.maxOutputTokens??'';
  function protocolChanged(){
   const value=find('llm-protocol').value,url=find('llm-base-url').value;
   const chat=value==='chat-completions'||(value==='auto'&&!/\/(responses|messages)\/?$/.test(url)&&!/^https:\/\/api\.anthropic\.com(?:\/|$)/.test(url)&&!(/^https:\/\/api\.openai\.com(?:\/|$)/.test(url)&&/^gpt-6(?:[.-]|$)/.test(find('llm-model').value)));
   find('llm-stream').disabled=!chat;find('llm-token-parameter').disabled=!chat;
   if(!chat){find('llm-stream').checked=false;find('llm-token-parameter').value='auto'}
  }
  function keyHint(){let same=false;try{same=new URL(find('llm-base-url').value).origin===new URL(saved?.baseUrl).origin}catch{}
   const keep=!!saved?.hasApiKey&&same;find('llm-api-key').required=!keep;find('llm-api-key').placeholder=keep?'已安全保存，留空保持原密钥':'填写此服务的 API Key';find('llm-api-key').setCustomValidity('');
  }
  select.onchange=()=>{const p=providers.presets.find(p=>p.id===select.value);if(p.id!=='custom'){find('llm-base-url').value=p.baseUrl;find('llm-model').value='';find('llm-api-key').value='';find('llm-protocol').value=p.protocol;find('llm-stream').checked=!!p.stream;find('llm-token-parameter').value='auto';find('llm-output-limit').value='';find('llm-base-url').setCustomValidity('');find('llm-model').setCustomValidity('');}
   find('llm-provider-hint').textContent=p.note||'请填写此平台的模型 ID；不同地域、订阅套餐与中转服务可能使用不同地址。';keyHint();protocolChanged();
  };
  find('llm-base-url').addEventListener('input',()=>{select.value='custom';keyHint();protocolChanged()});find('llm-model').addEventListener('input',protocolChanged);find('llm-protocol').onchange=protocolChanged;
  keyHint();protocolChanged();
 }
 function read(form){const find=id=>form.querySelector('#'+id);return {baseUrl:find('llm-base-url').value,model:find('llm-model').value,protocol:find('llm-protocol').value,stream:find('llm-stream').checked,tokenParameter:find('llm-token-parameter').value,maxOutputTokens:find('llm-output-limit').value===''?null:Number(find('llm-output-limit').value)}}
 root.JclAIConfig={draft,mount,read};
})(window);
