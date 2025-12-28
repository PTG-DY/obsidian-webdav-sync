import { XMLParser } from 'fast-xml-parser'
import { isNil, partial } from 'lodash-es'
import { basename, join } from 'path-browserify'
import { FileStat } from 'webdav'
import { getWebDAVEndpoint, getWebDAVBasePath } from '~/consts'
import { NutstoreSettings } from '~/settings'
import { is503Error } from '~/utils/is-503-error'
import logger from '~/utils/logger'
import requestUrl from '~/utils/request-url'

interface WebDAVResponse {
	multistatus: {
		response: Array<{
			href: string
			propstat: {
				prop: {
					displayname: string
					resourcetype: { collection?: any }
					getlastmodified?: string
					getcontentlength?: string
					getcontenttype?: string
				}
				status: string
			}
		}>
	}
}

function extractNextLink(linkHeader: string): string | null {
	const matches = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
	return matches ? matches[1] : null
}

function convertToFileStat(
	serverBase: string,
	item: WebDAVResponse['multistatus']['response'][number],
): FileStat {
	const props = item.propstat.prop
	const isDir = !isNil(props.resourcetype?.collection)
	const href = decodeURIComponent(item.href)

	// 处理服务器基础路径
	// 如果serverBase为'/'，直接使用href
	// 否则移除serverBase前缀
	let filename: string
	if (serverBase === '/') {
		filename = href
	} else {
		// 确保正确移除基础路径前缀
		if (href.startsWith(serverBase)) {
			filename = join('/', href.slice(serverBase.length))
		} else {
			filename = href
		}
	}

	// 确保路径格式正确
	if (!filename.startsWith('/')) {
		filename = '/' + filename
	}

	return {
		filename,
		basename: basename(filename),
		lastmod: props.getlastmodified || '',
		size: props.getcontentlength ? parseInt(props.getcontentlength, 10) : 0,
		type: isDir ? 'directory' : 'file',
		etag: null,
		mime: props.getcontenttype,
	}
}

/**
 * 获取WebDAV目录内容
 * @param token 认证令牌
 * @param path 目录路径
 * @param settings 插件设置（用于获取正确的端点和基础路径）
 */
export async function getDirectoryContents(
	token: string,
	path: string,
	settings: NutstoreSettings,
): Promise<FileStat[]> {
	const contents: FileStat[] = []
	const endpoint = getWebDAVEndpoint(settings)
	const serverBasePath = getWebDAVBasePath(settings)

	path = path.split('/').map(encodeURIComponent).join('/')
	if (!path.startsWith('/')) {
		path = '/' + path
	}
	let currentUrl = `${endpoint}${path}`

	while (true) {
		try {
			const response = await requestUrl({
				url: currentUrl,
				method: 'PROPFIND',
				headers: {
					Authorization: `Basic ${token}`,
					'Content-Type': 'application/xml',
					Depth: '1',
				},
				body: `<?xml version="1.0" encoding="utf-8"?>
        <propfind xmlns="DAV:">
          <prop>
            <displayname/>
            <resourcetype/>
            <getlastmodified/>
            <getcontentlength/>
            <getcontenttype/>
          </prop>
        </propfind>`,
			})
			const parseXml = new XMLParser({
				attributeNamePrefix: '',
				removeNSPrefix: true,
				parseTagValue: false,
				numberParseOptions: {
					eNotation: false,
					hex: true,
					leadingZeros: true,
				},
			})
			const result: WebDAVResponse = parseXml.parse(response.text)
			const items = Array.isArray(result.multistatus.response)
				? result.multistatus.response
				: [result.multistatus.response]

			// 跳过第一个条目（当前目录），使用动态的服务器基础路径
			contents.push(
				...items.slice(1).map(partial(convertToFileStat, serverBasePath)),
			)

			const linkHeader = response.headers['link'] || response.headers['Link']
			if (!linkHeader) {
				break
			}

			const nextLink = extractNextLink(linkHeader)
			if (!nextLink) {
				break
			}
			const nextUrl = new URL(nextLink)
			nextUrl.pathname = decodeURI(nextUrl.pathname)
			currentUrl = nextUrl.toString()
		} catch (e) {
			if (is503Error(e)) {
				logger.error('503 error, retrying...')
				await sleep(60_000)
				continue
			}
			throw e
		}
	}

	return contents
}
