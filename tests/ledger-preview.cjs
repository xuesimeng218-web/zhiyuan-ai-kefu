// Isolated synthetic preview: serves ledger assets only; never loads customer modules or IndexedDB.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const stamp = '2026-09-10T08:00:00.000Z';
const entries = ['03chatgpt/claude 充值', 'GPT-034'].map((name, i) => ({
  id: `synthetic-${i + 1}`, type: 'expense', category: '第三方代充', amountCents: (i + 1) * 12000,
  date: '2026-09-10', time: '12:00', partnerId: i ? `manual-group:${name}` : 'synthetic-partner',
  payee: '', customerCode: '', customerName: '', product: '合成验收业务', paymentMethod: '合成方式',
  invoiceEligibility: 'unknown', invoiceStatus: 'unissued', orderDescription: '', remark: '仅用于隔离验收',
  createdAt: stamp, updatedAt: stamp,
}));
const seed = {
  zy_kb_ledger_entries_v1: {version: 1, entries},
  zy_kb_ledger_partners_v1: {version: 1, partners: [{id:'synthetic-partner',name:'03chatgpt/claude 充值',createdAt:stamp,updatedAt:stamp}]},
  zy_kb_ledger_categories_v1: {version:1,categories:[{id:'synthetic-category',type:'expense',name:'生活支出',active:true,createdAt:stamp,updatedAt:stamp}]},
  zy_kb_ledger_state_v1: {version:1,month:'2026-09',view:'manual'},
};
const bootstrap = `
if (!sessionStorage.getItem('synthetic-ledger-seeded')) {
  for (const [key,value] of Object.entries(${JSON.stringify(seed)})) localStorage.setItem(key,JSON.stringify(value));
  sessionStorage.setItem('synthetic-ledger-seeded','yes');
}
globalThis.setMode = () => document.querySelector('.app').classList.add('ledger-mode');
globalThis.toast = message => { document.getElementById('toast').textContent = message; };
openLedgerWorkbench('manual');
`;
const allowed = new Set(['css/style.css','js/ledger.js','js/ledger-import.js','vendor/ledger-import/xlsx-0.20.3.min.js','vendor/ledger-import/fflate-0.8.2.min.js','icon.svg','manifest.webmanifest']);
const server = http.createServer((req,res) => {
  const route = new URL(req.url,'http://localhost').pathname.slice(1);
  res.setHeader('Cache-Control','no-store');
  if (!route || route === 'index.html') {
    let html = fs.readFileSync(path.join(root,'index.html'),'utf8');
    html = html.replace(/<script src="([^"]+)"><\/script>/g,(tag,src)=>allowed.has(src.split('?')[0]) ? tag : '');
    html = html.replace('<title>智源客服知识库</title>','<title>合成数据 · 记账隔离验收</title>').replace('</body>',`<script>${bootstrap}</script></body>`);
    res.setHeader('Content-Type','text/html; charset=utf-8'); return res.end(html);
  }
  if (!allowed.has(route)) { res.statusCode=404; return res.end(); }
  res.setHeader('Content-Type',route.endsWith('.js')?'text/javascript':route.endsWith('.css')?'text/css':route.endsWith('.svg')?'image/svg+xml':'application/manifest+json');
  res.end(fs.readFileSync(path.join(root,route)));
});
server.listen(0,'127.0.0.1',()=>console.log(`Synthetic-only preview: http://127.0.0.1:${server.address().port}/`));
