import { Platform, requireApiVersion } from 'obsidian'
import { NutstoreSettings, ServerType } from './settings'

// 坚果云默认端点（构建时配置）
export const NS_NSDAV_ENDPOINT = process.env.NS_NSDAV_ENDPOINT!
export const NS_DAV_ENDPOINT = process.env.NS_DAV_ENDPOINT!

export const API_VER_STAT_FOLDER = '0.13.27'
export const API_VER_REQURL = '0.13.26' // desktop ver 0.13.26, iOS ver 1.1.1
export const API_VER_REQURL_ANDROID = '0.14.6' // Android ver 1.2.1
export const API_VER_ENSURE_REQURL_OK = '1.0.0' // always bypass CORS here

export const VALID_REQURL =
	(!Platform.isAndroidApp && requireApiVersion(API_VER_REQURL)) ||
	(Platform.isAndroidApp && requireApiVersion(API_VER_REQURL_ANDROID))

export const IN_DEV = process.env.NODE_ENV === 'development'

/**
 * 根据设置获取WebDAV服务器端点
 * @param settings 插件设置
 * @returns WebDAV服务器URL
 */
export function getWebDAVEndpoint(settings: NutstoreSettings): string {
	if (settings.serverType === ServerType.WEBDAV && settings.webdavServerUrl) {
		// 移除末尾斜杠以保持一致性
		return settings.webdavServerUrl.replace(/\/+$/, '')
	}
	return NS_DAV_ENDPOINT
}

/**
 * 根据设置获取WebDAV服务器基础路径
 * @param settings 插件设置
 * @returns 服务器基础路径，用于从响应href中提取相对路径
 */
export function getWebDAVBasePath(settings: NutstoreSettings): string {
	if (settings.serverType === ServerType.WEBDAV) {
		const basePath = settings.webdavBasePath || '/'
		// 确保路径以斜杠开头且不以斜杠结尾（除非是根路径）
		let normalized = basePath.startsWith('/') ? basePath : '/' + basePath
		if (normalized !== '/' && normalized.endsWith('/')) {
			normalized = normalized.slice(0, -1)
		}
		return normalized
	}
	// 坚果云默认使用 /dav 路径
	return '/dav'
}

/**
 * 检查是否使用坚果云服务器
 * @param settings 插件设置
 * @returns 是否为坚果云模式
 */
export function isNutstoreServer(settings: NutstoreSettings): boolean {
	return settings.serverType !== ServerType.WEBDAV
}

/**
 * 检查是否支持Delta API（增量同步）
 * 只有坚果云支持Delta API
 * @param settings 插件设置
 * @returns 是否支持增量同步
 */
export function supportsDeltaAPI(settings: NutstoreSettings): boolean {
	return isNutstoreServer(settings)
}
