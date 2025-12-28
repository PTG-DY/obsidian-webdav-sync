/**
 * 高性能文件索引存储系统
 * 支持百万级文件的增量同步
 *
 * 设计原则：
 * 1. 使用IndexedDB实现分页查询，避免内存溢出
 * 2. 支持按路径前缀查询（用于目录级别增量检测）
 * 3. 支持按mtime范围查询（用于时间范围增量检测）
 * 4. 批量操作优化，减少事务开销
 */

import localforage from 'localforage'

/**
 * 文件索引条目
 */
export interface FileIndexEntry {
	/** 文件相对路径 */
	path: string
	/** 文件名 */
	basename: string
	/** 是否为目录 */
	isDir: boolean
	/** 修改时间戳（毫秒） */
	mtime: number
	/** 文件大小（字节），目录为0 */
	size: number
	/** ETag（如果服务器支持） */
	etag?: string
	/** 内容哈希（用于冲突检测） */
	contentHash?: string
	/** 最后同步时间 */
	lastSynced: number
	/** 父目录路径 */
	parentPath: string
}

/**
 * 目录mtime缓存条目
 */
export interface DirMtimeEntry {
	/** 目录路径 */
	path: string
	/** 目录mtime */
	mtime: number
	/** 上次检查时间 */
	lastChecked: number
	/** 子项数量 */
	childCount: number
}

/**
 * 同步进度状态
 */
export interface SyncProgress {
	/** 同步会话ID */
	sessionId: string
	/** 开始时间 */
	startTime: number
	/** 当前阶段 */
	phase: 'scanning' | 'comparing' | 'syncing' | 'updating'
	/** 已处理文件数 */
	processedCount: number
	/** 总文件数（预估） */
	totalCount: number
	/** 当前处理的路径 */
	currentPath: string
	/** 待处理任务列表 */
	pendingTasks: string[]
	/** 已完成任务列表 */
	completedTasks: string[]
	/** 失败任务列表 */
	failedTasks: string[]
}

const DB_NAME = 'Nutstore_Plugin_Cache'

/**
 * 文件索引存储类
 * 使用IndexedDB实现高性能文件索引
 */
export class FileIndexStore {
	private db: LocalForage
	private namespace: string

	constructor(namespace: string) {
		this.namespace = namespace
		this.db = localforage.createInstance({
			name: DB_NAME,
			storeName: `file_index_${namespace}`,
		})
	}

	/**
	 * 获取单个文件索引
	 */
	async get(path: string): Promise<FileIndexEntry | null> {
		return await this.db.getItem<FileIndexEntry>(path)
	}

	/**
	 * 设置单个文件索引
	 */
	async set(entry: FileIndexEntry): Promise<void> {
		await this.db.setItem(entry.path, entry)
	}

	/**
	 * 删除单个文件索引
	 */
	async delete(path: string): Promise<void> {
		await this.db.removeItem(path)
	}

	/**
	 * 批量设置文件索引（优化性能）
	 */
	async batchSet(entries: FileIndexEntry[]): Promise<void> {
		// 分批处理，每批1000个
		const BATCH_SIZE = 1000
		for (let i = 0; i < entries.length; i += BATCH_SIZE) {
			const batch = entries.slice(i, i + BATCH_SIZE)
			await Promise.all(batch.map((entry) => this.db.setItem(entry.path, entry)))
		}
	}

	/**
	 * 批量删除文件索引
	 */
	async batchDelete(paths: string[]): Promise<void> {
		const BATCH_SIZE = 1000
		for (let i = 0; i < paths.length; i += BATCH_SIZE) {
			const batch = paths.slice(i, i + BATCH_SIZE)
			await Promise.all(batch.map((path) => this.db.removeItem(path)))
		}
	}

	/**
	 * 获取指定目录下的所有文件（分页）
	 * @param parentPath 父目录路径
	 * @param offset 偏移量
	 * @param limit 限制数量
	 */
	async getByParent(
		parentPath: string,
		offset: number = 0,
		limit: number = 1000,
	): Promise<FileIndexEntry[]> {
		const results: FileIndexEntry[] = []
		let count = 0
		let skipped = 0

		await this.db.iterate<FileIndexEntry, void>((value, key) => {
			if (value.parentPath === parentPath) {
				if (skipped < offset) {
					skipped++
				} else if (count < limit) {
					results.push(value)
					count++
				}
				if (count >= limit) {
					return undefined // 停止迭代
				}
			}
		})

		return results
	}

