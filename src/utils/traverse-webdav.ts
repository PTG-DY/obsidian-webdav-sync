import { getDirectoryContents } from '~/api/webdav'
import { StatModel } from '~/model/stat.model'
import { NutstoreSettings } from '~/settings'
import { apiLimiter } from './api-limiter'
import { fileStatToStatModel } from './file-stat-to-stat-model'

const getContents = apiLimiter.wrap(getDirectoryContents)

/**
 * 递归遍历WebDAV目录
 * @param token 认证令牌
 * @param from 起始路径
 * @param settings 插件设置（用于获取正确的端点和基础路径）
 */
export async function traverseWebDAV(
	token: string,
	from: string = '',
	settings: NutstoreSettings,
): Promise<StatModel[]> {
	const contents = await getContents(token, from, settings)
	return [
		contents.map(fileStatToStatModel),
		await Promise.all(
			contents
				.filter((item) => item.type === 'directory')
				.map((item) => traverseWebDAV(token, item.filename, settings)),
		),
	].flat(2)
}
