/**
 * 增量WebDAV文件系统
 * 支持百万级文件的高效增量同步
 *
 * 核心特性：
 * 1. 使用分层mtime策略进行远程增量检测
 * 2. 使用本地事件监听进行本地增量检测
 * 3. 使用IndexedDB存储文件索引，支持分页查询
 * 4. 支持断点续传和进度恢复
 */

import { decode as decodeHtmlEntity } from 'html-entities'
import { Vault } from 'obsidian'
import { createClient, WebDAVClient } from 'webdav'
import { getWebDAVEndpoint } from '~/consts'
import { StatModel } from '~/model/stat.model'
import { NutstoreSettings, useSettings } from '~/settings'
import {
	DirMtimeStore,
	FileIndexEntry,
	FileIndexStore,
	SyncProgress,
	SyncProgressStore,
} from '~/storage/file-index'
import { getDBKey } from '~/utils/get-db-key'
import GlobMatch, {
	extendRules,
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
} from '~/utils/glob-match'
import { isSub } from '~/utils/is-sub'
import logger from '~/utils/logger'
import { stdRemotePath } from '~/utils/std-remote-path'
import {
	RemoteChange,
	RemoteDeltaDetectorService,
} from '~/services/remote-delta-detector.service'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export interface IncrementalWebDAVOptions {
	vault: Vault
	token: string
	remoteBaseDir: string
	settings: NutstoreSettings
	onProgress?: (phase: string, current: number, total: number) => void
}

/**
 * 增量WebDAV文件系统
 */
export class IncrementalWebDAVFileSystem implements AbstractFileSystem {
	private webdav: WebDAVClient
	private fileIndex: FileIndexStore
	private dirMtimeStore: DirMtimeStore
	private progressStore: SyncProgressStore
	private deltaDetector: RemoteDeltaDetectorService
	private namespace: string

	constructor(private options: IncrementalWebDAVOptions) {
		const endpoint = getWebDAVEndpoint(options.settings)
		this.webdav = createClient(endpoint, {
			headers: {
				Authorization: `Basic ${options.token}`,
			},
		})

		this.namespace = getDBKey(
			options.vault.getName(),
			options.remoteBaseDir,
		)
		this.fileIndex = new FileIndexStore(this.namespace)
		this.dirMtimeStore = new DirMtimeStore(this.namespace)
		this.progressStore = new SyncProgressStore(this.namespace)
		this.deltaDetector = new RemoteDeltaDetectorService({
			namespace: this.namespace,
			token: options.token,
			remoteBaseDir: options.remoteBaseDir,
			settings: options.settings,
			concurrency: 5,
		})
	}

	/**
	 * 遍历远程文件（使用增量检测）
	 */
	async walk(): Promise<StatModel[]> {
		// 检查是否有未完成的同步进度
		const savedProgress = await this.progressStore.get()
		if (savedProgress && savedProgress.phase !== 'syncing') {
			logger.debug('Resuming from saved progress:', savedProgress.phase)
		}

		// 检查是否需要全量扫描
		const indexCount = await this.fileIndex.count()

		if (indexCount === 0) {
			// 首次同步，执行全量扫描
			logger.debug('First sync, performing full scan')
			return await this.fullScan()
		}

		// 执行增量检测
		const deltaResult = await this.deltaDetector.detectChanges()

		if (deltaResult.needFullScan) {
			// 缓存失效，需要全量扫描
			logger.debug('Cache invalidated, performing full scan')
			return await this.fullScan()
		}

		if (deltaResult.changes.length === 0) {
			// 没有变更，返回缓存的文件列表
			logger.debug('No remote changes detected')
			return await this.getFromIndex()
		}

		// 应用增量变更
		logger.debug(`Applying ${deltaResult.changes.length} remote changes`)
		await this.applyChanges(deltaResult.changes)

		return await this.getFromIndex()
	}

	/**
	 * 全量扫描
	 */
	private async fullScan(): Promise<StatModel[]> {
		const startTime = Date.now()

		// 保存进度
		await this.progressStore.save({
			sessionId: `scan_${startTime}`,
			startTime,
			phase: 'scanning',
			processedCount: 0,
			totalCount: 0,
			currentPath: this.options.remoteBaseDir,
			pendingTasks: [],
			completedTasks: [],
			failedTasks: [],
		})

		// 执行全量扫描
		const result = await this.deltaDetector.fullScan((scanned, currentPath) => {
			if (this.options.onProgress) {
				this.options.onProgress('scanning', scanned, 0)
			}
		})

		logger.debug(
			`Full scan completed in ${Date.now() - startTime}ms: ${result.fileCount} files, ${result.dirCount} dirs`,
		)

		// 清除进度
		await this.progressStore.clear()

		return await this.getFromIndex()
	}

	/**
	 * 从索引获取文件列表
	 */
	private async getFromIndex(): Promise<StatModel[]> {
		const stats: StatModel[] = []
		const base = stdRemotePath(this.options.remoteBaseDir)

		// 流式遍历索引
		await this.fileIndex.iterateAll(async (entry) => {
			let path = entry.path

			// 解码HTML实体
			path = decodeHtmlEntity(path)

			// 规范化路径
			if (path.endsWith('/')) {
				path = path.slice(0, -1)
			}
			if (!path.startsWith('/')) {
				path = '/' + path
			}

			// 检查是否在基础目录下
			if (!isSub(base, path)) {
				return true // 继续遍历
			}

			// 转换为相对路径
			let relativePath = path.replace(this.options.remoteBaseDir, '')
			if (relativePath.startsWith('/')) {
				relativePath = relativePath.slice(1)
			}

			if (entry.isDir) {
				stats.push({
					path: relativePath,
					basename: entry.basename,
					isDir: true,
					isDeleted: false,
					mtime: entry.mtime,
				})
			} else {
				stats.push({
					path: relativePath,
					basename: entry.basename,
					isDir: false,
					isDeleted: false,
					mtime: entry.mtime,
					size: entry.size,
				})
			}

			return true // 继续遍历
		})

		// 应用过滤规则
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

		const filteredStats = stats.filter((item) =>
			needIncludeFromGlobRules(item.path, inclusion, exclusions),
		)

		return completeLossDir(stats, filteredStats)
	}

	/**
	 * 应用增量变更到索引
	 */
	private async applyChanges(changes: RemoteChange[]): Promise<void> {
		await this.deltaDetector.updateFileIndex(changes)
		await this.deltaDetector.updateDirMtimeCache(changes)
	}

	/**
	 * 获取索引统计信息
	 */
	async getStats(): Promise<{
		fileCount: number
		dirCount: number
		hasIndex: boolean
	}> {
		const count = await this.fileIndex.count()
		if (count === 0) {
			return { fileCount: 0, dirCount: 0, hasIndex: false }
		}

		const stats = await this.deltaDetector.getStats()
		return { ...stats, hasIndex: true }
	}

	/**
	 * 清除索引
	 */
	async clearIndex(): Promise<void> {
		await this.fileIndex.clear()
		await this.dirMtimeStore.clear()
		await this.progressStore.clear()
	}

	/**
	 * 强制全量重建索引
	 */
	async rebuildIndex(): Promise<void> {
		await this.clearIndex()
		await this.fullScan()
	}
}

/**
 * 创建增量WebDAV文件系统
 */
export function createIncrementalWebDAVFS(
	options: IncrementalWebDAVOptions,
): IncrementalWebDAVFileSystem {
	return new IncrementalWebDAVFileSystem(options)
}