	/**
	 * 获取指定路径前缀下的所有文件（用于目录增量检测）
	 */
	async getByPrefix(prefix: string): Promise<FileIndexEntry[]> {
		const results: FileIndexEntry[] = []
		const normalizedPrefix = prefix.endsWith('/') ? prefix : prefix + '/'

		await this.db.iterate<FileIndexEntry, void>((value, key) => {
			if (key === prefix || (key as string).startsWith(normalizedPrefix)) {
				results.push(value)
			}
		})

		return results
	}

	/**
	 * 获取mtime在指定时间之后的文件
	 */
	async getModifiedAfter(timestamp: number): Promise<FileIndexEntry[]> {
		const results: FileIndexEntry[] = []

		await this.db.iterate<FileIndexEntry, void>((value) => {
			if (value.mtime > timestamp) {
				results.push(value)
			}
		})

		return results
	}

	/**
	 * 流式遍历所有文件（使用回调，避免内存溢出）
	 */
	async iterateAll(
		callback: (entry: FileIndexEntry) => Promise<boolean | void>,
	): Promise<void> {
		await this.db.iterate<FileIndexEntry, void>(async (value) => {
			const shouldContinue = await callback(value)
			if (shouldContinue === false) {
				return undefined // 停止迭代
			}
		})
	}

	/**
	 * 获取所有文件数量
	 */
	async count(): Promise<number> {
		return await this.db.length()
	}

	/**
	 * 获取所有目录的路径
	 */
	async getAllDirs(): Promise<string[]> {
		const dirs: string[] = []

		await this.db.iterate<FileIndexEntry, void>((value) => {
			if (value.isDir) {
				dirs.push(value.path)
			}
		})

		return dirs
	}

	/**
	 * 清空索引
	 */
	async clear(): Promise<void> {
		await this.db.clear()
	}

	/**
	 * 获取所有索引条目的路径集合
	 */
	async getAllPaths(): Promise<Set<string>> {
		const paths = new Set<string>()

		await this.db.iterate<FileIndexEntry, void>((value, key) => {
			paths.add(key as string)
		})

		return paths
	}
}

/**
 * 目录mtime缓存存储
 */
export class DirMtimeStore {
	private db: LocalForage
	private namespace: string

	constructor(namespace: string) {
		this.namespace = namespace
		this.db = localforage.createInstance({
			name: DB_NAME,
			storeName: `dir_mtime_${namespace}`,
		})
	}

	async get(path: string): Promise<DirMtimeEntry | null> {
		return await this.db.getItem<DirMtimeEntry>(path)
	}

	async set(entry: DirMtimeEntry): Promise<void> {
		await this.db.setItem(entry.path, entry)
	}

	async batchSet(entries: DirMtimeEntry[]): Promise<void> {
		await Promise.all(entries.map((entry) => this.db.setItem(entry.path, entry)))
	}

	async delete(path: string): Promise<void> {
		await this.db.removeItem(path)
	}

	async getAll(): Promise<Map<string, DirMtimeEntry>> {
		const result = new Map<string, DirMtimeEntry>()

		await this.db.iterate<DirMtimeEntry, void>((value, key) => {
			result.set(key as string, value)
		})

		return result
	}

	async clear(): Promise<void> {
		await this.db.clear()
	}
}

/**
 * 同步进度存储
 */
export class SyncProgressStore {
	private db: LocalForage
	private namespace: string

	constructor(namespace: string) {
		this.namespace = namespace
		this.db = localforage.createInstance({
			name: DB_NAME,
			storeName: `sync_progress_${namespace}`,
		})
	}

	async get(): Promise<SyncProgress | null> {
		return await this.db.getItem<SyncProgress>('current')
	}

	async save(progress: SyncProgress): Promise<void> {
		await this.db.setItem('current', progress)
	}

	async clear(): Promise<void> {
		await this.db.removeItem('current')
	}
}

/**
 * 创建命名空间的索引存储集合
 */
export function createIndexStores(namespace: string) {
	return {
		fileIndex: new FileIndexStore(namespace),
		dirMtime: new DirMtimeStore(namespace),
		syncProgress: new SyncProgressStore(namespace),
	}
}
