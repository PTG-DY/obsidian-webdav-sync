import { App, PluginSettingTab, Setting } from 'obsidian'
import { onSsoReceive } from '~/events/sso-receive'
import i18n from '~/i18n'
import type NutstorePlugin from '~/index'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { GlobMatchOptions } from '~/utils/glob-match'
import waitUntil from '~/utils/wait-until'
import AccountSettings from './account'
import CacheSettings from './cache'
import CommonSettings from './common'
import FilterSettings from './filter'
import IncrementalSyncSettings from './incremental-sync'
import LogSettings from './log'

export enum SyncMode {
	STRICT = 'strict',
	LOOSE = 'loose',
}

/**
 * 服务器类型枚举
 * - nutstore: 坚果云，支持Delta API增量同步
 * - webdav: 通用WebDAV服务器（如群晖NAS），使用标准WebDAV协议
 */
export enum ServerType {
	NUTSTORE = 'nutstore',
	WEBDAV = 'webdav',
}

export interface NutstoreSettings {
	account: string
	credential: string
	remoteDir: string
	remoteCacheDir?: string
	useGitStyle: boolean
	conflictStrategy: ConflictStrategy
	oauthResponseText: string
	loginMode: 'manual' | 'sso'
	confirmBeforeSync: boolean
	syncMode: SyncMode
	filterRules: {
		exclusionRules: GlobMatchOptions[]
		inclusionRules: GlobMatchOptions[]
	}
	skipLargeFiles: {
		maxSize: string
	}
	realtimeSync: boolean
	startupSyncDelaySeconds: number
	autoSyncIntervalSeconds: number
	/**
	 * 服务器类型：坚果云或通用WebDAV
	 */
	serverType: ServerType
	/**
	 * 自定义WebDAV服务器URL（仅在serverType为webdav时使用）
	 * 例如: https://your-synology-nas:5006
	 */
	webdavServerUrl: string
	/**
	 * WebDAV服务器基础路径（仅在serverType为webdav时使用）
	 * 例如群晖通常是: / 或 /homes/username
	 */
	webdavBasePath: string
}

let pluginInstance: NutstorePlugin | null = null

export function setPluginInstance(plugin: NutstorePlugin | null) {
	pluginInstance = plugin
}

export function waitUntilPluginInstance() {
	return waitUntil(() => !!pluginInstance, 100)
}

export async function useSettings() {
	await waitUntilPluginInstance()
	return pluginInstance!.settings
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: NutstorePlugin
	accountSettings: AccountSettings
	commonSettings: CommonSettings
	filterSettings: FilterSettings
	logSettings: LogSettings
	cacheSettings: CacheSettings
	incrementalSyncSettings: IncrementalSyncSettings

	subSso = onSsoReceive().subscribe(() => {
		this.display()
	})

	constructor(app: App, plugin: NutstorePlugin) {
		super(app, plugin)
		this.plugin = plugin
		new Setting(this.containerEl)
			.setName(i18n.t('settings.backupWarning.name'))
			.setDesc(i18n.t('settings.backupWarning.desc'))
		this.accountSettings = new AccountSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.commonSettings = new CommonSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.filterSettings = new FilterSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.cacheSettings = new CacheSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.incrementalSyncSettings = new IncrementalSyncSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.logSettings = new LogSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
	}

	async display() {
		await this.accountSettings.display()
		await this.commonSettings.display()
		await this.filterSettings.display()
		await this.cacheSettings.display()
		await this.incrementalSyncSettings.display()
		await this.logSettings.display()
	}

	get isSSO() {
		return this.plugin.settings.loginMode === 'sso'
	}

	async hide() {
		await this.accountSettings.hide()
	}
}
