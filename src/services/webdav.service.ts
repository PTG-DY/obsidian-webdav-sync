import { createClient, WebDAVClient } from 'webdav'
import { getWebDAVEndpoint, isNutstoreServer } from '../consts'
import NutstorePlugin from '../index'
import { createRateLimitedWebDAVClient } from '../utils/rate-limited-client'

export class WebDAVService {
	constructor(private plugin: NutstorePlugin) {}

	/**
	 * 获取当前配置的WebDAV服务器端点
	 */
	getEndpoint(): string {
		return getWebDAVEndpoint(this.plugin.settings)
	}

	/**
	 * 检查当前是否为坚果云模式
	 */
	isNutstore(): boolean {
		return isNutstoreServer(this.plugin.settings)
	}

	async createWebDAVClient(): Promise<WebDAVClient> {
		const endpoint = this.getEndpoint()
		let client: WebDAVClient

		if (this.isNutstore() && this.plugin.settings.loginMode === 'sso') {
			// 坚果云SSO登录
			const oauth = await this.plugin.getDecryptedOAuthInfo()
			client = createClient(endpoint, {
				username: oauth.username,
				password: oauth.access_token,
			})
		} else {
			// 手动登录（适用于坚果云和通用WebDAV）
			client = createClient(endpoint, {
				username: this.plugin.settings.account,
				password: this.plugin.settings.credential,
			})
		}
		return createRateLimitedWebDAVClient(client)
	}

	async checkWebDAVConnection(): Promise<{ error?: Error; success: boolean }> {
		try {
			const client = await this.createWebDAVClient()
			return { success: await client.exists('/') }
		} catch (error) {
			return {
				error,
				success: false,
			}
		}
	}
}
