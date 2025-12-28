import { Modal, Notice, Setting } from 'obsidian'
import i18n from '~/i18n'
import { FileIndexStore, DirMtimeStore } from '~/storage/file-index'
import { getDBKey } from '~/utils/get-db-key'
import logger from '~/utils/logger'
import BaseSettings from './settings.base'

/**
 * 增量同步设置（仅通用WebDAV模式）
 * Incremental sync settings (Generic WebDAV mode only)
 */
export default class IncrementalSyncSettings extends BaseSettings {
	private fileIndex: FileIndexStore | null = null
	private dirMtimeStore: DirMtimeStore | null = null

	async display() {
		this.containerEl.empty()

		// 只在通用WebDAV模式下显示
		if (this.plugin.settings.serverType !== 'webdav') {
			return
		}

		new Setting(this.containerEl)
			.setName(i18n.t('settings.incrementalSync.title'))
			.setDesc(i18n.t('settings.incrementalSync.desc'))
			.setHeading()

		// 初始化索引存储
		const namespace = getDBKey(
			this.app.vault.getName(),
			this.plugin.settings.remoteDir,
		)
		this.fileIndex = new FileIndexStore(namespace)
		this.dirMtimeStore = new DirMtimeStore(namespace)

		// 显示索引状态
		await this.displayIndexStatus()

		// 重建索引按钮
		this.displayRebuildIndex()

		// 清除索引按钮
		this.displayClearIndex()

		// 工作原理说明
		this.displayHowItWorks()
	}

	/**
	 * 显示索引状态
	 */
	private async displayIndexStatus() {
		const statusSetting = new Setting(this.containerEl)
			.setName(i18n.t('settings.incrementalSync.status.name'))
			.setDesc(i18n.t('settings.incrementalSync.status.desc'))

		try {
			const count = await this.fileIndex!.count()
			if (count === 0) {
				statusSetting.descEl.innerHTML = `<span class="mod-warning">${i18n.t('settings.incrementalSync.status.noIndex')}</span>`
			} else {
				// 获取详细统计
				const allDirs = await this.fileIndex!.getAllDirs()
				const dirCount = allDirs.length
				const fileCount = count - dirCount

				const statusText = i18n
					.t('settings.incrementalSync.status.indexed')
					.replace('{{fileCount}}', String(fileCount))
					.replace('{{dirCount}}', String(dirCount))

				statusSetting.descEl.innerHTML = `<span class="mod-success">${statusText}</span>`
			}
		} catch (error) {
			logger.error('Failed to get index status:', error)
			statusSetting.descEl.innerHTML = `<span class="mod-warning">${i18n.t('settings.incrementalSync.status.noIndex')}</span>`
		}
	}

	/**
	 * 显示重建索引按钮
	 */
	private displayRebuildIndex() {
		new Setting(this.containerEl)
			.setName(i18n.t('settings.incrementalSync.rebuildIndex.name'))
			.setDesc(i18n.t('settings.incrementalSync.rebuildIndex.desc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.incrementalSync.rebuildIndex.button'))
					.onClick(() => {
						// 显示确认对话框
						new RebuildIndexConfirmModal(this.app, async () => {
							button.setDisabled(true)
							button.setButtonText(
								i18n.t('settings.incrementalSync.rebuildIndex.inProgress'),
							)

							try {
								// 清除现有索引
								await this.fileIndex!.clear()
								await this.dirMtimeStore!.clear()

								new Notice(
									i18n.t('settings.incrementalSync.rebuildIndex.success'),
								)

								// 刷新显示
								this.display()
							} catch (error) {
								logger.error('Failed to rebuild index:', error)
								new Notice(
									`Error rebuilding index: ${(error as Error).message}`,
								)
								button.setDisabled(false)
								button.setButtonText(
									i18n.t('settings.incrementalSync.rebuildIndex.button'),
								)
							}
						}).open()
					})
			})
	}

	/**
	 * 显示清除索引按钮
	 */
	private displayClearIndex() {
		new Setting(this.containerEl)
			.setName(i18n.t('settings.incrementalSync.clearIndex.name'))
			.setDesc(i18n.t('settings.incrementalSync.clearIndex.desc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.incrementalSync.clearIndex.button'))
					.setWarning()
					.onClick(async () => {
						try {
							await this.fileIndex!.clear()
							await this.dirMtimeStore!.clear()

							new Notice(i18n.t('settings.incrementalSync.clearIndex.success'))

							// 刷新显示
							this.display()
						} catch (error) {
							logger.error('Failed to clear index:', error)
							new Notice(`Error clearing index: ${(error as Error).message}`)
						}
					})
			})
	}

	/**
	 * 显示工作原理说明
	 */
	private displayHowItWorks() {
		const setting = new Setting(this.containerEl)
			.setName(i18n.t('settings.incrementalSync.howItWorks.name'))
			.setDesc(i18n.t('settings.incrementalSync.howItWorks.desc'))

		// 添加折叠样式
		setting.descEl.classList.add('setting-item-description-collapsed')
	}
}

/**
 * 重建索引确认对话框
 */
class RebuildIndexConfirmModal extends Modal {
	constructor(
		app: import('obsidian').App,
		private onConfirm: () => Promise<void>,
	) {
		super(app)
	}

	onOpen() {
		const { contentEl } = this

		contentEl.createEl('h3', {
			text: i18n.t('settings.incrementalSync.rebuildIndex.confirm'),
		})

		contentEl.createEl('p', {
			text: i18n.t('settings.incrementalSync.rebuildIndex.confirmMessage'),
		})

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.incrementalSync.rebuildIndex.confirm'))
					.setCta()
					.onClick(async () => {
						this.close()
						await this.onConfirm()
					})
			})
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.logout.cancel')).onClick(() => {
					this.close()
				})
			})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
