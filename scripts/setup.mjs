/**
 * Reads config.json (domain + key + location hint), generates
 * wrangler.local.json from the wrangler.json template and uploads the relay
 * secrets as Cloudflare secrets. The key never lands in any tracked file.
 *
 * Usage: npm run setup
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const configPath = path.join(root, 'config.json')

function fail(msg) {
	console.error(`❌ ${msg}`)
	process.exit(1)
}

const LOCATION_HINTS = new Set([
	'wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me',
])

function isValidDomain(value) {
	if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
		return false
	}
	if (value.trim() !== value || /[\s/:]/.test(value)) {
		return false
	}
	try {
		const parsed = new URL(`https://${value}`)
		const placeholder = value === 'example.com' || value.endsWith('.example.com')
		return parsed.hostname === value && value.includes('.') && !placeholder
	} catch {
		return false
	}
}

// 1. Load user config -------------------------------------------------------
if (!existsSync(configPath)) {
	// First run: generate a self-explanatory config.json for the user to edit.
	const template = {
		_说明_domain:
			'把 domain 改成你自己的域名（须已托管在你的 Cloudflare 账号），例如 rust.example.com | Change "domain" to your own domain hosted in your Cloudflare account',
		_说明_key:
			'把 key 改成一串 20 位以上的随机字符，之后填进每个 RustDesk 客户端的 Key 字段 | Change "key" to a random string (20+ chars); it also goes into the Key field of every RustDesk client',
		_说明_locationHint:
			'默认 apac，适合中国及亚太用户；可选 apac-ne / apac-se。这里只是 Durable Object 区域提示，不是固定国家 IP | Default apac for China/APAC users; apac-ne / apac-se are also available. This is a placement hint, not a country-specific IP',
		domain: 'rust.example.com',
		key: randomBytes(32).toString('base64url'),
		locationHint: 'apac',
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

const { domain, key, locationHint = 'apac' } = config
if (!isValidDomain(domain)) {
	fail('Please set "domain" in config.json to your own domain (hosted in your Cloudflare account).')
}
if (typeof key !== 'string' || key.trim() !== key || key.length < 20) {
	fail('Please set "key" in config.json to a random string (at least 20 chars).')
}
if (typeof locationHint !== 'string' || !LOCATION_HINTS.has(locationHint)) {
	fail('Please set "locationHint" to a valid Durable Object hint such as "apac", "apac-ne" or "apac-se".')
}

// 2. Generate wrangler.local.json ------------------------------------------
const templatePath = path.join(root, 'wrangler.json')
const wrangler = JSON.parse(readFileSync(templatePath, 'utf8'))
wrangler.routes = [{ pattern: domain, custom_domain: true }]
wrangler.vars = { ...(wrangler.vars || {}), DO_LOCATION_HINT: locationHint }
const localPath = path.join(root, 'wrangler.local.json')
writeFileSync(localPath, JSON.stringify(wrangler, null, '\t') + '\n')
console.log(`✅ Generated wrangler.local.json (domain: ${domain}, locationHint: ${locationHint})`)

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
