// One-time: register the encrypt Lit Action and add it to your group.
require('dotenv').config();

const LIT_API_URL = process.env.LIT_API_URL;
const LIT_API_KEY = process.env.LIT_API_KEY;

const ACTION_CODE = [
  'async function main({ pkpId, message }) {',
  '  const result = await Lit.Actions.Encrypt({ pkpId, message });',
  '  Lit.Actions.setResponse({ response: JSON.stringify(result) });',
  '}',
].join('\n');

async function api(endpoint, body, method) {
  method = method || 'POST';
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': LIT_API_KEY },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(LIT_API_URL + endpoint, opts);
  const text = await res.text();
  console.log('  ' + endpoint + ' -> ' + res.status + ': ' + text);
  return text;
}

async function main() {
  console.log('1. Get IPFS CID for action code...');
  const cidRaw = await api('/get_lit_action_ipfs_id', ACTION_CODE);
  const cid = JSON.parse(cidRaw);
  console.log('   CID: ' + cid);

  console.log('\n2. Register action...');
  await api('/add_action', {
    action_ipfs_cid: cid,
    name: 'alexandria-encrypt',
    description: 'Encrypts symmetric keys for Alexandria PDF encryption',
  });

  console.log('\n3. Add action to group 1...');
  await api('/add_action_to_group', {
    group_id: 1,
    action_ipfs_cid: cid,
  });

  console.log('\n4. Verify - list actions...');
  await api('/list_actions?page_number=0&page_size=100', null, 'GET');

  console.log('\nDone! Now run: node tests/encryption.manual.js');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
