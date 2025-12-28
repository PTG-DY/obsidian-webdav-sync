/**
 * 远程增量检测服务
 * 使用分层mtime策略实现高效的远程变更检测
 *
 * 核心原理：
 * 1. WebDAV目录的mtime会在其内容变化时更新
 * 2. 通过分层检测目录mtime，可以快速定位变更目录
 * 3. 只对mtime变化的目录进行深度扫描
 *
 * 优化策略：
 * 1. 维护目录mtime缓存，避免重复检查
 * 2. 并发扫描子目录，提高检测效率
 * 3. 使用增量结果，只返回变更的文件
 */

import { XMLParser } from 'fast-xml-parser'
import { basename, dirname, join } from 'path-browserify'
import { getWebDAVEndpoint, getWebDAVBasePath } from '~/consts'
import { StatModel } from '~/model/stat.model'
import { NutstoreSettings } from '~/settings'
import {
	DirMtimeEntry,
	DirMtimeStore,
	FileIndexEntry,
	FileIndexStore,
} from '~/storage/file-index'
import { apiLimiter } from '~/utils/api-limiter'
import logger from '~/utils/logger'
import requestUrl from '~/utils/request-url'

/**
 * 远程变更类型
 */
export interface RemoteChange {
	path: string
	type: 'added' | 'modified' | 'deleted'
	stat?: StatModel
}

/**
 * 增量检测结果
 */
export interface DeltaDetectionResult {
	/** 检测到的变更列表 */
	changes: RemoteChange[]
	/** 是否需要全量扫描（首次或缓存失效） */
	needFullScan: boolean
	/** 扫描的目录数量 */
	scannedDirs: number
	/** 检测到的变更目录数量 */
	changedDirs: number
}

export interface RemoteDeltaDetectorOptions {
	namespace: string
	token: string
	remoteBaseDir: string
	settings: NutstoreSettings
	/** 并发扫描数量 */
	concurrency?: number
}

/**
 * 远程增量检测器
 */
export class RemoteDeltaDetectorService {
	private fileIndex: FileIndexStore
	private dirMtimeStore: DirMtimeStore
	private token: string
	private remoteBaseDir: string
	private settings: NutstoreSettings
	private endpoint: string
	private basePath: string
	private concurrency: number

	constructor(options: RemoteDeltaDetectorOptions) {
		this.fileIndex = new FileIndexStore(options.namespace)
		this.dirMtimeStore = new DirMtimeStore(options.namespace)
		this.token = options.token
		this.remoteBaseDir = options.remoteBaseDir
		this.settings = options.settings
		this.endpoint = getWebDAVEndpoint(options.settings)
		this.basePath = getWebDAVBasePath(options.settings)
		this.concurrency = options.concurrency || 5
	}

	/**
	 * 执行增量检测
	 */
	async detectChanges(): Promise<DeltaDetectionResult> {
		const cachedDirMtimes = await this.dirMtimeStore.getAll()

		// 如果没有缓存，需要全量扫描
		if (cachedDirMtimes.size === 0) {
			logger.debug('No cached dir mtimes, need full scan')
			return {
				changes: [],
				needFullScan: true,
				scannedDirs: 0,
				changedDirs: 0,
			}
		}

		const changes: RemoteChange[] = []
		const changedDirs: string[] = []
		let scannedDirs = 0

		// 从根目录开始检测
		await this.detectDirChanges(
			this.remoteBaseDir,
			cachedDirMtimes,
			changedDirs,
			() => scannedDirs++,
		)

		// 对变更目录进行深度扫描
		if (changedDirs.length > 0) {
			logger.debug(`Detected ${changedDirs.length} changed directories`)

			for (const dir of changedDirs) {
				const dirChanges = await this.scanDirForChanges(dir)
				changes.push(...dirChanges)
			}
		}

		return {
			changes,
			needFullScan: false,
			scannedDirs,
			changedDirs: changedDirs.length,
		}
	}

	/**
	 * 递归检测目录变更
	 */
	private async detectDirChanges(
		dirPath: string,
		cachedMtimes: Map<string, DirMtimeEntry>,
		changedDirs: string[],
		onScanned: () => void,
	): Promise<void> {
		onScanned()

		// 获取当前目录信息
		const currentStat = await this.statDir(dirPath)
		if (!currentStat) {
			// 目录可能被删除
			changedDirs.push(dirPath)
			return
		}

		const cached = cachedMtimes.get(dirPath)

		// 检查mtime是否变化
		if (cached && cached.mtime === currentStat.mtime) {
			// mtime未变，目录内容未变
			return
		}

		// mtime变化，需要进一步检测
		changedDirs.push(dirPath)

		// 获取子目录列表
		const subDirs = await this.getSubDirs(dirPath)

		// 并发检测子目录
		const chunks = this.chunkArray(subDirs, this.concurrency)
		for (const chunk of chunks) {
			await Promise.all(
				chunk.map((subDir) =>
					this.detectDirChanges(subDir, cachedMtimes, changedDirs, onScanned),
				),
			)
		}
	}

