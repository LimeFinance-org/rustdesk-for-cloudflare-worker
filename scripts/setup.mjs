/**
 * Reads config.json (domain + key), generates wrangler.local.json from the
 * wrangler.json template and uploads the relay key as a Cloudflare secret.
 * The key never lands in any tracked file.
 *
 * Usage: npm run setup
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const configPath = path.join(root, 'config.json')

function fail(msg) {
	console.error(`❌ ${msg}`)
	process.exit(1)
}

// 1. Load user config -------------------------------------------------------
if (!existsSync(configPath)) {
	// First run: generate a self-explanatory config.json for the user to edit.
	const template = {
		_说明_domain:
			'把 domain 改成你自己的域名（须已托管在你的 Cloudflare 账号），例如 rust.example.com | Change "domain" to your own domain hosted in your Cloudflare account',
		_说明_key:
			'把 key 改成一串 20 位以上的随机字符，之后填进每个 RustDesk 客户端的 Key 字段 | Change "key" to a random string (20+ chars); it also goes into the Key field of every RustDesk client',
		domain: 'rust.example.com',
		key: 'CHANGE-ME-to-a-random-string-at-least-20-chars',
	}
	writeFileSync(configPath, JSON.stringify(template, null, '\t') + '\n')
	fail('config.json has been created. Please edit its "domain" and "key", then run again.')
}

let config
try {
	config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch (e) {
	fail(`config.json is not valid JSON: ${e.message}`)
}

const { domain, key } = config
if (!domain || domain.includes('example.com')) {
	fail('Please set "domain" in config.json to your own domain (hosted in your Cloudflare account).')
}
if (!key || key.startsWith('CHANGE-ME') || key.length < 12) {
	fail('Please set "key" in config.json to a random string (at least 12 chars).')
}

// 2. Generate wrangler.local.json ------------------------------------------
const templatePath = path.join(root, 'wrangler.json')
const wrangler = JSON.parse(readFileSync(templatePath, 'utf8'))
wrangler.routes = [{ pattern: domain, custom_domain: true }]
const localPath = path.join(root, 'wrangler.local.json')
writeFileSync(localPath, JSON.stringify(wrangler, null, '\t') + '\n')
console.log(`✅ Generated wrangler.local.json (domain: ${domain})`)

// 3. Upload secrets ---------------------------------------------------------
function putSecret(name, value) {
	const res = spawnSync('npx', ['wrangler', 'secret', 'put', name, '-c', 'wrangler.local.json'], {
		cwd: root,
		shell: true,
		input: value + '\n',
		stdio: ['pipe', 'inherit', 'inherit'],
	})
	if (res.status !== 0) fail(`Failed to upload secret ${name}. Did you run "npx wrangler login"?`)
	console.log(`✅ Secret ${name} uploaded`)
}

putSecret('RELAY_KEY', key)
putSecret('HBBS_RELAY_URL', `wss://${domain}`)

console.log('\n🎉 Setup complete. Now run: npm run deploy')
