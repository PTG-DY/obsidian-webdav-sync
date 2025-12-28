/**
 * Mock implementation for @nutstore/sso-js
 * Used when the private package is not available
 * SSO login is only for Nutstore, not generic WebDAV
 */

export async function createOAuthUrl(options: { app: string }): Promise<string> {
	// Return Nutstore OAuth URL (this won't work without the real package,
	// but generic WebDAV users don't need this)
	return `https://www.jianguoyun.com/d/oauth2/authorize?app=${options.app}`
}

export async function decryptSecret(options: { app: string; s: string }): Promise<string> {
	// This is a placeholder - SSO won't work without the real package
	// Generic WebDAV users should use manual login mode
	throw new Error('SSO login requires Nutstore private package. Please use manual login mode.')
}
