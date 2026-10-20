import assert from 'node:assert/strict';
import {summarizeWranglerLog} from '../scripts/wrangler-diagnostic-summary.mjs';

const secret='super-secret-token';
const jwt='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue';
const log=`
GET https://api.cloudflare.com/client/v4/accounts/8d9331889a693d328ef306692adf9d24/workers/scripts/iptv/settings?api_token=${secret}
status: 403
{"headers":{"Cookie":"session=abc","Authorization":"Bearer ${jwt}"}}
Authorization:
  Bearer ${secret}
POST https://api.cloudflare.com/client/v4/accounts/8d9331889a693d328ef306692adf9d24/workers/scripts/iptv?name=${secret}
{"method":"PUT","url":"https://api.cloudflare.com/client/v4/accounts/8d9331889a693d328ef306692adf9d24/tokens/verify","statusCode":200}
Unable to fetch bindings, routes, or services metadata from the dashboard. token=${secret}
`;
const summary=summarizeWranglerLog(log);
assert.match(summary,/GET \/client\/v4\/accounts\/\{account_id\}\/workers\/scripts\/iptv\/settings -> 403 permission denied/);
assert.match(summary,/POST \/client\/v4\/accounts\/\{account_id\}\/workers\/scripts\/iptv -> unknown status not found/);
assert.match(summary,/PUT \/client\/v4\/accounts\/\{account_id\}\/tokens\/verify -> 200 ok/);
assert.match(summary,/error: dashboard metadata fetch failed/);
assert.doesNotMatch(summary,new RegExp([secret,'session=','Bearer',jwt,'eyJ','api_token'].join('|')));
assert.equal(summary.split('\n').filter(Boolean).every(line=>/^(?:GET|POST|PUT|PATCH|DELETE|HEAD) \/[\w{}/.-]+ -> (?:[1-5]\d{2}|unknown) |error: /.test(line)),true);
console.log('Wrangler diagnostic summary: allowlisted routes only, secrets dropped passed');