	/**
	 * 扫描目录中的变更
	 */
	private async scanDirForChanges(dirPath: string): Promise<RemoteChange[]> {
		const changes: RemoteChange[] = []

		// 获取当前远程文件列表
		const remoteFiles = await this.listDir(dirPath)
		const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]))

		// 获取缓存的文件列表
		const cachedFiles = await this.fileIndex.getByParent(dirPath)
		const cachedMap = new Map(cachedFiles.map((f) => [f.path, f]))

		// 检测新增和修改
		for (const [path, remoteStat] of remoteMap) {
			const cached = cachedMap.get(path)
			if (!cached) {
				// 新增文件
				changes.push({
					path,
					type: 'added',
					stat: remoteStat,
				})
			} else if (this.isModified(cached, remoteStat)) {
				// 修改文件
				changes.push({
					path,
					type: 'modified',
					stat: remoteStat,
				})
			}
		}

		// 检测删除
		for (const [path, cached] of cachedMap) {
			if (!remoteMap.has(path)) {
				changes.push({
					path,
					type: 'deleted',
				})
			}
		}

		return changes
	}

	/**
	 * 检查文件是否被修改
	 */
	private isModified(cached: FileIndexEntry, remote: StatModel): boolean {
		if (cached.isDir !== remote.isDir) return true
		if (!remote.isDir && cached.mtime !== remote.mtime) return true
		if (!remote.isDir && cached.size !== remote.size) return true
		return false
	}

	/**
	 * 获取目录状态（只获取目录本身，不获取内容）
	 */
	private async statDir(
		path: string,
	): Promise<{ mtime: number } | null> {
		try {
			const result = await this.propfind(path, 0)
			if (result.length === 0) return null
			return { mtime: result[0].mtime || 0 }
		} catch (e) {
			logger.error('Failed to stat dir:', path, e)
			return null
		}
	}

	/**
	 * 获取子目录列表
	 */
	private async getSubDirs(path: string): Promise<string[]> {
		try {
			const contents = await this.propfind(path, 1)
			return contents
				.filter((item) => item.isDir && item.path !== path)
				.map((item) => item.path)
		} catch (e) {
			logger.error('Failed to get subdirs:', path, e)
			return []
		}
	}

	/**
	 * 列出目录内容
	 */
	private async listDir(path: string): Promise<StatModel[]> {
		try {
			const contents = await this.propfind(path, 1)
			// 排除目录本身
			return contents.filter((item) => item.path !== path)
		} catch (e) {
			logger.error('Failed to list dir:', path, e)
			return []
		}
	}

	/**
	 * 执行PROPFIND请求
	 */
	private propfind = apiLimiter.wrap(
		async (path: string, depth: 0 | 1): Promise<StatModel[]> => {
			const encodedPath = path
				.split('/')
				.map(encodeURIComponent)
				.join('/')
			const url = `${this.endpoint}${encodedPath.startsWith('/') ? '' : '/'}${encodedPath}`

			const response = await requestUrl({
				url,
				method: 'PROPFIND',
				headers: {
					Authorization: `Basic ${this.token}`,
					'Content-Type': 'application/xml',
					Depth: String(depth),
				},
				body: `<?xml version="1.0" encoding="utf-8"?>
          <propfind xmlns="DAV:">
            <prop>
              <displayname/>
              <resourcetype/>
              <getlastmodified/>
              <getcontentlength/>
            </prop>
          </propfind>`,
			})

			return this.parsePropfindResponse(response.text, path)
		},
	)

	/**
	 * 解析PROPFIND响应
	 */
	private parsePropfindResponse(xml: string, basePath: string): StatModel[] {
		const parser = new XMLParser({
			attributeNamePrefix: '',
			removeNSPrefix: true,
			parseTagValue: false,
		})

		const result = parser.parse(xml)
		const responses = result.multistatus?.response
		if (!responses) return []

		const items = Array.isArray(responses) ? responses : [responses]

		return items.map((item: any) => {
			const props = item.propstat?.prop
			const href = decodeURIComponent(item.href)
			const isDir = !!props?.resourcetype?.collection

			// 处理路径
			let filePath: string
			if (this.basePath === '/') {
				filePath = href
			} else if (href.startsWith(this.basePath)) {
				filePath = href.slice(this.basePath.length)
			} else {
				filePath = href
			}
			if (!filePath.startsWith('/')) {
				filePath = '/' + filePath
			}
			if (filePath.endsWith('/') && filePath !== '/') {
				filePath = filePath.slice(0, -1)
			}

			const mtime = props?.getlastmodified
				? new Date(props.getlastmodified).valueOf()
				: 0
			const size = props?.getcontentlength
				? parseInt(props.getcontentlength, 10)
				: 0

			if (isDir) {
				return {
					path: filePath,
					basename: basename(filePath) || filePath,
					isDir: true,
					isDeleted: false,
					mtime,
				} as StatModel
			} else {
				return {
					path: filePath,
					basename: basename(filePath),
					isDir: false,
					isDeleted: false,
					mtime,
					size,
				} as StatModel
			}
		})
	}

	/**
	 * 全量扫描并建立索引
	 * 使用流式处理，支持百万级文件
	 */
	async fullScan(
		onProgress?: (scanned: number, currentPath: string) => void,
	): Promise<{ fileCount: number; dirCount: number }> {
		let fileCount = 0
		let dirCount = 0
		const dirMtimes: DirMtimeEntry[] = []

		// 清空现有索引
		await this.fileIndex.clear()
		await this.dirMtimeStore.clear()

		// 递归扫描目录
		await this.scanDirRecursive(
			this.remoteBaseDir,
			async (entries, dirPath, dirMtime) => {
				// 批量保存文件索引
				const fileEntries: FileIndexEntry[] = entries.map((stat) => ({
					path: stat.path,
					basename: stat.basename,
					isDir: stat.isDir,
					mtime: stat.mtime || 0,
					size: stat.isDir ? 0 : stat.size,
					lastSynced: 0,
					parentPath: dirname(stat.path),
				}))

				await this.fileIndex.batchSet(fileEntries)

				// 记录目录mtime
				dirMtimes.push({
					path: dirPath,
					mtime: dirMtime,
					lastChecked: Date.now(),
					childCount: entries.length,
				})

				fileCount += entries.filter((e) => !e.isDir).length
				dirCount += entries.filter((e) => e.isDir).length

				if (onProgress) {
					onProgress(fileCount + dirCount, dirPath)
				}
			},
		)

		// 保存目录mtime
		await this.dirMtimeStore.batchSet(dirMtimes)

		logger.debug(`Full scan completed: ${fileCount} files, ${dirCount} dirs`)

		return { fileCount, dirCount }
	}

	/**
	 * 递归扫描目录
	 */
	private async scanDirRecursive(
		dirPath: string,
		onBatch: (
			entries: StatModel[],
			dirPath: string,
			dirMtime: number,
		) => Promise<void>,
	): Promise<void> {
		const contents = await this.propfind(dirPath, 1)

		// 获取目录本身的mtime
		const dirStat = contents.find((c) => c.path === dirPath)
		const dirMtime = dirStat?.mtime || 0

		// 过滤掉目录本身
		const items = contents.filter((c) => c.path !== dirPath)

		// 保存当前目录的内容
		await onBatch(items, dirPath, dirMtime)

		// 获取子目录
		const subDirs = items.filter((item) => item.isDir)

		// 并发扫描子目录
		const chunks = this.chunkArray(subDirs, this.concurrency)
		for (const chunk of chunks) {
			await Promise.all(
				chunk.map((subDir) =>
					this.scanDirRecursive(subDir.path, onBatch),
				),
			)
		}
	}

	/**
	 * 更新目录mtime缓存
	 */
	async updateDirMtimeCache(
		changes: RemoteChange[],
	): Promise<void> {
		// 收集受影响的目录
		const affectedDirs = new Set<string>()
		for (const change of changes) {
			affectedDirs.add(dirname(change.path))
		}

		// 更新目录mtime
		for (const dirPath of affectedDirs) {
			const stat = await this.statDir(dirPath)
			if (stat) {
				await this.dirMtimeStore.set({
					path: dirPath,
					mtime: stat.mtime,
					lastChecked: Date.now(),
					childCount: 0, // 将在下次扫描时更新
				})
			}
		}
	}

	/**
	 * 更新文件索引
	 */
	async updateFileIndex(changes: RemoteChange[]): Promise<void> {
		const toSet: FileIndexEntry[] = []
		const toDelete: string[] = []

		for (const change of changes) {
			if (change.type === 'deleted') {
				toDelete.push(change.path)
			} else if (change.stat) {
				toSet.push({
					path: change.path,
					basename: change.stat.basename,
					isDir: change.stat.isDir,
					mtime: change.stat.mtime || 0,
					size: change.stat.isDir ? 0 : change.stat.size,
					lastSynced: Date.now(),
					parentPath: dirname(change.path),
				})
			}
		}

		if (toSet.length > 0) {
			await this.fileIndex.batchSet(toSet)
		}
		if (toDelete.length > 0) {
			await this.fileIndex.batchDelete(toDelete)
		}
	}

	/**
	 * 获取索引统计信息
	 */
	async getStats(): Promise<{
		fileCount: number
		dirCount: number
	}> {
		const allPaths = await this.fileIndex.getAllDirs()
		const totalCount = await this.fileIndex.count()

		return {
			fileCount: totalCount - allPaths.length,
			dirCount: allPaths.length,
		}
	}

	/**
	 * 辅助方法：数组分块
	 */
	private chunkArray<T>(array: T[], size: number): T[][] {
		const chunks: T[][] = []
		for (let i = 0; i < array.length; i += size) {
			chunks.push(array.slice(i, i + size))
		}
		return chunks
	}
}
