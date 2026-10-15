const base = process.argv[2];
if (!base || !/^https:\/\//.test(base)) {
  console.error('Usage: npm run smoke -- https://site.example');
  process.exit(64);
}

let token = '';
for await (const chunk of process.stdin) token += chunk;
token = token.trim();
if (!token) {
  console.error('Smoke check requires a Sites authorization token on stdin.');
  process.exit(64);
}

const headers = {'OAI-Sites-Authorization': `Bearer ${token}`};

async function check(path, validate) {
  const response = await fetch(new URL(path, base), {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  await validate(response);
  console.log(`Smoke check passed: ${path} (HTTP ${response.status})`);
}

try {
  await check('/', async response => {
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) throw new Error('/ did not return HTML');
  });
  await check('/api/status', async response => {
    const value = await response.json();
    if (!value || typeof value !== 'object') throw new Error('/api/status did not return JSON');
  });
} catch (error) {
  console.error(`Production smoke check failed: ${error.message}`);
  process.exit(1);
}
