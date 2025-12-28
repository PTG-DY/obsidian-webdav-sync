import { decode as decodeHtmlEntity } from 'html-entities'
import { isArray } from 'lodash-es'
import { Vault } from 'obsidian'
import { basename, isAbsolute } from 'path-browserify'
import { isNotNil } from 'ramda'
import { createClient, WebDAVClient } from 'webdav'
import { getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { getWebDAVEndpoint, supportsDeltaAPI, getWebDAVBasePath } from '~/consts'
import { StatModel } from '~/model/stat.model'
import { NutstoreSettings, useSettings, ServerType } from '~/settings'
import { deltaCacheKV } from '~/storage'
import { getDBKey } from '~/utils/get-db-key'
import { getRootFolderName } from '~/utils/get-root-folder-name'
import GlobMatch, {
	extendRules,
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
} from '~/utils/glob-match'
import { isSub } from '~/utils/is-sub'
import logger from '~/utils/logger'
import { stdRemotePath } from '~/utils/std-remote-path'
import { traverseWebDAV } from '~/utils/traverse-webdav'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'
import { IncrementalWebDAVFileSystem } from './incremental-webdav'

export class NutstoreFileSystem implements AbstractFileSystem {
	private webdav: WebDAVClient
	private incrementalFS: IncrementalWebDAVFileSystem | null = null

	constructor(
		private options: {
			vault: Vault
			token: string
			remoteBaseDir: string
			settings: NutstoreSettings
			onProgress?: (phase: string, current: number, total: number) => void
		},
	) {
		const endpoint = getWebDAVEndpoint(options.settings)
		this.webdav = createClient(endpoint, {
			headers: {
				Authorization: `Basic ${this.options.token}`,
			},
		})

		// 通用WebDAV模式下初始化增量同步文件系统
		if (options.settings.serverType === ServerType.WEBDAV) {
			this.incrementalFS = new IncrementalWebDAVFileSystem({
				vault: options.vault,
				token: options.token,
				remoteBaseDir: options.remoteBaseDir,
				settings: options.settings,
				onProgress: options.onProgress,
			})
		}
	}

	/**
	 * 使用标准WebDAV协议遍历目录（通用WebDAV模式 - 旧版全量扫描）
	 * @deprecated 建议使用增量同步模式
	 */
	private async walkStandardWebDAV(): Promise<StatModel[]> {
		const files = await traverseWebDAV(
			this.options.token,
			this.options.remoteBaseDir,
			this.options.settings,
		)
		return files
	}

	/**
	 * 使用Delta API进行增量同步（仅坚果云）
	 */
	private async walkWithDeltaAPI(): Promise<{
		files: StatModel[]
		deltaCache: any
	}> {
		const kvKey = getDBKey(
			this.options.vault.getName(),
			this.options.remoteBaseDir,
		)
		let deltaCache = await deltaCacheKV.get(kvKey)

		if (deltaCache) {
			let cursor = deltaCache.deltas.at(-1)?.cursor ?? deltaCache.originCursor
			while (true) {
				const { response } = await getDelta({
					token: this.options.token,
					cursor,
					folderName: getRootFolderName(this.options.remoteBaseDir),
				})
				if (response.cursor === cursor) {
					break
				}
				if (response.reset) {
					deltaCache.deltas = []
					deltaCache.files = await traverseWebDAV(
						this.options.token,
						this.options.remoteBaseDir,
						this.options.settings,
					)
					cursor = await getLatestDeltaCursor({
						token: this.options.token,
						folderName: getRootFolderName(this.options.remoteBaseDir),
					}).then((d) => d?.response?.cursor)
					deltaCache.originCursor = cursor
				} else if (response.delta.entry) {
					if (!isArray(response.delta.entry)) {
						response.delta.entry = [response.delta.entry]
					}
					if (response.delta.entry.length > 0) {
						deltaCache.deltas.push(response)
					}
					if (response.hasMore) {
						cursor = response.cursor
					} else {
						break
					}
				} else {
					break
				}
			}
		} else {
			const files = await traverseWebDAV(
				this.options.token,
				this.options.remoteBaseDir,
				this.options.settings,
			)
			const {
				response: { cursor: originCursor },
			} = await getLatestDeltaCursor({
				token: this.options.token,
				folderName: getRootFolderName(this.options.remoteBaseDir),
			})
			deltaCache = {
				files,
				originCursor,
				deltas: [],
			}
		}

		return { files: deltaCache.files, deltaCache }
	}

	async walk() {
		const useDeltaAPI = supportsDeltaAPI(this.options.settings)

		if (useDeltaAPI) {
			// 坚果云模式：使用Delta API增量同步
			return this.walkWithDeltaMode()
		} else {
			// 通用WebDAV模式：使用增量同步
			return this.walkWithIncrementalMode()
		}
	}

	/**
	 * 使用增量同步模式（通用WebDAV）
	 * 支持百万级文件的高效同步
	 */
	private async walkWithIncrementalMode(): Promise<StatModel[]> {
		if (this.incrementalFS) {
			logger.debug('Using incremental WebDAV sync')
			return await this.incrementalFS.walk()
		}
		// 回退到标准模式
		logger.debug('Falling back to standard WebDAV sync')
		return this.walkWithStandardMode()
	}

	/**
	 * 通用WebDAV模式的遍历逻辑
	 * 直接使用标准WebDAV PROPFIND遍历，不使用Delta缓存
	 */
	private async walkWithStandardMode(): Promise<StatModel[]> {
		const files = await this.walkStandardWebDAV()

		// 解码HTML实体
		files.forEach((file) => {
			file.path = decodeHtmlEntity(file.path)
		})

		// 过滤并处理路径
		const base = stdRemotePath(this.options.remoteBaseDir)
		const subPath = new Set<string>()
		for (let { path } of files) {
			if (path.endsWith('/')) {
				path = path.slice(0, path.length - 1)
			}
			if (!path.startsWith('/')) {
				path = `/${path}`
			}
			if (isSub(base, path)) {
				subPath.add(path)
			}
		}

		const filesMap = new Map<string, StatModel>(
			files.map((d) => [d.path, d]),
		)
		const contents = [...subPath]
			.map((path) => filesMap.get(path))
			.filter(isNotNil)

		for (const item of contents) {
			if (isAbsolute(item.path)) {
				item.path = item.path.replace(this.options.remoteBaseDir, '')
				if (item.path.startsWith('/')) {
					item.path = item.path.slice(1)
				}
			}
		}

		const settings = await useSettings()
		const exclusions = extendRules(
			(settings?.filterRules.exclusionRules ?? [])
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
		const inclusion = extendRules(
			(settings?.filterRules.inclusionRules ?? [])
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
		const filteredContents = contents.filter((item) =>
			needIncludeFromGlobRules(item.path, inclusion, exclusions),
		)
		return completeLossDir(contents, filteredContents)
	}

	/**
	 * 坚果云Delta模式的遍历逻辑
	 * 使用Delta API进行增量同步
	 */
	private async walkWithDeltaMode(): Promise<StatModel[]> {
		const result = await this.walkWithDeltaAPI()
		const deltaCache = result.deltaCache

		const kvKey = getDBKey(
			this.options.vault.getName(),
			this.options.remoteBaseDir,
		)
		await deltaCacheKV.set(kvKey, deltaCache)

		deltaCache.deltas.forEach((delta: any) => {
			delta.delta.entry.forEach((entry: any) => {
				entry.path = decodeHtmlEntity(entry.path)
			})
		})
		deltaCache.files.forEach((file: any) => {
			file.path = decodeHtmlEntity(file.path)
		})

		const deltasMap = new Map(
			deltaCache.deltas.flatMap((d: any) =>
				d.delta.entry.map((e: any) => [e.path, e]),
			),
		)
		const filesMap = new Map<string, StatModel>(
			deltaCache.files.map((d: StatModel) => [d.path, d]),
		)

		for (const delta of deltasMap.values()) {
			if ((delta as any).isDeleted) {
				filesMap.delete((delta as any).path)
				continue
			}
			filesMap.set((delta as any).path, {
				path: (delta as any).path,
				basename: basename((delta as any).path),
				isDir: (delta as any).isDir,
				isDeleted: (delta as any).isDeleted,
				mtime: new Date((delta as any).modified).valueOf(),
				size: (delta as any).size,
			})
		}

		const stats = Array.from(filesMap.values())
		if (stats.length === 0) {
			return []
		}

		const base = stdRemotePath(this.options.remoteBaseDir)
		const subPath = new Set<string>()
		for (let { path } of stats) {
			if (path.endsWith('/')) {
				path = path.slice(0, path.length - 1)
			}
			if (!path.startsWith('/')) {
				path = `/${path}`
			}
			if (isSub(base, path)) {
				subPath.add(path)
			}
		}

		const contents = [...subPath]
			.map((path) => filesMap.get(path))
			.filter(isNotNil)

		for (const item of contents) {
			if (isAbsolute(item.path)) {
				item.path = item.path.replace(this.options.remoteBaseDir, '')
				if (item.path.startsWith('/')) {
					item.path = item.path.slice(1)
				}
			}
		}

		const settings = await useSettings()
		const exclusions = extendRules(
			(settings?.filterRules.exclusionRules ?? [])
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
		const inclusion = extendRules(
			(settings?.filterRules.inclusionRules ?? [])
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
		const filteredContents = contents.filter((item) =>
			needIncludeFromGlobRules(item.path, inclusion, exclusions),
		)
		return completeLossDir(contents, filteredContents)
	}

	/**
	 * 获取索引统计信息（仅通用WebDAV模式）
	 */
	async getIndexStats(): Promise<{
		fileCount: number
		dirCount: number
		hasIndex: boolean
	} | null> {
		if (this.incrementalFS) {
			return await this.incrementalFS.getStats()
		}
		return null
	}

	/**
	 * 清除增量同步索引（仅通用WebDAV模式）
	 */
	async clearIndex(): Promise<void> {
		if (this.incrementalFS) {
			await this.incrementalFS.clearIndex()
		}
	}

	/**
	 * 重建增量同步索引（仅通用WebDAV模式）
	 */
	async rebuildIndex(): Promise<void> {
		if (this.incrementalFS) {
			await this.incrementalFS.rebuildIndex()
		}
	}
}
